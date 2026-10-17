using System.Text.Json.Nodes;

namespace Conduit.Provider.Core;

public enum InstanceStatus
{
    Ready,
    Disabled,
    Unavailable,
}

public sealed record ModelInfo(
    string Slug,
    string DisplayName,
    int ContextWindow = 200_000,
    int MaxOutput = 32_000,
    bool Reasoning = false
);

/// <summary>What <c>/v1/providers</c> and <c>/v1/models</c> report for one instance.</summary>
public sealed record ProviderSnapshot(
    string InstanceId,
    string DriverKind,
    string DisplayName,
    InstanceStatus Status,
    string? Message,
    string? Version,
    string Mode,
    IReadOnlyList<ModelInfo> Models,
    string? DefaultModel = null
);

/// <summary>
/// One configured account of a driver. The envelope is the same as t3code's: the driver kind, an enabled flag, a mode,
/// per-instance environment, and an opaque <see cref="Config"/> the driver decodes itself.
/// </summary>
public sealed record ProviderInstanceConfig(
    string InstanceId,
    string Driver,
    string? DisplayName,
    bool Enabled,
    string Mode,
    IReadOnlyDictionary<string, string> Environment,
    JsonObject Config
);

/// <summary>The only door from a driver back into the host.</summary>
public interface IProviderHost
{
    /// <summary>A scratch directory for the instance (empty cwd for model mode).</summary>
    string ScratchDirectory(string instanceId);

    /// <summary>Something an operator should be able to find in the log (a retry, an unusable reply). Default: ignored.</summary>
    void Warn(string instanceId, string message) { }
}

public interface IProviderInstance : IAsyncDisposable
{
    ProviderSnapshot Snapshot { get; }

    /// <summary>Re-probe status and models. Must not open sessions that can start hooks or MCP servers.</summary>
    Task<ProviderSnapshot> RefreshAsync(CancellationToken ct);

    /// <summary>Produce one assistant turn. Throw <see cref="ProviderFailure"/> for anything the caller should see as an error.</summary>
    IAsyncEnumerable<CompletionEvent> CompleteAsync(
        CompletionRequest request,
        CancellationToken ct
    );
}

/// <summary>The kind of integration (claudeAgent, codex, ...). Instances are built from it; never route work by driver.</summary>
public interface IProviderDriver
{
    string Kind { get; }
    IProviderInstance Create(ProviderInstanceConfig config, IProviderHost host);
}
