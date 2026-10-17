using System.ComponentModel;
using Conduit.Server;
using Spectre.Console.Cli;

namespace Conduit.Cli.Commands;

public sealed class ConfigCommandSettings : ConfigSettings
{
    [CommandArgument(0, "[action]")]
    [Description("path | validate | show")]
    public string Action { get; init; } = "validate";
}

public sealed class ConfigCommand : Command<ConfigCommandSettings>
{
    public override int Execute(CommandContext context, ConfigCommandSettings s)
    {
        switch (s.Action.ToLowerInvariant())
        {
            case "path":
                Console.WriteLine(s.ConfigPath);
                return 0;
            case "validate" or "show":
                try
                {
                    var c = ConduitConfig.Load(s.ConfigPath);
                    var known = Drivers.All().Select(d => d.Kind).ToHashSet();
                    foreach (var i in c.Instances.Where(i => !known.Contains(i.Driver)))
                        Console.Error.WriteLine(
                            $"warning: instance '{i.InstanceId}' uses unknown driver '{i.Driver}' and will be listed as unavailable."
                        );
                    if (s.Action.Equals("show", StringComparison.OrdinalIgnoreCase))
                        Show(c);
                    else
                        Console.WriteLine(
                            $"OK: {c.Instances.Count} instance(s), listening on {c.Server.Host}:{c.Server.Port}, {c.Server.ApiKeys.Count} API key(s)."
                        );
                    return 0;
                }
                catch (ConfigException e)
                {
                    Console.Error.WriteLine(e.Message);
                    return 1;
                }
            default:
                Console.Error.WriteLine(
                    $"Unknown action '{s.Action}'. Use path, validate or show."
                );
                return 2;
        }
    }

    // Secrets are redacted: only the number of keys is printed.
    private static void Show(ConduitConfig c)
    {
        Console.WriteLine(
            $"server: {c.Server.Host}:{c.Server.Port}  api-keys: {c.Server.ApiKeys.Count} (redacted)  data-dir: {c.Server.DataDirectory}"
        );
        foreach (var i in c.Instances)
            Console.WriteLine(
                $"instance {i.InstanceId}: driver={i.Driver} mode={i.Mode} enabled={i.Enabled} env={i.Environment.Count} config={i.Config.ToJsonString()}"
            );
    }
}
