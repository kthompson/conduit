using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using Conduit.Provider.Core;

namespace Conduit.Provider.Fake;

/// <summary>
/// Driver kind <c>fake</c>. The last message picks the behavior:
/// <c>[tool:NAME]</c> calls an offered tool, <c>[reason]</c> streams reasoning first, <c>[slow]</c> pauses between words,
/// <c>[fail:limit]</c> / <c>[fail:unavailable]</c> / <c>[fail:boom]</c> throw, a tool result is quoted back, anything else is echoed.
/// Config: <c>models = [..]</c>, <c>delay-ms</c> (pause for <c>[slow]</c>, default 200).
/// </summary>
public sealed class FakeDriver : IProviderDriver
{
    public string Kind => "fake";

    public IProviderInstance Create(ProviderInstanceConfig config, IProviderHost host) =>
        new FakeInstance(config);
}

internal sealed class FakeInstance : IProviderInstance
{
    private readonly int _delayMs;

    public FakeInstance(ProviderInstanceConfig config)
    {
        var slugs = config.Config["models"] is JsonArray a
            ? a.Select(n => n!.GetValue<string>()).ToList()
            : ["fake-1"];
        _delayMs = config.Config["delay-ms"]?.GetValue<int>() ?? 200;
        Snapshot = new ProviderSnapshot(
            config.InstanceId,
            "fake",
            config.DisplayName ?? config.InstanceId,
            config.Enabled ? InstanceStatus.Ready : InstanceStatus.Disabled,
            null,
            "fake-1.0",
            config.Mode,
            slugs
                .Select(s => new ModelInfo(
                    s,
                    s,
                    ContextWindow: 200_000,
                    MaxOutput: 8_192,
                    Reasoning: true
                ))
                .ToList(),
            slugs[0]
        );
    }

    public ProviderSnapshot Snapshot { get; }

    public Task<ProviderSnapshot> RefreshAsync(CancellationToken ct) => Task.FromResult(Snapshot);

    public async IAsyncEnumerable<CompletionEvent> CompleteAsync(
        CompletionRequest request,
        [EnumeratorCancellation] CancellationToken ct
    )
    {
        var last = request.Messages[^1];
        var text = last.Text ?? "";

        if (text.Contains("[fail:limit]"))
            throw new ProviderFailure(
                FailureKind.UsageLimit,
                "Fake usage limit reached.",
                TimeSpan.FromSeconds(30)
            );
        if (text.Contains("[fail:unavailable]"))
            throw new ProviderFailure(FailureKind.Unavailable, "Fake provider is unavailable.");
        if (text.Contains("[fail:boom]"))
            throw new ProviderFailure(FailureKind.Failed, "Fake provider failed.");

        if (text.Contains("[reason]"))
            yield return new ReasoningDelta("Thinking about it. ");

        if (last.Role == "tool")
        {
            foreach (var d in Words("The tool said: " + text))
                yield return d;
            yield return new UsageEvent(Estimate(request), 8);
            yield return new Finish(FinishReason.Stop);
            yield break;
        }

        var marker = text.IndexOf("[tool:", StringComparison.Ordinal);
        if (marker >= 0)
        {
            var name = text[(marker + 6)..text.IndexOf(']', marker)];
            if (request.Tools.All(t => t.Name != name))
                throw new ProviderFailure(
                    FailureKind.BadRequest,
                    $"Tool '{name}' was not offered."
                );
            yield return new ToolCallEvent(
                new ToolCall("call_" + Guid.NewGuid().ToString("N")[..12], name, "{}")
            );
            yield return new UsageEvent(Estimate(request), 4);
            yield return new Finish(FinishReason.ToolCalls);
            yield break;
        }

        var slow = text.Contains("[slow]");
        foreach (var d in Words("echo: " + text))
        {
            ct.ThrowIfCancellationRequested();
            if (slow)
                await Task.Delay(_delayMs, ct);
            yield return d;
        }
        yield return new UsageEvent(Estimate(request), 8);
        yield return new Finish(FinishReason.Stop);
    }

    private static IEnumerable<TextDelta> Words(string s) =>
        s.Split(' ').Select((w, i) => new TextDelta(i == 0 ? w : " " + w));

    private static int Estimate(CompletionRequest r) =>
        r.Messages.Sum(m => (m.Text?.Length ?? 0) / 4 + 1);

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;
}
