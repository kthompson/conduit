using System.Net;
using System.Net.Sockets;
using System.Runtime.CompilerServices;
using Conduit.Provider.Core;
using Conduit.Provider.Fake;
using Conduit.Server;

namespace Conduit.Server.Tests;

public class DoctorAndConnectTests
{
    private static readonly IReadOnlyList<IProviderDriver> Fake = [new FakeDriver()];

    private static string WriteConfig(string body)
    {
        var dir = Path.Combine(Path.GetTempPath(), "conduit-doc-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, "conduit.conf");
        File.WriteAllText(path, body.Replace("DATA", Path.Combine(dir, "data").Replace("\\", "/")));
        return path;
    }

    private static async Task<List<Check>> Doctor(string config, IReadOnlyList<IProviderDriver>? drivers = null, bool completion = true)
    {
        var checks = new List<Check>();
        await foreach (var c in Server.Doctor.RunAsync(config, drivers ?? Fake, completion, CancellationToken.None)) checks.Add(c);
        return checks;
    }

    private static Check Find(List<Check> checks, string titleStart) => checks.Single(c => c.Title.StartsWith(titleStart));

    private const string Good = """
        server { listen = "127.0.0.1:0", data-dir = "DATA" }
        provider-instances { fake { driver = fake, config { models = [fake-1, fake-2] } } }
        """;

    [Fact]
    public async Task A_healthy_setup_passes_including_the_sample_completion()
    {
        var checks = await Doctor(WriteConfig(Good));
        Assert.DoesNotContain(checks, c => c.Status == CheckStatus.Fail);
        Assert.Equal(CheckStatus.Ok, Find(checks, "Instance fake").Status);
        Assert.Contains("fake-1, fake-2", Find(checks, "Instance fake").Detail);
        var sample = Find(checks, "Sample completion on fake");
        Assert.Equal(CheckStatus.Ok, sample.Status);
        Assert.Contains("replied 'echo: Reply with the single word: pong'", sample.Detail);
        Assert.Equal(CheckStatus.Ok, Find(checks, "Data directory").Status);
        Assert.Equal(CheckStatus.Warn, Find(checks, "API keys").Status);
    }

    [Fact]
    public async Task Skip_completion_sends_no_prompt()
    {
        var checks = await Doctor(WriteConfig(Good), completion: false);
        Assert.DoesNotContain(checks, c => c.Title.StartsWith("Sample completion"));
    }

    [Fact]
    public async Task A_missing_config_file_fails_with_a_hint_and_stops()
    {
        var checks = await Doctor(Path.Combine(Path.GetTempPath(), "nope-" + Guid.NewGuid().ToString("N"), "conduit.conf"));
        var c = Assert.Single(checks);
        Assert.Equal(CheckStatus.Fail, c.Status);
        Assert.Contains("docs/serve.md", c.Detail);
    }

    [Fact]
    public async Task A_broken_config_fails_with_the_parser_message()
    {
        var c = Assert.Single(await Doctor(WriteConfig("provider-instances { x { enabled = true } }")));
        Assert.Equal(CheckStatus.Fail, c.Status);
        Assert.Contains("missing 'driver'", c.Detail);
    }

    [Fact]
    public async Task Unknown_driver_fails_and_disabled_instance_is_only_informational()
    {
        var checks = await Doctor(WriteConfig("""
            server { listen = "127.0.0.1:0", data-dir = "DATA" }
            provider-instances { ghost { driver = nope }, off { driver = fake, enabled = false }, ok { driver = fake } }
            """));
        Assert.Equal(CheckStatus.Fail, Find(checks, "Instance ghost").Status);
        Assert.Contains("Unknown driver 'nope'", Find(checks, "Instance ghost").Detail);
        Assert.Equal(CheckStatus.Info, Find(checks, "Instance off").Status);
        Assert.Equal(CheckStatus.Ok, Find(checks, "Instance ok").Status);
        Assert.DoesNotContain(checks, c => c.Title == "Sample completion on ghost");
    }

    [Fact]
    public async Task Exposure_checks_distinguish_keys_loopback_and_open_binds()
    {
        var withKey = await Doctor(WriteConfig("server { listen = \"127.0.0.1:0\", api-keys = [\"k\"], data-dir = \"DATA\" }"));
        Assert.Equal(CheckStatus.Ok, Find(withKey, "API keys").Status);

        var open = await Doctor(WriteConfig("server { listen = \"0.0.0.0:0\", data-dir = \"DATA\" }"));
        Assert.Equal(CheckStatus.Fail, Find(open, "API keys").Status);
        Assert.Contains("refuses to start", Find(open, "API keys").Detail);
    }

    [Fact]
    public async Task A_port_taken_by_another_program_fails_and_a_free_one_passes()
    {
        var l = new TcpListener(IPAddress.Loopback, 0);
        l.Start();
        try
        {
            var port = ((IPEndPoint)l.LocalEndpoint).Port;
            var busy = await Doctor(WriteConfig($"server {{ listen = \"127.0.0.1:{port}\", data-dir = \"DATA\" }}"));
            Assert.Equal(CheckStatus.Fail, Find(busy, "Port").Status);
            Assert.Contains("in use by something else", Find(busy, "Port").Detail);
        }
        finally { l.Stop(); }

        var free = new TcpListener(IPAddress.Loopback, 0);
        free.Start();
        var freePort = ((IPEndPoint)free.LocalEndpoint).Port;
        free.Stop();
        Assert.Equal(CheckStatus.Ok, Find(await Doctor(WriteConfig($"server {{ listen = \"127.0.0.1:{freePort}\", data-dir = \"DATA\" }}")), "Port").Status);
    }

    [Fact]
    public async Task A_port_already_serving_conduit_is_reported_as_a_running_server()
    {
        await using var host = await TestHost.StartAsync();
        var port = host.Http.BaseAddress!.Port;
        var checks = await Doctor(WriteConfig($"server {{ listen = \"127.0.0.1:{port}\", data-dir = \"DATA\" }}"));
        Assert.Equal(CheckStatus.Info, Find(checks, "Port").Status);
        Assert.Contains("already serving", Find(checks, "Port").Detail);
    }

    private sealed class FailingDriver : IProviderDriver
    {
        public string Kind => "failing";
        public IProviderInstance Create(ProviderInstanceConfig c, IProviderHost h) => new Inst(c);

        private sealed class Inst(ProviderInstanceConfig c) : IProviderInstance
        {
            public ProviderSnapshot Snapshot { get; } = new(c.InstanceId, "failing", c.InstanceId, InstanceStatus.Ready, null, "1", "model", [new ModelInfo("m", "m")], "m");
            public Task<ProviderSnapshot> RefreshAsync(CancellationToken ct) => Task.FromResult(Snapshot);
            public async IAsyncEnumerable<CompletionEvent> CompleteAsync(CompletionRequest r, [EnumeratorCancellation] CancellationToken ct)
            {
                await Task.CompletedTask;
                throw new ProviderFailure(FailureKind.UsageLimit, "limit reached");
#pragma warning disable CS0162
                yield break;
#pragma warning restore CS0162
            }
            public ValueTask DisposeAsync() => ValueTask.CompletedTask;
        }
    }

    [Fact]
    public async Task A_failing_sample_completion_is_a_failure_with_the_reason()
    {
        var checks = await Doctor(WriteConfig("""
            server { listen = "127.0.0.1:0", data-dir = "DATA" }
            provider-instances { f { driver = failing } }
            """), [new FailingDriver()]);
        var sample = Find(checks, "Sample completion on f");
        Assert.Equal(CheckStatus.Fail, sample.Status);
        Assert.Contains("UsageLimit: limit reached", sample.Detail);
    }

    // ---- connect ----

    private static Task<ConnectInfo> Connect(string hocon, string? host = null, bool reveal = false)
    {
        var config = ConduitConfig.Parse(hocon.Replace("DATA", Path.Combine(Path.GetTempPath(), "conduit-conn").Replace("\\", "/")));
        return ConnectInfo.BuildAsync(config, Fake, host, reveal, CancellationToken.None);
    }

    [Fact]
    public async Task Connect_lists_the_form_values_and_every_ready_model_id()
    {
        var i = await Connect("""
            server { listen = "127.0.0.1:9100", data-dir = "DATA" }
            provider-instances { fake { driver = fake, config { models = [fake-1, fake-2] } } }
            """);
        Assert.Equal("http://127.0.0.1:9100/v1", i.BaseUrl);
        Assert.Equal("completions", i.WireApi);
        Assert.False(i.KeyRequired);
        Assert.Equal(["fake/fake-1", "fake/fake-2"], i.Models.Select(m => m.Id));
        Assert.Empty(i.Problems);
    }

    [Fact]
    public async Task Connect_hides_the_key_unless_asked()
    {
        const string cfg = "server { listen = \"127.0.0.1:9100\", api-keys = [\"s3cret\"], data-dir = \"DATA\" }\nprovider-instances { fake { driver = fake } }";
        var hidden = await Connect(cfg);
        Assert.True(hidden.KeyRequired);
        Assert.Null(hidden.Key);
        Assert.Equal("s3cret", (await Connect(cfg, reveal: true)).Key);
    }

    [Fact]
    public async Task Connect_flags_wildcard_hosts_random_ports_and_unavailable_instances()
    {
        var wildcard = await Connect("server { listen = \"0.0.0.0:9100\", api-keys = [\"k\"], data-dir = \"DATA\" }\nprovider-instances { fake { driver = fake } }");
        Assert.Contains("<this-machine-address>", wildcard.BaseUrl);
        Assert.Contains(wildcard.Notes, n => n.Contains("--host"));
        Assert.Contains(wildcard.Notes, n => n.Contains("not a loopback"));
        Assert.Equal("http://lan.box:9100/v1", (await Connect("server { listen = \"0.0.0.0:9100\", api-keys = [\"k\"], data-dir = \"DATA\" }\nprovider-instances { fake { driver = fake } }", host: "lan.box")).BaseUrl);

        var broken = await Connect("server { listen = \"127.0.0.1:0\", data-dir = \"DATA\" }\nprovider-instances { ghost { driver = nope } }");
        Assert.Contains(broken.Problems, p => p.Contains("port 0"));
        Assert.Contains(broken.Problems, p => p.Contains("'ghost' is unavailable"));
        Assert.Contains(broken.Problems, p => p.Contains("No ready instances"));
    }

    [Fact]
    public async Task Verify_passes_against_a_running_server_and_catches_key_and_model_problems()
    {
        await using var host = await TestHost.StartAsync(apiKey: "k1");
        var port = host.Http.BaseAddress!.Port;
        var info = await Connect($"server {{ listen = \"127.0.0.1:{port}\", api-keys = [\"k1\"], data-dir = \"DATA\" }}\nprovider-instances {{ fake {{ driver = fake, config {{ models = [fake-1, fake-2] }} }} }}");

        Assert.All(await ConnectInfo.VerifyAsync(info, "k1", CancellationToken.None), r => Assert.True(r.Ok, r.Message));

        var wrong = await ConnectInfo.VerifyAsync(info, "nope", CancellationToken.None);
        Assert.False(wrong[0].Ok);
        Assert.Contains("rejected", wrong[0].Message);

        var none = await ConnectInfo.VerifyAsync(info, null, CancellationToken.None);
        Assert.Contains("requires an API key", none[0].Message);

        var extra = info with { Models = [.. info.Models, new ConnectModel("fake/ghost", "g", 1, false)] };
        var mismatch = await ConnectInfo.VerifyAsync(extra, "k1", CancellationToken.None);
        Assert.False(mismatch[1].Ok);
        Assert.Contains("fake/ghost", mismatch[1].Message);
    }

    [Fact]
    public async Task Verify_reports_an_unreachable_server_with_the_command_to_start_it()
    {
        var l = new TcpListener(IPAddress.Loopback, 0);
        l.Start();
        var port = ((IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        var info = await Connect($"server {{ listen = \"127.0.0.1:{port}\", data-dir = \"DATA\" }}\nprovider-instances {{ fake {{ driver = fake }} }}");
        var r = await ConnectInfo.VerifyAsync(info, null, CancellationToken.None);
        Assert.False(r[0].Ok);
        Assert.Contains("conduit serve", r[0].Message);
    }
}
