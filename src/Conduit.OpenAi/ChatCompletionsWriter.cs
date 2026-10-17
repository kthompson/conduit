using System.Text;
using System.Text.Json.Nodes;
using Conduit.Provider.Core;

namespace Conduit.OpenAi;

/// <summary>One server-sent event: the <c>data:</c> payload, or null for a comment frame.</summary>
public readonly record struct SseFrame(string? Data, string? Comment = null)
{
    public static SseFrame KeepAlive => new(null, "keep-alive");
    public static SseFrame Done => new("[DONE]");
}

/// <summary>Serializes the internal item stream as Chat Completions chunks, or as one <c>chat.completion</c> object.</summary>
public sealed class ChatCompletionsWriter(string model, bool includeUsage, int promptTokensEstimate = 0)
{
    private readonly string _id = "chatcmpl-" + Guid.NewGuid().ToString("N");
    private readonly long _created = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
    private readonly StringBuilder _text = new(), _reasoning = new();
    private readonly List<ToolCall> _tools = [];
    private int _outChars;
    private UsageEvent? _usage;

    public bool Finished { get; private set; }
    public JsonObject? Final { get; private set; }

    private JsonObject Chunk(JsonObject delta, string? finish = null) => new()
    {
        ["id"] = _id,
        ["object"] = "chat.completion.chunk",
        ["created"] = _created,
        ["model"] = model,
        ["choices"] = new JsonArray(new JsonObject { ["index"] = 0, ["delta"] = delta, ["finish_reason"] = finish }),
    };

    private static SseFrame F(JsonNode n) => new(n.ToJsonString());

    private JsonObject Usage() => _usage is { } u
        ? new() { ["prompt_tokens"] = u.PromptTokens, ["completion_tokens"] = u.CompletionTokens, ["total_tokens"] = u.PromptTokens + u.CompletionTokens }
        : new()
        {
            ["prompt_tokens"] = promptTokensEstimate,
            ["completion_tokens"] = EstimateTokens(_outChars),
            ["total_tokens"] = promptTokensEstimate + EstimateTokens(_outChars),
        };

    public static int EstimateTokens(int chars) => (chars + 3) / 4;

    /// <summary>The opening chunk. Sent first so a client sees headers and a role immediately.</summary>
    public IEnumerable<SseFrame> Begin()
    {
        yield return F(Chunk(new JsonObject { ["role"] = "assistant", ["content"] = "" }));
    }

    public IEnumerable<SseFrame> Render(CompletionEvent ev)
    {
        switch (ev)
        {
            case TextDelta t:
                _text.Append(t.Text);
                _outChars += t.Text.Length;
                yield return F(Chunk(new JsonObject { ["content"] = t.Text }));
                break;

            // Non-standard but the shape the Copilot app displayed in the capture ("Thought for ..." panel).
            case ReasoningDelta r:
                _reasoning.Append(r.Text);
                _outChars += r.Text.Length;
                yield return F(Chunk(new JsonObject { ["reasoning_content"] = r.Text }));
                break;

            case ToolCallEvent tc:
                var index = _tools.Count;
                _tools.Add(tc.Call);
                _outChars += tc.Call.ArgumentsJson.Length;
                yield return F(Chunk(new JsonObject
                {
                    ["tool_calls"] = new JsonArray(new JsonObject
                    {
                        ["index"] = index, ["id"] = tc.Call.Id, ["type"] = "function",
                        ["function"] = new JsonObject { ["name"] = tc.Call.Name, ["arguments"] = "" },
                    }),
                }));
                yield return F(Chunk(new JsonObject
                {
                    ["tool_calls"] = new JsonArray(new JsonObject
                    {
                        ["index"] = index, ["function"] = new JsonObject { ["arguments"] = tc.Call.ArgumentsJson },
                    }),
                }));
                break;

            case UsageEvent u:
                _usage = u;
                break;

            case Finish f:
                Finished = true;
                var reason = Reason(f.Reason);
                Final = BuildFinal(reason);
                yield return F(Chunk(new JsonObject(), reason));
                if (includeUsage)
                    yield return F(new JsonObject
                    {
                        ["id"] = _id, ["object"] = "chat.completion.chunk", ["created"] = _created, ["model"] = model,
                        ["choices"] = new JsonArray(), ["usage"] = Usage(),
                    });
                yield return SseFrame.Done;
                break;
        }
    }

    private static string Reason(FinishReason r) => r switch
    {
        FinishReason.Length => "length",
        FinishReason.ToolCalls => "tool_calls",
        _ => "stop",
    };

    private JsonObject BuildFinal(string reason)
    {
        var message = new JsonObject { ["role"] = "assistant", ["content"] = _text.Length == 0 && _tools.Count > 0 ? null : _text.ToString() };
        if (_reasoning.Length > 0) message["reasoning_content"] = _reasoning.ToString();
        if (_tools.Count > 0)
        {
            var calls = new JsonArray();
            foreach (var c in _tools)
                calls.Add(new JsonObject
                {
                    ["id"] = c.Id, ["type"] = "function",
                    ["function"] = new JsonObject { ["name"] = c.Name, ["arguments"] = c.ArgumentsJson },
                });
            message["tool_calls"] = calls;
        }

        return new JsonObject
        {
            ["id"] = _id,
            ["object"] = "chat.completion",
            ["created"] = _created,
            ["model"] = model,
            ["choices"] = new JsonArray(new JsonObject { ["index"] = 0, ["message"] = message, ["finish_reason"] = reason }),
            ["usage"] = Usage(),
        };
    }
}
