using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using Conduit.Provider.Claude;
using Conduit.Provider.Core;

namespace Conduit.Server.Tests;

/// <summary>The malformed tool calls haiku was seen to write against Copilot's real 48-tool request, and the repair retry.</summary>
public class ToolCallHardeningTests
{
    private static readonly ToolSpec Bash = new(
        "bash",
        "Run a shell command",
        """
        {"type":"object","properties":{"command":{"type":"string"},"description":{"type":"string"},"timeout":{"type":"integer"}},"required":["command","description"]}
        """
    );
    private static readonly ToolSpec View = new(
        "view",
        "Read a file",
        """{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}"""
    );
    private static readonly List<ToolSpec> Tools = [Bash, View];

    private static string Line(string text) =>
        new JsonObject
        {
            ["type"] = "stream_event",
            ["event"] = new JsonObject
            {
                ["type"] = "content_block_delta",
                ["delta"] = new JsonObject { ["type"] = "text_delta", ["text"] = text },
            },
        }.ToJsonString();

    private static (List<CompletionEvent> Events, TranslatedTurn Turn) Run(
        IEnumerable<string> chunks
    )
    {
        var t = new StreamTranslator(Tools);
        var events = new List<CompletionEvent>();
        foreach (var c in chunks)
            events.AddRange(t.Feed(Line(c)));
        var turn = t.Complete();
        events.AddRange(turn.Events);
        return (events, turn);
    }

    private static ToolCall OnlyCall(List<CompletionEvent> events) =>
        events.OfType<ToolCallEvent>().Single().Call;

    [Fact]
    public void Flat_arguments_with_a_stray_closing_brace_are_read_as_one_call()
    {
        // Verbatim shape from a real haiku reply.
        var (events, turn) = Run([
            "<tool_call>\n{\"name\":\"bash\",\"description\":\"List files\",\"command\":\"ls -la\"}}\n</tool_call>\n\nThe directory is empty.",
        ]);
        var call = OnlyCall(events);
        Assert.Equal("bash", call.Name);
        var args = JsonNode.Parse(call.ArgumentsJson)!;
        Assert.Equal("ls -la", args["command"]!.GetValue<string>());
        Assert.Equal("List files", args["description"]!.GetValue<string>());
        Assert.Null(args["name"]);
        Assert.Null(turn.Problem);
        Assert.Empty(events.OfType<TextDelta>());
    }

    [Theory]
    [InlineData("call")]
    [InlineData("function_call")]
    [InlineData("tool_use")]
    [InlineData("TOOL_CALL")]
    public void Other_tag_names_open_and_close_a_block(string tag)
    {
        var (events, _) = Run([
            $"<{tag}>{{\"name\":\"view\",\"arguments\":{{\"path\":\"a.txt\"}}}}</{tag}>",
        ]);
        Assert.Equal("view", OnlyCall(events).Name);
    }

    [Fact]
    public void A_function_calls_wrapper_around_tool_call_blocks_is_one_block()
    {
        var (events, turn) = Run([
            "<function_calls>\n<tool_call>{\"name\":\"view\",\"arguments\":{\"path\":\"a\"}}</tool_call>\n</function_calls>",
        ]);
        Assert.Equal("view", OnlyCall(events).Name);
        Assert.Empty(events.OfType<TextDelta>());
        Assert.Null(turn.Problem);
    }

    [Fact]
    public void Claude_native_invoke_xml_is_read_with_typed_parameters()
    {
        var (events, turn) = Run([
            "<function_calls><invoke name=\"bash\"><parameter name=\"command\">ls -la</parameter><parameter name=\"description\">List</parameter><parameter name=\"timeout\">30</parameter></invoke></function_calls>",
        ]);
        var args = JsonNode.Parse(OnlyCall(events).ArgumentsJson)!;
        Assert.Equal("ls -la", args["command"]!.GetValue<string>());
        Assert.Equal(30, args["timeout"]!.GetValue<int>());
        Assert.Null(turn.Problem);
    }

    [Fact]
    public void OpenAi_style_function_object_and_string_encoded_arguments_are_read()
    {
        var (events, _) = Run([
            "<tool_call>{\"function\":{\"name\":\"view\",\"arguments\":\"{\\\"path\\\":\\\"b\\\"}\"}}</tool_call>",
        ]);
        Assert.Equal("""{"path":"b"}""", OnlyCall(events).ArgumentsJson);
    }

    [Fact]
    public void Tool_names_are_matched_ignoring_case_and_separators()
    {
        var (events, turn) = Run([
            "<tool_call>{\"name\":\"View\",\"arguments\":{\"path\":\"a\"}}</tool_call>",
        ]);
        Assert.Equal("view", OnlyCall(events).Name);
        Assert.Null(turn.Problem);
    }

    [Fact]
    public void A_tag_split_across_chunks_is_still_recognized_and_never_leaks()
    {
        var (events, _) = Run([
            "Sure.\n<func",
            "tion_ca",
            "lls><tool_ca",
            "ll>{\"name\":\"view\",\"arguments\":{\"path\":\"a\"}}</tool_call></function",
            "_calls>",
        ]);
        Assert.Equal("Sure.\n", string.Concat(events.OfType<TextDelta>().Select(e => e.Text)));
        Assert.Equal("view", OnlyCall(events).Name);
    }

    [Fact]
    public void Comparison_operators_and_html_like_text_are_not_mistaken_for_tags()
    {
        var (events, turn) = Run(["if a < b and <b>bold</b> then x <", " y"]);
        Assert.Equal(
            "if a < b and <b>bold</b> then x < y",
            string.Concat(events.OfType<TextDelta>().Select(e => e.Text))
        );
        Assert.Null(turn.Problem);
    }

    [Fact]
    public void A_missing_required_argument_is_a_problem_but_the_call_is_still_returned()
    {
        var (events, turn) = Run(["<tool_call>{\"name\":\"bash\",\"arguments\":{}}</tool_call>"]);
        Assert.Contains("missing required argument(s): command, description", turn.Problem);
        Assert.Equal("bash", OnlyCall(events).Name);
    }

    [Fact]
    public void An_unknown_tool_is_a_problem_that_lists_what_exists()
    {
        var (_, turn) = Run(["<tool_call>{\"name\":\"rm_rf\",\"arguments\":{}}</tool_call>"]);
        Assert.Contains("no tool named 'rm_rf'", turn.Problem);
        Assert.Contains("bash", turn.Problem);
    }

    [Fact]
    public void An_unreadable_block_is_a_problem_and_is_shown_as_text()
    {
        var (events, turn) = Run(["<tool_call>please run ls</tool_call>"]);
        Assert.NotNull(turn.Problem);
        Assert.Empty(events.OfType<ToolCallEvent>());
        Assert.Contains(
            "please run ls",
            string.Concat(events.OfType<TextDelta>().Select(e => e.Text))
        );
    }

    [Fact]
    public void An_unterminated_block_at_end_of_output_is_still_parsed()
    {
        var (events, turn) = Run(["<tool_call>{\"name\":\"view\",\"arguments\":{\"path\":\"a\"}}"]);
        Assert.Equal("view", OnlyCall(events).Name);
        Assert.Null(turn.Problem);
    }

    // ---- repair retry in the driver ----

    private sealed class Scripted(Func<int, IEnumerable<string>> script) : IClaudeProcess
    {
        public List<ClaudeInvocation> Runs { get; } = [];

        public async IAsyncEnumerable<string> RunAsync(
            ClaudeInvocation inv,
            [EnumeratorCancellation] CancellationToken ct
        )
        {
            var n = Runs.Count;
            Runs.Add(inv);
            foreach (var l in script(n))
            {
                await Task.Yield();
                yield return l;
            }
        }

        public Task<(int ExitCode, string Output)> RunToEndAsync(
            ClaudeInvocation inv,
            CancellationToken ct
        ) => Task.FromResult((0, ""));
    }

    private sealed class Host : IProviderHost
    {
        public string ScratchDirectory(string id) =>
            Directory.CreateDirectory(Path.Combine(Path.GetTempPath(), "repair-" + id)).FullName;
    }

    private static async Task<(List<CompletionEvent> Events, Scripted Process)> Complete(
        Func<int, IEnumerable<string>> script
    )
    {
        var p = new Scripted(script);
        var instance = new ClaudeDriver(p).Create(
            new ProviderInstanceConfig(
                "claude",
                "claudeAgent",
                null,
                true,
                "model",
                new Dictionary<string, string>(),
                []
            ),
            new Host()
        );
        var events = await instance
            .CompleteAsync(
                new CompletionRequest("sonnet", [new ChatMessage("user", "list files")], Tools),
                default
            )
            .ToListAsync();
        return (events, p);
    }

    [Fact]
    public async Task A_call_missing_required_arguments_is_retried_once_and_the_fixed_call_is_returned()
    {
        var (events, p) = await Complete(n =>
            n == 0
                ?
                [
                    Line("I'll check. "),
                    Line(
                        "<tool_call>{\"name\":\"bash\",\"arguments\":{\"command\":\"ls\"}}</tool_call>"
                    ),
                ]
                :
                [
                    Line(
                        "<tool_call>{\"name\":\"bash\",\"arguments\":{\"command\":\"ls\",\"description\":\"List files\"}}</tool_call>"
                    ),
                ]
        );

        Assert.Equal(2, p.Runs.Count);
        Assert.Contains("[harness]", p.Runs[1].Stdin);
        Assert.Contains("missing required argument(s): description", p.Runs[1].Stdin);
        Assert.Contains(
            "<tool_call>{\"name\":\"bash\",\"arguments\":{\"command\":\"ls\"}}</tool_call>",
            p.Runs[1].Stdin
        );
        Assert.Equal(
            "List files",
            JsonNode.Parse(events.OfType<ToolCallEvent>().Single().Call.ArgumentsJson)![
                "description"
            ]!.GetValue<string>()
        );
        Assert.Equal("I'll check. ", string.Concat(events.OfType<TextDelta>().Select(e => e.Text)));
        Assert.Equal(FinishReason.ToolCalls, events.OfType<Finish>().Single().Reason);
    }

    [Fact]
    public async Task Retry_stops_after_one_attempt_and_returns_the_best_effort_call()
    {
        var (events, p) = await Complete(_ =>
            [Line("<tool_call>{\"name\":\"bash\",\"arguments\":{}}</tool_call>")]
        );
        Assert.Equal(2, p.Runs.Count);
        Assert.Equal("bash", events.OfType<ToolCallEvent>().Single().Call.Name);
    }

    [Fact]
    public async Task A_retry_that_answers_in_plain_text_returns_that_text()
    {
        var (events, p) = await Complete(n =>
            n == 0 ? [Line("<tool_call>nonsense</tool_call>")] : [Line("Here are the files: a, b.")]
        );
        Assert.Equal(2, p.Runs.Count);
        var text = string.Concat(events.OfType<TextDelta>().Select(e => e.Text));
        Assert.Contains("Here are the files: a, b.", text);
        Assert.Empty(events.OfType<ToolCallEvent>());
    }

    [Fact]
    public void A_call_missing_its_final_closing_brace_is_repaired_and_runs()
    {
        // Verbatim from a real reply: the outer object is never closed before </tool_call>.
        var (events, turn) = Run([
            "<tool_call>{\"name\":\"bash\",\"arguments\":{\"command\":\"cd /x && export PATH=/tmp/d:$PATH && dotnet publish 2>&1 | tail -60\",\"description\":\"Test publish\",\"initial_wait\":180}</tool_call>",
        ]);
        var args = JsonNode.Parse(OnlyCall(events).ArgumentsJson)!;
        Assert.Equal(
            "cd /x && export PATH=/tmp/d:$PATH && dotnet publish 2>&1 | tail -60",
            args["command"]!.GetValue<string>()
        );
        Assert.Equal(180, args["initial_wait"]!.GetValue<int>());
        Assert.Null(turn.Problem);
        Assert.Empty(events.OfType<TextDelta>());
    }

    [Fact]
    public async Task An_unreadable_block_that_survives_the_retry_is_shown_exactly_once()
    {
        // The user saw the raw block twice: once per attempt. It must now be held until the last attempt and shown once.
        var (events, p) = await Complete(_ =>
            [Line("<tool_call>this is not json at all</tool_call>")]
        );
        Assert.Equal(2, p.Runs.Count);
        Assert.Equal(
            "<tool_call>this is not json at all</tool_call>",
            string.Concat(events.OfType<TextDelta>().Select(e => e.Text))
        );
        Assert.Empty(events.OfType<ToolCallEvent>());
    }

    [Fact]
    public async Task A_valid_call_is_not_retried()
    {
        var (_, p) = await Complete(_ =>
            [Line("<tool_call>{\"name\":\"view\",\"arguments\":{\"path\":\"a\"}}</tool_call>")]
        );
        Assert.Single(p.Runs);
    }

    [Fact]
    public async Task Usage_reports_the_final_prompt_size_and_all_output_tokens()
    {
        static string Usage(int input, int output) =>
            new JsonObject
            {
                ["type"] = "stream_event",
                ["event"] = new JsonObject
                {
                    ["type"] = "message_delta",
                    ["delta"] = new JsonObject(),
                    ["usage"] = new JsonObject
                    {
                        ["input_tokens"] = input,
                        ["output_tokens"] = output,
                    },
                },
            }.ToJsonString();

        var (events, _) = await Complete(n =>
            n == 0
                ?
                [
                    Line("<tool_call>{\"name\":\"bash\",\"arguments\":{}}</tool_call>"),
                    Usage(100, 10),
                ]
                :
                [
                    Line(
                        "<tool_call>{\"name\":\"bash\",\"arguments\":{\"command\":\"ls\",\"description\":\"d\"}}</tool_call>"
                    ),
                    Usage(150, 20),
                ]
        );
        var usage = events.OfType<UsageEvent>().Single();
        Assert.Equal((150, 30), (usage.PromptTokens, usage.CompletionTokens));
    }

    [Fact]
    public void The_prompt_ends_with_a_tool_reminder_and_the_system_prompt_demands_required_arguments()
    {
        var built = PromptBuilder.Build(
            new CompletionRequest("sonnet", [new ChatMessage("user", "hi")], Tools)
        );
        Assert.EndsWith(
            "nothing after it. Never state a tool's result yourself: the harness will send it.",
            built.Prompt
        );
        Assert.Contains("every argument the schema lists under \"required\"", built.SystemPrompt);

        var repaired = PromptBuilder.Repair(built, "<tool_call>bad</tool_call>", "no good");
        Assert.StartsWith("Here is the conversation so far.", repaired);
        Assert.Contains("[user]\nhi", repaired);
        Assert.Contains("[assistant]\n<tool_call>bad</tool_call>", repaired);
        Assert.Contains("That reply could not be used: no good.", repaired);
    }
}

public class ClaudeProcessTests
{
    [Fact]
    public async Task A_missing_binary_is_unavailable_with_advice_that_does_not_mention_the_working_directory()
    {
        var dir = Directory
            .CreateDirectory(
                Path.Combine(Path.GetTempPath(), "proc-" + Guid.NewGuid().ToString("N"))
            )
            .FullName;
        var inv = new ClaudeInvocation(
            "/nonexistent/claude-" + Guid.NewGuid().ToString("N"),
            ["--version"],
            dir,
            new Dictionary<string, string>(),
            null
        );
        var f = await Assert.ThrowsAsync<ProviderFailure>(() =>
            new SystemClaudeProcess().RunToEndAsync(inv, default)
        );
        Assert.Equal(FailureKind.Unavailable, f.Kind);
        Assert.Contains("on PATH", f.Message);
        Assert.Contains("binary-path", f.Message);
        Assert.DoesNotContain("working directory", f.Message);
    }
}

public class ChunkSplitTests
{
    private static readonly List<ToolSpec> Create =
    [
        new(
            "create",
            "Create a file",
            """{"type":"object","properties":{"path":{"type":"string"},"file_text":{"type":"string"}},"required":["path","file_text"]}"""
        ),
    ];

    private static string Line(string text) =>
        new JsonObject
        {
            ["type"] = "stream_event",
            ["event"] = new JsonObject
            {
                ["type"] = "content_block_delta",
                ["delta"] = new JsonObject { ["type"] = "text_delta", ["text"] = text },
            },
        }.ToJsonString();

    private static (string Text, int Calls, string? Problem) Run(IEnumerable<string> chunks)
    {
        var t = new StreamTranslator(Create);
        var events = new List<CompletionEvent>();
        foreach (var c in chunks)
            events.AddRange(t.Feed(Line(c)));
        var turn = t.Complete();
        events.AddRange(turn.Events);
        return (
            string.Concat(events.OfType<TextDelta>().Select(e => e.Text)),
            events.OfType<ToolCallEvent>().Count(),
            turn.Problem
        );
    }

    [Theory]
    [InlineData(
        "Now creating the workflow.\n\n<tool_call>{\"name\":\"create\",\"arguments\":{\"path\":\"/a/ci.yml\",\"file_text\":\"name: CI\\non:\\n  push: {}\\n\"}}</tool_call>"
    )]
    [InlineData(
        "<tool_call>{\"name\":\"create\",\"arguments\":{\"path\":\"/a/ci.yml\",\"file_text\":\"x\"}}</tool_call>"
    )]
    [InlineData(
        "<tool_call>{\"name\":\"create\",\"arguments\":{\"path\":\"/a/ci.yml\",\"file_text\":\"x\"}}"
    )]
    [InlineData(
        "ok\n<function_calls>\n<tool_call>{\"name\":\"create\",\"arguments\":{\"path\":\"p\",\"file_text\":\"t\"}}</tool_call>\n</function_calls>"
    )]
    public void The_call_is_found_for_every_way_the_stream_can_be_chunked(string full)
    {
        var expectedText =
            full.StartsWith("Now") ? "Now creating the workflow.\n\n"
            : full.StartsWith("ok") ? "ok\n"
            : "";
        // Every pair of split points, so tags, braces and escapes are cut at every possible place.
        for (var i = 0; i <= full.Length; i++)
        for (var j = i; j <= full.Length; j++)
        {
            var (text, calls, problem) = Run([full[..i], full[i..j], full[j..]]);
            Assert.True(
                calls == 1 && problem is null && text == expectedText,
                $"split at {i},{j}: calls={calls} problem={problem} text=[{text}]"
            );
        }
    }
}

public class BareCallTests
{
    private static readonly List<ToolSpec> Tools =
    [
        new(
            "create",
            null,
            """{"type":"object","properties":{"path":{"type":"string"},"file_text":{"type":"string"}},"required":["path","file_text"]}"""
        ),
        new("bash", null, null),
    ];

    private static string Line(string text) =>
        new JsonObject
        {
            ["type"] = "stream_event",
            ["event"] = new JsonObject
            {
                ["type"] = "content_block_delta",
                ["delta"] = new JsonObject { ["type"] = "text_delta", ["text"] = text },
            },
        }.ToJsonString();

    private static (string Text, List<ToolCall> Calls, string? Problem) Run(params string[] chunks)
    {
        var t = new StreamTranslator(Tools);
        var events = new List<CompletionEvent>();
        foreach (var c in chunks)
            events.AddRange(t.Feed(Line(c)));
        var turn = t.Complete();
        events.AddRange(turn.Events);
        return (
            string.Concat(events.OfType<TextDelta>().Select(e => e.Text)),
            events.OfType<ToolCallEvent>().Select(e => e.Call).ToList(),
            turn.Problem
        );
    }

    // Verbatim shape of a real reply: the "<tool" never arrived, the text begins with "_call>{".
    private const string Mangled =
        "_call>{\"name\":\"create\",\"arguments\":{\"path\":\"/a/ci.yml\",\"file_text\":\"name: CI\\non: push\\nenv: ${{ github.ref }}\\n\"}}";

    [Fact]
    public void A_call_whose_opening_tag_was_mangled_is_still_run_and_the_remnant_is_not_shown()
    {
        var (text, calls, problem) = Run(Mangled);
        Assert.Equal("create", Assert.Single(calls).Name);
        Assert.Null(problem);
        Assert.Equal("", text);
    }

    [Fact]
    public void The_mangled_call_is_found_for_every_chunking()
    {
        for (var i = 0; i <= Mangled.Length; i++)
        for (var j = i; j <= Mangled.Length; j++)
        {
            var (text, calls, problem) = Run(Mangled[..i], Mangled[i..j], Mangled[j..]);
            Assert.True(
                calls.Count == 1 && problem is null && text == "",
                $"split {i},{j}: calls={calls.Count} text=[{text}] problem={problem}"
            );
        }
    }

    [Fact]
    public void Text_before_a_bare_call_is_kept()
    {
        var (text, calls, _) = Run(
            "Creating it now.\n\n{\"name\":\"bash\",\"arguments\":{\"command\":\"ls\"}}"
        );
        Assert.Equal("Creating it now.\n\n", text);
        Assert.Equal("bash", Assert.Single(calls).Name);
    }

    [Fact]
    public void A_json_example_naming_no_offered_tool_is_ordinary_text()
    {
        const string prose =
            "A config looks like {\"name\":\"my-app\",\"version\":\"1\"} in package.json.";
        var (text, calls, problem) = Run(prose);
        Assert.Equal(prose, text);
        Assert.Empty(calls);
        Assert.Null(problem);
    }

    [Fact]
    public void A_bare_call_with_a_missing_final_brace_is_repaired()
    {
        var (_, calls, _) = Run("{\"name\":\"bash\",\"arguments\":{\"command\":\"ls\"}");
        Assert.Equal("bash", Assert.Single(calls).Name);
    }
}
