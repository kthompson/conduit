using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text.Json.Nodes;
using Conduit.Provider.Core;
using Microsoft.Extensions.Logging.Abstractions;

namespace Conduit.Server;

public enum CheckStatus
{
    Ok,
    Info,
    Warn,
    Fail,
}

public sealed record Check(CheckStatus Status, string Title, string? Detail = null);

/// <summary>
/// Diagnoses a setup without starting the server: config, exposure, port, scratch space, each instance (binary, version, sign-in)
/// and, unless skipped, one tiny real completion per ready instance. Checks come back one at a time so the CLI can print as it goes.
/// </summary>
public static class Doctor
{
    public const string SampleQuestion = "Reply with the single word: pong";

    public static async IAsyncEnumerable<Check> RunAsync(
        string configPath,
        IReadOnlyList<IProviderDriver> drivers,
        bool completion,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct
    )
    {
        ConduitConfig? config = null;
        string? configError = null;
        try
        {
            config = ConduitConfig.Load(configPath);
        }
        catch (ConfigException e)
        {
            configError = e.Message;
        }
        if (config is null)
        {
            yield return new Check(
                CheckStatus.Fail,
                "Config",
                configError
                    + (
                        File.Exists(configPath)
                            ? ""
                            : " Create it (see docs/serve.md) or pass --config."
                    )
            );
            yield break;
        }
        yield return new Check(
            CheckStatus.Ok,
            "Config",
            $"{configPath}: {config.Instances.Count} instance(s)"
        );

        foreach (var c in Exposure(config.Server))
            yield return c;
        yield return await PortAsync(config.Server, ct);
        yield return Scratch(config.Server);

        var registry = new ProviderRegistry(config, drivers, NullLogger.Instance);
        await registry.RefreshAllAsync(ct);
        if (registry.Instances.Count == 0)
            yield return new Check(
                CheckStatus.Warn,
                "Instances",
                "No provider-instances configured: /v1/models will be empty."
            );

        foreach (
            var i in registry.Instances.OrderBy(i => i.Snapshot.InstanceId, StringComparer.Ordinal)
        )
        {
            var s = i.Snapshot;
            var label = $"Instance {s.InstanceId} ({s.DriverKind}, {s.Mode} mode)";
            yield return s.Status switch
            {
                InstanceStatus.Ready => new Check(
                    CheckStatus.Ok,
                    label,
                    $"ready{(s.Version is null ? "" : ", " + s.Version)}; models: {string.Join(", ", s.Models.Select(m => m.Slug))}"
                ),
                InstanceStatus.Disabled => new Check(
                    CheckStatus.Info,
                    label,
                    "disabled (enabled = false)"
                ),
                _ => new Check(CheckStatus.Fail, label, s.Message ?? "unavailable"),
            };
            if (s.Status == InstanceStatus.Ready && s.Mode == "model")
                yield return new Check(
                    CheckStatus.Info,
                    $"Isolation for {s.InstanceId}",
                    "model mode: the runtime gets no built-in tools, MCP servers, hooks, skills or user settings, and runs in an empty scratch directory"
                );
        }

        if (!completion)
            yield break;
        foreach (
            var i in registry
                .Instances.Where(i => i.Snapshot.Status == InstanceStatus.Ready)
                .OrderBy(i => i.Snapshot.InstanceId, StringComparer.Ordinal)
        )
            yield return await SampleAsync(i, ct);
    }

    private static IEnumerable<Check> Exposure(ServerSettings s)
    {
        yield return new Check(
            CheckStatus.Info,
            "Listen",
            $"{s.Host}:{s.Port}" + (s.IsLoopback ? " (loopback only)" : "")
        );
        if (s.ApiKeys.Count > 0)
            yield return new Check(
                CheckStatus.Ok,
                "API keys",
                $"{s.ApiKeys.Count} configured; /v1 requires 'Authorization: Bearer <key>'"
            );
        else if (s.IsLoopback)
            yield return new Check(
                CheckStatus.Warn,
                "API keys",
                "none: any process on this machine can use the endpoint. Set server.api-keys to require one."
            );
        else
            yield return new Check(
                CheckStatus.Fail,
                "API keys",
                $"none, but {s.Host} is not loopback: the server refuses to start. Set server.api-keys."
            );
    }

    /// <summary>A free port is fine. A busy one is fine only if it is already a Conduit server (then <c>serve</c> would clash, so say so).</summary>
    private static async Task<Check> PortAsync(ServerSettings s, CancellationToken ct)
    {
        if (s.Port == 0)
            return new Check(CheckStatus.Info, "Port", "0: a free port is chosen at start");
        if (!IPAddress.TryParse(s.Host.Trim('[', ']'), out var ip))
            ip = s.Host == "localhost" ? IPAddress.Loopback : IPAddress.Any;
        try
        {
            var l = new TcpListener(ip, s.Port);
            l.Start();
            l.Stop();
            return new Check(CheckStatus.Ok, "Port", $"{s.Port} is free");
        }
        catch (SocketException)
        {
            try
            {
                using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
                var health = await http.GetStringAsync(
                    $"http://{(ip.Equals(IPAddress.Any) ? "127.0.0.1" : s.Host)}:{s.Port}/healthz",
                    ct
                );
                if (JsonNode.Parse(health)?["status"]?.GetValue<string>() == "ok")
                    return new Check(
                        CheckStatus.Info,
                        "Port",
                        $"{s.Port} is already serving a Conduit-style /healthz: a server is probably running"
                    );
            }
            catch (Exception e)
                when (e
                        is HttpRequestException
                            or TaskCanceledException
                            or System.Text.Json.JsonException
                ) { }
            return new Check(
                CheckStatus.Fail,
                "Port",
                $"{s.Port} is in use by something else. Change server.listen or stop it."
            );
        }
    }

    private static Check Scratch(ServerSettings s)
    {
        try
        {
            var dir = Path.Combine(s.DataDirectory, "scratch");
            Directory.CreateDirectory(dir);
            var probe = Path.Combine(dir, $".doctor-{Guid.NewGuid():N}");
            File.WriteAllText(probe, "ok");
            File.Delete(probe);
            return new Check(CheckStatus.Ok, "Data directory", $"{s.DataDirectory} is writable");
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return new Check(
                CheckStatus.Fail,
                "Data directory",
                $"{s.DataDirectory} is not writable: {e.Message}"
            );
        }
    }

    private static async Task<Check> SampleAsync(IProviderInstance instance, CancellationToken ct)
    {
        var s = instance.Snapshot;
        var model = s.DefaultModel ?? s.Models.FirstOrDefault()?.Slug;
        var title = $"Sample completion on {s.InstanceId}";
        if (model is null)
            return new Check(CheckStatus.Fail, title, "the instance lists no models");

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(90));
        var sw = Stopwatch.StartNew();
        TimeSpan? first = null;
        var text = new System.Text.StringBuilder();
        try
        {
            var request = new CompletionRequest(
                model,
                [new ChatMessage("user", SampleQuestion)],
                []
            );
            await foreach (var ev in instance.CompleteAsync(request, timeout.Token))
                if (ev is TextDelta t)
                {
                    first ??= sw.Elapsed;
                    text.Append(t.Text);
                }
        }
        catch (ProviderFailure f)
        {
            return new Check(CheckStatus.Fail, title, $"{f.Kind}: {f.Message}");
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            return new Check(CheckStatus.Fail, title, "no reply within 90 s");
        }

        return text.Length == 0
            ? new Check(CheckStatus.Fail, title, "the model returned no text")
            : new Check(
                CheckStatus.Ok,
                title,
                $"{model} replied '{text.ToString().Trim()}' in {sw.Elapsed.TotalSeconds:0.0} s (first text after {first!.Value.TotalSeconds:0.0} s)"
            );
    }
}
