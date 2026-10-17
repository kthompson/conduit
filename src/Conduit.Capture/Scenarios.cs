using Conduit.Capture.Wire;

namespace Conduit.Capture;

/// <summary>What the server will do for one request: fail before streaming, or play a script.</summary>
public sealed class ScenarioPlan
{
    public int? ErrorStatus { get; init; }
    public string ErrorType { get; init; } = "server_error";
    public string ErrorCode { get; init; } = "capture_error";
    public string ErrorMessage { get; init; } = "";
    public int? RetryAfterSeconds { get; init; }
    public IEnumerable<ScriptEvent> Events { get; init; } = [];
    public string Label { get; init; } = "";
}

public sealed record ScenarioContext(
    RequestFacts Facts,
    CaptureOptions Options,
    string Wire,
    long Seq,
    int ErrorCycle
);

public static class Scenarios
{
    public static ScenarioPlan Plan(ScenarioSpec spec, ScenarioContext c)
    {
        var label = spec.ToString();
        if (!spec.IsKnown)
            return Plan(
                label,
                Text(
                    $"Unknown scenario `{spec}`. Known scenarios: {string.Join(", ", ScenarioSpec.Names)}. "
                        + "Pick one with `?scenario=`, the `X-Capture-Scenario` header, a model id suffix like `capture@slow`, or `--scenario`."
                )
            );

        return spec.Name switch
        {
            "text" => Plan(label, TextScenario()),
            "slow" => Plan(label, Slow(spec, c)),
            "progress" => Plan(label, Progress()),
            "reasoning" => Plan(label, Reasoning(c.Wire)),
            "toolcall" => Plan(label, ToolCall(c)),
            "error" => ErrorPlan(spec, c, label),
            _ => Plan(label, Text(c.Facts.Summary(label), delayMs: 0)), // echo
        };
    }

    private static ScenarioPlan Plan(string label, IEnumerable<ScriptEvent> events) =>
        new() { Label = label, Events = events };

    // Words as individual deltas with a small pause, so streaming is visible.
    private static IEnumerable<ScriptEvent> Text(string text, int delayMs = 15)
    {
        foreach (var chunk in Chunk(text))
        {
            yield return new TextDelta(chunk);
            if (delayMs > 0)
                yield return new Pause(TimeSpan.FromMilliseconds(delayMs), false);
        }
        yield return new Finish("stop");
    }

    private static IEnumerable<string> Chunk(string text)
    {
        var start = 0;
        while (start < text.Length)
        {
            var next = text.IndexOf(' ', start);
            var end = next < 0 ? text.Length : next + 1;
            yield return text[start..end];
            start = end;
        }
    }

    private static IEnumerable<ScriptEvent> TextScenario() =>
        Text(
            "Capture server here. This is the `text` scenario: a short plain streamed answer. "
                + "If you can read this, the wire format works."
        );

    private static IEnumerable<ScriptEvent> Slow(ScenarioSpec spec, ScenarioContext c)
    {
        var keepAlive = c.Options.KeepAlive && spec.Variant != "nokeepalive";
        yield return new TextDelta(
            $"`slow` scenario: {c.Options.SlowChunks} chunks, {c.Options.SlowPause.TotalSeconds:0.#}s apart, "
                + $"keep-alive comments {(keepAlive ? "ON" : "OFF")}.\n\n"
        );
        var started = DateTime.UtcNow;
        for (var i = 1; i <= c.Options.SlowChunks; i++)
        {
            yield return new Pause(c.Options.SlowPause, keepAlive);
            yield return new TextDelta(
                $"chunk {i}/{c.Options.SlowChunks} at {(DateTime.UtcNow - started).TotalSeconds:0}s\n"
            );
        }
        yield return new TextDelta("\nDone: the client waited through every pause.");
        yield return new Finish("stop");
    }

    private static IEnumerable<ScriptEvent> Progress()
    {
        string[] lines =
        [
            "**Working on it...**\n\n",
            "- ran `git status` (exit 0)\n",
            "- read `src/index.ts`\n",
            "- read `src/a.ts`\n",
            "- edited `src/a.ts` (+12 -3)\n",
            "- ran `npm test` (exit 1)\n\n",
            "```text\nFAIL src/a.test.ts\n  x adds numbers (3 ms)\n    expected 4, received 3\n```\n\n",
            "- edited `src/a.ts` (+1 -1)\n",
            "- ran `npm test` (exit 0)\n",
            "- ran `npm run lint` (exit 0)\n\n",
            "> The agent declined a request to run `rm -rf build/` (approval required).\n\n",
            "| file | change |\n|---|---|\n| `src/a.ts` | +13 -4 |\n| `src/a.test.ts` | +0 -0 |\n\n",
            "**Done.** All tests pass. This whole message was one assistant turn made of progress lines.",
        ];
        foreach (var l in lines)
        {
            yield return new TextDelta(l);
            yield return new Pause(TimeSpan.FromMilliseconds(400), false);
        }
        yield return new Finish("stop");
    }

    private static IEnumerable<ScriptEvent> Reasoning(string wire)
    {
        var shapes = wire switch
        {
            "responses" => new[] { ReasoningShape.ResponsesSummary, ReasoningShape.ResponsesText },
            "messages" => new[] { ReasoningShape.AnthropicThinking },
            _ => new[]
            {
                ReasoningShape.ChatReasoningContent,
                ReasoningShape.ChatReasoning,
                ReasoningShape.ChatReasoningDetails,
            },
        };
        foreach (var shape in shapes)
        {
            foreach (
                var part in new[]
                {
                    $"[{shape}] Considering the request. ",
                    "Weighing two options. ",
                    "Picking the simpler one.",
                }
            )
            {
                yield return new ReasoningDelta(part, shape);
                yield return new Pause(TimeSpan.FromMilliseconds(120), false);
            }
        }
        yield return new TextDelta(
            $"`reasoning` scenario done. I streamed reasoning in {shapes.Length} shape(s) for the `{wire}` wire: "
                + $"{string.Join(", ", shapes)}. Which of them did the app display?"
        );
        yield return new Finish("stop");
    }

    private static IEnumerable<ScriptEvent> ToolCall(ScenarioContext c)
    {
        var f = c.Facts;
        if (f.ContainsToolResults)
        {
            foreach (
                var e in Text(
                    "`toolcall` scenario: the app ran the tool and sent a result back. "
                        + $"Result starts with: {f.ToolResultSnippet ?? "(empty)"}"
                )
            )
                yield return e;
            yield break;
        }
        if (f.FirstToolName is null)
        {
            foreach (
                var e in Text(
                    "`toolcall` scenario: this request offered no tools, so there was nothing to call."
                )
            )
                yield return e;
            yield break;
        }
        yield return new TextDelta($"Calling `{f.FirstToolName}` with bogus arguments.\n");
        yield return new ToolCallEvent(
            $"call_capture_{c.Seq}",
            f.FirstToolName,
            "{\"capture_probe\":\"bogus\",\"value\":42}"
        );
        yield return new Finish("tool_calls");
    }

    private static ScenarioPlan ErrorPlan(ScenarioSpec spec, ScenarioContext c, string label)
    {
        var variant = spec.Variant is "429" or "500" or "mid"
            ? spec.Variant
            : new[] { "429", "500", "mid" }[c.ErrorCycle % 3];
        label = $"error-{variant}";
        return variant switch
        {
            "429" => new ScenarioPlan
            {
                Label = label,
                ErrorStatus = 429,
                ErrorType = "rate_limit_error",
                ErrorCode = "rate_limit_exceeded",
                ErrorMessage = "Capture server: simulated rate limit. Retry after 5 seconds.",
                RetryAfterSeconds = 5,
            },
            "500" => new ScenarioPlan
            {
                Label = label,
                ErrorStatus = 500,
                ErrorType = "server_error",
                ErrorCode = "capture_server_error",
                ErrorMessage = "Capture server: simulated internal error.",
            },
            _ => Plan(label, MidStream()),
        };
    }

    private static IEnumerable<ScriptEvent> MidStream()
    {
        foreach (
            var chunk in new[]
            {
                "This answer starts fine, ",
                "then the connection ",
                "fails in the middle.",
            }
        )
        {
            yield return new TextDelta(chunk);
            yield return new Pause(TimeSpan.FromMilliseconds(300), false);
        }
        yield return new StreamError("Capture server: simulated failure mid-stream.");
    }
}
