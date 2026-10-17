using System.Text;
using System.Text.Json.Nodes;
using Conduit.Provider.Core;
using Conduit.Server;
using Microsoft.AspNetCore.Builder;

namespace Conduit.Server.Tests;

/// <summary>A real server on a free loopback port, over the given drivers and a HOCON config.</summary>
internal sealed class TestHost : IAsyncDisposable
{
    private readonly WebApplication _app;
    private readonly string _dir;
    public HttpClient Http { get; }

    private TestHost(WebApplication app, string dir)
    {
        _app = app;
        _dir = dir;
        Http = new HttpClient { BaseAddress = new Uri(ConduitServer.ListeningUrl(app)), Timeout = TimeSpan.FromSeconds(20) };
    }

    public static readonly string DefaultConfig = """
        provider-instances {
          fake { driver = fake, config { models = [fake-1, fake-2] } }
        }
        """;

    public static async Task<TestHost> StartAsync(string? hocon = null, IEnumerable<IProviderDriver>? drivers = null, string? apiKey = null)
    {
        var dir = Path.Combine(Path.GetTempPath(), "conduit-tests-" + Guid.NewGuid().ToString("N"));
        var keys = apiKey is null ? "" : $"api-keys = [\"{apiKey}\"]";
        var text = $"server {{ listen = \"127.0.0.1:0\", data-dir = \"{dir.Replace("\\", "/")}\", {keys} }}\n" + (hocon ?? DefaultConfig);
        var config = ConduitConfig.Parse(text);
        var app = ConduitServer.Build(config, drivers ?? [new Conduit.Provider.Fake.FakeDriver()], _ => { });
        await app.Services.GetService(typeof(ProviderRegistry)).As<ProviderRegistry>().RefreshAllAsync(CancellationToken.None);
        await app.StartAsync();
        var host = new TestHost(app, dir);
        if (apiKey is not null) host.Http.DefaultRequestHeaders.Authorization = new("Bearer", apiKey);
        return host;
    }

    public static StringContent Json(string json) => new(json, Encoding.UTF8, "application/json");

    public async Task<(HttpResponseMessage Response, JsonNode? Body)> PostChatAsync(string json)
    {
        var r = await Http.PostAsync("/v1/chat/completions", Json(json));
        var text = await r.Content.ReadAsStringAsync();
        return (r, text.Length > 0 && text[0] == '{' ? JsonNode.Parse(text) : null);
    }

    /// <summary>The <c>data:</c> payloads of an SSE body, in order (comments dropped).</summary>
    public static List<string> SseData(string body) =>
        body.Split("\n\n", StringSplitOptions.RemoveEmptyEntries)
            .Where(f => f.StartsWith("data: ")).Select(f => f[6..]).ToList();

    public async ValueTask DisposeAsync()
    {
        Http.Dispose();
        await _app.StopAsync();
        await _app.DisposeAsync();
        try { Directory.Delete(_dir, recursive: true); } catch (IOException) { }
    }
}

internal static class Cast
{
    public static T As<T>(this object? o) where T : class => (T)o!;
}
