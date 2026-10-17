using System.Text;
using System.Text.Json.Nodes;

namespace Conduit.Capture.Wire;

/// <summary>OpenAI Responses API: typed SSE events and the non-streaming <c>response</c> object.</summary>
public sealed class ResponsesRenderer(RenderContext c) : IWireRenderer
{
    private enum Kind { None, Message, ReasoningSummary, ReasoningText, FunctionCall }

    private readonly JsonArray _output = new();
    private readonly StringBuilder _buf = new();
    private Kind _open = Kind.None;
    private int _seq;
    private int _outIndex = -1;
    private int _chars;
    private string _itemId = "", _callId = "", _name = "";

    public bool Finished { get; private set; }
    public JsonObject? Final { get; private set; }

    private SseFrame Ev(string type, Action<JsonObject> fill)
    {
        var o = new JsonObject { ["type"] = type, ["sequence_number"] = _seq++ };
        fill(o);
        return new SseFrame(type, WireJson.S(o));
    }

    private JsonObject Usage() => new()
    {
        ["input_tokens"] = c.PromptTokens,
        ["input_tokens_details"] = new JsonObject { ["cached_tokens"] = 0 },
        ["output_tokens"] = WireJson.EstimateTokens(_chars),
        ["output_tokens_details"] = new JsonObject { ["reasoning_tokens"] = 0 },
        ["total_tokens"] = c.PromptTokens + WireJson.EstimateTokens(_chars),
    };

    private JsonObject Resp(string status, JsonArray output, bool usage) => new()
    {
        ["id"] = c.Id,
        ["object"] = "response",
        ["created_at"] = c.Created,
        ["status"] = status,
        ["model"] = c.Model,
        ["output"] = output,
        ["parallel_tool_calls"] = true,
        ["tool_choice"] = "auto",
        ["tools"] = new JsonArray(),
        ["store"] = false,
        ["error"] = null,
        ["incomplete_details"] = null,
        ["usage"] = usage ? Usage() : null,
    };

    public IEnumerable<SseFrame> Begin()
    {
        yield return Ev("response.created", o => o["response"] = Resp("in_progress", new JsonArray(), false));
        yield return Ev("response.in_progress", o => o["response"] = Resp("in_progress", new JsonArray(), false));
    }

    private IEnumerable<SseFrame> OpenItem(Kind kind)
    {
        _outIndex++;
        _open = kind;
        _buf.Clear();
        var idx = _outIndex;
        switch (kind)
        {
            case Kind.Message:
                _itemId = WireJson.NewId("msg_");
                var mid = _itemId;
                yield return Ev("response.output_item.added", o =>
                {
                    o["output_index"] = idx;
                    o["item"] = new JsonObject
                    {
                        ["id"] = mid, ["type"] = "message", ["status"] = "in_progress", ["role"] = "assistant",
                        ["content"] = new JsonArray(),
                    };
                });
                yield return Ev("response.content_part.added", o =>
                {
                    o["item_id"] = mid; o["output_index"] = idx; o["content_index"] = 0;
                    o["part"] = new JsonObject { ["type"] = "output_text", ["text"] = "", ["annotations"] = new JsonArray() };
                });
                break;

            case Kind.ReasoningSummary:
            case Kind.ReasoningText:
                _itemId = WireJson.NewId("rs_");
                var rid = _itemId;
                yield return Ev("response.output_item.added", o =>
                {
                    o["output_index"] = idx;
                    o["item"] = new JsonObject { ["id"] = rid, ["type"] = "reasoning", ["summary"] = new JsonArray() };
                });
                if (kind == Kind.ReasoningSummary)
                    yield return Ev("response.reasoning_summary_part.added", o =>
                    {
                        o["item_id"] = rid; o["output_index"] = idx; o["summary_index"] = 0;
                        o["part"] = new JsonObject { ["type"] = "summary_text", ["text"] = "" };
                    });
                break;

            case Kind.FunctionCall:
                _itemId = WireJson.NewId("fc_");
                var fid = _itemId; var call = _callId; var name = _name;
                yield return Ev("response.output_item.added", o =>
                {
                    o["output_index"] = idx;
                    o["item"] = new JsonObject
                    {
                        ["id"] = fid, ["type"] = "function_call", ["status"] = "in_progress",
                        ["call_id"] = call, ["name"] = name, ["arguments"] = "",
                    };
                });
                break;
        }
    }

    private IEnumerable<SseFrame> CloseOpen()
    {
        if (_open == Kind.None) yield break;
        var idx = _outIndex; var id = _itemId; var text = _buf.ToString();
        JsonObject item;
        switch (_open)
        {
            case Kind.Message:
                yield return Ev("response.output_text.done", o =>
                {
                    o["item_id"] = id; o["output_index"] = idx; o["content_index"] = 0; o["text"] = text;
                });
                yield return Ev("response.content_part.done", o =>
                {
                    o["item_id"] = id; o["output_index"] = idx; o["content_index"] = 0;
                    o["part"] = new JsonObject { ["type"] = "output_text", ["text"] = text, ["annotations"] = new JsonArray() };
                });
                item = new JsonObject
                {
                    ["id"] = id, ["type"] = "message", ["status"] = "completed", ["role"] = "assistant",
                    ["content"] = new JsonArray(new JsonObject
                    {
                        ["type"] = "output_text", ["text"] = text, ["annotations"] = new JsonArray(),
                    }),
                };
                break;

            case Kind.ReasoningSummary:
                yield return Ev("response.reasoning_summary_text.done", o =>
                {
                    o["item_id"] = id; o["output_index"] = idx; o["summary_index"] = 0; o["text"] = text;
                });
                yield return Ev("response.reasoning_summary_part.done", o =>
                {
                    o["item_id"] = id; o["output_index"] = idx; o["summary_index"] = 0;
                    o["part"] = new JsonObject { ["type"] = "summary_text", ["text"] = text };
                });
                item = new JsonObject
                {
                    ["id"] = id, ["type"] = "reasoning",
                    ["summary"] = new JsonArray(new JsonObject { ["type"] = "summary_text", ["text"] = text }),
                };
                break;

            case Kind.ReasoningText:
                yield return Ev("response.reasoning_text.done", o =>
                {
                    o["item_id"] = id; o["output_index"] = idx; o["content_index"] = 0; o["text"] = text;
                });
                item = new JsonObject
                {
                    ["id"] = id, ["type"] = "reasoning", ["summary"] = new JsonArray(),
                    ["content"] = new JsonArray(new JsonObject { ["type"] = "reasoning_text", ["text"] = text }),
                };
                break;

            default: // FunctionCall
                var call = _callId; var name = _name;
                yield return Ev("response.function_call_arguments.done", o =>
                {
                    o["item_id"] = id; o["output_index"] = idx; o["name"] = name; o["arguments"] = text;
                });
                item = new JsonObject
                {
                    ["id"] = id, ["type"] = "function_call", ["status"] = "completed",
                    ["call_id"] = call, ["name"] = name, ["arguments"] = text,
                };
                break;
        }

        _output.Add(item.DeepClone());
        yield return Ev("response.output_item.done", o => { o["output_index"] = idx; o["item"] = item; });
        _open = Kind.None;
        _buf.Clear();
    }

    public IEnumerable<SseFrame> Render(ScriptEvent ev)
    {
        switch (ev)
        {
            case TextDelta t:
                if (_open != Kind.Message)
                {
                    foreach (var f in CloseOpen()) yield return f;
                    foreach (var f in OpenItem(Kind.Message)) yield return f;
                }
                _buf.Append(t.Text); _chars += t.Text.Length;
                {
                    var id = _itemId; var idx = _outIndex;
                    yield return Ev("response.output_text.delta", o =>
                    {
                        o["item_id"] = id; o["output_index"] = idx; o["content_index"] = 0;
                        o["delta"] = t.Text; o["logprobs"] = new JsonArray();
                    });
                }
                break;

            case ReasoningDelta d when d.Shape is ReasoningShape.ResponsesSummary or ReasoningShape.ResponsesText:
                var want = d.Shape == ReasoningShape.ResponsesSummary ? Kind.ReasoningSummary : Kind.ReasoningText;
                if (_open != want)
                {
                    foreach (var f in CloseOpen()) yield return f;
                    foreach (var f in OpenItem(want)) yield return f;
                }
                _buf.Append(d.Text); _chars += d.Text.Length;
                {
                    var id = _itemId; var idx = _outIndex;
                    var type = want == Kind.ReasoningSummary ? "response.reasoning_summary_text.delta" : "response.reasoning_text.delta";
                    yield return Ev(type, o =>
                    {
                        o["item_id"] = id; o["output_index"] = idx;
                        if (want == Kind.ReasoningSummary) o["summary_index"] = 0; else o["content_index"] = 0;
                        o["delta"] = d.Text;
                    });
                }
                break;

            case ToolCallEvent tc:
                foreach (var f in CloseOpen()) yield return f;
                _callId = tc.Id; _name = tc.Name;
                foreach (var f in OpenItem(Kind.FunctionCall)) yield return f;
                _buf.Append(tc.ArgumentsJson); _chars += tc.ArgumentsJson.Length;
                {
                    var id = _itemId; var idx = _outIndex;
                    yield return Ev("response.function_call_arguments.delta", o =>
                    {
                        o["item_id"] = id; o["output_index"] = idx; o["delta"] = tc.ArgumentsJson;
                    });
                }
                foreach (var f in CloseOpen()) yield return f;
                break;

            case Finish:
                foreach (var f in CloseOpen()) yield return f;
                Finished = true;
                var completed = Resp("completed", _output, true);
                Final = (JsonObject)completed.DeepClone();
                yield return Ev("response.completed", o => o["response"] = completed);
                break;

            case StreamError e:
                yield return Ev("error", o =>
                {
                    o["code"] = "capture_midstream_error"; o["message"] = e.Message; o["param"] = null;
                });
                break;
        }
    }

    public JsonObject ErrorBody(string type, string code, string message) => new()
    {
        ["error"] = new JsonObject { ["message"] = message, ["type"] = type, ["param"] = null, ["code"] = code },
    };
}
