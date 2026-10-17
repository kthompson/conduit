using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Conduit.Provider.Core;

namespace Conduit.Provider.Claude;

/// <summary>
/// Reads the tool calls out of one block of model output. Strict form is <c>&lt;tool_call&gt;{"name":..,"arguments":{..}}&lt;/tool_call&gt;</c>,
/// but small models drift, so this also accepts what they were seen to write: other tag names, flat arguments next to <c>name</c>,
/// stray closing braces, string-encoded arguments, OpenAI-style <c>{"function":{..}}</c>, and Claude's own
/// <c>&lt;invoke name=".."&gt;&lt;parameter name=".."&gt;</c> XML.
/// </summary>
public static partial class ToolCallParser
{
    /// <summary>Every tag that can open or close a tool-call block. Matching is by shape, not by pairing names.</summary>
    public static readonly Regex Tag = TagRegex();

    private static readonly string[] NameKeys = ["name", "tool", "tool_name", "function_name"];
    private static readonly string[] ArgKeys = ["arguments", "input", "parameters", "args"];

    [GeneratedRegex(@"<(/?)(tool_call|function_calls|function_call|tool_use|tool|call|invoke)\b([^>]*)>", RegexOptions.IgnoreCase)]
    private static partial Regex TagRegex();

    [GeneratedRegex(@"<invoke\s+name\s*=\s*""([^""]+)""\s*>(.*?)(?:</invoke>|$)", RegexOptions.IgnoreCase | RegexOptions.Singleline)]
    private static partial Regex InvokeRegex();

    [GeneratedRegex(@"<parameter\s+name\s*=\s*""([^""]+)""\s*>(.*?)</parameter>", RegexOptions.IgnoreCase | RegexOptions.Singleline)]
    private static partial Regex ParameterRegex();

    public static IReadOnlyList<ToolCall> Parse(string block, IReadOnlyList<ToolSpec> tools)
    {
        var calls = new List<ToolCall>();

        foreach (Match m in InvokeRegex().Matches(block))
        {
            var spec = Find(tools, m.Groups[1].Value);
            var args = new JsonObject();
            foreach (Match p in ParameterRegex().Matches(m.Groups[2].Value))
                args[p.Groups[1].Value] = Coerce(p.Groups[2].Value, spec, p.Groups[1].Value);
            calls.Add(Make(spec?.Name ?? m.Groups[1].Value, args));
        }
        if (calls.Count > 0) return calls;

        foreach (var json in TopLevelObjects(block))
            if (TryParse(json) is JsonObject o) Collect(o, tools, calls);
        return calls;
    }

    private static void Collect(JsonObject o, IReadOnlyList<ToolSpec> tools, List<ToolCall> calls)
    {
        if (o["tool_calls"] is JsonArray many)
        {
            foreach (var c in many) if (c is JsonObject co) Collect(co, tools, calls);
            return;
        }

        var source = o["function"] is JsonObject f ? f : o;
        string? name = null;
        foreach (var k in NameKeys)
            if (source[k] is JsonValue v && v.TryGetValue<string>(out var s) && s.Length > 0) { name = s; break; }
        name ??= source["function"] is JsonValue fv && fv.TryGetValue<string>(out var fn) ? fn : null;
        if (name is null) return;

        JsonObject? args = null;
        foreach (var k in ArgKeys)
        {
            if (source[k] is JsonObject ao) { args = (JsonObject)ao.DeepClone(); break; }
            if (source[k] is JsonValue sv && sv.TryGetValue<string>(out var text) && TryParse(text) is JsonObject parsed) { args = parsed; break; }
        }
        if (args is null)
        {
            // Flat form: every other key is an argument ({"name":"bash","command":"ls"}).
            args = new JsonObject();
            foreach (var (k, v) in source)
                if (!NameKeys.Contains(k) && !ArgKeys.Contains(k) && k != "function" && k != "type" && k != "id")
                    args[k] = v?.DeepClone();
        }

        calls.Add(Make(Find(tools, name)?.Name ?? name, args));
    }

    private static ToolCall Make(string name, JsonObject args) =>
        new("call_" + Guid.NewGuid().ToString("N")[..24], name, args.ToJsonString());

    /// <summary>Exact name first, then ignoring case and separators ("View", "read-file", "read_file").</summary>
    public static ToolSpec? Find(IReadOnlyList<ToolSpec> tools, string name)
    {
        var exact = tools.FirstOrDefault(t => t.Name == name);
        if (exact is not null) return exact;
        var n = Normalize(name);
        return tools.FirstOrDefault(t => Normalize(t.Name) == n);
    }

    private static string Normalize(string s) => new(s.Where(char.IsLetterOrDigit).Select(char.ToLowerInvariant).ToArray());

    private static JsonNode? Coerce(string raw, ToolSpec? spec, string property)
    {
        var text = raw.Trim('\n', '\r');
        var type = SchemaProperty(spec, property)?["type"]?.GetValue<string>();
        if (type is null or "string") return text;
        return TryParse(text) ?? text;
    }

    private static JsonObject? SchemaProperty(ToolSpec? spec, string property) =>
        spec?.ParametersJson is { } p && TryParse(p) is JsonObject schema && schema["properties"] is JsonObject props ? props[property] as JsonObject : null;

    /// <summary>Why a call cannot be run as written, or null: an unknown tool, or a required argument that is missing.</summary>
    public static string? Validate(ToolCall call, IReadOnlyList<ToolSpec> tools)
    {
        var spec = tools.FirstOrDefault(t => t.Name == call.Name);
        if (spec is null) return $"there is no tool named '{call.Name}' (available: {string.Join(", ", tools.Select(t => t.Name).Take(60))})";
        if (spec.ParametersJson is not { } p || TryParse(p) is not JsonObject schema || schema["required"] is not JsonArray required) return null;
        var args = TryParse(call.ArgumentsJson) as JsonObject;
        var missing = required.Select(r => r!.GetValue<string>()).Where(r => args?[r] is null).ToList();
        return missing.Count == 0 ? null : $"the call to '{call.Name}' is missing required argument(s): {string.Join(", ", missing)}";
    }

    /// <summary>Balanced <c>{..}</c> objects in order, string-aware. A stray closing brace is skipped; an object left open at the end is closed.</summary>
    private static IEnumerable<string> TopLevelObjects(string s)
    {
        var depth = 0;
        var start = -1;
        var inString = false;
        var escaped = false;
        var lastClose = -1;
        for (var i = 0; i < s.Length; i++)
        {
            var c = s[i];
            if (inString)
            {
                if (escaped) escaped = false;
                else if (c == '\\') escaped = true;
                else if (c == '"') inString = false;
                continue;
            }
            switch (c)
            {
                case '"' when depth > 0: inString = true; break;
                case '{':
                    if (depth++ == 0) start = i;
                    break;
                case '}':
                    if (depth == 0) break;
                    lastClose = i;
                    if (--depth == 0) yield return s[start..(i + 1)];
                    break;
            }
        }
        // The model sometimes drops the last closing brace(s). Close what is open; the caller keeps it only if it then parses.
        if (depth > 0 && start >= 0 && lastClose > start) yield return s[start..(lastClose + 1)] + new string('}', depth);
    }

    private static JsonNode? TryParse(string json)
    {
        try { return JsonNode.Parse(json.Trim()); }
        catch (JsonException) { return null; }
    }
}
