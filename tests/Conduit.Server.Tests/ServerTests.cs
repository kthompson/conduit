using System.Net;
using System.Text.Json.Nodes;
using Conduit.Provider.Core;
using Conduit.Provider.Fake;
using Conduit.Server;

namespace Conduit.Server.Tests;

public class ServerTests
{
    private const string Tools = """
        "tools":[{"type":"function","function":{"name":"bash","description":"Run","parameters":{"type":"object","properties":{"command":{"type":"string"}}}}}]
        """;

    [Fact]
    public async Task Healthz_and_models_list_instance_default_and_each_model()
    {
        await using var h = await TestHost.StartAsync();
        Assert.Equal("ok", JsonNode.Parse(await h.Http.GetStringAsync("/healthz"))!["status"]!.GetValue<string>());

        var ids = JsonNode.Parse(await h.Http.GetStringAsync("/v1/models"))!["data"]!.AsArray().Select(m => m!["id"]!.GetValue<string>()).ToList();
        Assert.Equal(["fake", "fake/fake-1", "fake/fake-2"], ids);

        var one = await h.Http.GetAsync("/v1/models/fake/fake-2");
        Assert.Equal(HttpStatusCode.OK, one.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await h.Http.GetAsync("/v1/models/nope")).StatusCode);
    }

    [Fact]
    public async Task Non_streaming_chat_returns_a_chat_completion()
    {
        await using var h = await TestHost.StartAsync();
        var (r, body) = await h.PostChatAsync("""{"model":"fake","messages":[{"role":"user","content":"hello there"}]}""");
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        Assert.Equal("chat.completion", body!["object"]!.GetValue<string>());
        Assert.Equal("fake", body["model"]!.GetValue<string>());
        Assert.Equal("echo: hello there", body["choices"]![0]!["message"]!["content"]!.GetValue<string>());
        Assert.Equal("stop", body["choices"]![0]!["finish_reason"]!.GetValue<string>());
        Assert.True(body["usage"]!["total_tokens"]!.GetValue<int>() > 0);
    }

    [Fact]
    public async Task Streaming_chat_sends_role_deltas_finish_usage_and_done()
    {
        await using var h = await TestHost.StartAsync();
        var r = await h.Http.PostAsync("/v1/chat/completions", TestHost.Json(
            """{"model":"fake/fake-2","stream":true,"stream_options":{"include_usage":true},"messages":[{"role":"user","content":"a b"}]}"""));
        Assert.Equal("text/event-stream", r.Content.Headers.ContentType!.MediaType);
        var data = TestHost.SseData(await r.Content.ReadAsStringAsync());

        Assert.Equal("[DONE]", data[^1]);
        var chunks = data[..^1].Select(d => JsonNode.Parse(d)!).ToList();
        Assert.Equal("assistant", chunks[0]["choices"]![0]!["delta"]!["role"]!.GetValue<string>());
        var text = string.Concat(chunks.Where(c => c["choices"]!.AsArray().Count > 0).Select(c => c["choices"]![0]!["delta"]!["content"]?.GetValue<string>()));
        Assert.Equal("echo: a b", text);
        Assert.Equal("stop", chunks.Last(c => c["choices"]!.AsArray().Count > 0)["choices"]![0]!["finish_reason"]!.GetValue<string>());
        Assert.NotNull(chunks[^1]["usage"]);
        Assert.All(chunks, c => Assert.Equal("fake/fake-2", c["model"]!.GetValue<string>()));
    }

    [Fact]
    public async Task Tool_call_round_trip_is_returned_to_the_caller_not_executed()
    {
        await using var h = await TestHost.StartAsync();
        var (_, first) = await h.PostChatAsync($$"""{"model":"fake","messages":[{"role":"user","content":"[tool:bash]"}],{{Tools}} }""");
        var choice = first!["choices"]![0]!;
        Assert.Equal("tool_calls", choice["finish_reason"]!.GetValue<string>());
        var call = choice["message"]!["tool_calls"]![0]!;
        Assert.Equal("bash", call["function"]!["name"]!.GetValue<string>());
        var id = call["id"]!.GetValue<string>();

        var (_, second) = await h.PostChatAsync(("""
            {"model":"fake","messages":[{"role":"user","content":"[tool:bash]"},
              {"role":"assistant","content":null,"tool_calls":[{"id":"CALLID","type":"function","function":{"name":"bash","arguments":"{}"}}]},
              {"role":"tool","tool_call_id":"CALLID","content":"file.txt"}],TOOLS}
            """).Replace("TOOLS", Tools).Replace("CALLID", id));
        Assert.Equal("The tool said: file.txt", second!["choices"]![0]!["message"]!["content"]!.GetValue<string>());
    }

    [Fact]
    public async Task Streamed_tool_call_arrives_as_indexed_tool_calls_deltas()
    {
        await using var h = await TestHost.StartAsync();
        var r = await h.Http.PostAsync("/v1/chat/completions", TestHost.Json($$"""{"model":"fake","stream":true,"messages":[{"role":"user","content":"[tool:bash]"}],{{Tools}} }"""));
        var chunks = TestHost.SseData(await r.Content.ReadAsStringAsync()).Where(d => d != "[DONE]").Select(d => JsonNode.Parse(d)!).ToList();
        var calls = chunks.Select(c => c["choices"]![0]!["delta"]!["tool_calls"]).Where(t => t is not null).ToList();
        Assert.Equal("bash", calls[0]![0]!["function"]!["name"]!.GetValue<string>());
        Assert.Equal(0, calls[0]![0]!["index"]!.GetValue<int>());
        Assert.Equal("tool_calls", chunks.Last()["choices"]![0]!["finish_reason"]!.GetValue<string>());
    }

    [Fact]
    public async Task Usage_limit_before_output_is_an_http_429_with_retry_after()
    {
        await using var h = await TestHost.StartAsync();
        var (r, body) = await h.PostChatAsync("""{"model":"fake","stream":true,"messages":[{"role":"user","content":"[fail:limit]"}]}""");
        Assert.Equal(HttpStatusCode.TooManyRequests, r.StatusCode);
        Assert.Equal("30", r.Headers.RetryAfter!.Delta!.Value.TotalSeconds.ToString());
        Assert.Equal("usage_limit", body!["error"]!["code"]!.GetValue<string>());
    }

    [Theory]
    [InlineData("[fail:unavailable]", HttpStatusCode.ServiceUnavailable)]
    [InlineData("[fail:boom]", HttpStatusCode.BadGateway)]
    public async Task Provider_failures_map_to_http_errors(string marker, HttpStatusCode expected)
    {
        await using var h = await TestHost.StartAsync();
        var (r, body) = await h.PostChatAsync($$"""{"model":"fake","messages":[{"role":"user","content":"{{marker}}"}]}""");
        Assert.Equal(expected, r.StatusCode);
        Assert.NotNull(body!["error"]!["message"]);
    }

    [Fact]
    public async Task Bad_requests_are_400_with_openai_error_bodies()
    {
        await using var h = await TestHost.StartAsync();
        foreach (var bad in new[]
        {
            """{"messages":[{"role":"user","content":"x"}]}""",
            """{"model":"fake"}""",
            """{"model":"fake","n":2,"messages":[{"role":"user","content":"x"}]}""",
            """{"model":"fake","messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"x"}}]}]}""",
        })
        {
            var (r, body) = await h.PostChatAsync(bad);
            Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
            Assert.NotNull(body!["error"]!["code"]);
        }
        var notJson = await h.Http.PostAsync("/v1/chat/completions", TestHost.Json("{nope"));
        Assert.Equal(HttpStatusCode.BadRequest, notJson.StatusCode);
    }

    [Fact]
    public async Task Unknown_model_and_unknown_route_are_404()
    {
        await using var h = await TestHost.StartAsync();
        var (r, body) = await h.PostChatAsync("""{"model":"ghost","messages":[{"role":"user","content":"x"}]}""");
        Assert.Equal(HttpStatusCode.NotFound, r.StatusCode);
        Assert.Equal("model_not_found", body!["error"]!["code"]!.GetValue<string>());
        Assert.Equal(HttpStatusCode.NotFound, (await h.Http.GetAsync("/v1/nothing")).StatusCode);
    }

    [Fact]
    public async Task Ignored_params_are_listed_in_a_header()
    {
        await using var h = await TestHost.StartAsync();
        var (r, _) = await h.PostChatAsync("""{"model":"fake","temperature":0,"top_p":0.9,"messages":[{"role":"user","content":"x"}]}""");
        Assert.Equal("temperature, top_p", r.Headers.GetValues("X-Ignored-Params").Single());
    }

    [Fact]
    public async Task Api_key_is_required_on_v1_when_configured_but_not_on_healthz()
    {
        await using var h = await TestHost.StartAsync(apiKey: "s3cret");
        using var anon = new HttpClient { BaseAddress = h.Http.BaseAddress };
        Assert.Equal(HttpStatusCode.OK, (await anon.GetAsync("/healthz")).StatusCode);
        var denied = await anon.GetAsync("/v1/models");
        Assert.Equal(HttpStatusCode.Unauthorized, denied.StatusCode);
        Assert.Equal("invalid_api_key", JsonNode.Parse(await denied.Content.ReadAsStringAsync())!["error"]!["code"]!.GetValue<string>());
        Assert.Equal(HttpStatusCode.OK, (await h.Http.GetAsync("/v1/models")).StatusCode);
    }

    [Fact]
    public void Non_loopback_listen_without_a_key_refuses_to_start()
    {
        var config = ConduitConfig.Parse("server { listen = \"0.0.0.0:0\" }");
        var e = Assert.Throws<ConfigException>(() => ConduitServer.Build(config, [new FakeDriver()], _ => { }));
        Assert.Contains("api-keys", e.Message);
    }

    [Fact]
    public async Task Unknown_driver_is_an_unavailable_shadow_not_a_startup_failure()
    {
        await using var h = await TestHost.StartAsync("""
            provider-instances {
              ok { driver = fake }
              ghost { driver = doesNotExist }
              off { driver = fake, enabled = false }
            }
            """);
        var providers = JsonNode.Parse(await h.Http.GetStringAsync("/v1/providers"))!["data"]!.AsArray();
        string Status(string id) => providers.Single(p => p!["id"]!.GetValue<string>() == id)!["status"]!.GetValue<string>();
        Assert.Equal("ready", Status("ok"));
        Assert.Equal("unavailable", Status("ghost"));
        Assert.Equal("disabled", Status("off"));

        var ids = JsonNode.Parse(await h.Http.GetStringAsync("/v1/models"))!["data"]!.AsArray().Select(m => m!["id"]!.GetValue<string>());
        Assert.All(ids, id => Assert.StartsWith("ok", id));

        var (r, _) = await h.PostChatAsync("""{"model":"ghost","messages":[{"role":"user","content":"x"}]}""");
        Assert.Equal(HttpStatusCode.ServiceUnavailable, r.StatusCode);
    }

    [Fact]
    public async Task Client_disconnect_cancels_the_provider()
    {
        await using var h = await TestHost.StartAsync("provider-instances { fake { driver = fake, config { delay-ms = 300 } } }");
        using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(400));
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var req = new HttpRequestMessage(HttpMethod.Post, "/v1/chat/completions")
        {
            Content = TestHost.Json("""{"model":"fake","stream":true,"messages":[{"role":"user","content":"[slow] one two three four five six seven eight nine ten"}]}"""),
        };
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
        {
            using var resp = await h.Http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token);
            await resp.Content.ReadAsStringAsync(cts.Token);
        });
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(3));
        // The server stays healthy afterwards.
        Assert.Equal(HttpStatusCode.OK, (await h.Http.GetAsync("/healthz")).StatusCode);
    }
}
