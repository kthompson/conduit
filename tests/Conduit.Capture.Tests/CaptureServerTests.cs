using System.Net;
using System.Net.Http.Headers;
using System.Text.Json.Nodes;
using Xunit;

namespace Conduit.Capture.Tests;

public class CaptureServerTests
{
    private const string ChatBody =
        """{"model":"capture","stream":true,"stream_options":{"include_usage":true},"messages":[{"role":"system","content":"Work in /home/kevin/worktrees/feat-x"},{"role":"user","content":"hi"}]}""";

    [Fact]
    public void Lan_requires_a_key()
    {
        Assert.NotNull(new CaptureOptions { Lan = true }.Validate());
        Assert.NotNull(new CaptureOptions { Host = "0.0.0.0" }.Validate());
        Assert.Null(new CaptureOptions { Lan = true, Key = "k" }.Validate());
        Assert.Null(new CaptureOptions().Validate());
    }

    [Fact]
    public void Scenario_specs_parse_from_names_and_model_suffixes()
    {
        Assert.Equal("error", ScenarioSpec.Parse("error-429").Name);
        Assert.Equal("429", ScenarioSpec.Parse("Error-429").Variant);
        var (model, spec) = ScenarioSpec.SplitModel("claude-work/opus@slow-nokeepalive");
        Assert.Equal("claude-work/opus", model);
        Assert.Equal("slow", spec!.Value.Name);
        Assert.Equal("nokeepalive", spec.Value.Variant);
        Assert.Null(ScenarioSpec.SplitModel("capture").Spec);
    }

    [Fact]
    public async Task Models_lists_scenario_variants_and_capability_blob()
    {
        await using var s = await TestServer.StartAsync(o => o.ContextLength = 256_000);
        var json = JsonNode.Parse(await s.Http.GetStringAsync("/v1/models"))!;
        var ids = json["data"]!.AsArray().Select(m => (string)m!["id"]!).ToList();
        Assert.True(ids.Contains("capture"));
        Assert.True(ids.Contains("capture@slow"));
        var first = json["data"]![0]!;
        Assert.Equal(256_000, (int)first["context_length"]!);
        Assert.True((bool)first["capabilities"]!["supports"]!["tool_calls"]!);
        Assert.Equal(404, (int)(await s.Http.GetAsync("/v1/models/nope")).StatusCode);
        Assert.Equal(200, (int)(await s.Http.GetAsync("/v1/models/capture@slow")).StatusCode);
    }

    [Fact]
    public async Task Chat_stream_ends_with_done_includes_usage_and_is_logged_without_the_key()
    {
        await using var s = await TestServer.StartAsync();
        var req = new HttpRequestMessage(HttpMethod.Post, "/v1/chat/completions") { Content = TestServer.Json(ChatBody) };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", "sk-super-secret");
        req.Headers.Add("X-Session-Id", "abc123");
        var text = await (await s.Http.SendAsync(req)).Content.ReadAsStringAsync();

        Assert.Contains("data: [DONE]", text);
        Assert.Contains("\"usage\"", text);

        var rec = (await s.RecordsAsync(1))[0];
        Assert.Equal("chat", (string)rec["wire"]!);
        Assert.True((bool)rec["derived"]!["stream"]!);
        Assert.True((bool)rec["derived"]!["includeUsage"]!);
        Assert.Equal("<redacted>", (string)rec["headers"]!["authorization"]!);
        Assert.Equal("Bearer", (string)rec["auth"]!["scheme"]!);
        Assert.Equal("/home/kevin/worktrees/feat-x", (string)rec["derived"]!["paths"]![0]!["path"]!);
        Assert.Equal("system prompt", (string)rec["derived"]!["paths"]![0]!["where"]!);
        Assert.Contains("abc123", rec["derived"]!["sessionIds"]!.ToJsonString());
        Assert.Contains("hi", (string)rec["body"]!);
        Assert.False(File.ReadAllText(s.CaptureFile).Contains("sk-super-secret"));
        Assert.Equal("completed", (string)rec["response"]!["endedBy"]!);
    }

    [Fact]
    public async Task Toolcall_scenario_calls_the_first_offered_tool_then_acknowledges_the_result()
    {
        await using var s = await TestServer.StartAsync();
        var first = await s.Http.PostAsync("/v1/chat/completions?scenario=toolcall", TestServer.Json(
            """{"model":"m","messages":[{"role":"user","content":"x"}],"tools":[{"type":"function","function":{"name":"read_file","parameters":{"type":"object"}}},{"type":"function","function":{"name":"other"}}]}"""));
        var msg = JsonNode.Parse(await first.Content.ReadAsStringAsync())!["choices"]![0]!;
        Assert.Equal("tool_calls", (string)msg["finish_reason"]!);
        Assert.Equal("read_file", (string)msg["message"]!["tool_calls"]![0]!["function"]!["name"]!);

        var second = await s.Http.PostAsync("/v1/chat/completions?scenario=toolcall", TestServer.Json(
            """{"model":"m","messages":[{"role":"user","content":"x"},{"role":"tool","tool_call_id":"c","content":"boom"}],"tools":[{"type":"function","function":{"name":"read_file"}}]}"""));
        Assert.Contains("boom", await second.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Responses_stream_emits_typed_events_through_completed()
    {
        await using var s = await TestServer.StartAsync();
        var text = await (await s.Http.PostAsync("/v1/responses?scenario=reasoning",
            TestServer.Json("""{"model":"m","stream":true,"input":"hi"}"""))).Content.ReadAsStringAsync();
        Assert.Contains("event: response.created", text);
        Assert.Contains("event: response.reasoning_summary_text.delta", text);
        Assert.Contains("event: response.reasoning_text.delta", text);
        Assert.Contains("event: response.output_text.delta", text);
        Assert.Contains("event: response.completed", text);
    }

    [Fact]
    public async Task Messages_non_stream_returns_thinking_then_text()
    {
        await using var s = await TestServer.StartAsync();
        var res = await s.Http.PostAsync("/v1/messages?scenario=reasoning",
            TestServer.Json("""{"model":"m","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}"""));
        var content = JsonNode.Parse(await res.Content.ReadAsStringAsync())!["content"]!;
        Assert.Equal("thinking", (string)content[0]!["type"]!);
        Assert.Equal("text", (string)content[1]!["type"]!);
    }

    [Fact]
    public async Task Error_variants_return_status_retry_after_or_drop_mid_stream()
    {
        await using var s = await TestServer.StartAsync();
        const string body = """{"model":"m","stream":true,"messages":[]}""";
        var r429 = await s.Http.PostAsync("/v1/chat/completions?scenario=error-429", TestServer.Json(body));
        Assert.Equal(HttpStatusCode.TooManyRequests, r429.StatusCode);
        Assert.Equal("5", r429.Headers.RetryAfter!.Delta!.Value.TotalSeconds.ToString());
        var r500 = await s.Http.PostAsync("/v1/chat/completions?scenario=error-500", TestServer.Json(body));
        Assert.Equal(HttpStatusCode.InternalServerError, r500.StatusCode);

        var failed = false;
        try { await (await s.Http.PostAsync("/v1/chat/completions?scenario=error-mid", TestServer.Json(body))).Content.ReadAsStringAsync(); }
        catch (HttpRequestException) { failed = true; }
        Assert.True(failed);
        var recs = await s.RecordsAsync(3);
        Assert.Equal("server_aborted", (string)recs[2]["response"]!["endedBy"]!);
    }

    [Fact]
    public async Task Key_is_enforced_only_when_configured()
    {
        await using var s = await TestServer.StartAsync(o => o.Key = "right");
        var denied = await s.Http.GetAsync("/v1/models");
        Assert.Equal(HttpStatusCode.Unauthorized, denied.StatusCode);
        var req = new HttpRequestMessage(HttpMethod.Get, "/v1/models");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", "right");
        Assert.Equal(HttpStatusCode.OK, (await s.Http.SendAsync(req)).StatusCode);
        var recs = await s.RecordsAsync(2);
        Assert.False((bool)recs[0]["auth"]!["accepted"]!);
    }

    [Fact]
    public async Task Unknown_paths_404_and_are_still_logged_and_prefixless_paths_route()
    {
        await using var s = await TestServer.StartAsync();
        Assert.Equal(HttpStatusCode.NotFound, (await s.Http.PostAsync("/v1/embeddings", TestServer.Json("{}"))).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await s.Http.GetAsync("/models")).StatusCode);
        var recs = await s.RecordsAsync(2);
        Assert.Equal("other", (string)recs[0]["wire"]!);
        Assert.Equal("/v1/embeddings", (string)recs[0]["path"]!);
        Assert.Equal("models", (string)recs[1]["wire"]!);
        Assert.True((bool)recs[1]["matchedBySuffix"]!);
    }

    [Fact]
    public async Task Model_suffix_picks_the_scenario_and_echo_summarizes_the_request()
    {
        await using var s = await TestServer.StartAsync();
        var res = await s.Http.PostAsync("/v1/chat/completions", TestServer.Json(
            """{"model":"capture@echo","messages":[{"role":"user","content":"see C:\\Users\\kev\\proj\\a.ts and https://github.com/a/b"}],"tools":[{"type":"function","function":{"name":"bash"}}]}"""));
        var content = (string)JsonNode.Parse(await res.Content.ReadAsStringAsync())!["choices"]![0]!["message"]!["content"]!;
        Assert.Contains("tools offered: **1**", content);
        Assert.Contains(@"C:\Users\kev\proj\a.ts", content);
        Assert.False(content.Contains("github.com/a/b"));
        Assert.Equal("echo", (string)(await s.RecordsAsync(1))[0]["response"]!["scenario"]!);
    }

    [Fact]
    public async Task Slow_sends_keepalive_comments_unless_disabled()
    {
        await using var s = await TestServer.StartAsync();
        const string body = """{"model":"m","stream":true,"messages":[{"role":"user","content":"x"}]}""";
        var with = await (await s.Http.PostAsync("/v1/chat/completions?scenario=slow", TestServer.Json(body))).Content.ReadAsStringAsync();
        var without = await (await s.Http.PostAsync("/v1/chat/completions?scenario=slow-nokeepalive", TestServer.Json(body))).Content.ReadAsStringAsync();
        Assert.Contains(": keep-alive", with);
        Assert.False(without.Contains(": keep-alive"));
    }

    [Fact]
    public async Task A_client_that_hangs_up_mid_stream_is_recorded_with_its_timing()
    {
        await using var s = await TestServer.StartAsync(o => { o.SlowPause = TimeSpan.FromSeconds(5); o.SlowChunks = 1; });
        var req = new HttpRequestMessage(HttpMethod.Post, "/v1/chat/completions?scenario=slow-nokeepalive")
        {
            Content = TestServer.Json("""{"model":"m","stream":true,"messages":[{"role":"user","content":"x"}]}"""),
        };
        var res = await s.Http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead);
        using (var stream = await res.Content.ReadAsStreamAsync())
        using (var reader = new StreamReader(stream))
        {
            await reader.ReadLineAsync(); // first data line arrived
        }
        res.Dispose();

        var rec = (await s.RecordsAsync(1))[0];
        Assert.Equal("client_aborted", (string)rec["response"]!["endedBy"]!);
        Assert.NotNull(rec["response"]!["clientAbortedAtMs"]);
    }

    [Fact]
    public async Task Repeated_identical_bodies_are_flagged_and_the_report_summarizes_everything()
    {
        await using var s = await TestServer.StartAsync();
        for (var i = 0; i < 2; i++)
            await s.Http.PostAsync("/v1/chat/completions", TestServer.Json(ChatBody.Replace("true", "false")));
        await s.Http.GetAsync("/v1/models");
        var recs = await s.RecordsAsync(3);
        Assert.Equal(1, (int)recs[1]["duplicateOfSeq"]!);

        var report = CaptureReport.BuildFromFiles([s.CaptureFile]);
        Assert.Contains("## Endpoints the app called", report);
        Assert.Contains("repeated an earlier body", report);
        Assert.Contains("/home/kevin/worktrees/feat-x", report);
        Assert.Contains("## Open questions", report);
    }
}

public class RequestAnalyzerTests
{
    private static RequestFacts Analyze(string wire, string json) =>
        RequestAnalyzer.Analyze(wire, new Microsoft.AspNetCore.Http.HeaderDictionary(), JsonNode.Parse(json));

    [Fact]
    public void Finds_paths_but_not_urls_or_prose()
    {
        var f = Analyze("chat", """{"messages":[{"role":"user","content":"open ~/code/app/src/a.ts, see https://example.com/a/b and/or 10/17/2026 and file:///home/k/x.txt in D:\\work\\r"}]}""");
        var paths = f.Json["paths"]!.AsArray().Select(p => (string)p!["path"]!).ToList();
        Assert.True(paths.Contains("~/code/app/src/a.ts"));
        Assert.True(paths.Contains("file:///home/k/x.txt"));
        Assert.True(paths.Contains(@"D:\work\r"));
        Assert.Equal(3, paths.Count);
    }

    [Fact]
    public void Summarizes_tools_reasoning_and_images_across_wire_formats()
    {
        var chat = Analyze("chat", """{"model":"m","reasoning_effort":"high","tool_choice":"auto","tools":[{"type":"function","function":{"name":"a","parameters":{"type":"object"}}}],"messages":[{"role":"user","content":[{"type":"text","text":"x"},{"type":"image_url","image_url":{"url":"data:"}}]}]}""");
        Assert.Equal(1, chat.ToolCount);
        Assert.Equal("a", chat.FirstToolName);
        Assert.True((bool)chat.Json["messages"]!["hasImages"]!);
        Assert.Equal("high", (string)chat.Json["reasoning"]!["reasoning_effort"]!);

        var resp = Analyze("responses", """{"model":"m","instructions":"sys","reasoning":{"effort":"low"},"previous_response_id":"resp_1","tools":[{"type":"function","name":"b"}],"input":[{"type":"function_call_output","call_id":"c","output":"done"}]}""");
        Assert.Equal("b", resp.FirstToolName);
        Assert.True(resp.ContainsToolResults);
        Assert.Contains("previous_response_id", resp.Json["sessionIds"]!.ToJsonString());

        var msg = Analyze("messages", """{"model":"m","system":[{"type":"text","text":"s"}],"thinking":{"type":"enabled","budget_tokens":100},"tools":[{"name":"c","input_schema":{"type":"object"}}],"messages":[{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":"r"}]}]}""");
        Assert.Equal("c", msg.FirstToolName);
        Assert.True(msg.ContainsToolResults);
        Assert.Equal("enabled", (string)msg.Json["reasoning"]!["thinking"]!["type"]!);
    }
}
