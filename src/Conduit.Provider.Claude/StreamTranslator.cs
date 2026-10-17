using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Conduit.Provider.Core;

namespace Conduit.Provider.Claude;

/// <summary>
/// Reads <c>claude --output-format stream-json --include-partial-messages</c> lines and produces the internal item stream.
/// Text is streamed live, except that <c>&lt;tool_call&gt;</c> blocks are held back, parsed, and emitted as tool calls.
/// </summary>
public sealed class StreamTranslator(bool parseToolCalls)
{
    private readonly StringBuilder _buf = new();
    private readonly StringBuilder _tool = new();
    private readonly List<ToolCall> _calls = [];
    private bool _inTool;
    private int _inputTokens, _outputTokens;
    private bool _truncated;
    private string? _error;
    private TimeSpan? _retryAfter;
    private bool _limited;

    /// <summary>
    /// True once the model kept writing after a tool call. A model that does so is inventing the tool's result, so everything after the
    /// call is dropped and the driver stops the process instead of paying for the rest.
    /// </summary>
    public bool Stopped { get; private set; }

    public IEnumerable<CompletionEvent> Feed(string line)
    {
        if (Stopped) yield break;
        JsonNode? node;
        try { node = JsonNode.Parse(line); }
        catch (JsonException) { yield break; }
        if (node is not JsonObject o) yield break;

        switch (o["type"]?.GetValue<string>())
        {
            case "stream_event":
                foreach (var e in Event(o["event"] as JsonObject)) yield return e;
                break;

            case "rate_limit_event":
                if (o["rate_limit_info"] is JsonObject info && info["status"]?.GetValue<string>() == "rejected")
                {
                    _limited = true;
                    if (info["resetsAt"]?.GetValue<long>() is { } at)
                        _retryAfter = TimeSpan.FromSeconds(Math.Max(1, at - DateTimeOffset.UtcNow.ToUnixTimeSeconds()));
                }
                break;

            case "result":
                if (o["is_error"]?.GetValue<bool>() == true)
                    _error = o["result"]?.GetValue<string>() ?? o["terminal_reason"]?.GetValue<string>() ?? "claude reported an error";
                break;
        }
    }

    private IEnumerable<CompletionEvent> Event(JsonObject? ev)
    {
        switch (ev?["type"]?.GetValue<string>())
        {
            case "content_block_delta":
                var delta = ev["delta"] as JsonObject;
                switch (delta?["type"]?.GetValue<string>())
                {
                    case "text_delta":
                        foreach (var e in Text(delta["text"]?.GetValue<string>() ?? "")) yield return e;
                        break;
                    case "thinking_delta":
                        if (delta["thinking"]?.GetValue<string>() is { Length: > 0 } th) yield return new ReasoningDelta(th);
                        break;
                }
                break;

            case "message_start":
                if (ev["message"]?["usage"] is JsonObject start) _inputTokens = InputTokens(start);
                break;

            case "message_delta":
                if (ev["usage"] is JsonObject u)
                {
                    if (InputTokens(u) is > 0 and var inTok) _inputTokens = inTok;
                    _outputTokens = u["output_tokens"]?.GetValue<int>() ?? _outputTokens;
                }
                if (ev["delta"]?["stop_reason"]?.GetValue<string>() == "max_tokens") _truncated = true;
                break;
        }
    }

    private static int InputTokens(JsonObject u) =>
        (u["input_tokens"]?.GetValue<int>() ?? 0) + (u["cache_creation_input_tokens"]?.GetValue<int>() ?? 0) + (u["cache_read_input_tokens"]?.GetValue<int>() ?? 0);

    private IEnumerable<CompletionEvent> Text(string chunk)
    {
        if (!parseToolCalls)
        {
            if (chunk.Length > 0) yield return new TextDelta(chunk);
            yield break;
        }

        _buf.Append(chunk);
        while (true)
        {
            var s = _buf.ToString();
            if (!_inTool)
            {
                var i = s.IndexOf(PromptBuilder.ToolOpen, StringComparison.Ordinal);
                if (i >= 0)
                {
                    foreach (var e in Emit(s[..i])) yield return e;
                    if (Stopped) yield break;
                    _buf.Clear().Append(s[(i + PromptBuilder.ToolOpen.Length)..]);
                    _inTool = true;
                    continue;
                }
                // Hold back a tail that could be the start of an opening tag split across chunks.
                var keep = PartialSuffix(s, PromptBuilder.ToolOpen);
                if (s.Length > keep) foreach (var e in Emit(s[..^keep])) yield return e;
                if (Stopped) yield break;
                _buf.Clear().Append(s[^keep..]);
                yield break;
            }

            var close = s.IndexOf(PromptBuilder.ToolClose, StringComparison.Ordinal);
            if (close < 0) yield break;
            var body = s[..close];
            _buf.Clear().Append(s[(close + PromptBuilder.ToolClose.Length)..]);
            _inTool = false;
            if (TryParseCall(body) is { } call)
            {
                _calls.Add(call);
                yield return new ToolCallEvent(call);
            }
            else
            {
                // Not valid JSON: show it rather than lose it (or, after a good call, treat it as the model running on).
                foreach (var e in Emit(PromptBuilder.ToolOpen + body + PromptBuilder.ToolClose)) yield return e;
                if (Stopped) yield break;
            }
        }
    }

    private IEnumerable<CompletionEvent> Emit(string text)
    {
        if (_calls.Count == 0) { if (text.Length > 0) yield return new TextDelta(text); yield break; }
        if (text.Trim().Length > 0) { Stopped = true; _buf.Clear(); }
    }

    private static int PartialSuffix(string s, string tag)
    {
        for (var n = Math.Min(tag.Length - 1, s.Length); n > 0; n--)
            if (s.EndsWith(tag[..n], StringComparison.Ordinal)) return n;
        return 0;
    }

    private static ToolCall? TryParseCall(string body)
    {
        try
        {
            if (JsonNode.Parse(body.Trim()) is not JsonObject o || o["name"]?.GetValue<string>() is not { Length: > 0 } name) return null;
            var args = o["arguments"] ?? new JsonObject();
            // Some models double-encode arguments as a JSON string.
            if (args is JsonValue v && v.TryGetValue<string>(out var s) && JsonNode.Parse(s) is JsonObject inner) args = inner;
            return new ToolCall("call_" + Guid.NewGuid().ToString("N")[..24], name, args.ToJsonString());
        }
        catch (Exception e) when (e is JsonException or InvalidOperationException) { return null; }
    }

    /// <summary>Call once the process output ends. Flushes held-back text, then usage and the finish reason, or throws.</summary>
    public IEnumerable<CompletionEvent> Complete()
    {
        if (_error is not null || _limited)
        {
            var msg = _error ?? "Claude usage limit reached.";
            if (_limited || LooksLikeLimit(msg)) throw new ProviderFailure(FailureKind.UsageLimit, msg, _retryAfter);
            if (LooksLikeAuth(msg)) throw new ProviderFailure(FailureKind.Unavailable, msg);
            throw new ProviderFailure(FailureKind.Failed, msg);
        }

        if (_buf.Length > 0)
        {
            // An unterminated tool block, or a held-back "<tool" that never completed: it was only text after all.
            var rest = (_inTool ? PromptBuilder.ToolOpen : "") + _buf;
            _buf.Clear();
            foreach (var e in Emit(rest)) yield return e;
        }

        yield return new UsageEvent(_inputTokens, _outputTokens);
        yield return new Finish(_calls.Count > 0 ? FinishReason.ToolCalls : _truncated ? FinishReason.Length : FinishReason.Stop);
    }

    private static bool LooksLikeLimit(string m) =>
        m.Contains("limit", StringComparison.OrdinalIgnoreCase) && (m.Contains("usage", StringComparison.OrdinalIgnoreCase) || m.Contains("reached", StringComparison.OrdinalIgnoreCase));

    private static bool LooksLikeAuth(string m) =>
        m.Contains("not logged in", StringComparison.OrdinalIgnoreCase) || m.Contains("/login", StringComparison.Ordinal) || m.Contains("authentication", StringComparison.OrdinalIgnoreCase);
}
