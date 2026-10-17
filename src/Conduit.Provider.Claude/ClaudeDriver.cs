using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Conduit.Provider.Core;

namespace Conduit.Provider.Claude;

/// <summary>
/// Driver kind <c>claudeAgent</c> (same slug as t3code). Only model mode exists so far: the claude CLI runs with every built-in
/// tool, MCP server, hook, skill and user setting switched off, and the caller's tools are carried as a prompt protocol.
/// Config: <c>binary-path</c> (default "claude"), <c>models</c> (list of slugs; default sonnet, opus, haiku), <c>default-model</c>.
/// </summary>
public sealed class ClaudeDriver(IClaudeProcess? process = null) : IProviderDriver
{
    public string Kind => "claudeAgent";

    public IProviderInstance Create(ProviderInstanceConfig config, IProviderHost host)
    {
        if (config.Mode != "model")
            throw new ProviderFailure(
                FailureKind.BadRequest,
                $"Mode '{config.Mode}' is not supported yet; only 'model' is."
            );
        return new ClaudeInstance(config, host, process ?? new SystemClaudeProcess());
    }
}

internal sealed class ClaudeInstance : IProviderInstance
{
    private static readonly (string Slug, string Name)[] DefaultModels =
    [
        ("sonnet", "Claude Sonnet"),
        ("opus", "Claude Opus"),
        ("haiku", "Claude Haiku"),
    ];

    /// <summary>Extra attempts after an unusable tool call. One is enough to fix a missed argument; more would only add latency.</summary>
    private const int MaxRepairs = 1;

    private static readonly HashSet<string> Efforts = ["low", "medium", "high", "xhigh", "max"];

    private readonly ProviderInstanceConfig _config;
    private readonly IProviderHost _host;
    private readonly IClaudeProcess _process;
    private readonly string _binary;
    private readonly IReadOnlyList<ModelInfo> _models;
    private readonly string _defaultModel;

    public ClaudeInstance(ProviderInstanceConfig config, IProviderHost host, IClaudeProcess process)
    {
        _config = config;
        _host = host;
        _process = process;
        _binary = config.Config["binary-path"]?.GetValue<string>() ?? "claude";
        _models = config.Config["models"] is JsonArray a
            ? a.Select(n => new ModelInfo(
                    n!.GetValue<string>(),
                    n.GetValue<string>(),
                    Reasoning: true
                ))
                .ToList()
            : DefaultModels.Select(m => new ModelInfo(m.Slug, m.Name, Reasoning: true)).ToList();
        _defaultModel = config.Config["default-model"]?.GetValue<string>() ?? _models[0].Slug;
        Snapshot = Build(
            config.Enabled ? InstanceStatus.Unavailable : InstanceStatus.Disabled,
            config.Enabled ? "Not probed yet." : null,
            null
        );
    }

    public ProviderSnapshot Snapshot { get; private set; }

    private ProviderSnapshot Build(InstanceStatus status, string? message, string? version) =>
        new(
            _config.InstanceId,
            "claudeAgent",
            _config.DisplayName ?? _config.InstanceId,
            status,
            message,
            version,
            "model",
            _models,
            _defaultModel
        );

    private ClaudeInvocation Probe(params string[] args) =>
        new(_binary, args, _host.ScratchDirectory(_config.InstanceId), _config.Environment, null);

    /// <summary>Version and auth state only: neither opens a session, starts MCP servers, or runs hooks.</summary>
    public async Task<ProviderSnapshot> RefreshAsync(CancellationToken ct)
    {
        if (!_config.Enabled)
            return Snapshot = Build(InstanceStatus.Disabled, null, null);
        try
        {
            var (code, version) = await _process.RunToEndAsync(Probe("--version"), ct);
            if (code != 0)
                return Snapshot = Build(
                    InstanceStatus.Unavailable,
                    $"'{_binary} --version' exited with {code}.",
                    null
                );
            version = version.Trim();

            var (_, auth) = await _process.RunToEndAsync(Probe("auth", "status"), ct);
            var loggedIn = false;
            try
            {
                loggedIn = JsonNode.Parse(auth)?["loggedIn"]?.GetValue<bool>() ?? false;
            }
            catch (JsonException) { }
            return Snapshot = loggedIn
                ? Build(InstanceStatus.Ready, null, version)
                : Build(
                    InstanceStatus.Unavailable,
                    $"Not signed in. Run `{_binary} auth login`.",
                    version
                );
        }
        catch (ProviderFailure f)
        {
            return Snapshot = Build(InstanceStatus.Unavailable, f.Message, null);
        }
    }

    public async IAsyncEnumerable<CompletionEvent> CompleteAsync(
        CompletionRequest request,
        [EnumeratorCancellation] CancellationToken ct
    )
    {
        var slug = request.Model;
        if (
            _models.All(m => m.Slug != slug)
            && !slug.StartsWith("claude-", StringComparison.Ordinal)
        )
            throw new ProviderFailure(
                FailureKind.BadRequest,
                $"Unknown model '{slug}'. Known: {string.Join(", ", _models.Select(m => m.Slug))}."
            );

        var built = PromptBuilder.Build(request);
        var scratch = _host.ScratchDirectory(_config.InstanceId);
        var promptFile = Path.Combine(scratch, $"system-{Guid.NewGuid():N}.txt");
        await File.WriteAllTextAsync(promptFile, built.SystemPrompt, ct);

        var args = new List<string>
        {
            "-p",
            "--tools",
            "",
            "--strict-mcp-config",
            "--mcp-config",
            "{\"mcpServers\":{}}",
            "--no-session-persistence",
            "--setting-sources",
            "",
            "--disable-slash-commands",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--system-prompt-file",
            promptFile,
            "--model",
            slug,
        };
        if (request.ReasoningEffort is { } e && Efforts.Contains(e))
        {
            args.Add("--effort");
            args.Add(e);
        }

        var env = new Dictionary<string, string>(_config.Environment);
        if (request.MaxTokens is { } max)
            env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] = max.ToString();

        var tools = request.ToolChoice == "none" ? [] : request.Tools;
        TranslatedTurn? turn = null;
        int promptTokens = 0,
            completionTokens = 0;
        try
        {
            // Attempt 0 streams text live. If its tool calls cannot be run as written, one more attempt shows the model its mistake;
            // that attempt buffers its text so nothing the client already saw is repeated.
            for (var attempt = 0; attempt <= MaxRepairs; attempt++)
            {
                var translator = new StreamTranslator(tools, bufferText: attempt > 0);
                var prompt =
                    attempt == 0
                        ? built.Prompt
                        : PromptBuilder.Repair(built, turn!.RawReply, turn.Problem!);
                await foreach (
                    var line in _process.RunAsync(
                        new ClaudeInvocation(_binary, args, scratch, env, prompt),
                        ct
                    )
                )
                {
                    foreach (var ev in translator.Feed(line))
                        yield return ev;
                    // The model ran on past its tool call. Leaving the loop disposes the process stream, which kills the process.
                    if (translator.Stopped)
                        break;
                }
                turn = translator.Complete();
                // The prompt size clients track for compaction is the size of the request that produced the answer, not the sum of attempts.
                promptTokens = turn.PromptTokens;
                completionTokens += turn.CompletionTokens;
                if (turn.Problem is null)
                    break;
                _host.Warn(
                    _config.InstanceId,
                    attempt < MaxRepairs
                        ? $"Unusable tool call, retrying once: {turn.Problem}. Raw reply: {Excerpt(turn.RawReply)}"
                        : $"Tool call still unusable after the retry, sending it as is: {turn.Problem}. Raw reply: {Excerpt(turn.RawReply)}"
                );
            }

            foreach (var ev in turn!.Events)
                yield return ev is UsageEvent ? new UsageEvent(promptTokens, completionTokens) : ev;
        }
        finally
        {
            try
            {
                File.Delete(promptFile);
            }
            catch (IOException) { }
        }
    }

    private static string Excerpt(string s) =>
        (s.Length <= 700 ? s : s[..700] + "...").ReplaceLineEndings("\\n");

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;
}
