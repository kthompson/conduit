using System.Net;
using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using Conduit.Provider.Claude;
using Conduit.Provider.Core;

namespace Conduit.Server.Tests;

/// <summary>Replays recorded claude stream-json (Fixtures/) through the real translator and driver. No process is started.</summary>
public class ClaudeTests
{
    private static string[] Fixture(string name) =>
        File.ReadAllLines(Path.Combine(AppContext.BaseDirectory, "Fixtures", name));

    private static List<ToolSpec> Specs(params string[] names) =>
        names.Select(n => new ToolSpec(n, null, null)).ToList();

    private static List<CompletionEvent> Translate(IEnumerable<string> lines, bool tools)
    {
        var t = new StreamTranslator(tools ? Specs("bash", "view", "a", "b", "x") : []);
        var events = new List<CompletionEvent>();
        foreach (var l in lines)
            events.AddRange(t.Feed(l));
        events.AddRange(t.Complete().Events);
        return events;
    }

    private static string StreamLine(string textDelta) =>
        new JsonObject
        {
            ["type"] = "stream_event",
            ["event"] = new JsonObject
            {
                ["type"] = "content_block_delta",
                ["delta"] = new JsonObject { ["type"] = "text_delta", ["text"] = textDelta },
            },
        }.ToJsonString();

    [Fact]
    public void Recorded_plain_reply_becomes_text_usage_and_stop()
    {
        var events = Translate(Fixture("claude-text.jsonl"), tools: false);
        Assert.Equal(
            "Hello, how are you?",
            string.Concat(events.OfType<TextDelta>().Select(e => e.Text))
        );
        Assert.True(events.OfType<UsageEvent>().Single().PromptTokens > 0);
        Assert.Equal(FinishReason.Stop, events.OfType<Finish>().Single().Reason);
    }

    [Fact]
    public void Recorded_tool_call_split_across_tiny_chunks_is_parsed_not_leaked_as_text()
    {
        var events = Translate(Fixture("claude-toolcall.jsonl"), tools: true);
        var call = events.OfType<ToolCallEvent>().Single().Call;
        Assert.Equal("bash", call.Name);
        Assert.StartsWith("ls", JsonNode.Parse(call.ArgumentsJson)!["command"]!.GetValue<string>());
        Assert.DoesNotContain(
            "tool_call",
            string.Concat(events.OfType<TextDelta>().Select(e => e.Text))
        );
        Assert.Equal(FinishReason.ToolCalls, events.OfType<Finish>().Single().Reason);
    }

    [Fact]
    public void Text_before_a_tool_call_streams_and_a_partial_open_tag_is_held_back()
    {
        var events = Translate(
            [
                StreamLine("Let me check. <tool"),
                StreamLine("_call>{\"name\":\"view\",\"arguments\":{\"path\":\"a\"}}</tool_"),
                StreamLine("call>"),
            ],
            tools: true
        );
        Assert.Equal(
            "Let me check. ",
            string.Concat(events.OfType<TextDelta>().Select(e => e.Text))
        );
        Assert.Equal("view", events.OfType<ToolCallEvent>().Single().Call.Name);
    }

    [Fact]
    public void A_lone_angle_bracket_is_text_once_it_cannot_be_a_tag()
    {
        var events = Translate([StreamLine("a <"), StreamLine("b and 1 < 2")], tools: true);
        Assert.Equal(
            "a <b and 1 < 2",
            string.Concat(events.OfType<TextDelta>().Select(e => e.Text))
        );
    }

    [Fact]
    public void Invalid_or_unterminated_tool_blocks_are_shown_as_text_instead_of_lost()
    {
        var bad = Translate([StreamLine("<tool_call>not json</tool_call>")], tools: true);
        Assert.Equal(
            "<tool_call>not json</tool_call>",
            string.Concat(bad.OfType<TextDelta>().Select(e => e.Text))
        );
        Assert.Empty(bad.OfType<ToolCallEvent>());

        var open = Translate([StreamLine("hi <tool_call>{\"name\":\"x\"")], tools: true);
        Assert.Equal(
            "hi <tool_call>{\"name\":\"x\"",
            string.Concat(open.OfType<TextDelta>().Select(e => e.Text))
        );
    }

    [Fact]
    public void Text_after_a_tool_call_is_dropped_and_marks_the_stream_stopped()
    {
        var t = new StreamTranslator(Specs("bash"));
        var events = new List<CompletionEvent>();
        foreach (
            var l in new[]
            {
                StreamLine(
                    "Checking.\n<tool_call>{\"name\":\"bash\",\"arguments\":{\"command\":\"ls\"}}</tool_call>"
                ),
                StreamLine("\n\n"),
                StreamLine("The directory is empty."),
            }
        )
            events.AddRange(t.Feed(l));
        events.AddRange(t.Complete().Events);

        Assert.True(t.Stopped);
        Assert.Equal("Checking.\n", string.Concat(events.OfType<TextDelta>().Select(e => e.Text)));
        Assert.Single(events.OfType<ToolCallEvent>());
        Assert.Equal(FinishReason.ToolCalls, events.OfType<Finish>().Single().Reason);
    }

    [Fact]
    public void Several_consecutive_tool_calls_with_only_whitespace_between_are_all_kept()
    {
        var events = Translate(
            [
                StreamLine(
                    "<tool_call>{\"name\":\"a\",\"arguments\":{}}</tool_call>\n<tool_call>{\"name\":\"b\",\"arguments\":{}}</tool_call>\n"
                ),
            ],
            tools: true
        );
        Assert.Equal(["a", "b"], events.OfType<ToolCallEvent>().Select(e => e.Call.Name));
        Assert.Empty(events.OfType<TextDelta>());
    }

    [Fact]
    public async Task Driver_stops_reading_and_releases_the_process_when_the_model_runs_on_after_a_call()
    {
        var consumed = 0;
        IEnumerable<string> Script(ClaudeInvocation _)
        {
            yield return StreamLine("<tool_call>{\"name\":\"bash\",\"arguments\":{}}</tool_call>");
            for (var i = 0; i < 1000; i++)
            {
                consumed++;
                yield return StreamLine("invented answer ");
            }
        }
        var (d, _, dir) = Setup(Script);
        var events = await d.Create(Config(), new Host(dir))
            .CompleteAsync(
                new CompletionRequest(
                    "sonnet",
                    [new ChatMessage("user", "x")],
                    [new ToolSpec("bash", null, null)]
                ),
                default
            )
            .ToListAsync();

        Assert.Single(events.OfType<ToolCallEvent>());
        Assert.Empty(events.OfType<TextDelta>());
        Assert.InRange(consumed, 0, 5);
    }

    [Fact]
    public void Tool_blocks_are_plain_text_when_no_tools_were_offered()
    {
        var events = Translate(
            [StreamLine("<tool_call>{\"name\":\"x\",\"arguments\":{}}</tool_call>")],
            tools: false
        );
        Assert.Empty(events.OfType<ToolCallEvent>());
        Assert.Contains("tool_call", string.Concat(events.OfType<TextDelta>().Select(e => e.Text)));
    }

    [Fact]
    public void Double_encoded_arguments_are_unwrapped()
    {
        var events = Translate(
            [
                StreamLine(
                    "<tool_call>{\"name\":\"bash\",\"arguments\":\"{\\\"command\\\":\\\"ls\\\"}\"}</tool_call>"
                ),
            ],
            tools: true
        );
        Assert.Equal(
            """{"command":"ls"}""",
            events.OfType<ToolCallEvent>().Single().Call.ArgumentsJson
        );
    }

    [Theory]
    [InlineData(
        """{"type":"result","is_error":true,"result":"Not logged in · Please run /login"}""",
        FailureKind.Unavailable
    )]
    [InlineData(
        """{"type":"result","is_error":true,"result":"5-hour usage limit reached"}""",
        FailureKind.UsageLimit
    )]
    [InlineData(
        """{"type":"result","is_error":true,"result":"something odd"}""",
        FailureKind.Failed
    )]
    public void Error_results_map_to_failure_kinds(string line, FailureKind kind)
    {
        var t = new StreamTranslator([]);
        _ = t.Feed(line).ToList();
        Assert.Equal(kind, Assert.Throws<ProviderFailure>(() => t.Complete()).Kind);
    }

    [Fact]
    public void Rejected_rate_limit_event_gives_retry_after()
    {
        var reset = DateTimeOffset.UtcNow.AddMinutes(10).ToUnixTimeSeconds();
        var t = new StreamTranslator([]);
        _ = t.Feed(
                """{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":RESET}}""".Replace(
                    "RESET",
                    reset.ToString()
                )
            )
            .ToList();
        var f = Assert.Throws<ProviderFailure>(() => t.Complete());
        Assert.Equal(FailureKind.UsageLimit, f.Kind);
        Assert.InRange(f.RetryAfter!.Value.TotalSeconds, 500, 700);
    }

    [Fact]
    public void Prompt_puts_system_messages_and_tool_protocol_in_the_system_prompt_and_history_in_the_transcript()
    {
        var req = new CompletionRequest(
            "sonnet",
            [
                new ChatMessage("system", "You are Copilot."),
                new ChatMessage("user", "list files"),
                new ChatMessage(
                    "assistant",
                    null,
                    [new ToolCall("c1", "bash", """{"command":"ls"}""")]
                ),
                new ChatMessage("tool", "a.txt", ToolCallId: "c1"),
            ],
            [new ToolSpec("bash", "Run a command", """{"type":"object"}""")]
        );
        var built = PromptBuilder.Build(req);

        Assert.Contains("You are Copilot.", built.SystemPrompt);
        Assert.Contains("<tool_call>", built.SystemPrompt);
        Assert.Contains("\"name\":\"bash\"", built.SystemPrompt);
        Assert.Contains("[user]\nlist files", built.Prompt);
        Assert.Contains(
            """<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>""",
            built.Prompt
        );
        Assert.Contains("[tool result for c1]\na.txt", built.Prompt);
    }

    [Fact]
    public void A_single_user_message_is_sent_as_is_and_tool_choice_none_hides_the_protocol()
    {
        var built = PromptBuilder.Build(
            new CompletionRequest(
                "sonnet",
                [new ChatMessage("user", "hi")],
                [new ToolSpec("bash", null, null)],
                ToolChoice: "none"
            )
        );
        Assert.Equal("hi", built.Prompt);
        Assert.DoesNotContain("Tool calling", built.SystemPrompt);
    }

    [Fact]
    public void Required_tool_choice_is_stated_in_the_protocol()
    {
        var built = PromptBuilder.Build(
            new CompletionRequest(
                "sonnet",
                [new ChatMessage("user", "hi")],
                [new ToolSpec("bash", null, null)],
                ToolChoice: "fn:bash"
            )
        );
        Assert.Contains("must call the tool 'bash'", built.SystemPrompt);
    }

    // ---- driver, with a scripted process ----

    private sealed class ScriptedProcess(
        Func<ClaudeInvocation, IEnumerable<string>> script,
        string version = "9.9.9",
        bool loggedIn = true
    ) : IClaudeProcess
    {
        public List<ClaudeInvocation> Runs { get; } = [];

        public async IAsyncEnumerable<string> RunAsync(
            ClaudeInvocation inv,
            [EnumeratorCancellation] CancellationToken ct
        )
        {
            Runs.Add(inv);
            foreach (var l in script(inv))
            {
                await Task.Yield();
                yield return l;
            }
        }

        public Task<(int ExitCode, string Output)> RunToEndAsync(
            ClaudeInvocation inv,
            CancellationToken ct
        ) =>
            Task.FromResult(
                inv.Args[0] == "--version"
                    ? (0, version + " (Claude Code)\n")
                    : (0, $"{{\"loggedIn\":{(loggedIn ? "true" : "false")}}}")
            );
    }

    private sealed class Host(string dir) : IProviderHost
    {
        public string ScratchDirectory(string id) =>
            Directory.CreateDirectory(Path.Combine(dir, id)).FullName;
    }

    private static (ClaudeDriver Driver, ScriptedProcess Process, string Dir) Setup(
        Func<ClaudeInvocation, IEnumerable<string>> script,
        bool loggedIn = true
    )
    {
        var p = new ScriptedProcess(script, loggedIn: loggedIn);
        return (
            new ClaudeDriver(p),
            p,
            Path.Combine(Path.GetTempPath(), "claude-driver-" + Guid.NewGuid().ToString("N"))
        );
    }

    private static ProviderInstanceConfig Config(string mode = "model") =>
        new(
            "claude",
            "claudeAgent",
            null,
            true,
            mode,
            new Dictionary<string, string> { ["X"] = "1" },
            []
        );

    [Fact]
    public async Task Refresh_reports_ready_with_version_when_signed_in_and_unavailable_when_not()
    {
        var (d, _, dir) = Setup(_ => []);
        var ready = await d.Create(Config(), new Host(dir)).RefreshAsync(CancellationToken.None);
        Assert.Equal(InstanceStatus.Ready, ready.Status);
        Assert.Equal("9.9.9 (Claude Code)", ready.Version);
        Assert.Equal(["sonnet", "opus", "haiku"], ready.Models.Select(m => m.Slug));

        var (d2, _, dir2) = Setup(_ => [], loggedIn: false);
        var out2 = await d2.Create(Config(), new Host(dir2)).RefreshAsync(CancellationToken.None);
        Assert.Equal(InstanceStatus.Unavailable, out2.Status);
        Assert.Contains("auth login", out2.Message);
    }

    [Fact]
    public void Agent_mode_is_rejected_until_it_exists()
    {
        var (d, _, dir) = Setup(_ => []);
        Assert.Equal(
            FailureKind.BadRequest,
            Assert.Throws<ProviderFailure>(() => d.Create(Config("agent"), new Host(dir))).Kind
        );
    }

    [Fact]
    public async Task Completion_runs_claude_with_every_built_in_capability_off_and_streams_the_reply()
    {
        var (d, p, dir) = Setup(_ => Fixture("claude-text.jsonl"));
        var instance = d.Create(Config(), new Host(dir));
        var events = await instance
            .CompleteAsync(
                new CompletionRequest(
                    "haiku",
                    [new ChatMessage("user", "hi")],
                    [],
                    ReasoningEffort: "high",
                    MaxTokens: 123
                ),
                default
            )
            .ToListAsync();

        Assert.Equal(
            "Hello, how are you?",
            string.Concat(events.OfType<TextDelta>().Select(e => e.Text))
        );
        var run = Assert.Single(p.Runs);
        Assert.Equal("hi", run.Stdin);
        Assert.Equal("1", run.Env["X"]);
        Assert.Equal("123", run.Env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"]);
        string After(string flag) => run.Args[run.Args.ToList().IndexOf(flag) + 1];
        Assert.Equal("", After("--tools"));
        Assert.Equal("{\"mcpServers\":{}}", After("--mcp-config"));
        Assert.Equal("", After("--setting-sources"));
        Assert.Contains("--strict-mcp-config", run.Args);
        Assert.Contains("--no-session-persistence", run.Args);
        Assert.Contains("--disable-slash-commands", run.Args);
        Assert.Equal("haiku", After("--model"));
        Assert.Equal("high", After("--effort"));
        Assert.StartsWith(Path.Combine(dir, "claude"), run.WorkingDirectory);
        Assert.False(
            File.Exists(After("--system-prompt-file")),
            "the system prompt file is removed after the run"
        );
    }

    [Fact]
    public async Task Unknown_model_is_a_bad_request_and_never_starts_a_process()
    {
        var (d, p, dir) = Setup(_ => []);
        var f = await Assert.ThrowsAsync<ProviderFailure>(() =>
            d.Create(Config(), new Host(dir))
                .CompleteAsync(
                    new CompletionRequest("gpt-9", [new ChatMessage("user", "x")], []),
                    default
                )
                .ToListAsync()
                .AsTask()
        );
        Assert.Equal(FailureKind.BadRequest, f.Kind);
        Assert.Empty(p.Runs);
    }

    [Fact]
    public async Task End_to_end_through_the_server_a_tool_call_comes_back_as_tool_calls()
    {
        var (d, _, _) = Setup(_ => Fixture("claude-toolcall.jsonl"));
        await using var h = await TestHost.StartAsync(
            "provider-instances { claude { driver = claudeAgent } }",
            [d]
        );
        var (r, body) = await h.PostChatAsync(
            """
            {"model":"claude/sonnet","messages":[{"role":"user","content":"list files"}],
             "tools":[{"type":"function","function":{"name":"bash","parameters":{"type":"object"}}}]}
            """
        );
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        var choice = body!["choices"]![0]!;
        Assert.Equal("tool_calls", choice["finish_reason"]!.GetValue<string>());
        Assert.Equal(
            "bash",
            choice["message"]!["tool_calls"]![0]!["function"]!["name"]!.GetValue<string>()
        );
        Assert.True(body["usage"]!["prompt_tokens"]!.GetValue<int>() > 0);
    }

    [Fact]
    public async Task End_to_end_not_signed_in_is_a_503_before_any_process_runs()
    {
        var (d, p, _) = Setup(_ => [], loggedIn: false);
        await using var h = await TestHost.StartAsync(
            "provider-instances { claude { driver = claudeAgent } }",
            [d]
        );
        var (r, body) = await h.PostChatAsync(
            """{"model":"claude","messages":[{"role":"user","content":"x"}]}"""
        );
        Assert.Equal(HttpStatusCode.ServiceUnavailable, r.StatusCode);
        Assert.Contains("auth login", body!["error"]!["message"]!.GetValue<string>());
        Assert.Empty(p.Runs);
    }
}
