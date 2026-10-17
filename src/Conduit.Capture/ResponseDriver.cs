using System.Diagnostics;
using Conduit.Capture.Wire;
using Microsoft.AspNetCore.Http;

namespace Conduit.Capture;

/// <summary>Per-request timing and outcome facts, written into the capture record.</summary>
public sealed class RequestTiming(Stopwatch clock)
{
    private long _abortedAt = -1;

    public double? FirstByteMs { get; private set; }
    public double? LastWriteMs { get; private set; }
    public double? AbortedAtMs => _abortedAt < 0 ? null : _abortedAt;
    public double? CompletedMs { get; set; }
    public long BytesWritten { get; private set; }
    public int Frames { get; private set; }
    public int KeepAlives { get; private set; }
    public bool ServerAborted { get; set; }
    public string EndedBy { get; set; } = "completed";

    public double NowMs => clock.Elapsed.TotalMilliseconds;

    public void MarkAborted() => Interlocked.CompareExchange(ref _abortedAt, (long)NowMs, -1);

    public void Wrote(int bytes, bool keepAlive)
    {
        var now = NowMs;
        FirstByteMs ??= now;
        LastWriteMs = now;
        BytesWritten += bytes;
        Frames++;
        if (keepAlive) KeepAlives++;
    }
}

internal static class ResponseDriver
{
    public static async Task WriteJsonAsync(HttpContext ctx, int status, string json, RequestTiming t)
    {
        ctx.Response.StatusCode = status;
        ctx.Response.ContentType = "application/json; charset=utf-8";
        var bytes = System.Text.Encoding.UTF8.GetBytes(json);
        ctx.Response.ContentLength = bytes.Length;
        await ctx.Response.Body.WriteAsync(bytes, ctx.RequestAborted);
        await ctx.Response.Body.FlushAsync(ctx.RequestAborted);
        t.Wrote(bytes.Length, false);
    }

    /// <summary>Plays <paramref name="events"/> through <paramref name="renderer"/> as SSE or one JSON body.</summary>
    public static async Task RunAsync(HttpContext ctx, IWireRenderer renderer, IEnumerable<ScriptEvent> events,
        bool stream, CaptureOptions options, RequestTiming t)
    {
        var ct = ctx.RequestAborted;

        if (stream)
        {
            ctx.Response.StatusCode = 200;
            ctx.Response.ContentType = "text/event-stream; charset=utf-8";
            ctx.Response.Headers.CacheControl = "no-cache";
            ctx.Response.Headers["X-Accel-Buffering"] = "no";
            await ctx.Response.StartAsync(ct);
        }

        async Task Send(SseFrame frame)
        {
            var bytes = frame.ToBytes();
            await ctx.Response.Body.WriteAsync(bytes, ct);
            await ctx.Response.Body.FlushAsync(ct);
            t.Wrote(bytes.Length, frame.Comment is not null);
        }

        async Task SendAll(IEnumerable<SseFrame> frames)
        {
            foreach (var fr in frames) await Send(fr);
        }

        if (stream) await SendAll(renderer.Begin()); else _ = renderer.Begin().ToList();

        foreach (var ev in events)
        {
            switch (ev)
            {
                case Pause p:
                    await PauseAsync(p, stream, options, Send, ct);
                    break;

                case StreamError err:
                    if (stream)
                    {
                        await SendAll(renderer.Render(err));
                    }
                    else
                    {
                        // Non-streaming: send half a JSON body, then drop the connection.
                        var half = "{\"id\":\"" + "chatcmpl-cut";
                        ctx.Response.StatusCode = 200;
                        ctx.Response.ContentType = "application/json";
                        await ctx.Response.Body.WriteAsync(System.Text.Encoding.UTF8.GetBytes(half), ct);
                        await ctx.Response.Body.FlushAsync(ct);
                        t.Wrote(half.Length, false);
                    }
                    t.ServerAborted = true;
                    t.EndedBy = "server_aborted";
                    ctx.Abort();
                    return;

                default:
                    var frames = renderer.Render(ev);
                    if (stream) await SendAll(frames); else _ = frames.ToList();
                    break;
            }
        }

        if (!renderer.Finished)
        {
            var frames = renderer.Render(new Finish("stop"));
            if (stream) await SendAll(frames); else _ = frames.ToList();
        }

        if (!stream && renderer.Final is { } final)
            await WriteJsonAsync(ctx, 200, WireJson.S(final), t);
    }

    private static async Task PauseAsync(Pause p, bool stream, CaptureOptions options, Func<SseFrame, Task> send, CancellationToken ct)
    {
        var remaining = p.Duration;
        while (remaining > TimeSpan.Zero)
        {
            var step = stream && p.KeepAlive ? TimeSpan.FromTicks(Math.Min(remaining.Ticks, options.KeepAliveInterval.Ticks)) : remaining;
            await Task.Delay(step, ct);
            remaining -= step;
            if (stream && p.KeepAlive && remaining > TimeSpan.Zero)
                await send(new SseFrame(null, null, "keep-alive"));
        }
    }
}
