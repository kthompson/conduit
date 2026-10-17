using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Conduit.Provider.Core;

namespace Conduit.OpenAi;

public sealed record ChatCompletionsCall(
    CompletionRequest Request,
    bool Stream,
    bool IncludeUsage,
    IReadOnlyList<string> Ignored
);

/// <summary>Parses a Chat Completions request body into the internal <see cref="CompletionRequest"/>.</summary>
public static class ChatCompletionsRequest
{
    // Accepted and ignored, reported back in X-Ignored-Params. Ignoring them does not change what the request means.
    private static readonly string[] IgnorableParams =
    [
        "temperature",
        "top_p",
        "presence_penalty",
        "frequency_penalty",
        "seed",
        "stop",
        "logit_bias",
        "user",
        "metadata",
        "store",
        "parallel_tool_calls",
        "service_tier",
        "prediction",
        "modalities",
        "audio",
        "web_search_options",
    ];

    public static ChatCompletionsCall Parse(JsonNode? body)
    {
        if (body is not JsonObject o)
            throw OpenAiError.BadRequest("The request body must be a JSON object.");

        var model = o["model"]?.GetValue<string>();
        if (string.IsNullOrWhiteSpace(model))
            throw OpenAiError.BadRequest("'model' is required.", "missing_model");

        if (o["n"] is { } n && n.GetValue<int>() != 1)
            throw OpenAiError.BadRequest("Only n=1 is supported.", "unsupported_n");
        if (
            o["logprobs"] is JsonValue lp
            && lp.TryGetValue<bool>(out var wantsLogprobs)
            && wantsLogprobs
        )
            throw OpenAiError.BadRequest("logprobs are not supported.", "unsupported_logprobs");
        if (
            o["response_format"] is JsonObject rf
            && rf["type"]?.GetValue<string>() is "json_schema" or "json_object"
        )
            throw OpenAiError.BadRequest(
                "response_format is not supported yet.",
                "unsupported_response_format"
            );

        if (o["messages"] is not JsonArray rawMessages || rawMessages.Count == 0)
            throw OpenAiError.BadRequest(
                "'messages' must be a non-empty array.",
                "missing_messages"
            );

        var messages = new List<ChatMessage>(rawMessages.Count);
        foreach (var m in rawMessages)
            messages.Add(ParseMessage(m));

        var tools = new List<ToolSpec>();
        if (o["tools"] is JsonArray rawTools)
            foreach (var t in rawTools)
            {
                if (
                    t?["type"]?.GetValue<string>() != "function"
                    || t["function"] is not JsonObject f
                )
                    throw OpenAiError.BadRequest(
                        "Only function tools are supported.",
                        "unsupported_tool"
                    );
                tools.Add(
                    new ToolSpec(
                        f["name"]?.GetValue<string>()
                            ?? throw OpenAiError.BadRequest("A tool is missing its function name."),
                        f["description"]?.GetValue<string>(),
                        f["parameters"]?.ToJsonString()
                    )
                );
            }

        var stream = o["stream"]?.GetValue<bool>() ?? false;
        var includeUsage = o["stream_options"]?["include_usage"]?.GetValue<bool>() ?? false;
        var maxTokens = (o["max_completion_tokens"] ?? o["max_tokens"])?.GetValue<int>();
        var ignored = IgnorableParams.Where(p => o[p] is not null).ToList();

        var request = new CompletionRequest(
            model,
            messages,
            tools,
            ParseToolChoice(o["tool_choice"]),
            maxTokens,
            o["reasoning_effort"]?.GetValue<string>()
        );
        return new ChatCompletionsCall(request, stream, includeUsage, ignored);
    }

    private static string? ParseToolChoice(JsonNode? n) =>
        n switch
        {
            null => null,
            JsonValue v => v.GetValue<string>(),
            JsonObject o => o["function"]?["name"]?.GetValue<string>() is { } name
                ? "fn:" + name
                : null,
            _ => null,
        };

    private static ChatMessage ParseMessage(JsonNode? node)
    {
        if (node is not JsonObject m)
            throw OpenAiError.BadRequest("Every message must be an object.");
        var role =
            m["role"]?.GetValue<string>()
            ?? throw OpenAiError.BadRequest("A message is missing its role.");
        if (role is not ("system" or "developer" or "user" or "assistant" or "tool"))
            throw OpenAiError.BadRequest($"Unsupported message role '{role}'.", "unsupported_role");
        if (role == "developer")
            role = "system";

        var text = Flatten(m["content"]);
        List<ToolCall>? calls = null;
        if (m["tool_calls"] is JsonArray rawCalls)
        {
            calls = [];
            foreach (var c in rawCalls)
                calls.Add(
                    new ToolCall(
                        c?["id"]?.GetValue<string>()
                            ?? throw OpenAiError.BadRequest("A tool call is missing its id."),
                        c["function"]?["name"]?.GetValue<string>()
                            ?? throw OpenAiError.BadRequest("A tool call is missing its name."),
                        c["function"]?["arguments"]?.GetValue<string>() ?? "{}"
                    )
                );
        }

        var toolCallId = m["tool_call_id"]?.GetValue<string>();
        if (role == "tool" && toolCallId is null)
            throw OpenAiError.BadRequest("A tool message needs tool_call_id.");
        return new ChatMessage(role, text, calls, toolCallId);
    }

    /// <summary>Content is a string or an array of parts. Text parts are joined; anything else is refused until images land (phase 7).</summary>
    private static string? Flatten(JsonNode? content)
    {
        switch (content)
        {
            case null:
                return null;
            case JsonValue v:
                return v.GetValue<string>();
            case JsonArray parts:
                var sb = new StringBuilder();
                foreach (var p in parts)
                {
                    var type = p?["type"]?.GetValue<string>();
                    if (type is "text" or "input_text")
                        sb.Append(p!["text"]?.GetValue<string>());
                    else
                        throw OpenAiError.BadRequest(
                            $"Content part type '{type}' is not supported yet.",
                            "unsupported_content"
                        );
                }
                return sb.ToString();
            default:
                throw OpenAiError.BadRequest("Unsupported message content.");
        }
    }
}
