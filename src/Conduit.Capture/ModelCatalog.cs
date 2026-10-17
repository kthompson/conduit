using System.Text.Json.Nodes;

namespace Conduit.Capture;

/// <summary>
/// The fake model list. Each object carries the capability/limit fields in every common shape (OpenAI, OpenRouter,
/// vLLM, Copilot-style <c>capabilities.limits</c>, Anthropic) because we do not yet know which one the app reads.
/// </summary>
public sealed class ModelCatalog
{
    private readonly CaptureOptions _o;
    private readonly long _created = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
    private readonly JsonNode? _fileBody;

    public ModelCatalog(CaptureOptions options)
    {
        _o = options;
        if (options.ModelsFile is not null) _fileBody = JsonNode.Parse(File.ReadAllText(options.ModelsFile));
    }

    public IReadOnlyList<string> AllIds
    {
        get
        {
            var ids = new List<string>();
            foreach (var m in _o.Models)
            {
                ids.Add(m);
                ids.AddRange(ScenarioSpec.Advertised.Select(s => $"{m}@{s}"));
            }
            return ids;
        }
    }

    public string ListJson()
    {
        if (_fileBody is not null) return _fileBody.ToJsonString(Wire.WireJson.Opts);
        var data = new JsonArray(AllIds.Select(id => (JsonNode?)Model(id)).ToArray());
        return new JsonObject
        {
            ["object"] = "list",
            ["data"] = data,
            ["has_more"] = false,
            ["first_id"] = AllIds[0],
            ["last_id"] = AllIds[^1],
        }.ToJsonString(Wire.WireJson.Opts);
    }

    /// <summary>The model object for <paramref name="id"/>, or null if the id is unknown.</summary>
    public JsonObject? Find(string id)
    {
        if (_fileBody?["data"] is JsonArray fileModels)
        {
            var hit = fileModels.OfType<JsonObject>().FirstOrDefault(m => (string?)m["id"] == id);
            if (hit is not null) return (JsonObject)hit.DeepClone();
        }
        return AllIds.Contains(id, StringComparer.OrdinalIgnoreCase) ? Model(id) : null;
    }

    private JsonObject Model(string id)
    {
        var ctx = _o.ContextLength;
        var max = Math.Min(_o.MaxOutputTokens, ctx);
        var tools = _o.AdvertiseToolCalling;
        var supportedParams = new List<string> { "max_tokens", "temperature", "stream", "stop" };
        if (tools) supportedParams.AddRange(["tools", "tool_choice", "parallel_tool_calls"]);
        supportedParams.AddRange(["reasoning", "reasoning_effort", "response_format"]);

        return new JsonObject
        {
            ["id"] = id,
            ["object"] = "model",
            ["created"] = _created,
            ["owned_by"] = "capture-server",
            // Anthropic list shape
            ["type"] = "model",
            ["display_name"] = id,
            ["created_at"] = DateTimeOffset.FromUnixTimeSeconds(_created).ToString("yyyy-MM-ddTHH:mm:ssZ"),
            // context / output limits under the names various clients read
            ["context_length"] = ctx,
            ["context_window"] = ctx,
            ["max_context_length"] = ctx,
            ["max_model_len"] = ctx,
            ["max_input_tokens"] = ctx - max,
            ["max_output_tokens"] = max,
            ["max_completion_tokens"] = max,
            // Copilot-style capability object, plus flat flags
            ["capabilities"] = new JsonObject
            {
                ["family"] = "capture",
                ["type"] = "chat",
                ["object"] = "model_capabilities",
                ["tokenizer"] = "o200k_base",
                ["limits"] = new JsonObject
                {
                    ["max_context_window_tokens"] = ctx,
                    ["max_prompt_tokens"] = ctx - max,
                    ["max_output_tokens"] = max,
                },
                ["supports"] = new JsonObject
                {
                    ["tool_calls"] = tools,
                    ["parallel_tool_calls"] = tools,
                    ["streaming"] = true,
                    ["vision"] = false,
                    ["structured_outputs"] = true,
                    ["reasoning"] = true,
                },
                ["tool_calling"] = tools,
                ["function_calling"] = tools,
                ["streaming"] = true,
                ["vision"] = false,
                ["reasoning"] = true,
            },
            // OpenRouter-style
            ["supported_parameters"] = new JsonArray(supportedParams.Select(p => (JsonNode?)JsonValue.Create(p)).ToArray()),
            ["top_provider"] = new JsonObject { ["context_length"] = ctx, ["max_completion_tokens"] = max },
            ["architecture"] = new JsonObject
            {
                ["input_modalities"] = new JsonArray("text"),
                ["output_modalities"] = new JsonArray("text"),
            },
            ["model_picker_enabled"] = true,
        };
    }
}
