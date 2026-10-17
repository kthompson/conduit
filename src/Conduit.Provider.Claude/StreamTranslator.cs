using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Conduit.Provider.Core;

namespace Conduit.Provider.Claude;

/// <summary>What one run produced: the events to send, why they are not trustworthy (if they are not), and the raw reply for a retry.</summary>
public sealed record TranslatedTurn(IReadOnlyList<CompletionEvent> Events, string? Problem, string RawReply, int PromptTokens, int CompletionTokens);

/// <summary>
/// Reads <c>claude --output-format stream-json --include-partial-messages</c> lines and produces the internal item stream.
/// Text is streamed live, except that tool-call blocks are held back, parsed (see <see cref="ToolCallParser"/>), and returned as
/// tool calls at the end. <see cref="Complete"/> reports a <c>Problem</c> when the calls cannot be run as written, so the driver
/// can ask the model once more before anything is sent.
/// </summary>
public sealed partial class StreamTranslator(IReadOnlyList<ToolSpec> tools, bool bufferText = false)
{
    private readonly bool _parse = tools.Count > 0;
    private readonly StringBuilder _buf = new();
    private readonly StringBuilder _raw = new();
    private readonly List<ToolCall> _calls = [];
    private readonly List<string> _held = [];
    private readonly List<string> _unreadable = [];
    private bool _inTool;
    private bool _unparsedBlock;
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

    /// <summary>Feed one stdout line. Returns the text and reasoning to send right now.</summary>
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
                        if (!bufferText && delta["thinking"]?.GetValue<string>() is { Length: > 0 } th) yield return new ReasoningDelta(th);
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
        _raw.Append(chunk);
        if (!_parse)
        {
            foreach (var e in Emit(chunk)) yield return e;
            yield break;
        }

        _buf.Append(chunk);
        while (!Stopped)
        {
            var s = _buf.ToString();
            if (!_inTool)
            {
                var open = OpenTag(s);
                if (open is not null)
                {
                    foreach (var e in Emit(s[..open.Index])) yield return e;
                    _buf.Clear().Append(s[open.Index..]);
                    _inTool = true;
                    continue;
                }
                // Hold back a tail that could be the start of a tag split across chunks.
                var keep = PartialTagLength(s);
                if (s.Length > keep) foreach (var e in Emit(s[..^keep])) yield return e;
                if (!Stopped) _buf.Clear().Append(s[^keep..]);
                yield break;
            }

            var end = BlockEnd(s);
            if (end < 0) yield break;
            _buf.Clear().Append(s[end..]);
            _inTool = false;
            foreach (var e in Block(s[..end])) yield return e;
        }
    }

    private static Match? OpenTag(string s)
    {
        foreach (Match m in ToolCallParser.Tag.Matches(s))
            if (m.Groups[1].Length == 0 && !m.Value.EndsWith("/>")) return m;
        return null;
    }

    /// <summary>The index just past the close tag that balances the block's first open tag, or -1 while it is still open.</summary>
    private static int BlockEnd(string s)
    {
        var depth = 0;
        foreach (Match m in ToolCallParser.Tag.Matches(s))
        {
            if (m.Value.EndsWith("/>")) continue;
            depth += m.Groups[1].Length == 0 ? 1 : -1;
            if (depth <= 0) return m.Index + m.Length;
        }
        return -1;
    }

    private static int PartialTagLength(string s)
    {
        var i = s.LastIndexOf('<');
        if (i < 0) return 0;
        var tail = s[i..];
        return tail.Length <= 64 && !tail.Contains('>') && PartialTag().IsMatch(tail) ? tail.Length : 0;
    }

    [GeneratedRegex(@"^</?[A-Za-z_]*(\s[^>]*)?$")]
    private static partial Regex PartialTag();

    private IEnumerable<CompletionEvent> Block(string block)
    {
        var found = ToolCallParser.Parse(block, tools);
        if (found.Count > 0)
        {
            _calls.AddRange(found);
            yield break;
        }
        // A tag with nothing runnable inside. Remember it was a failed attempt. It is not streamed now, because a retry may fix it;
        // if no attempt does, <see cref="Complete"/> returns it as text so it is shown once rather than lost.
        _unparsedBlock = true;
        if (_calls.Count == 0) _unreadable.Add(block);
        else foreach (var e in Emit(block)) yield return e;
    }

    /// <summary>Text goes out live, is held for a retry attempt, or (after a tool call) is dropped and ends the turn.</summary>
    private IEnumerable<CompletionEvent> Emit(string text)
    {
        if (text.Length == 0) yield break;
        if (_calls.Count > 0)
        {
            if (text.Trim().Length > 0) { Stopped = true; _buf.Clear(); }
            yield break;
        }
        if (bufferText) _held.Add(text);
        else yield return new TextDelta(text);
    }

    /// <summary>Call once the process output ends. Throws for failures the caller should see; otherwise returns the turn and any problem.</summary>
    public TranslatedTurn Complete()
    {
        if (_error is not null || _limited)
        {
            var msg = _error ?? "Claude usage limit reached.";
            if (_limited || LooksLikeLimit(msg)) throw new ProviderFailure(FailureKind.UsageLimit, msg, _retryAfter);
            if (LooksLikeAuth(msg)) throw new ProviderFailure(FailureKind.Unavailable, msg);
            throw new ProviderFailure(FailureKind.Failed, msg);
        }

        var events = new List<CompletionEvent>();
        if (_buf.Length > 0 && !Stopped)
        {
            // An unterminated block (the closing tag never came) or a held-back "<tool" that never completed.
            var rest = _buf.ToString();
            _buf.Clear();
            if (_inTool)
            {
                _inTool = false;
                events.AddRange(Block(rest));
            }
            else events.AddRange(Emit(rest));
        }

        var problem = Validate();
        if (_calls.Count == 0) events.AddRange(_held.Select(h => (CompletionEvent)new TextDelta(h)));
        if (_calls.Count == 0) events.AddRange(_unreadable.Select(h => (CompletionEvent)new TextDelta(h)));
        events.AddRange(_calls.Select(c => new ToolCallEvent(c)));
        events.Add(new UsageEvent(_inputTokens, _outputTokens));
        events.Add(new Finish(_calls.Count > 0 ? FinishReason.ToolCalls : _truncated ? FinishReason.Length : FinishReason.Stop));
        return new TranslatedTurn(events, problem, _raw.ToString(), _inputTokens, _outputTokens);
    }

    private string? Validate()
    {
        if (!_parse) return null;
        foreach (var c in _calls)
            if (ToolCallParser.Validate(c, tools) is { } why) return why;
        if (_calls.Count == 0 && _unparsedBlock) return "the tool call block could not be read as JSON with a tool name and arguments";
        return null;
    }

    private static bool LooksLikeLimit(string m) =>
        m.Contains("limit", StringComparison.OrdinalIgnoreCase) && (m.Contains("usage", StringComparison.OrdinalIgnoreCase) || m.Contains("reached", StringComparison.OrdinalIgnoreCase));

    private static bool LooksLikeAuth(string m) =>
        m.Contains("not logged in", StringComparison.OrdinalIgnoreCase) || m.Contains("/login", StringComparison.Ordinal) || m.Contains("authentication", StringComparison.OrdinalIgnoreCase);
}
