using Conduit.Cli.Commands;
using Spectre.Console.Cli;

var app = new CommandApp();
app.Configure(config =>
{
    config.SetApplicationName("conduit");
    config.AddCommand<ServeCommand>("serve")
        .WithDescription("Run the OpenAI-compatible server over the configured provider instances.")
        .WithExample("serve")
        .WithExample("serve", "--config", "./conduit.conf", "--listen", "127.0.0.1:8787");
    config.AddCommand<ConfigCommand>("config")
        .WithDescription("Locate, validate or print the merged config (secrets redacted).")
        .WithExample("config", "validate")
        .WithExample("config", "show");
    config.AddCommand<DoctorCommand>("doctor")
        .WithDescription("Diagnose the setup: config, exposure, port, each instance, and a sample completion.")
        .WithExample("doctor")
        .WithExample("doctor", "--skip-completion");
    config.AddCommand<ConnectCommand>("connect")
        .WithDescription("Print the values to enter in another app so it uses this server (copilot).")
        .WithExample("connect", "copilot")
        .WithExample("connect", "copilot", "--check");
    config.AddCommand<CaptureCommand>("capture")
        .WithDescription("Run the capture server (a logging OpenAI-compatible endpoint), or summarize what it recorded.")
        .WithExample("capture")
        .WithExample("capture", "--scenario", "progress", "--port", "9000")
        .WithExample("capture", "--lan", "--key", "secret")
        .WithExample("capture", "report");
});
return await app.RunAsync(args);
