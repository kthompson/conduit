using System.Diagnostics;
using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Conduit.OpenAi;
using Conduit.Provider.Core;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Conduit.Server;

/// <summary>Builds the OpenAI-compatible host. Logging goes through Microsoft.Extensions.Logging; the executable picks the provider.</summary>
public static class ConduitServer
{
    // Send headers and a first SSE frame after this long even if the provider is silent, so client idle timers do not trip.
    internal static readonly TimeSpan FirstEventWait = TimeSpan.FromSeconds(10);
    internal static readonly TimeSpan KeepAliveInterval = TimeSpan.FromSeconds(15);
    private const int MaxBodyBytes = 64 * 1024 * 1024;

    public static WebApplication Build(ConduitConfig config, IEnumerable<IProviderDriver> drivers, Action<ILoggingBuilder>? configureLogging = null)
    {
        var server = config.Server;
        if (!server.IsLoopback && server.ApiKeys.Count == 0)
            throw new ConfigException($"Refusing to listen on {server.Host} without an API key: set server.api-keys. The key is effectively a shell on this machine for agent instances.");
        var address = server.Host == "localhost" ? IPAddress.Loopback : IPAddress.Parse(server.Host.Trim('[', ']'));

        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders();
        if (configureLogging is not null) configureLogging(builder.Logging);
        else builder.Logging.AddSimpleConsole(o => o.SingleLine = true);

        builder.WebHost.ConfigureKestrel(k =>
        {
            k.AddServerHeader = false;
            k.Limits.MaxRequestBodySize = MaxBodyBytes;
            k.Limits.KeepAliveTimeout = TimeSpan.FromMinutes(10);
            k.Listen(address, server.Port, lo => lo.Protocols = HttpProtocols.Http1);
        });

        builder.Services.AddSingleton(config);
        builder.Services.AddSingleton(sp => new ProviderRegistry(config, drivers, sp.GetRequiredService<ILoggerFactory>().CreateLogger("Registry")));
        builder.Services.AddSingleton<ChatEndpoint>();

        var app = builder.Build();
        MapRoutes(app, config);
        return app;
    }

    private static void MapRoutes(WebApplication app, ConduitConfig config)
    {
        var keys = config.Server.ApiKeys.ToHashSet(StringComparer.Ordinal);

        app.Use(async (ctx, next) =>
        {
            try
            {
                if (keys.Count > 0 && ctx.Request.Path.StartsWithSegments("/v1") && !Authorized(ctx.Request, keys))
                    throw OpenAiError.Unauthorized("Incorrect or missing API key. Send it as 'Authorization: Bearer <key>'.");
                await next();
            }
            catch (OpenAiError e) when (!ctx.Response.HasStarted)
            {
                await WriteError(ctx, e);
            }
        });

        app.MapGet("/healthz", () => Results.Json(new { status = "ok" }));
        app.MapGet("/v1/models", (ProviderRegistry r) => Results.Json(ModelList(r)));
        app.MapGet("/v1/models/{*id}", (string id, ProviderRegistry r) =>
            ModelList(r)["data"]!.AsArray().FirstOrDefault(m => m!["id"]!.GetValue<string>() == id) is { } m
                ? Results.Json(m)
                : Results.Json(OpenAiError.NotFound($"The model '{id}' does not exist.", "model_not_found").ToJson(), statusCode: 404));
        app.MapGet("/v1/providers", (ProviderRegistry r) => Results.Json(new JsonObject
        {
            ["object"] = "list",
            ["data"] = new JsonArray(r.Instances.Select(i => Describe(i.Snapshot)).ToArray<JsonNode?>()),
        }));
        app.MapPost("/v1/providers/{id}/refresh", async (string id, ProviderRegistry r, CancellationToken ct) =>
            r.Find(id) is { } i
                ? Results.Json(Describe(await i.RefreshAsync(ct)))
                : Results.Json(OpenAiError.NotFound($"No instance '{id}'.").ToJson(), statusCode: 404));
        app.MapPost("/v1/chat/completions", (HttpContext ctx, ChatEndpoint e) => e.HandleAsync(ctx));
        // Anything else under /v1 is an OpenAI-shaped 404 rather than an empty one.
        app.MapFallback(ctx => WriteError(ctx, OpenAiError.NotFound($"Unknown route {ctx.Request.Method} {ctx.Request.Path}.", "unknown_route")));
    }

    private static bool Authorized(HttpRequest req, HashSet<string> keys) =>
        req.Headers.Authorization.ToString() is { } h && h.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) && keys.Contains(h[7..].Trim());

    internal static async Task WriteError(HttpContext ctx, OpenAiError e)
    {
        ctx.Response.StatusCode = e.Status;
        if (e.RetryAfter is { } ra) ctx.Response.Headers.RetryAfter = ((int)Math.Ceiling(ra.TotalSeconds)).ToString();
        ctx.Response.ContentType = "application/json";
        await ctx.Response.WriteAsync(e.ToJson().ToJsonString());
    }

    private static JsonObject ModelList(ProviderRegistry r)
    {
        var created = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var data = new JsonArray();
        foreach (var i in r.Instances.Where(i => i.Snapshot.Status == InstanceStatus.Ready))
        {
            var s = i.Snapshot;
            data.Add(Model(s.InstanceId, created, s.InstanceId, s.Models.FirstOrDefault(m => m.Slug == s.DefaultModel)));
            foreach (var m in s.Models) data.Add(Model(ModelIds.Join(s.InstanceId, m.Slug), created, s.InstanceId, m));
        }
        return new JsonObject { ["object"] = "list", ["data"] = data };
    }

    private static JsonObject Model(string id, long created, string owner, ModelInfo? info) => new()
    {
        ["id"] = id,
        ["object"] = "model",
        ["created"] = created,
        ["owned_by"] = owner,
        ["context_length"] = info?.ContextWindow ?? 200_000,
        ["max_output_tokens"] = info?.MaxOutput ?? 32_000,
    };

    private static JsonObject Describe(ProviderSnapshot s) => new()
    {
        ["id"] = s.InstanceId,
        ["driver"] = s.DriverKind,
        ["display_name"] = s.DisplayName,
        ["status"] = s.Status.ToString().ToLowerInvariant(),
        ["message"] = s.Message,
        ["version"] = s.Version,
        ["mode"] = s.Mode,
        ["default_model"] = s.DefaultModel,
        ["models"] = new JsonArray(s.Models.Select(m => (JsonNode?)new JsonObject
        {
            ["id"] = ModelIds.Join(s.InstanceId, m.Slug), ["name"] = m.DisplayName, ["context_window"] = m.ContextWindow, ["reasoning"] = m.Reasoning,
        }).ToArray()),
    };

    /// <summary>Probes the instances, then runs until <paramref name="ct"/> is cancelled.</summary>
    public static async Task RunAsync(ConduitConfig config, IEnumerable<IProviderDriver> drivers, Action<ILoggingBuilder>? configureLogging, CancellationToken ct)
    {
        await using var app = Build(config, drivers, configureLogging);
        await app.Services.GetRequiredService<ProviderRegistry>().RefreshAllAsync(ct);
        await app.StartAsync(ct);
        var log = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("Conduit");
        log.LogInformation("Conduit listening on {Url}; OpenAI base URL {Base}", ListeningUrl(app), ListeningUrl(app) + "/v1");
        if (config.Server.ApiKeys.Count == 0) log.LogWarning("No API keys configured: any client on this machine can use the endpoint.");
        try { await app.WaitForShutdownAsync(ct); }
        catch (OperationCanceledException) { }
        await app.StopAsync(CancellationToken.None);
    }

    public static string ListeningUrl(WebApplication app) =>
        app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.First();
}
