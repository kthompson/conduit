using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Conduit.OpenAi;
using Conduit.Provider.Core;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.Logging;

namespace Conduit.Server;

/// <summary><c>POST /v1/chat/completions</c>: parse, pick the instance, run it, and serialize the item stream (SSE or one object).</summary>
public sealed class ChatEndpoint(ProviderRegistry registry, ILogger<ChatEndpoint> log)
{
    public async Task HandleAsync(HttpContext ctx)
    {
        var sw = Stopwatch.StartNew();
        JsonNode? body;
        try
        {
            body = await JsonNode.ParseAsync(
                ctx.Request.Body,
                cancellationToken: ctx.RequestAborted
            );
        }
        catch (JsonException e)
        {
            throw OpenAiError.BadRequest(
                "The request body is not valid JSON: " + e.Message,
                "invalid_json"
            );
        }

        var call = ChatCompletionsRequest.Parse(body);
        var (instance, slug) = registry.Resolve(call.Request.Model);
        var request = call.Request with { Model = slug };
        if (call.Ignored.Count > 0)
            ctx.Response.Headers["X-Ignored-Params"] = string.Join(", ", call.Ignored);

        var promptEstimate = request.Messages.Sum(m =>
            ChatCompletionsWriter.EstimateTokens(m.Text?.Length ?? 0)
        );
        var writer = new ChatCompletionsWriter(
            call.Request.Model,
            call.IncludeUsage,
            promptEstimate
        );
        log.LogInformation(
            "chat {Model} stream={Stream} messages={Messages} tools={Tools}",
            call.Request.Model,
            call.Stream,
            request.Messages.Count,
            request.Tools.Count
        );

        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ctx.RequestAborted);
        var events = instance.CompleteAsync(request, cts.Token).GetAsyncEnumerator(cts.Token);
        var inFlight = new StrongBox<Task<bool>?>();
        try
        {
            if (call.Stream)
                await StreamAsync(ctx, events, writer, sw, inFlight, cts.Token);
            else
                await JsonAsync(ctx, events, writer, cts.Token);
            log.LogInformation(
                "chat {Model} done in {Total} ms",
                call.Request.Model,
                sw.ElapsedMilliseconds
            );
            log.LogDebug(
                "chat {Model} final: {Final}",
                call.Request.Model,
                writer.Final?.ToJsonString()
            );
        }
        catch (OperationCanceledException) when (ctx.RequestAborted.IsCancellationRequested)
        {
            log.LogInformation(
                "chat {Model} cancelled: client disconnected after {Total} ms",
                call.Request.Model,
                sw.ElapsedMilliseconds
            );
        }
        finally
        {
            // Stop the provider (this kills the child process), let any in-flight MoveNext finish, then dispose.
            cts.Cancel();
            if (inFlight.Value is { } pending)
            {
                try
                {
                    await pending;
                }
                catch (Exception) { }
            }
            await events.DisposeAsync();
        }
    }

    /// <summary>Non-streaming: run to the end, then return one chat.completion object (or an HTTP error).</summary>
    private static async Task JsonAsync(
        HttpContext ctx,
        IAsyncEnumerator<CompletionEvent> events,
        ChatCompletionsWriter writer,
        CancellationToken ct
    )
    {
        try
        {
            while (await events.MoveNextAsync())
                foreach (var _ in writer.Render(events.Current)) { }
        }
        catch (ProviderFailure f)
        {
            throw OpenAiError.From(f);
        }
        if (!writer.Finished)
            foreach (var _ in writer.Render(new Finish(FinishReason.Stop))) { }

        ctx.Response.ContentType = "application/json";
        await ctx.Response.WriteAsync(writer.Final!.ToJsonString(), ct);
    }

    /// <summary>
    /// Streaming. A failure before the first event is a normal HTTP error (clients retry those cleanly). If the provider is
    /// merely slow, headers and the first frame go out after <see cref="ConduitServer.FirstEventWait"/> and SSE comments keep the
    /// connection alive. A failure after output has started can only be reported inside the stream.
    /// </summary>
    private async Task StreamAsync(
        HttpContext ctx,
        IAsyncEnumerator<CompletionEvent> events,
        ChatCompletionsWriter writer,
        Stopwatch sw,
        StrongBox<Task<bool>?> inFlight,
        CancellationToken ct
    )
    {
        var started = false;
        var pending = inFlight.Value = events.MoveNextAsync().AsTask();

        async Task Start()
        {
            started = true;
            ctx.Response.StatusCode = 200;
            ctx.Response.ContentType = "text/event-stream";
            ctx.Response.Headers.CacheControl = "no-cache";
            ctx.Response.Headers["X-Accel-Buffering"] = "no";
            ctx.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();
            foreach (var f in writer.Begin())
                await Write(ctx, f, ct);
            log.LogDebug("first byte after {Ms} ms", sw.ElapsedMilliseconds);
        }

        while (true)
        {
            ct.ThrowIfCancellationRequested();
            var done = await Task.WhenAny(
                pending,
                Task.Delay(
                    started ? ConduitServer.KeepAliveInterval : ConduitServer.FirstEventWait,
                    ct
                )
            );
            if (done != pending)
            {
                if (!started)
                    await Start();
                else
                    await Write(ctx, SseFrame.KeepAlive, ct);
                continue;
            }

            bool has;
            try
            {
                has = await pending;
            }
            catch (ProviderFailure f) when (!started)
            {
                throw OpenAiError.From(f);
            }
            catch (ProviderFailure f)
            {
                log.LogWarning("provider failed mid-stream: {Message}", f.Message);
                await Write(ctx, new SseFrame(OpenAiError.From(f).ToJson().ToJsonString()), ct);
                return;
            }

            if (!started)
                await Start();
            if (!has)
                break;
            foreach (var frame in writer.Render(events.Current))
                await Write(ctx, frame, ct);
            pending = inFlight.Value = events.MoveNextAsync().AsTask();
        }

        if (!writer.Finished)
            foreach (var frame in writer.Render(new Finish(FinishReason.Stop)))
                await Write(ctx, frame, ct);
    }

    private static async Task Write(HttpContext ctx, SseFrame frame, CancellationToken ct)
    {
        var text = frame.Data is not null ? $"data: {frame.Data}\n\n" : $": {frame.Comment}\n\n";
        await ctx.Response.WriteAsync(text, Encoding.UTF8, ct);
        await ctx.Response.Body.FlushAsync(ct);
    }
}
