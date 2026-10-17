using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Conduit.Capture.Wire;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace Conduit.Capture;

/// <summary>
/// Handles every request: records it, then answers according to the chosen scenario.
/// Nothing is routed by the framework, so unknown paths are logged too.
/// </summary>
public sealed class CaptureHandler(
    CaptureOptions options,
    CaptureStore store,
    ModelCatalog catalog,
    ILogger<CaptureHandler> log
)
{
    private static readonly HashSet<string> RedactedHeaders = new(StringComparer.OrdinalIgnoreCase)
    {
        "authorization",
        "proxy-authorization",
        "x-api-key",
        "api-key",
        "cookie",
        "set-cookie",
    };

    private readonly ConcurrentDictionary<string, long> _lastSeqByBody = new();
    private long _seq;
    private long _errorCycle;
    private long _lastRequestTicks;

    public async Task HandleAsync(HttpContext ctx)
    {
        var clock = Stopwatch.StartNew();
        var seq = Interlocked.Increment(ref _seq);
        var started = DateTimeOffset.UtcNow;
        var sinceLast = SinceLastRequest(started);
        var timing = new RequestTiming(clock);
        using var abortReg = ctx.RequestAborted.Register(timing.MarkAborted);

        var route = Route(ctx.Request.Method, ctx.Request.Path.Value ?? "/");
        var rec = new JsonObject
        {
            ["seq"] = seq,
            ["ts"] = started.ToString("O"),
            ["method"] = ctx.Request.Method,
            ["path"] = ctx.Request.Path.Value,
            ["query"] = ctx.Request.QueryString.Value,
            ["remote"] = ctx.Connection.RemoteIpAddress?.ToString(),
            ["httpVersion"] = ctx.Request.Protocol,
            ["wire"] = route.Wire,
            ["matchedBySuffix"] =
                route.Wire != "other"
                && !(ctx.Request.Path.Value ?? "").StartsWith("/v1/", StringComparison.Ordinal),
            ["sinceLastRequestMs"] = sinceLast,
        };
        rec["headers"] = HeadersJson(ctx.Request.Headers);
        rec["auth"] = AuthJson(ctx.Request.Headers, out var authOk);

        RequestFacts facts = new() { Wire = route.Wire };
        ScenarioSpec spec = default;
        string? bodyText = null;
        string scenarioLabel = "";
        var failure = (string?)null;

        try
        {
            var raw = await ReadBodyAsync(ctx, rec);
            bodyText = DecodeText(raw, rec);
            JsonNode? json = null;
            if (
                bodyText is not null
                && ctx.Request.ContentLength != 0
                && (bodyText.TrimStart().StartsWith('{') || bodyText.TrimStart().StartsWith('['))
            )
            {
                try
                {
                    json = JsonNode.Parse(bodyText);
                }
                catch (JsonException ex)
                {
                    rec["bodyParseError"] = ex.Message;
                }
            }
            rec["body"] = bodyText;
            rec["bodyBytes"] = raw.Length;
            if (raw.Length > 0)
                DuplicateInfo(raw, seq, rec);

            facts = RequestAnalyzer.Analyze(route.Wire, ctx.Request.Headers, json);
            rec["derived"] = facts.Json;

            spec = ResolveScenario(ctx, facts);
            scenarioLabel = route.Wire is "chat" or "responses" or "messages"
                ? spec.ToString()
                : "";

            log.LogInformation(
                "#{Seq} {Method} {Path} wire={Wire} stream={Stream} tools={Tools} paths={Paths} ids={Ids}",
                seq,
                ctx.Request.Method,
                ctx.Request.Path.Value,
                route.Wire,
                facts.Stream,
                facts.ToolCount,
                facts.PathCount,
                facts.SessionIdCount
            );

            await DispatchAsync(ctx, route, facts, json, spec, authOk, seq, timing, rec);
            if (rec["scenario"] is { } s)
                scenarioLabel = s.ToString();
        }
        catch (Exception ex)
            when (ex is OperationCanceledException or IOException or BadHttpRequestException
                && (ctx.RequestAborted.IsCancellationRequested || timing.ServerAborted)
            )
        {
            timing.EndedBy = timing.ServerAborted ? "server_aborted" : "client_aborted";
        }
        catch (Exception ex)
        {
            failure = ex.Message;
            timing.EndedBy = "error";
            log.LogError(ex, "#{Seq} handler failed", seq);
            if (!ctx.Response.HasStarted)
            {
                try
                {
                    ctx.Response.StatusCode = 500;
                    await ResponseDriver.WriteJsonAsync(
                        ctx,
                        500,
                        new JsonObject
                        {
                            ["error"] = new JsonObject
                            {
                                ["message"] = "capture server error: " + ex.Message,
                            },
                        }.ToJsonString(),
                        timing
                    );
                }
                catch
                { /* the client is gone */
                }
            }
        }
        finally
        {
            if (
                timing.AbortedAtMs is not null
                && !timing.ServerAborted
                && timing.EndedBy == "completed"
            )
                timing.EndedBy = "client_aborted";
            timing.CompletedMs = timing.NowMs;
            rec["response"] = new JsonObject
            {
                ["status"] = ctx.Response.StatusCode,
                ["scenario"] = scenarioLabel,
                ["stream"] = facts.Stream,
                ["endedBy"] = timing.EndedBy,
                ["error"] = failure,
                ["bytesWritten"] = timing.BytesWritten,
                ["frames"] = timing.Frames,
                ["keepAlivesSent"] = timing.KeepAlives,
                ["firstByteWrittenMs"] = Round(timing.FirstByteMs),
                ["completedMs"] = Round(timing.CompletedMs),
                ["clientAbortedAtMs"] = Round(timing.AbortedAtMs),
                ["msSinceLastWriteAtAbort"] =
                    timing.AbortedAtMs is { } a && timing.LastWriteMs is { } w
                        ? Round(a - w)
                        : null,
            };
            try
            {
                store.Append(rec);
            }
            catch (Exception ex)
            {
                log.LogError(ex, "#{Seq} could not write capture record", seq);
            }

            log.LogInformation(
                "#{Seq} -> {Status} scenario={Scenario} end={End} firstByte={FirstByte}ms total={Total}ms bytes={Bytes}",
                seq,
                ctx.Response.StatusCode,
                scenarioLabel,
                timing.EndedBy,
                Round(timing.FirstByteMs),
                Round(timing.CompletedMs),
                timing.BytesWritten
            );
        }
    }

    // ---- dispatch ----------------------------------------------------------------------------------------------

    private async Task DispatchAsync(
        HttpContext ctx,
        (string Wire, string? ModelId) route,
        RequestFacts facts,
        JsonNode? json,
        ScenarioSpec spec,
        bool authOk,
        long seq,
        RequestTiming timing,
        JsonObject rec
    )
    {
        if (route.Wire == "options")
        {
            ctx.Response.StatusCode = 204;
            ctx.Response.Headers["Access-Control-Allow-Origin"] = "*";
            ctx.Response.Headers["Access-Control-Allow-Headers"] = "*";
            ctx.Response.Headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
            return;
        }

        if (!authOk)
        {
            await WriteErrorAsync(
                ctx,
                route.Wire,
                401,
                "authentication_error",
                "invalid_api_key",
                "Capture server: missing or wrong key (the server was started with --key).",
                timing
            );
            return;
        }

        switch (route.Wire)
        {
            case "models":
                await ResponseDriver.WriteJsonAsync(ctx, 200, catalog.ListJson(), timing);
                return;

            case "model":
                var model = route.ModelId is null ? null : catalog.Find(route.ModelId);
                if (model is null)
                    await WriteErrorAsync(
                        ctx,
                        "other",
                        404,
                        "invalid_request_error",
                        "model_not_found",
                        $"The model '{route.ModelId}' does not exist.",
                        timing
                    );
                else
                    await ResponseDriver.WriteJsonAsync(ctx, 200, WireJson.S(model), timing);
                return;

            case "count_tokens":
                await ResponseDriver.WriteJsonAsync(
                    ctx,
                    200,
                    new JsonObject
                    {
                        ["input_tokens"] = Math.Max(1, (json?.ToJsonString().Length ?? 0) / 4),
                    }.ToJsonString(),
                    timing
                );
                return;

            case "chat"
            or "responses"
            or "messages":
                await CompletionAsync(ctx, route.Wire, facts, json, spec, seq, timing, rec);
                return;

            default:
                await WriteErrorAsync(
                    ctx,
                    "other",
                    404,
                    "invalid_request_error",
                    "not_found",
                    $"Capture server: no route for {ctx.Request.Method} {ctx.Request.Path}. The request was logged.",
                    timing
                );
                return;
        }
    }

    private async Task CompletionAsync(
        HttpContext ctx,
        string wire,
        RequestFacts facts,
        JsonNode? json,
        ScenarioSpec spec,
        long seq,
        RequestTiming timing,
        JsonObject rec
    )
    {
        if (json is not JsonObject)
        {
            await WriteErrorAsync(
                ctx,
                wire,
                400,
                "invalid_request_error",
                "invalid_json",
                "Capture server: the request body is not a JSON object.",
                timing
            );
            return;
        }

        var plan = Scenarios.Plan(
            spec,
            new ScenarioContext(
                facts,
                options,
                wire,
                seq,
                (int)(spec.Name == "error" ? Interlocked.Increment(ref _errorCycle) - 1 : 0)
            )
        );
        rec["scenario"] = plan.Label;

        if (plan.ErrorStatus is { } status)
        {
            if (plan.RetryAfterSeconds is { } ra)
                ctx.Response.Headers.RetryAfter = ra.ToString();
            await WriteErrorAsync(
                ctx,
                wire,
                status,
                plan.ErrorType,
                plan.ErrorCode,
                plan.ErrorMessage,
                timing
            );
            return;
        }

        var prefix = wire switch
        {
            "responses" => "resp_",
            "messages" => "msg_",
            _ => "chatcmpl-",
        };
        var renderer = CreateRenderer(
            wire,
            new RenderContext
            {
                Id = WireJson.NewId(prefix),
                Model = facts.Model ?? options.Models[0],
                IncludeUsage = facts.IncludeUsage,
                PromptTokens = facts.PromptTokensEstimate,
            }
        );
        await ResponseDriver.RunAsync(ctx, renderer, plan.Events, facts.Stream, options, timing);
    }

    private static IWireRenderer CreateRenderer(string wire, RenderContext c) =>
        wire switch
        {
            "responses" => new ResponsesRenderer(c),
            "messages" => new MessagesRenderer(c),
            _ => new ChatRenderer(c),
        };

    private static async Task WriteErrorAsync(
        HttpContext ctx,
        string wire,
        int status,
        string type,
        string code,
        string message,
        RequestTiming timing
    )
    {
        IWireRenderer r =
            wire == "messages"
                ? new MessagesRenderer(new RenderContext { Id = "", Model = "" })
                : new ChatRenderer(new RenderContext { Id = "", Model = "" });
        await ResponseDriver.WriteJsonAsync(
            ctx,
            status,
            WireJson.S(r.ErrorBody(type, code, message)),
            timing
        );
    }

    // ---- routing and scenario choice ---------------------------------------------------------------------------

    internal static (string Wire, string? ModelId) Route(string method, string path)
    {
        var p = path.TrimEnd('/').ToLowerInvariant();
        if (method == "OPTIONS")
            return ("options", null);
        if (method == "GET")
        {
            if (p.EndsWith("/models", StringComparison.Ordinal))
                return ("models", null);
            var i = p.LastIndexOf("/models/", StringComparison.Ordinal);
            if (i >= 0)
                return ("model", path.TrimEnd('/')[(i + "/models/".Length)..]);
        }
        if (method == "POST")
        {
            if (p.EndsWith("/chat/completions", StringComparison.Ordinal))
                return ("chat", null);
            if (p.EndsWith("/responses", StringComparison.Ordinal))
                return ("responses", null);
            if (p.EndsWith("/messages/count_tokens", StringComparison.Ordinal))
                return ("count_tokens", null);
            if (p.EndsWith("/messages", StringComparison.Ordinal))
                return ("messages", null);
        }
        return ("other", null);
    }

    private ScenarioSpec ResolveScenario(HttpContext ctx, RequestFacts facts)
    {
        if (
            ctx.Request.Query.TryGetValue("scenario", out var q)
            && q.Count > 0
            && !string.IsNullOrEmpty(q[0])
        )
            return ScenarioSpec.Parse(q[0]);
        if (
            ctx.Request.Headers.TryGetValue("X-Capture-Scenario", out var h)
            && !string.IsNullOrEmpty(h.ToString())
        )
            return ScenarioSpec.Parse(h.ToString());
        var (_, fromModel) = ScenarioSpec.SplitModel(facts.Model);
        return fromModel ?? ScenarioSpec.Parse(options.DefaultScenario);
    }

    // ---- request recording -------------------------------------------------------------------------------------

    private double? SinceLastRequest(DateTimeOffset now)
    {
        var prev = Interlocked.Exchange(ref _lastRequestTicks, now.UtcTicks);
        return prev == 0
            ? null
            : Math.Round(TimeSpan.FromTicks(now.UtcTicks - prev).TotalMilliseconds);
    }

    private static JsonObject HeadersJson(IHeaderDictionary headers)
    {
        var o = new JsonObject();
        foreach (var h in headers)
            o[h.Key.ToLowerInvariant()] = RedactedHeaders.Contains(h.Key)
                ? "<redacted>"
                : h.Value.ToString();
        return o;
    }

    /// <summary>Notes whether and how a key was presented, never the key itself.</summary>
    private JsonObject AuthJson(IHeaderDictionary headers, out bool ok)
    {
        string? header = null,
            scheme = null,
            value = null;
        var auth = headers.Authorization.ToString();
        if (!string.IsNullOrEmpty(auth))
        {
            header = "authorization";
            var space = auth.IndexOf(' ');
            scheme = space > 0 ? auth[..space] : "(none)";
            value = space > 0 ? auth[(space + 1)..] : auth;
        }
        else if (headers.TryGetValue("x-api-key", out var xk) && !string.IsNullOrEmpty(xk))
        {
            header = "x-api-key";
            value = xk.ToString();
        }
        else if (headers.TryGetValue("api-key", out var ak) && !string.IsNullOrEmpty(ak))
        {
            header = "api-key";
            value = ak.ToString();
        }

        ok = options.Key is null || (value is not null && FixedTimeEquals(value, options.Key));
        return new JsonObject
        {
            ["present"] = header is not null,
            ["header"] = header,
            ["scheme"] = scheme,
            ["valueLength"] = value?.Length,
            ["accepted"] = ok,
        };
    }

    private static bool FixedTimeEquals(string a, string b) =>
        CryptographicOperations.FixedTimeEquals(
            SHA256.HashData(Encoding.UTF8.GetBytes(a)),
            SHA256.HashData(Encoding.UTF8.GetBytes(b))
        );

    private async Task<byte[]> ReadBodyAsync(HttpContext ctx, JsonObject rec)
    {
        using var ms = new MemoryStream();
        await ctx.Request.Body.CopyToAsync(ms, ctx.RequestAborted);
        var raw = ms.ToArray();

        var enc = ctx.Request.Headers.ContentEncoding.ToString().ToLowerInvariant();
        if (raw.Length == 0 || string.IsNullOrEmpty(enc) || enc == "identity")
            return raw;
        rec["contentEncoding"] = enc;
        rec["bodyBytesOnWire"] = raw.Length;
        try
        {
            using var input = new MemoryStream(raw);
            using Stream? dec = enc switch
            {
                "gzip" => new GZipStream(input, CompressionMode.Decompress),
                "deflate" => new ZLibStream(input, CompressionMode.Decompress),
                "br" => new BrotliStream(input, CompressionMode.Decompress),
                _ => null,
            };
            if (dec is null)
            {
                rec["bodyDecodeError"] =
                    $"unsupported content-encoding '{enc}', body stored as base64";
                return raw;
            }
            using var outMs = new MemoryStream();
            await dec.CopyToAsync(outMs, ctx.RequestAborted);
            return outMs.ToArray();
        }
        catch (InvalidDataException ex)
        {
            rec["bodyDecodeError"] = ex.Message;
            return raw;
        }
    }

    private static string? DecodeText(byte[] raw, JsonObject rec)
    {
        if (raw.Length == 0)
            return null;
        try
        {
            return new UTF8Encoding(false, throwOnInvalidBytes: true).GetString(raw);
        }
        catch (DecoderFallbackException)
        {
            rec["bodyEncoding"] = "base64";
            return Convert.ToBase64String(raw);
        }
    }

    private void DuplicateInfo(byte[] raw, long seq, JsonObject rec)
    {
        var hash = Convert.ToHexString(SHA256.HashData(raw))[..16].ToLowerInvariant();
        rec["bodyHash"] = hash;
        var seen = _lastSeqByBody.TryGetValue(hash, out var previous);
        _lastSeqByBody[hash] = seq;
        if (seen)
            rec["duplicateOfSeq"] = previous;
    }

    private static double? Round(double? v) => v is null ? null : Math.Round(v.Value, 1);
}
