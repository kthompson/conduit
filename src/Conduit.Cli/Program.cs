using Conduit.Cli.Commands;
using Spectre.Console.Cli;

var app = new CommandApp();
app.Configure(config =>
{
    config.SetApplicationName("conduit");
    config.AddCommand<CaptureCommand>("capture")
        .WithDescription("Run the capture server (a logging OpenAI-compatible endpoint), or summarize what it recorded.")
        .WithExample("capture")
        .WithExample("capture", "--scenario", "progress", "--port", "9000")
        .WithExample("capture", "--lan", "--key", "secret")
        .WithExample("capture", "report");
});
return await app.RunAsync(args);
