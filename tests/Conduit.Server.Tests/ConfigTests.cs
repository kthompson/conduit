using Conduit.Server;

namespace Conduit.Server.Tests;

public class ConfigTests
{
    [Fact]
    public void Parses_server_and_instances_with_env_substitution()
    {
        Environment.SetEnvironmentVariable("CONDUIT_TEST_KEY", "k1");
        var c = ConduitConfig.Parse(
            """
            server { listen = "127.0.0.1:9000", api-keys = [ ${?CONDUIT_TEST_KEY} ] }
            provider-instances {
              claude { driver = claudeAgent, display-name = "Claude", mode = model, environment = [ { name = A, value = b } ], config { binary-path = "/x/claude" } }
              off { driver = fake, enabled = false }
            }
            """
        );
        Assert.Equal(("127.0.0.1", 9000), (c.Server.Host, c.Server.Port));
        Assert.Equal(["k1"], c.Server.ApiKeys);
        var claude = c.Instances.Single(i => i.InstanceId == "claude");
        Assert.Equal("claudeAgent", claude.Driver);
        Assert.Equal("b", claude.Environment["A"]);
        Assert.Equal("/x/claude", claude.Config["binary-path"]!.GetValue<string>());
        Assert.False(c.Instances.Single(i => i.InstanceId == "off").Enabled);
        Assert.Equal("model", c.Instances.Single(i => i.InstanceId == "off").Mode);
    }

    [Fact]
    public void Unset_env_key_yields_no_keys_and_defaults_apply()
    {
        Environment.SetEnvironmentVariable("CONDUIT_TEST_UNSET", null);
        var c = ConduitConfig.Parse("server { api-keys = [ ${?CONDUIT_TEST_UNSET} ] }");
        Assert.Empty(c.Server.ApiKeys);
        Assert.Equal(("127.0.0.1", 8787), (c.Server.Host, c.Server.Port));
    }

    [Theory]
    [InlineData("provider-instances { \"9bad\" { driver = fake } }", "Invalid instance id")]
    [InlineData("provider-instances { x { enabled = true } }", "missing 'driver'")]
    [InlineData("provider-instances { x { driver = fake, mode = weird } }", "mode")]
    [InlineData("server { listen = \"nope\" }", "server.listen")]
    [InlineData("server { listen = ", "Invalid config")]
    public void Bad_config_reports_what_is_wrong(string text, string expected)
    {
        var e = Assert.Throws<ConfigException>(() => ConduitConfig.Parse(text));
        Assert.Contains(expected, e.Message);
    }

    [Fact]
    public void Load_merges_instances_d_files_beside_the_main_file()
    {
        var dir = Path.Combine(Path.GetTempPath(), "conduit-cfg-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(dir, "instances.d"));
        File.WriteAllText(
            Path.Combine(dir, "conduit.conf"),
            "server { listen = \"127.0.0.1:1234\" }\nprovider-instances { a { driver = fake } }"
        );
        File.WriteAllText(
            Path.Combine(dir, "instances.d", "b.conf"),
            "provider-instances { b { driver = fake } }"
        );
        try
        {
            var c = ConduitConfig.Load(Path.Combine(dir, "conduit.conf"));
            Assert.Equal(["a", "b"], c.Instances.Select(i => i.InstanceId).Order());
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }
}
