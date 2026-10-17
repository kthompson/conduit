using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Http;

namespace Conduit.Capture;

/// <summary>What the analyzer learned about one request. <see cref="Json"/> is the "derived" block written to the capture log.</summary>
public sealed class RequestFacts
{
    public string Wire { get; init; } = "other";
    public string? Model { get; set; }
    public bool Stream { get; set; }
    public bool IncludeUsage { get; set; }
    public int ToolCount { get; set; }
    public string? FirstToolName { get; set; }
    public bool ContainsToolResults { get; set; }
    public string? ToolResultSnippet { get; set; }
    public int PromptChars { get; set; }
    public int PathCount { get; set; }
    public int SessionIdCount { get; set; }
    public JsonObject Json { get; } = new();

    public int PromptTokensEstimate => Math.Max(1, PromptChars / 4);

    /// <summary>Markdown summary used by the <c>echo</c> scenario so findings are visible in the app's own UI.</summary>
    public string Summary(string scenarioLabel)
    {
        var sb = new StringBuilder();
        sb.AppendLine("**Capture server echo**").AppendLine();
        sb.AppendLine(
            $"- wire format: `{Wire}`, stream: `{Stream}`, model sent: `{Model ?? "(none)"}`, scenario: `{scenarioLabel}`"
        );
        sb.AppendLine($"- prompt size: ~{PromptChars:N0} chars");
        sb.AppendLine(
            $"- tools offered: **{ToolCount}**"
                + (FirstToolName is null ? "" : $" (first: `{FirstToolName}`)")
        );
        if (Json["messages"] is JsonObject m)
        {
            sb.AppendLine($"- messages: {m["count"]}, roles: `{Join(m["roles"], 24)}`");
            sb.AppendLine(
                $"- content part types: `{Join(m["partTypes"], 20)}`, images: {m["hasImages"]}, tool results: {m["hasToolResults"]}"
            );
        }
        if (Json["reasoning"] is JsonObject r && r.Count > 0)
            sb.AppendLine($"- reasoning fields: `{Wire_S(r)}`");
        if (Json["toolChoice"] is { } tc)
            sb.AppendLine($"- tool_choice: `{Wire_S(tc)}`");
        if (Json["streamOptions"] is { } so)
            sb.AppendLine($"- stream_options: `{Wire_S(so)}`");
        sb.AppendLine($"- session-like ids found: **{SessionIdCount}**");
        if (Json["sessionIds"] is JsonArray ids)
            foreach (var id in ids.Take(8))
                sb.AppendLine($"  - {id?["where"]}: `{id?["name"]}` = `{id?["value"]}`");
        sb.AppendLine($"- filesystem paths found: **{PathCount}**");
        if (Json["paths"] is JsonArray paths)
            foreach (var p in paths.Take(8))
                sb.AppendLine($"  - `{p?["path"]}` (in {p?["where"]})");
        if (Json["params"] is JsonObject pr && pr.Count > 0)
            sb.AppendLine($"- other params: `{Wire_S(pr)}`");
        return sb.ToString();
    }

    private static string Wire_S(JsonNode n) => n.ToJsonString();

    private static string Join(JsonNode? arr, int max)
    {
        if (arr is not JsonArray a)
            return "";
        var items = a.Take(max).Select(x => x?.ToString() ?? "");
        return string.Join(",", items) + (a.Count > max ? ",..." : "");
    }
}

public static partial class RequestAnalyzer
{
    private static readonly string[] ScalarParams =
    [
        "temperature",
        "top_p",
        "top_k",
        "max_tokens",
        "max_completion_tokens",
        "max_output_tokens",
        "n",
        "stop",
        "seed",
        "presence_penalty",
        "frequency_penalty",
        "logprobs",
        "top_logprobs",
        "parallel_tool_calls",
        "store",
        "background",
        "truncation",
        "service_tier",
        "modalities",
        "verbosity",
        "prediction",
        "stop_sequences",
    ];

    private static readonly string[] BodySessionFields =
    [
        "user",
        "previous_response_id",
        "conversation",
        "prompt_cache_key",
        "safety_identifier",
        "session_id",
        "conversation_id",
        "thread_id",
        "chat_id",
        "request_id",
        "client_session_id",
    ];

    private static readonly HashSet<string> SystemRoles = new(StringComparer.OrdinalIgnoreCase)
    {
        "system",
        "developer",
    };

    public static RequestFacts Analyze(string wire, IHeaderDictionary headers, JsonNode? body)
    {
        var f = new RequestFacts { Wire = wire };
        var j = f.Json;
        j["wire"] = wire;

        CollectHeaderSessionIds(headers, j);

        if (body is JsonObject root)
        {
            j["topLevelKeys"] = new JsonArray(
                root.Select(kv => (JsonNode?)JsonValue.Create(kv.Key)).ToArray()
            );
            f.Model = Str(root["model"]);
            j["model"] = f.Model;
            f.Stream = root["stream"] is JsonValue sv && sv.TryGetValue<bool>(out var s) && s;
            j["stream"] = f.Stream;

            if (root["stream_options"] is JsonNode so)
            {
                j["streamOptions"] = so.DeepClone();
                f.IncludeUsage =
                    so is JsonObject soo
                    && soo["include_usage"] is JsonValue iu
                    && iu.TryGetValue<bool>(out var b)
                    && b;
            }
            j["includeUsage"] = f.IncludeUsage;

            switch (wire)
            {
                case "chat":
                    AnalyzeChat(root, f);
                    break;
                case "responses":
                    AnalyzeResponses(root, f);
                    break;
                case "messages":
                    AnalyzeMessages(root, f);
                    break;
            }

            AnalyzeCommon(root, f);
            ScanPaths(root, f);
        }

        f.SessionIdCount = (j["sessionIds"] as JsonArray)?.Count ?? 0;
        return f;
    }

    // ---- per-wire ----------------------------------------------------------------------------------------------

    private static void AnalyzeChat(JsonObject root, RequestFacts f)
    {
        var tools = root["tools"] as JsonArray ?? root["functions"] as JsonArray;
        SummarizeTools(
            tools,
            f,
            t => Str(t?["function"]?["name"]) ?? Str(t?["custom"]?["name"]) ?? Str(t?["name"])
        );
        if (root["tool_choice"] is { } tc)
            f.Json["toolChoice"] = tc.DeepClone();
        if (root["reasoning_effort"] is { } re)
            Reasoning(f)["reasoning_effort"] = re.DeepClone();
        if (root["reasoning"] is { } r)
            Reasoning(f)["reasoning"] = r.DeepClone();
        if (root["thinking"] is { } th)
            Reasoning(f)["thinking"] = th.DeepClone();
        if (root["response_format"] is JsonObject rf)
            f.Json.GetOrAddObject("params")["response_format"] = Str(rf["type"]);

        var m = Messages(f);
        var roles = new JsonArray();
        var parts = new SortedSet<string>();
        var count = 0;
        var systemChars = 0;
        var textChars = 0;
        if (root["messages"] is JsonArray msgs)
        {
            foreach (var msg in msgs)
            {
                count++;
                var role = Str(msg?["role"]) ?? "?";
                roles.Add(role);
                if (role is "tool" or "function")
                    Note(f, Str(msg?["content"]) ?? msg?["content"]?.ToJsonString());
                var chars = ContentParts(msg?["content"], parts);
                textChars += chars;
                if (SystemRoles.Contains(role))
                    systemChars += chars;
                if (msg?["tool_calls"] is JsonArray)
                    parts.Add("tool_calls");
            }
            m["lastRole"] = roles.Count > 0 ? roles[^1]?.GetValue<string>() : null;
        }
        FinishMessages(f, m, roles, parts, count, systemChars, textChars);
    }

    private static void AnalyzeResponses(JsonObject root, RequestFacts f)
    {
        SummarizeTools(
            root["tools"] as JsonArray,
            f,
            t => Str(t?["name"]) ?? Str(t?["function"]?["name"])
        );
        if (root["tool_choice"] is { } tc)
            f.Json["toolChoice"] = tc.DeepClone();
        if (root["reasoning"] is { } r)
            Reasoning(f)["reasoning"] = r.DeepClone();
        if (root["include"] is { } inc)
            Reasoning(f)["include"] = inc.DeepClone();
        if (root["text"] is JsonObject text)
            f.Json.GetOrAddObject("params")["text"] = text.DeepClone();

        var m = Messages(f);
        var roles = new JsonArray();
        var parts = new SortedSet<string>();
        var count = 0;
        var systemChars = Str(root["instructions"])?.Length ?? 0;
        var textChars = systemChars;
        if (systemChars > 0)
            parts.Add("instructions");
        switch (root["input"])
        {
            case JsonValue v when v.TryGetValue<string>(out var s):
                count = 1;
                roles.Add("user");
                textChars += s.Length;
                parts.Add("input:string");
                break;
            case JsonArray items:
                foreach (var item in items)
                {
                    count++;
                    var type = Str(item?["type"]) ?? "message";
                    var role = Str(item?["role"]) ?? type;
                    roles.Add(role);
                    parts.Add("item:" + type);
                    if (type == "function_call_output")
                        Note(f, Str(item?["output"]) ?? item?["output"]?.ToJsonString());
                    var chars = ContentParts(item?["content"], parts);
                    textChars += chars;
                    if (SystemRoles.Contains(role))
                        systemChars += chars;
                }
                break;
        }
        m["hasInstructions"] = systemChars > 0 && Str(root["instructions"]) is not null;
        FinishMessages(f, m, roles, parts, count, systemChars, textChars);
    }

    private static void AnalyzeMessages(JsonObject root, RequestFacts f)
    {
        SummarizeTools(root["tools"] as JsonArray, f, t => Str(t?["name"]));
        if (root["tool_choice"] is { } tc)
            f.Json["toolChoice"] = tc.DeepClone();
        if (root["thinking"] is { } th)
            Reasoning(f)["thinking"] = th.DeepClone();
        if (root["output_config"] is { } oc)
            Reasoning(f)["output_config"] = oc.DeepClone();

        var m = Messages(f);
        var roles = new JsonArray();
        var parts = new SortedSet<string>();
        var count = 0;
        var systemChars = 0;
        var textChars = 0;
        switch (root["system"])
        {
            case JsonValue v when v.TryGetValue<string>(out var s):
                systemChars = s.Length;
                parts.Add("system:string");
                break;
            case JsonArray blocks:
                systemChars = ContentParts(blocks, parts, "system:");
                break;
        }
        textChars += systemChars;
        if (root["messages"] is JsonArray msgs)
        {
            foreach (var msg in msgs)
            {
                count++;
                roles.Add(Str(msg?["role"]) ?? "?");
                textChars += ContentParts(msg?["content"], parts);
                if (msg?["content"] is JsonArray blocks)
                    foreach (
                        var b in blocks
                            .OfType<JsonObject>()
                            .Where(b => Str(b["type"]) == "tool_result")
                    )
                        Note(f, Str(b["content"]) ?? b["content"]?.ToJsonString());
            }
        }
        FinishMessages(f, m, roles, parts, count, systemChars, textChars);
    }

    // ---- shared helpers ----------------------------------------------------------------------------------------

    private static void AnalyzeCommon(JsonObject root, RequestFacts f)
    {
        var pr = f.Json.GetOrAddObject("params");
        foreach (var name in ScalarParams)
            if (root[name] is { } v)
                pr[name] = v.DeepClone();

        foreach (var name in BodySessionFields)
            if (root[name] is { } v)
                AddSessionId(
                    f.Json,
                    "body",
                    name,
                    v is JsonValue ? v.ToString() : v.ToJsonString()
                );
        if (root["metadata"] is JsonObject md)
            foreach (var kv in md)
                AddSessionId(f.Json, "body", "metadata." + kv.Key, kv.Value?.ToString() ?? "null");
    }

    private static void SummarizeTools(
        JsonArray? tools,
        RequestFacts f,
        Func<JsonNode?, string?> nameOf
    )
    {
        var info = f.Json.GetOrAddObject("tools");
        var count = tools?.Count ?? 0;
        info["count"] = count;
        f.ToolCount = count;
        if (tools is null || count == 0)
            return;
        info["types"] = new JsonArray(
            tools
                .Select(t =>
                    Str(t?["type"]) ?? (t?["input_schema"] is not null ? "anthropic" : "?")
                )
                .Distinct()
                .Select(x => (JsonNode?)JsonValue.Create(x))
                .ToArray()
        );
        var names = tools.Select(nameOf).Where(n => n is not null).Select(n => n!).ToList();
        info["names"] = new JsonArray(
            names.Take(80).Select(n => (JsonNode?)JsonValue.Create(n)).ToArray()
        );
        f.FirstToolName = names.FirstOrDefault();
        var first = tools[0];
        if (first is JsonObject fo)
        {
            var fn = fo["function"] as JsonObject ?? fo;
            var schema = fn["parameters"] ?? fn["input_schema"];
            info["first"] = new JsonObject
            {
                ["name"] = nameOf(first),
                ["type"] = Str(fo["type"]),
                ["hasSchema"] = schema is not null,
                ["schemaKeys"] = schema is JsonObject so
                    ? new JsonArray(so.Select(kv => (JsonNode?)JsonValue.Create(kv.Key)).ToArray())
                    : null,
                ["strict"] = fn["strict"]?.DeepClone(),
            };
        }
    }

    private static JsonObject Reasoning(RequestFacts f) => f.Json.GetOrAddObject("reasoning");

    private static JsonObject Messages(RequestFacts f) => f.Json.GetOrAddObject("messages");

    private static void FinishMessages(
        RequestFacts f,
        JsonObject m,
        JsonArray roles,
        SortedSet<string> parts,
        int count,
        int systemChars,
        int textChars
    )
    {
        m["count"] = count;
        m["roles"] =
            roles.Count > 200
                ? new JsonArray(roles.TakeLast(200).Select(x => x?.DeepClone()).ToArray())
                : roles;
        m["partTypes"] = new JsonArray(parts.Select(p => (JsonNode?)JsonValue.Create(p)).ToArray());
        m["hasImages"] = parts.Any(p => p.Contains("image", StringComparison.OrdinalIgnoreCase));
        m["hasToolResults"] = f.ContainsToolResults;
        if (f.ToolResultSnippet is not null)
            f.Json["toolResultSnippet"] = f.ToolResultSnippet;
        m["systemChars"] = systemChars;
        m["textChars"] = textChars;
        f.PromptChars = textChars;
    }

    /// <summary>Counts text characters in a message's content and records the part types seen.</summary>
    private static int ContentParts(JsonNode? content, ISet<string> parts, string prefix = "")
    {
        switch (content)
        {
            case JsonValue v when v.TryGetValue<string>(out var s):
                parts.Add(prefix + "string");
                return s.Length;
            case JsonArray arr:
                var chars = 0;
                foreach (var p in arr)
                {
                    var type = Str(p?["type"]) ?? "?";
                    parts.Add(prefix + type);
                    chars += Str(p?["text"])?.Length ?? 0;
                }
                return chars;
            default:
                return 0;
        }
    }

    private static void Note(RequestFacts f, string? toolResult)
    {
        f.ContainsToolResults = true;
        if (f.ToolResultSnippet is null && !string.IsNullOrEmpty(toolResult))
            f.ToolResultSnippet = toolResult.Length > 240 ? toolResult[..240] + "..." : toolResult;
    }

    private static string? Str(JsonNode? n) =>
        n is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    // ---- session-like ids --------------------------------------------------------------------------------------

    [GeneratedRegex(
        "session|conversation|thread|chat-?id|trace|request-?id|correlation|interaction|agent|task|turn|client-?id|device|machine|user-?id|editor|integration|intent|vscode",
        RegexOptions.IgnoreCase
    )]
    private static partial Regex SessionHeaderName();

    private static readonly HashSet<string> NeverLog = new(StringComparer.OrdinalIgnoreCase)
    {
        "authorization",
        "proxy-authorization",
        "x-api-key",
        "api-key",
        "cookie",
        "set-cookie",
        "user-agent",
    };

    private static void CollectHeaderSessionIds(IHeaderDictionary headers, JsonObject j)
    {
        foreach (var h in headers)
        {
            if (NeverLog.Contains(h.Key) || !SessionHeaderName().IsMatch(h.Key))
                continue;
            AddSessionId(j, "header", h.Key.ToLowerInvariant(), h.Value.ToString());
        }
    }

    private static void AddSessionId(JsonObject j, string where, string name, string value)
    {
        var arr = j["sessionIds"] as JsonArray;
        if (arr is null)
        {
            arr = new JsonArray();
            j["sessionIds"] = arr;
        }
        arr.Add(
            new JsonObject
            {
                ["where"] = where,
                ["name"] = name,
                ["value"] = value.Length > 200 ? value[..200] + "..." : value,
            }
        );
    }

    // ---- filesystem paths --------------------------------------------------------------------------------------

    // Unix-style absolute or ~/ paths. The lookbehind rejects URL pieces ("https://host/a/b"), "and/or", dates.
    [GeneratedRegex(@"(?<![\w.:/~@%+\-])(~?/(?:[\w.@%+=,\-]+/)*[\w.@%+=,\-]+/?)")]
    private static partial Regex UnixPath();

    [GeneratedRegex(@"(?<!\w)[A-Za-z]:[\\/](?:[^\s""'<>|*?:\\/]+[\\/])*[^\s""'<>|*?:\\/]+")]
    private static partial Regex WindowsPath();

    [GeneratedRegex(@"file:///[^\s""'<>)\]]+")]
    private static partial Regex FileUri();

    private static readonly HashSet<string> KnownRoots = new(StringComparer.Ordinal)
    {
        "tmp",
        "home",
        "Users",
        "workspace",
        "workspaces",
        "repo",
        "repos",
        "mnt",
        "opt",
        "var",
        "etc",
        "usr",
        "Volumes",
        "root",
        "srv",
        "work",
        "app",
        "code",
        "projects",
        "private",
    };

    private static readonly HashSet<string> NotFsRoots = new(StringComparer.OrdinalIgnoreCase)
    {
        "v1",
        "v2",
        "v1beta",
        "api",
        "openai",
        "responses",
        "chat",
        "models",
        "messages",
        "completions",
    };

    private static void ScanPaths(JsonObject root, RequestFacts f)
    {
        var found = new Dictionary<string, (string Where, int Count)>(StringComparer.Ordinal);

        void Visit(string label, string text)
        {
            if (text.Length > 1_000_000)
                text = text[..1_000_000];
            foreach (Match m in UnixPath().Matches(text))
                Add(m.Value, label);
            foreach (Match m in WindowsPath().Matches(text))
                Add(m.Value, label);
            foreach (Match m in FileUri().Matches(text))
                Add(m.Value, label);
        }

        void Add(string raw, string label)
        {
            var p = raw.TrimEnd('.', ',', ';', ':', ')', ']', '}', '\'', '"', '`', '*');
            if (p.Length < 3)
                return;
            if (p.StartsWith('/') || p.StartsWith("~/"))
            {
                var segs = p.TrimStart('~').Trim('/').Split('/');
                if (NotFsRoots.Contains(segs[0]))
                    return;
                if (segs.Length < 2 && !p.StartsWith("~/") && !KnownRoots.Contains(segs[0]))
                    return;
            }
            found[p] = found.TryGetValue(p, out var e) ? (e.Where, e.Count + 1) : (label, 1);
        }

        Walk(root, "", null, Visit);

        var paths = new JsonArray();
        foreach (var kv in found.OrderByDescending(x => x.Value.Count).ThenBy(x => x.Key).Take(100))
            paths.Add(
                new JsonObject
                {
                    ["path"] = kv.Key,
                    ["where"] = Categorize(kv.Value.Where),
                    ["firstLocation"] = kv.Value.Where,
                    ["count"] = kv.Value.Count,
                }
            );
        f.PathCount = found.Count;
        if (paths.Count > 0)
            f.Json["paths"] = paths;
    }

    private static string Categorize(string label)
    {
        var l = label.ToLowerInvariant();
        if (
            l.StartsWith(".instructions")
            || l.StartsWith(".system")
            || l.Contains("{system}")
            || l.Contains("{developer}")
        )
            return "system prompt";
        if (l.StartsWith(".tools"))
            return "tool definitions";
        if (l.Contains("{tool}") || l.Contains("tool_result") || l.Contains("function_call_output"))
            return "tool results";
        if (l.Contains("{assistant}"))
            return "assistant message";
        if (l.Contains("{user}"))
            return "user message";
        if (l.StartsWith(".metadata"))
            return "metadata";
        return "other (" + label + ")";
    }

    private static void Walk(
        JsonNode? n,
        string label,
        string? role,
        Action<string, string> onString
    )
    {
        switch (n)
        {
            case JsonObject o:
                var r = Str(o["role"]) ?? role;
                foreach (var kv in o)
                    Walk(kv.Value, label + "." + kv.Key, r, onString);
                break;
            case JsonArray a:
                for (var i = 0; i < a.Count; i++)
                    Walk(a[i], $"{label}[{i}]", role, onString);
                break;
            case JsonValue v when v.TryGetValue<string>(out var s):
                onString(role is null ? label : $"{label}{{{role}}}", s);
                break;
        }
    }
}

internal static class JsonObjectExtensions
{
    public static JsonObject GetOrAddObject(this JsonObject parent, string name)
    {
        if (parent[name] is JsonObject existing)
            return existing;
        var created = new JsonObject();
        parent[name] = created;
        return created;
    }
}
