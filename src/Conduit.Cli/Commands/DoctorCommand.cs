using System.ComponentModel;
using Conduit.Server;
using Spectre.Console;
using Spectre.Console.Cli;

namespace Conduit.Cli.Commands;

public sealed class DoctorSettings : ConfigSettings
{
    [CommandOption("--skip-completion")]
    [Description("Do not send the one-word sample prompt to each ready instance (it uses a little of the subscription).")]
    public bool SkipCompletion { get; init; }
}

public sealed class DoctorCommand : AsyncCommand<DoctorSettings>
{
    public override async Task<int> ExecuteAsync(CommandContext context, DoctorSettings s)
    {
        using var cts = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };

        int fails = 0, warns = 0;
        await foreach (var c in Doctor.RunAsync(s.ConfigPath, Drivers.All(), !s.SkipCompletion, cts.Token))
        {
            var (mark, color) = c.Status switch
            {
                CheckStatus.Ok => ("ok  ", "green"),
                CheckStatus.Info => ("info", "blue"),
                CheckStatus.Warn => ("warn", "yellow"),
                _ => ("FAIL", "red"),
            };
            if (c.Status == CheckStatus.Fail) fails++;
            if (c.Status == CheckStatus.Warn) warns++;
            AnsiConsole.MarkupLine($"[{color}]{mark}[/] [bold]{Markup.Escape(c.Title)}[/]" + (c.Detail is null ? "" : $"\n     {Markup.Escape(c.Detail)}"));
        }

        AnsiConsole.WriteLine();
        if (fails > 0) AnsiConsole.MarkupLine($"[red]{fails} problem(s) found.[/] Fix them, then run `conduit doctor` again.");
        else AnsiConsole.MarkupLine(warns > 0 ? $"[yellow]Ready, with {warns} warning(s).[/]" : "[green]Everything looks good.[/]");
        return fails > 0 ? 1 : 0;
    }
}
