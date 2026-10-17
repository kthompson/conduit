using System.Text;
using System.Text.Json.Nodes;

namespace Conduit.Capture;

/// <summary>Summarizes capture JSONL files into answers to the open questions in PLAN.md section 11.</summary>
public static class CaptureReport
{
    private static readonly string[] CompletionWires = ["chat", "responses", "messages"];

    /// <summary>All <c>*.jsonl</c> files in <paramref name="dir"/>, oldest first.</summary>
    public static IReadOnlyList<string> FindFiles(string dir) =>
        Directory.Exists(dir) ? Directory.GetFiles(dir, "*.jsonl").OrderBy(f => f, StringComparer.Ordinal).ToList() : [];

    public static string BuildFromFiles(IEnumerable<string> files)
    {
        var list = files.ToList();
        var records = new List<JsonObject>();
        var bad = 0;
        foreach (var f in list)
            foreach (var line in File.ReadLines(f))
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                try { if (JsonNode.Parse(line) is JsonObject o) records.Add(o); else bad++; }
                catch (System.Text.Json.JsonException) { bad++; }
            }
        return Build(records, list.Select(Path.GetFileName).ToList()!, bad);
    }

    public static string Build(IReadOnlyList<JsonObject> records, IReadOnlyList<string> sources, int unreadableLines = 0)
    {
        var sb = new StringBuilder();
        sb.AppendLine("# Capture report").AppendLine();
        if (records.Count == 0)
            return sb.AppendLine("No captured requests found. Start `conduit capture`, point the app at it, and use the app.").ToString();

        var ordered = records.OrderBy(r => Str(r, "ts")).ToList();
        var completions = ordered.Where(r => CompletionWires.Contains(Str(r, "wire") ?? "")).ToList();
        sb.AppendLine($"- sources: {string.Join(", ", sources)}");
        sb.AppendLine($"- {records.Count} requests ({completions.Count} completion requests), {Str(ordered[0], "ts")} to {Str(ordered[^1], "ts")}");
        if (unreadableLines > 0) sb.AppendLine($"- {unreadableLines} unreadable lines skipped");
        sb.AppendLine();

        Endpoints(sb, ordered);
        Client(sb, ordered);
        Formats(sb, completions);
        Tools(sb, completions);
        Reasoning(sb, completions);
        Conversation(sb, completions);
        Identity(sb, completions);
        Paths(sb, completions);
        Timing(sb, ordered);
        ToolReaction(sb, ordered);
        Answers(sb, ordered, completions);
        return sb.ToString();
    }

    // ---- sections ----------------------------------------------------------------------------------------------

    private static void Endpoints(StringBuilder sb, List<JsonObject> all)
    {
        sb.AppendLine("## Endpoints the app called").AppendLine();
        sb.AppendLine("| count | method | path | status |").AppendLine("|---|---|---|---|");
        foreach (var g in all.GroupBy(r => (Str(r, "method"), Str(r, "path"), Int(r, "response", "status")))
                     .OrderByDescending(g => g.Count()))
            sb.AppendLine($"| {g.Count()} | {g.Key.Item1} | `{g.Key.Item2}` | {g.Key.Item3} |");
        var unknown = all.Where(r => Str(r, "wire") == "other").Select(r => $"{Str(r, "method")} {Str(r, "path")}").Distinct().ToList();
        sb.AppendLine().AppendLine(unknown.Count == 0
            ? "No unrouted paths: the app only used endpoints the server knows."
            : $"Unrouted (got 404): {string.Join(", ", unknown.Select(u => $"`{u}`"))}. These are endpoints to consider supporting.");
        sb.AppendLine();
    }

    private static void Client(StringBuilder sb, List<JsonObject> all)
    {
        sb.AppendLine("## Client").AppendLine();
        var agents = all.Select(r => Str(r, "headers", "user-agent")).Where(x => x is not null).GroupBy(x => x).OrderByDescending(g => g.Count());
        foreach (var g in agents) sb.AppendLine($"- user-agent `{g.Key}` x{g.Count()}");
        var hdr = new Dictionary<string, int>();
        foreach (var r in all)
            if (r["headers"] is JsonObject h)
                foreach (var kv in h) hdr[kv.Key] = hdr.GetValueOrDefault(kv.Key) + 1;
        var boring = new HashSet<string> { "host", "content-length", "accept-encoding", "connection", "content-type", "accept", "user-agent" };
        var extra = hdr.Where(kv => !boring.Contains(kv.Key)).OrderBy(kv => kv.Key).ToList();
        sb.AppendLine(extra.Count == 0 ? "- no non-standard headers" : "- other headers seen: " + string.Join(", ", extra.Select(kv => $"`{kv.Key}` x{kv.Value}")));
        var auth = all.Select(r => (Str(r, "auth", "header"), Str(r, "auth", "scheme"))).Distinct().ToList();
        sb.AppendLine("- auth presented: " + string.Join(", ", auth.Select(a => a.Item1 is null ? "none" : $"{a.Item1}/{a.Item2}")));
        sb.AppendLine();
    }

    private static void Formats(StringBuilder sb, List<JsonObject> c)
    {
        sb.AppendLine("## Wire format and streaming").AppendLine();
        if (c.Count == 0) { sb.AppendLine("No completion requests yet.").AppendLine(); return; }
        foreach (var g in c.GroupBy(r => Str(r, "wire")))
            sb.AppendLine($"- `{g.Key}`: {g.Count()} requests, streaming {g.Count(r => Bool(r, "derived", "stream"))}, non-streaming {g.Count(r => !Bool(r, "derived", "stream"))}");
        var opts = c.Select(r => r["derived"]?["streamOptions"]?.ToJsonString()).Where(x => x is not null).Distinct().ToList();
        sb.AppendLine("- stream_options: " + (opts.Count == 0 ? "never sent" : string.Join("; ", opts.Select(o => $"`{o}`"))));
        sb.AppendLine("- models requested: " + string.Join(", ", c.Select(r => Str(r, "derived", "model")).Where(x => x is not null).Distinct().Select(m => $"`{m}`")));
        var keys = c.SelectMany(r => (r["derived"]?["topLevelKeys"] as JsonArray)?.Select(k => k?.ToString() ?? "") ?? []).Distinct().OrderBy(k => k);
        sb.AppendLine("- top-level body fields: " + string.Join(", ", keys.Select(k => $"`{k}`")));
        var pr = c.Select(r => r["derived"]?["params"]?.ToJsonString()).Where(x => x is not null && x != "{}").Distinct().Take(5).ToList();
        if (pr.Count > 0) sb.AppendLine("- params: " + string.Join("; ", pr.Select(p => $"`{p}`")));
        sb.AppendLine();
    }

    private static void Tools(StringBuilder sb, List<JsonObject> c)
    {
        sb.AppendLine("## Tools the app offers").AppendLine();
        var withTools = c.Where(r => Int(r, "derived", "tools", "count") > 0).ToList();
        if (withTools.Count == 0) { sb.AppendLine("The app sent no tools in any completion request.").AppendLine(); return; }
        var counts = withTools.Select(r => Int(r, "derived", "tools", "count")).ToList();
        sb.AppendLine($"- {withTools.Count} of {c.Count} requests carried tools; {counts.Min()} to {counts.Max()} per request");
        sb.AppendLine("- types: " + string.Join(", ", withTools.SelectMany(r => Arr(r, "derived", "tools", "types")).Distinct().Select(t => $"`{t}`")));
        var names = withTools.SelectMany(r => Arr(r, "derived", "tools", "names")).GroupBy(n => n).OrderByDescending(g => g.Count()).Take(40);
        sb.AppendLine("- names: " + string.Join(", ", names.Select(g => $"`{g.Key}`")));
        var choices = c.Select(r => r["derived"]?["toolChoice"]?.ToJsonString()).Where(x => x is not null).Distinct().ToList();
        sb.AppendLine("- tool_choice: " + (choices.Count == 0 ? "never sent" : string.Join("; ", choices.Select(x => $"`{x}`"))));
        sb.AppendLine();
    }

    private static void Reasoning(StringBuilder sb, List<JsonObject> c)
    {
        sb.AppendLine("## Reasoning parameters").AppendLine();
        var all = c.Select(r => r["derived"]?["reasoning"]?.ToJsonString()).Where(x => x is not null).GroupBy(x => x).OrderByDescending(g => g.Count()).Take(6).ToList();
        if (all.Count == 0) sb.AppendLine("No reasoning / thinking / effort fields were sent.");
        foreach (var g in all) sb.AppendLine($"- `{g.Key}` x{g.Count()}");
        sb.AppendLine();
    }

    private static void Conversation(StringBuilder sb, List<JsonObject> c)
    {
        sb.AppendLine("## Message shape and history").AppendLine();
        if (c.Count == 0) { sb.AppendLine("No completion requests yet.").AppendLine(); return; }
        var counts = c.Select(r => Int(r, "derived", "messages", "count")).ToList();
        sb.AppendLine("- message/input item counts in request order: " + string.Join(" ", counts.Take(40)) + (counts.Count > 40 ? " ..." : ""));
        var grows = counts.Zip(counts.Skip(1), (a, b) => b > a).Count(x => x);
        sb.AppendLine($"- count grew between consecutive requests {grows} time(s): " +
                      (grows > 0 ? "the app resends the whole history each turn." : "no growth seen (single turns, or the app does not resend history)."));
        sb.AppendLine("- roles: " + string.Join(", ", c.SelectMany(r => Arr(r, "derived", "messages", "roles")).Distinct().Select(x => $"`{x}`")));
        sb.AppendLine("- content part types: " + string.Join(", ", c.SelectMany(r => Arr(r, "derived", "messages", "partTypes")).Distinct().Select(x => $"`{x}`")));
        sb.AppendLine($"- requests with images: {c.Count(r => Bool(r, "derived", "messages", "hasImages"))}");
        var sys = c.Select(r => Int(r, "derived", "messages", "systemChars")).Where(x => x > 0).ToList();
        if (sys.Count > 0) sb.AppendLine($"- system prompt size: {sys.Min():N0} to {sys.Max():N0} chars");
        var small = c.Count(r => Int(r, "derived", "tools", "count") == 0);
        sb.AppendLine($"- requests without tools (probes, titles or summaries?): {small}");
        sb.AppendLine();
    }

    private static void Identity(StringBuilder sb, List<JsonObject> c)
    {
        sb.AppendLine("## Session / conversation identity candidates").AppendLine();
        var seen = new List<(string Where, string Name, string Value)>();
        foreach (var r in c)
            foreach (var id in (r["derived"]?["sessionIds"] as JsonArray) ?? [])
                seen.Add((Str(id, "where") ?? "", Str(id, "name") ?? "", Str(id, "value") ?? ""));
        if (seen.Count == 0) { sb.AppendLine("No session-like headers or body fields were found.").AppendLine(); return; }
        sb.AppendLine("| where | name | requests | distinct values | verdict | example |").AppendLine("|---|---|---|---|---|---|");
        foreach (var g in seen.GroupBy(x => (x.Where, x.Name)).OrderBy(g => g.Key.Where).ThenBy(g => g.Key.Name))
        {
            var n = g.Count(); var d = g.Select(x => x.Value).Distinct().Count();
            var verdict = n < 2 ? "too few requests" : d == 1 ? "constant (session-like?)" : d == n ? "changes every request" : "repeats in groups (per-conversation id?)";
            sb.AppendLine($"| {g.Key.Where} | `{g.Key.Name}` | {n} | {d} | {verdict} | `{Trim(g.First().Value, 40)}` |");
        }
        sb.AppendLine().AppendLine("A value that repeats across the turns of one conversation but differs between conversations would be an explicit session id.");
        sb.AppendLine();
    }

    private static void Paths(StringBuilder sb, List<JsonObject> c)
    {
        sb.AppendLine("## Filesystem paths in requests").AppendLine();
        var rows = new Dictionary<string, (string Where, int Requests)>();
        foreach (var r in c)
            foreach (var p in (r["derived"]?["paths"] as JsonArray) ?? [])
            {
                var path = Str(p, "path") ?? "";
                var e = rows.GetValueOrDefault(path);
                rows[path] = (e.Where ?? Str(p, "where") ?? "", e.Requests + 1);
            }
        if (rows.Count == 0)
        {
            sb.AppendLine("No filesystem paths appeared anywhere in the requests. If the app shows a worktree, it is not telling the model.").AppendLine();
            return;
        }
        sb.AppendLine("| path | first seen in | requests |").AppendLine("|---|---|---|");
        foreach (var kv in rows.OrderBy(kv => kv.Value.Where.StartsWith("system") ? 0 : 1).ThenByDescending(kv => kv.Value.Requests).Take(20))
            sb.AppendLine($"| `{kv.Key}` | {kv.Value.Where} | {kv.Value.Requests} |");
        sb.AppendLine();
    }

    private static void Timing(StringBuilder sb, List<JsonObject> all)
    {
        sb.AppendLine("## Timing and client behavior").AppendLine();
        sb.AppendLine("| scenario | requests | completed | client aborted | server aborted | keep-alives sent |").AppendLine("|---|---|---|---|---|---|");
        foreach (var g in all.Where(r => Str(r, "response", "scenario") is { Length: > 0 }).GroupBy(r => Str(r, "response", "scenario")).OrderBy(g => g.Key))
            sb.AppendLine($"| {g.Key} | {g.Count()} | {g.Count(r => Str(r, "response", "endedBy") == "completed")} | " +
                          $"{g.Count(r => Str(r, "response", "endedBy") == "client_aborted")} | {g.Count(r => Str(r, "response", "endedBy") == "server_aborted")} | " +
                          $"{g.Sum(r => Int(r, "response", "keepAlivesSent"))} |");
        sb.AppendLine();

        foreach (var r in all.Where(r => Str(r, "response", "endedBy") == "client_aborted"))
            sb.AppendLine($"- #{Int(r, "seq")} `{Str(r, "response", "scenario")}` was dropped by the client {Dbl(r, "response", "clientAbortedAtMs"):N0} ms in, " +
                          $"{Dbl(r, "response", "msSinceLastWriteAtAbort"):N0} ms after the last byte we sent");
        foreach (var r in all.Where(r => Str(r, "response", "scenario")?.StartsWith("slow") == true && Str(r, "response", "endedBy") == "completed"))
            sb.AppendLine($"- #{Int(r, "seq")} `{Str(r, "response", "scenario")}` ran to completion in {Dbl(r, "response", "completedMs") / 1000:N0} s " +
                          $"with {Int(r, "response", "keepAlivesSent")} keep-alives: the app tolerated that duration");
        var dups = all.Where(r => r["duplicateOfSeq"] is not null).ToList();
        sb.AppendLine(dups.Count == 0
            ? "- no identical request bodies were repeated (no retries seen)"
            : $"- {dups.Count} request(s) repeated an earlier body exactly (retries?): " +
              string.Join(", ", dups.Take(10).Select(r => $"#{Int(r, "seq")} repeats #{Int(r, "duplicateOfSeq")} after {Dbl(r, "sinceLastRequestMs"):N0} ms")));
        sb.AppendLine();
    }

    private static void ToolReaction(StringBuilder sb, List<JsonObject> all)
    {
        var probes = all.Where(r => Str(r, "response", "scenario") == "toolcall" && Str(r, "response", "endedBy") == "completed"
                                    && Int(r, "derived", "tools", "count") > 0
                                    && !Bool(r, "derived", "messages", "hasToolResults")).ToList();
        if (probes.Count == 0) return;
        sb.AppendLine("## Reaction to a tool call").AppendLine();
        foreach (var p in probes)
        {
            var seq = Int(p, "seq");
            var follow = all.Where(r => Int(r, "seq") > seq && Bool(r, "derived", "messages", "hasToolResults")).OrderBy(r => Int(r, "seq")).FirstOrDefault();
            sb.AppendLine(follow is null
                ? $"- #{seq}: we asked the app to call `{Str(p, "derived", "tools", "first", "name")}`; no request with a tool result followed (the app did not run it, or has not yet)."
                : $"- #{seq}: after the call to `{Str(p, "derived", "tools", "first", "name")}`, request #{Int(follow, "seq")} came back with a tool result: `{Trim(Str(follow, "derived", "toolResultSnippet") ?? "", 160)}`");
        }
        sb.AppendLine();
    }

    private static void Answers(StringBuilder sb, List<JsonObject> all, List<JsonObject> c)
    {
        sb.AppendLine("## Open questions (PLAN.md section 11)").AppendLine();

        var toolReqs = c.Count(r => Int(r, "derived", "tools", "count") > 0);
        var maxTools = c.Select(r => Int(r, "derived", "tools", "count")).DefaultIfEmpty(0).Max();
        sb.AppendLine("1. **Agent vs. model mode as default.** " + (c.Count == 0 ? "No data yet."
            : toolReqs == 0 ? "The app sent no tools, so it is not acting as its own tool harness through this endpoint; agent mode is plausible."
            : $"The app sent its own tool list in {toolReqs} of {c.Count} requests (up to {maxTools} tools). It brings its own harness, which favours model mode. " +
              "Check the tool-call section above for whether it executes calls we return."));

        var sysPaths = c.SelectMany(r => (r["derived"]?["paths"] as JsonArray) ?? []).Where(p => (Str(p, "where") ?? "").StartsWith("system")).Select(p => Str(p, "path")).Distinct().ToList();
        var anyPaths = c.Any(r => r["derived"]?["paths"] is JsonArray { Count: > 0 });
        sb.AppendLine("2. **How the app conveys its working directory.** " + (sysPaths.Count > 0
            ? $"Paths appear in the system prompt: {string.Join(", ", sysPaths.Take(5).Select(p => $"`{p}`"))}. Extractable."
            : anyPaths ? "Paths appear, but not in the system prompt; see the paths table for where." : "No paths seen: a fixed per-instance workspace would be the fallback."));

        var constant = new List<string>();
        foreach (var g in c.SelectMany(r => (r["derived"]?["sessionIds"] as JsonArray) ?? []).GroupBy(id => (Str(id, "where"), Str(id, "name"))))
        {
            var n = g.Count(); var d = g.Select(i => Str(i, "value")).Distinct().Count();
            if (n >= 2 && d < n) constant.Add($"{g.Key.Item1}:{g.Key.Item2}");
        }
        sb.AppendLine("3. **Conversation identity.** " + (constant.Count > 0
            ? $"Repeats across requests (candidate session ids): {string.Join(", ", constant.Select(x => $"`{x}`"))}. Confirm each stays fixed within one conversation and differs between conversations."
            : "No constant id found yet; the prefix fingerprint stays necessary. Run two separate conversations to be sure."));

        var aborted = all.Where(r => Str(r, "response", "scenario")?.StartsWith("slow") == true && Str(r, "response", "endedBy") == "client_aborted").ToList();
        sb.AppendLine("4. **Idle timeout / keep-alives.** " + (aborted.Count > 0
            ? "The app dropped a slow stream: " + string.Join("; ", aborted.Select(r => $"#{Int(r, "seq")} after {Dbl(r, "response", "msSinceLastWriteAtAbort") / 1000:N0} s of silence ({Int(r, "response", "keepAlivesSent")} keep-alives sent)")) + "."
            : all.Any(r => Str(r, "response", "scenario")?.StartsWith("slow") == true)
                ? "A slow stream completed without the client dropping it."
                : "Not tested: run the `slow` and `slow-nokeepalive` scenarios."));

        var models = all.Count(r => Str(r, "wire") == "models");
        sb.AppendLine($"5. **Model list.** {(models == 0 ? "The app never fetched /v1/models." : $"/v1/models was fetched {models} time(s).")} " +
                      "Whether it accepted the advertised context length and tool-calling flags shows in the app UI, not the log.");
        sb.AppendLine("6. **Needs your eyes in the app** (the log cannot know): how `progress` markdown renders, which `reasoning` shape is displayed, how `error` variants look, and what `toolcall` does to the UI.");
        sb.AppendLine();
    }

    // ---- json helpers ------------------------------------------------------------------------------------------

    private static JsonNode? At(JsonNode? n, params string[] path)
    {
        foreach (var p in path) { n = n is JsonObject o ? o[p] : null; if (n is null) return null; }
        return n;
    }

    private static string? Str(JsonNode? n, params string[] path) => At(n, path) is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    private static int Int(JsonNode? n, params string[] path) =>
        At(n, path) is JsonValue v && v.TryGetValue<double>(out var d) ? (int)d : 0;

    private static double Dbl(JsonNode? n, params string[] path) =>
        At(n, path) is JsonValue v && v.TryGetValue<double>(out var d) ? d : 0;

    private static bool Bool(JsonNode? n, params string[] path) => At(n, path) is JsonValue v && v.TryGetValue<bool>(out var b) && b;

    private static IEnumerable<string> Arr(JsonNode? n, params string[] path) =>
        (At(n, path) as JsonArray)?.Select(x => x?.ToString() ?? "") ?? [];

    private static string Trim(string s, int max) => s.Length <= max ? s : s[..max] + "...";
}
