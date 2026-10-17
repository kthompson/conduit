using System.Text.Json.Nodes;
using Conduit.Capture;
using Microsoft.AspNetCore.Builder;

namespace Conduit.Capture.Tests;

/// <summary>A real capture server on a free port, with a temp output directory.</summary>
internal sealed class TestServer : IAsyncDisposable
{
    private readonly WebApplication _app;
    private readonly string _dir;

    public HttpClient Http { get; }
    public string CaptureFile { get; }

    private TestServer(WebApplication app, string dir)
    {
        _app = app;
        _dir = dir;
        CaptureFile = CaptureServer.CaptureFile(app);
        Http = new HttpClient { BaseAddress = new Uri(CaptureServer.ListeningUrl(app)), Timeout = TimeSpan.FromSeconds(20) };
    }

    public static async Task<TestServer> StartAsync(Action<CaptureOptions>? configure = null)
    {
        var dir = Path.Combine(Path.GetTempPath(), "capture-tests-" + Guid.NewGuid().ToString("N"));
        var options = new CaptureOptions
        {
            Port = 0,
            OutputDirectory = dir,
            SlowChunks = 2,
            SlowPause = TimeSpan.FromMilliseconds(150),
            KeepAliveInterval = TimeSpan.FromMilliseconds(50),
        };
        configure?.Invoke(options);
        var app = CaptureServer.Build(options, _ => { });
        await app.StartAsync();
        return new TestServer(app, dir);
    }

    public static StringContent Json(string json) => new(json, System.Text.Encoding.UTF8, "application/json");

    /// <summary>Records are written just after the response completes, so poll briefly.</summary>
    public async Task<IReadOnlyList<JsonObject>> RecordsAsync(int expected)
    {
        for (var i = 0; i < 100; i++)
        {
            var lines = File.Exists(CaptureFile) ? File.ReadAllLines(CaptureFile).Where(l => l.Length > 0).ToList() : [];
            if (lines.Count >= expected) return lines.Select(l => (JsonObject)JsonNode.Parse(l)!).ToList();
            await Task.Delay(50);
        }
        throw new TimeoutException($"Expected {expected} capture records.");
    }

    public async ValueTask DisposeAsync()
    {
        Http.Dispose();
        await _app.StopAsync();
        await _app.DisposeAsync();
        try { Directory.Delete(_dir, recursive: true); } catch (IOException) { }
    }
}
