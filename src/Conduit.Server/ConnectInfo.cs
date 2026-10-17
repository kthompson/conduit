using Conduit.OpenAi;
using Conduit.Provider.Core;
using Microsoft.Extensions.Logging.Abstractions;

namespace Conduit.Server;

public sealed record ConnectModel(string Id, string Name, int ContextWindow, bool Reasoning);

/// <summary>
/// The values to type into the GitHub Copilot app's custom endpoint form (Settings, Model providers, Add provider, Custom endpoint).
/// The app has no documented config file for providers, so Conduit prints these rather than writing app settings.
/// </summary>
public sealed record ConnectInfo(
    string DisplayName,
    string BaseUrl,
    string WireApi,
    bool KeyRequired,
    string? Key,
    IReadOnlyList<ConnectModel> Models,
    IReadOnlyList<string> Notes,
    IReadOnlyList<string> Problems)
{
    public static async Task<ConnectInfo> BuildAsync(ConduitConfig config, IReadOnlyList<IProviderDriver> drivers, string? hostOverride,
        bool revealKey, CancellationToken ct)
    {
        var s = config.Server;
        var notes = new List<string>();
        var problems = new List<string>();

        var host = hostOverride ?? s.Host;
        if (hostOverride is null && host is "0.0.0.0" or "::" or "[::]")
        {
            host = "<this-machine-address>";
            notes.Add("The server listens on all interfaces. Replace <this-machine-address> with the address the app can reach (or pass --host).");
        }
        if (s.Port == 0) problems.Add("server.listen uses port 0 (a random port); set a fixed port so the app can find it.");
        var baseUrl = $"http://{host}:{s.Port}/v1";

        var registry = new ProviderRegistry(config, drivers, NullLogger.Instance);
        await registry.RefreshAllAsync(ct);
        var models = new List<ConnectModel>();
        foreach (var i in registry.Instances.OrderBy(i => i.Snapshot.InstanceId, StringComparer.Ordinal))
        {
            var snap = i.Snapshot;
            if (snap.Status == InstanceStatus.Ready)
                models.AddRange(snap.Models.Select(m => new ConnectModel(ModelIds.Join(snap.InstanceId, m.Slug), m.DisplayName, m.ContextWindow, m.Reasoning)));
            else if (snap.Status == InstanceStatus.Unavailable)
                problems.Add($"Instance '{snap.InstanceId}' is unavailable and will not appear in the app: {snap.Message}");
        }
        if (models.Count == 0) problems.Add("No ready instances, so the app would list no models. Run `conduit doctor`.");

        if (!s.IsLoopback) notes.Add("This is not a loopback address: anyone who can reach it and has the key can use your Claude subscription.");
        var window = models.Count > 0 ? models.Max(m => m.ContextWindow) : 200_000;
        notes.Add($"IMPORTANT: the app does not read the context window from /v1/models, so it assumes a small default and compacts conversations early. " +
                  $"For each model, click its pencil icon (Model providers > this provider) and set Max prompt tokens to {window - 32_000} and Max output tokens to 32000; " +
                  "tick the reasoning-effort levels you want (Conduit passes low, medium, high, xhigh, max to Claude).");
        if (models.Any(m => m.Id.EndsWith("/haiku", StringComparison.Ordinal)))
            notes.Add("Prefer sonnet or opus in the app for coding sessions; haiku works but is the weakest at tool calls.");

        var key = s.ApiKeys.Count > 0 && revealKey ? s.ApiKeys[0] : null;
        return new ConnectInfo("Conduit", baseUrl, "completions", s.ApiKeys.Count > 0, key, models, notes, problems);
    }

    /// <summary>Reachability check against a running server, with the same key the app would use. Returns (ok, message) lines.</summary>
    public static async Task<IReadOnlyList<(bool Ok, string Message)>> VerifyAsync(ConnectInfo info, string? key, CancellationToken ct)
    {
        var results = new List<(bool, string)>();
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
        if (key is not null) http.DefaultRequestHeaders.Authorization = new("Bearer", key);
        try
        {
            using var r = await http.GetAsync(info.BaseUrl + "/models", ct);
            if (r.StatusCode == System.Net.HttpStatusCode.Unauthorized)
            {
                results.Add((false, info.KeyRequired && key is null
                    ? "The server requires an API key. Pass --key <key> to check with it."
                    : "The server rejected the API key."));
                return results;
            }
            if (!r.IsSuccessStatusCode)
            {
                results.Add((false, $"GET {info.BaseUrl}/models returned {(int)r.StatusCode}."));
                return results;
            }
            var ids = System.Text.Json.Nodes.JsonNode.Parse(await r.Content.ReadAsStringAsync(ct))?["data"]?.AsArray()
                .Select(m => m!["id"]!.GetValue<string>()).ToHashSet() ?? [];
            results.Add((true, $"{info.BaseUrl}/models is reachable and lists {ids.Count} model id(s)."));
            var missing = info.Models.Where(m => !ids.Contains(m.Id)).Select(m => m.Id).ToList();
            results.Add(missing.Count == 0
                ? (true, "Every model above is served.")
                : (false, "The running server does not list: " + string.Join(", ", missing) + ". Restart it after config changes."));
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException)
        {
            results.Add((false, $"Could not reach {info.BaseUrl}: {e.Message}. Start it with `conduit serve`."));
        }
        return results;
    }
}
