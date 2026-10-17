using System.Runtime.CompilerServices;
using Conduit.OpenAi;
using Conduit.Provider.Core;
using Microsoft.Extensions.Logging;

namespace Conduit.Server;

/// <summary>Builds one live instance per config entry. Unknown drivers and bad config become unavailable shadows, never a startup failure.</summary>
public sealed class ProviderRegistry : IProviderHost
{
    private readonly Dictionary<string, IProviderInstance> _instances = new(StringComparer.Ordinal);
    private readonly string _scratchRoot;
    private readonly ILogger _log;

    public ProviderRegistry(ConduitConfig config, IEnumerable<IProviderDriver> drivers, ILogger log)
    {
        _log = log;
        _scratchRoot = Path.Combine(config.Server.DataDirectory, "scratch");
        var byKind = drivers.ToDictionary(d => d.Kind, StringComparer.Ordinal);
        foreach (var c in config.Instances)
        {
            IProviderInstance instance;
            if (!byKind.TryGetValue(c.Driver, out var driver))
                instance = new ShadowInstance(c, $"Unknown driver '{c.Driver}'. Known: {string.Join(", ", byKind.Keys.Order())}.");
            else
            {
                try { instance = driver.Create(c, this); }
                catch (Exception e) when (e is ProviderFailure or InvalidOperationException or FormatException)
                {
                    instance = new ShadowInstance(c, $"Invalid config: {e.Message}");
                }
            }
            _instances[c.InstanceId] = instance;
        }
    }

    public IReadOnlyCollection<IProviderInstance> Instances => _instances.Values;

    public string ScratchDirectory(string instanceId)
    {
        var dir = Path.Combine(_scratchRoot, instanceId);
        Directory.CreateDirectory(dir);
        return dir;
    }

    /// <summary>Probe every instance once, in parallel. Failures are recorded on the snapshot, not thrown.</summary>
    public async Task RefreshAllAsync(CancellationToken ct)
    {
        await Task.WhenAll(_instances.Values.Select(async i =>
        {
            var s = await i.RefreshAsync(ct);
            _log.LogInformation("Instance {Id} ({Driver}, {Mode}): {Status}{Message}", s.InstanceId, s.DriverKind, s.Mode, s.Status,
                s.Message is null ? "" : " - " + s.Message);
        }));
    }

    public IProviderInstance? Find(string instanceId) => _instances.GetValueOrDefault(instanceId);

    /// <summary>Resolves a public model id (<c>instance</c> or <c>instance/slug</c>) to a ready instance and the slug to run.</summary>
    public (IProviderInstance Instance, string Slug) Resolve(string model)
    {
        var (id, slug) = ModelIds.Split(model);
        if (Find(id) is not { } instance) throw OpenAiError.NotFound($"The model '{model}' does not exist.", "model_not_found");
        var s = instance.Snapshot;
        if (s.Status == InstanceStatus.Disabled) throw OpenAiError.NotFound($"The instance '{id}' is disabled.", "model_not_found");
        if (s.Status != InstanceStatus.Ready)
            throw new OpenAiError(503, "server_error", "provider_unavailable", $"The instance '{id}' is unavailable: {s.Message}");
        slug ??= s.DefaultModel ?? s.Models.FirstOrDefault()?.Slug
            ?? throw OpenAiError.BadRequest($"The instance '{id}' has no models.");
        if (s.Models.All(m => m.Slug != slug) && !slug.StartsWith("claude-", StringComparison.Ordinal))
            throw OpenAiError.NotFound($"The model '{model}' does not exist.", "model_not_found");
        return (instance, slug);
    }
}

internal sealed class ShadowInstance(ProviderInstanceConfig config, string message) : IProviderInstance
{
    public ProviderSnapshot Snapshot { get; } = new(config.InstanceId, config.Driver, config.DisplayName ?? config.InstanceId,
        InstanceStatus.Unavailable, message, null, config.Mode, []);

    public Task<ProviderSnapshot> RefreshAsync(CancellationToken ct) => Task.FromResult(Snapshot);

    public async IAsyncEnumerable<CompletionEvent> CompleteAsync(CompletionRequest request, [EnumeratorCancellation] CancellationToken ct)
    {
        await Task.CompletedTask;
        throw new ProviderFailure(FailureKind.Unavailable, message);
        #pragma warning disable CS0162
        yield break;
        #pragma warning restore CS0162
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;
}
