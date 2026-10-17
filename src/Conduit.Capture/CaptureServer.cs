using System.Net;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Conduit.Capture;

/// <summary>Builds and runs the capture server. Logging goes through <c>Microsoft.Extensions.Logging</c>; the host chooses the provider.</summary>
public static class CaptureServer
{
    public static WebApplication Build(
        CaptureOptions options,
        Action<ILoggingBuilder>? configureLogging = null
    )
    {
        if (options.Validate() is { } problem)
            throw new CaptureConfigException(problem);

        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders();
        if (configureLogging is not null)
            configureLogging(builder.Logging);
        else
            builder.Logging.AddSimpleConsole(o => o.SingleLine = true);

        builder.WebHost.ConfigureKestrel(k =>
        {
            k.AddServerHeader = false;
            k.Limits.MaxRequestBodySize = options.MaxBodyBytes;
            k.Limits.KeepAliveTimeout = TimeSpan.FromMinutes(10);
            k.Listen(options.BindAddress, options.Port, lo => lo.Protocols = HttpProtocols.Http1);
        });

        builder.Services.AddSingleton(options);
        builder.Services.AddSingleton(_ => new CaptureStore(options.OutputDirectory));
        builder.Services.AddSingleton(_ => new ModelCatalog(options));
        builder.Services.AddSingleton<CaptureHandler>();

        var app = builder.Build();
        app.Run(ctx => ctx.RequestServices.GetRequiredService<CaptureHandler>().HandleAsync(ctx));
        return app;
    }

    /// <summary>Runs until <paramref name="ct"/> is cancelled.</summary>
    public static async Task RunAsync(
        CaptureOptions options,
        Action<ILoggingBuilder>? configureLogging,
        CancellationToken ct
    )
    {
        await using var app = Build(options, configureLogging);
        await app.StartAsync(ct);
        Describe(app, options);
        try
        {
            await app.WaitForShutdownAsync(ct);
        }
        catch (OperationCanceledException) { }
        await app.StopAsync(CancellationToken.None);
    }

    /// <summary>The URL the server is actually listening on (useful when port 0 was requested).</summary>
    public static string ListeningUrl(WebApplication app) =>
        app
            .Services.GetRequiredService<IServer>()
            .Features.Get<IServerAddressesFeature>()!
            .Addresses.First();

    public static string CaptureFile(WebApplication app) =>
        app.Services.GetRequiredService<CaptureStore>().FilePath;

    private static void Describe(WebApplication app, CaptureOptions o)
    {
        var log = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("Capture");
        var url = ListeningUrl(app)
            .Replace("0.0.0.0", "<this-machine>")
            .Replace("[::]", "<this-machine>");
        log.LogInformation("Capture server listening on {Url}", url);
        log.LogInformation(
            "Point the app's custom endpoint at {BaseUrl} (key: {KeyHint})",
            url + "/v1",
            o.Key is null ? "any value is accepted" : "must equal --key"
        );
        log.LogInformation("Recording requests to {File}", CaptureFile(app));
        log.LogInformation(
            "Default scenario: {Scenario}. Switch per request with ?scenario=, X-Capture-Scenario, or a model id like {Model}@slow",
            o.DefaultScenario,
            o.Models[0]
        );
        log.LogInformation("Scenarios: {Scenarios}", string.Join(", ", ScenarioSpec.Advertised));
        if (o.Lan)
            log.LogWarning(
                "--lan: reachable from other devices on the network; protected by --key only"
            );
    }
}
