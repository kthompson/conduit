using System.Text;
using System.Text.Json.Nodes;

namespace Conduit.Capture.Wire;

/// <summary>Anthropic-style <c>/v1/messages</c>: named SSE events and the non-streaming <c>message</c> object.</summary>
public sealed class MessagesRenderer(RenderContext c) : IWireRenderer
{
    private enum Kind
    {
        None,
        Text,
        Thinking,
    }

    private const string Signature = "capture-signature";

    private readonly JsonArray _content = new();
    private readonly StringBuilder _buf = new();
    private Kind _open = Kind.None;
    private int _index = -1;
    private int _chars;
    private bool _usedTool;

    public bool Finished { get; private set; }
    public JsonObject? Final { get; private set; }

    private static SseFrame Ev(string type, Action<JsonObject> fill)
    {
        var o = new JsonObject { ["type"] = type };
        fill(o);
        return new SseFrame(type, WireJson.S(o));
    }

    public IEnumerable<SseFrame> Begin()
    {
        yield return Ev(
            "message_start",
            o =>
                o["message"] = new JsonObject
                {
                    ["id"] = c.Id,
                    ["type"] = "message",
                    ["role"] = "assistant",
                    ["model"] = c.Model,
                    ["content"] = new JsonArray(),
                    ["stop_reason"] = null,
                    ["stop_sequence"] = null,
                    ["usage"] = new JsonObject
                    {
                        ["input_tokens"] = c.PromptTokens,
                        ["output_tokens"] = 1,
                    },
                }
        );
        yield return Ev("ping", _ => { });
    }

    private IEnumerable<SseFrame> CloseOpen()
    {
        if (_open == Kind.None)
            yield break;
        var idx = _index;
        var text = _buf.ToString();
        if (_open == Kind.Thinking)
        {
            yield return Ev(
                "content_block_delta",
                o =>
                {
                    o["index"] = idx;
                    o["delta"] = new JsonObject
                    {
                        ["type"] = "signature_delta",
                        ["signature"] = Signature,
                    };
                }
            );
            _content.Add(
                new JsonObject
                {
                    ["type"] = "thinking",
                    ["thinking"] = text,
                    ["signature"] = Signature,
                }
            );
        }
        else
        {
            _content.Add(new JsonObject { ["type"] = "text", ["text"] = text });
        }
        yield return Ev("content_block_stop", o => o["index"] = idx);
        _open = Kind.None;
        _buf.Clear();
    }

    private IEnumerable<SseFrame> Open(Kind kind)
    {
        _index++;
        _open = kind;
        _buf.Clear();
        var idx = _index;
        yield return Ev(
            "content_block_start",
            o =>
            {
                o["index"] = idx;
                o["content_block"] =
                    kind == Kind.Text
                        ? new JsonObject { ["type"] = "text", ["text"] = "" }
                        : new JsonObject
                        {
                            ["type"] = "thinking",
                            ["thinking"] = "",
                            ["signature"] = "",
                        };
            }
        );
    }

    public IEnumerable<SseFrame> Render(ScriptEvent ev)
    {
        switch (ev)
        {
            case TextDelta t:
                if (_open != Kind.Text)
                {
                    foreach (var f in CloseOpen())
                        yield return f;
                    foreach (var f in Open(Kind.Text))
                        yield return f;
                }
                _buf.Append(t.Text);
                _chars += t.Text.Length;

                {
                    var idx = _index;
                    yield return Ev(
                        "content_block_delta",
                        o =>
                        {
                            o["index"] = idx;
                            o["delta"] = new JsonObject
                            {
                                ["type"] = "text_delta",
                                ["text"] = t.Text,
                            };
                        }
                    );
                }
                break;

            case ReasoningDelta d when d.Shape == ReasoningShape.AnthropicThinking:
                if (_open != Kind.Thinking)
                {
                    foreach (var f in CloseOpen())
                        yield return f;
                    foreach (var f in Open(Kind.Thinking))
                        yield return f;
                }
                _buf.Append(d.Text);
                _chars += d.Text.Length;

                {
                    var idx = _index;
                    yield return Ev(
                        "content_block_delta",
                        o =>
                        {
                            o["index"] = idx;
                            o["delta"] = new JsonObject
                            {
                                ["type"] = "thinking_delta",
                                ["thinking"] = d.Text,
                            };
                        }
                    );
                }
                break;

            case ToolCallEvent tc:
                foreach (var f in CloseOpen())
                    yield return f;
                _index++;
                _usedTool = true;
                _chars += tc.ArgumentsJson.Length;

                {
                    var idx = _index;
                    yield return Ev(
                        "content_block_start",
                        o =>
                        {
                            o["index"] = idx;
                            o["content_block"] = new JsonObject
                            {
                                ["type"] = "tool_use",
                                ["id"] = tc.Id,
                                ["name"] = tc.Name,
                                ["input"] = new JsonObject(),
                            };
                        }
                    );
                    yield return Ev(
                        "content_block_delta",
                        o =>
                        {
                            o["index"] = idx;
                            o["delta"] = new JsonObject
                            {
                                ["type"] = "input_json_delta",
                                ["partial_json"] = tc.ArgumentsJson,
                            };
                        }
                    );
                    yield return Ev("content_block_stop", o => o["index"] = idx);
                }
                _content.Add(
                    new JsonObject
                    {
                        ["type"] = "tool_use",
                        ["id"] = tc.Id,
                        ["name"] = tc.Name,
                        ["input"] = JsonNode.Parse(tc.ArgumentsJson),
                    }
                );
                break;

            case Finish:
                foreach (var f in CloseOpen())
                    yield return f;
                Finished = true;
                var stop = _usedTool ? "tool_use" : "end_turn";
                var outTokens = WireJson.EstimateTokens(_chars);
                Final = new JsonObject
                {
                    ["id"] = c.Id,
                    ["type"] = "message",
                    ["role"] = "assistant",
                    ["model"] = c.Model,
                    ["content"] = _content,
                    ["stop_reason"] = stop,
                    ["stop_sequence"] = null,
                    ["usage"] = new JsonObject
                    {
                        ["input_tokens"] = c.PromptTokens,
                        ["output_tokens"] = outTokens,
                    },
                };
                yield return Ev(
                    "message_delta",
                    o =>
                    {
                        o["delta"] = new JsonObject
                        {
                            ["stop_reason"] = stop,
                            ["stop_sequence"] = null,
                        };
                        o["usage"] = new JsonObject { ["output_tokens"] = outTokens };
                    }
                );
                yield return Ev("message_stop", _ => { });
                break;

            case StreamError e:
                yield return Ev(
                    "error",
                    o =>
                        o["error"] = new JsonObject
                        {
                            ["type"] = "api_error",
                            ["message"] = e.Message,
                        }
                );
                break;
        }
    }

    public JsonObject ErrorBody(string type, string code, string message) =>
        new()
        {
            ["type"] = "error",
            ["error"] = new JsonObject { ["type"] = type, ["message"] = message },
        };
}
