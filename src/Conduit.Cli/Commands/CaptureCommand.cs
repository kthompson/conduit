using System.ComponentModel;
using Conduit.Capture;
using Microsoft.Extensions.Logging;
using Serilog;
using Spectre.Console.Cli;

namespace Conduit.Cli.Commands;

public sealed class CaptureSettings : CommandSettings
{
    [CommandArgument(0, "[action]")]
    [Description("Leave out to run the server. 'report' summarizes recorded captures instead.")]
    public string? Action { get; init; }

    [CommandOption("--host <HOST>")]
    [Description("Address to bind (loopback by default).")]
    [DefaultValue("127.0.0.1")]
    public string Host { get; init; } = "127.0.0.1";

    [CommandOption("-p|--port <PORT>")]
    [Description("Port to listen on.")]
    [DefaultValue(8788)]
    public int Port { get; init; } = 8788;

    [CommandOption("--lan")]
    [Description(
        "Listen on all interfaces so another device can reach the server. Requires --key."
    )]
    public bool Lan { get; init; }

    [CommandOption("--key <KEY>")]
    [Description("Require this API key. Without it any key is accepted.")]
    public string? Key { get; init; }

    [CommandOption("-s|--scenario <SCENARIO>")]
    [Description(
        "Default scenario: text, slow, slow-nokeepalive, progress, reasoning, toolcall, error[-429|-500|-mid], echo. A request can override it with ?scenario=, X-Capture-Scenario, or a model id like capture@slow."
    )]
    [DefaultValue("text")]
    public string Scenario { get; init; } = "text";

    [CommandOption("-o|--dir <DIR>")]
    [Description("Directory for <timestamp>.jsonl captures and the log file.")]
    [DefaultValue("captures")]
    public string Dir { get; init; } = "captures";

    [CommandOption("--model <ID>")]
    [Description("Model id to advertise on /v1/models. Repeatable. Default: capture.")]
    public string[] Models { get; init; } = [];

    [CommandOption("--context-length <TOKENS>")]
    [Description("Context window to advertise.")]
    [DefaultValue(200000)]
    public int ContextLength { get; init; } = 200_000;

    [CommandOption("--max-output <TOKENS>")]
    [Description("Max output tokens to advertise.")]
    [DefaultValue(32000)]
    public int MaxOutput { get; init; } = 32_000;

    [CommandOption("--no-tools")]
    [Description("Advertise the models as not supporting tool calling.")]
    public bool NoTools { get; init; }

    [CommandOption("--models-file <PATH>")]
    [Description("Serve this JSON file verbatim as the /v1/models response.")]
    public string? ModelsFile { get; init; }

    [CommandOption("--no-keepalive")]
    [Description("Do not send SSE keep-alive comments during the slow scenario.")]
    public bool NoKeepAlive { get; init; }

    [CommandOption("--keepalive-interval <SECONDS>")]
    [Description("Seconds between keep-alive comments.")]
    [DefaultValue(15)]
    public int KeepAliveSeconds { get; init; } = 15;

    [CommandOption("--slow-chunks <N>")]
    [Description("Chunks sent by the slow scenario.")]
    [DefaultValue(6)]
    public int SlowChunks { get; init; } = 6;

    [CommandOption("--slow-pause <SECONDS>")]
    [Description("Seconds before each chunk in the slow scenario.")]
    [DefaultValue(30)]
    public int SlowPauseSeconds { get; init; } = 30;

    [CommandOption("-v|--verbose")]
    [Description("Debug-level logging.")]
    public bool Verbose { get; init; }

    // ---- report ----
    [CommandOption("--file <PATH>")]
    [Description("report: summarize this capture file.")]
    public string? File { get; init; }

    [CommandOption("--all")]
    [Description("report: include every capture file in --dir, not just the newest.")]
    public bool All { get; init; }

    [CommandOption("--out <PATH>")]
    [Description("report: also write the Markdown report to this file.")]
    public string? Out { get; init; }
}

public sealed class CaptureCommand : AsyncCommand<CaptureSettings>
{
    public override async Task<int> ExecuteAsync(CommandContext context, CaptureSettings settings)
    {
        if (settings.Action is null)
            return await RunServerAsync(settings);
        if (string.Equals(settings.Action, "report", StringComparison.OrdinalIgnoreCase))
            return Report(settings);

        Console.Error.WriteLine(
            $"Unknown action '{settings.Action}'. Use 'conduit capture' or 'conduit capture report'."
        );
        return 2;
    }

    private static async Task<int> RunServerAsync(CaptureSettings s)
    {
        var options = new CaptureOptions
        {
            Host = s.Host,
            Port = s.Port,
            Lan = s.Lan,
            Key = string.IsNullOrEmpty(s.Key) ? null : s.Key,
            DefaultScenario = s.Scenario,
            OutputDirectory = s.Dir,
            Models = s.Models.Length > 0 ? s.Models.ToList() : ["capture"],
            ContextLength = s.ContextLength,
            MaxOutputTokens = s.MaxOutput,
            AdvertiseToolCalling = !s.NoTools,
            ModelsFile = s.ModelsFile,
            KeepAlive = !s.NoKeepAlive,
            KeepAliveInterval = TimeSpan.FromSeconds(s.KeepAliveSeconds),
            SlowChunks = s.SlowChunks,
            SlowPause = TimeSpan.FromSeconds(s.SlowPauseSeconds),
        };

        if (options.Validate() is { } problem)
        {
            Console.Error.WriteLine(problem);
            return 2;
        }

        Logging.Configure(options.OutputDirectory, s.Verbose);
        using var cts = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) =>
        {
            e.Cancel = true;
            cts.Cancel();
        };

        try
        {
            await CaptureServer.RunAsync(
                options,
                logging => logging.AddSerilog(Log.Logger, dispose: false),
                cts.Token
            );
            return 0;
        }
        catch (IOException ex)
            when (ex.Message.Contains("address already in use", StringComparison.OrdinalIgnoreCase))
        {
            Log.Fatal("Port {Port} is already in use. Pick another with --port.", options.Port);
            return 1;
        }
        catch (Exception ex)
        {
            Log.Fatal(ex, "Capture server stopped unexpectedly");
            return 1;
        }
        finally
        {
            await Log.CloseAndFlushAsync();
        }
    }

    private static int Report(CaptureSettings s)
    {
        IReadOnlyList<string> files;
        if (s.File is not null)
            files = [s.File];
        else
        {
            var all = CaptureReport.FindFiles(s.Dir);
            files = s.All || all.Count == 0 ? all : [all[^1]];
        }

        if (files.Count == 0)
        {
            Console.Error.WriteLine(
                $"No capture files found in '{s.Dir}'. Run 'conduit capture' first."
            );
            return 1;
        }
        if (files.Any(f => !File.Exists(f)))
        {
            Console.Error.WriteLine($"Capture file not found: {files.First(f => !File.Exists(f))}");
            return 1;
        }

        var report = CaptureReport.BuildFromFiles(files);
        Console.WriteLine(report);
        if (s.Out is not null)
            File.WriteAllText(s.Out, report);
        return 0;
    }
}
