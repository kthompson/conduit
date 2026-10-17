using System.ComponentModel;
using Conduit.Server;
using Serilog;
using Spectre.Console.Cli;

namespace Conduit.Cli.Commands;

public class ConfigSettings : CommandSettings
{
    [CommandOption("-c|--config <PATH>")]
    [Description("Config file. Default: ~/.config/conduit/conduit.conf (plus instances.d/*.conf beside it).")]
    public string? Config { get; init; }

    internal string ConfigPath => Config ?? ConduitConfig.DefaultPath;
}

public sealed class ServeSettings : ConfigSettings
{
    [CommandOption("--listen <ADDRESS>")]
    [Description("Override server.listen.")]
    public string? Listen { get; init; }

    [CommandOption("-v|--verbose")]
    [Description("Debug-level logging.")]
    public bool Verbose { get; init; }
}

public sealed class ServeCommand : AsyncCommand<ServeSettings>
{
    public override async Task<int> ExecuteAsync(CommandContext context, ServeSettings s)
    {
        ConduitConfig config;
        try
        {
            config = ConduitConfig.Load(s.ConfigPath);
            if (s.Listen is not null)
            {
                var i = s.Listen.LastIndexOf(':');
                if (i < 0 || !int.TryParse(s.Listen[(i + 1)..], out var port)) throw new ConfigException("--listen must look like 127.0.0.1:8787.");
                config = config with { Server = config.Server with { Host = s.Listen[..i], Port = port } };
            }
        }
        catch (ConfigException e)
        {
            Console.Error.WriteLine(e.Message);
            return 2;
        }

        Logging.Configure(Path.Combine(config.Server.DataDirectory, "logs"), s.Verbose, "conduit");
        using var cts = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };
        try
        {
            await ConduitServer.RunAsync(config, Drivers.All(), logging => logging.AddSerilog(Log.Logger, dispose: false), cts.Token);
            return 0;
        }
        catch (ConfigException e)
        {
            Log.Fatal("{Message}", e.Message);
            return 2;
        }
        catch (IOException e) when (e.Message.Contains("address already in use", StringComparison.OrdinalIgnoreCase))
        {
            Log.Fatal("{Host}:{Port} is already in use. Change server.listen or pass --listen.", config.Server.Host, config.Server.Port);
            return 1;
        }
        catch (Exception e)
        {
            Log.Fatal(e, "Conduit stopped unexpectedly");
            return 1;
        }
        finally
        {
            await Log.CloseAndFlushAsync();
        }
    }
}
