using System.Text;
using System.Text.Json.Nodes;

namespace Conduit.Capture.Wire;

/// <summary>OpenAI Chat Completions: <c>chat.completion.chunk</c> SSE and the non-streaming <c>chat.completion</c> object.</summary>
public sealed class ChatRenderer(RenderContext c) : IWireRenderer
{
    private readonly StringBuilder _text = new(), _reasoningContent = new(), _reasoning = new(), _details = new();
    private readonly List<(string Id, string Name, string Args)> _tools = [];
    private int _chars;

    public bool Finished { get; private set; }
    public JsonObject? Final { get; private set; }

    private JsonObject Chunk(JsonObject delta, string? finish = null) => new()
    {
        ["id"] = c.Id,
        ["object"] = "chat.completion.chunk",
        ["created"] = c.Created,
        ["model"] = c.Model,
        ["choices"] = new JsonArray(new JsonObject { ["index"] = 0, ["delta"] = delta, ["finish_reason"] = finish }),
    };

    private static SseFrame F(JsonNode n) => new(null, WireJson.S(n));

    private JsonObject Usage() => new()
    {
        ["prompt_tokens"] = c.PromptTokens,
        ["completion_tokens"] = WireJson.EstimateTokens(_chars),
        ["total_tokens"] = c.PromptTokens + WireJson.EstimateTokens(_chars),
    };

    public IEnumerable<SseFrame> Begin()
    {
        yield return F(Chunk(new JsonObject { ["role"] = "assistant", ["content"] = "" }));
    }

    public IEnumerable<SseFrame> Render(ScriptEvent ev)
    {
        switch (ev)
        {
            case TextDelta t:
                _text.Append(t.Text);
                _chars += t.Text.Length;
                yield return F(Chunk(new JsonObject { ["content"] = t.Text }));
                break;

            case ReasoningDelta d:
                _chars += d.Text.Length;
                switch (d.Shape)
                {
                    case ReasoningShape.ChatReasoningContent:
                        _reasoningContent.Append(d.Text);
                        yield return F(Chunk(new JsonObject { ["reasoning_content"] = d.Text }));
                        break;
                    case ReasoningShape.ChatReasoning:
                        _reasoning.Append(d.Text);
                        yield return F(Chunk(new JsonObject { ["reasoning"] = d.Text }));
                        break;
                    case ReasoningShape.ChatReasoningDetails:
                        _details.Append(d.Text);
                        yield return F(Chunk(new JsonObject
                        {
                            ["reasoning_details"] = new JsonArray(new JsonObject
                            {
                                ["type"] = "reasoning.text", ["text"] = d.Text, ["index"] = 0, ["format"] = "unknown",
                            }),
                        }));
                        break;
                }
                break;

            case ToolCallEvent tc:
                var index = _tools.Count;
                _tools.Add((tc.Id, tc.Name, tc.ArgumentsJson));
                _chars += tc.ArgumentsJson.Length;
                yield return F(Chunk(new JsonObject
                {
                    ["tool_calls"] = new JsonArray(new JsonObject
                    {
                        ["index"] = index, ["id"] = tc.Id, ["type"] = "function",
                        ["function"] = new JsonObject { ["name"] = tc.Name, ["arguments"] = "" },
                    }),
                }));
                yield return F(Chunk(new JsonObject
                {
                    ["tool_calls"] = new JsonArray(new JsonObject
                    {
                        ["index"] = index,
                        ["function"] = new JsonObject { ["arguments"] = tc.ArgumentsJson },
                    }),
                }));
                break;

            case Finish f:
                Finished = true;
                Final = BuildFinal(f.Reason);
                yield return F(Chunk(new JsonObject(), f.Reason));
                if (c.IncludeUsage)
                {
                    yield return F(new JsonObject
                    {
                        ["id"] = c.Id, ["object"] = "chat.completion.chunk", ["created"] = c.Created, ["model"] = c.Model,
                        ["choices"] = new JsonArray(), ["usage"] = Usage(),
                    });
                }
                yield return new SseFrame(null, "[DONE]");
                break;

            case StreamError e:
                yield return F(new JsonObject
                {
                    ["error"] = new JsonObject
                    {
                        ["message"] = e.Message, ["type"] = "server_error", ["param"] = null, ["code"] = "capture_midstream_error",
                    },
                });
                break;
        }
    }

    private JsonObject BuildFinal(string reason)
    {
        var message = new JsonObject { ["role"] = "assistant" };
        message["content"] = _text.Length == 0 && _tools.Count > 0 ? null : _text.ToString();
        if (_reasoningContent.Length > 0) message["reasoning_content"] = _reasoningContent.ToString();
        if (_reasoning.Length > 0) message["reasoning"] = _reasoning.ToString();
        if (_details.Length > 0)
            message["reasoning_details"] = new JsonArray(new JsonObject
            {
                ["type"] = "reasoning.text", ["text"] = _details.ToString(), ["index"] = 0, ["format"] = "unknown",
            });
        if (_tools.Count > 0)
        {
            var calls = new JsonArray();
            foreach (var (id, name, args) in _tools)
                calls.Add(new JsonObject
                {
                    ["id"] = id, ["type"] = "function",
                    ["function"] = new JsonObject { ["name"] = name, ["arguments"] = args },
                });
            message["tool_calls"] = calls;
        }

        return new JsonObject
        {
            ["id"] = c.Id,
            ["object"] = "chat.completion",
            ["created"] = c.Created,
            ["model"] = c.Model,
            ["choices"] = new JsonArray(new JsonObject { ["index"] = 0, ["message"] = message, ["finish_reason"] = reason }),
            ["usage"] = Usage(),
        };
    }

    public JsonObject ErrorBody(string type, string code, string message) => new()
    {
        ["error"] = new JsonObject { ["message"] = message, ["type"] = type, ["param"] = null, ["code"] = code },
    };
}
