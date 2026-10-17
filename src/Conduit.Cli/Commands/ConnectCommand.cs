using System.ComponentModel;
using System.Text.Json;
using System.Text.Json.Nodes;
using Conduit.Server;
using Spectre.Console;
using Spectre.Console.Cli;

namespace Conduit.Cli.Commands;

public sealed class ConnectSettings : ConfigSettings
{
    [CommandArgument(0, "<target>")]
    [Description("What to connect. Only 'copilot' (the GitHub Copilot app) for now.")]
    public string Target { get; init; } = "";

    [CommandOption("--host <HOST>")]
    [Description("Host name or address to show in the base URL instead of the configured listen address.")]
    public string? Host { get; init; }

    [CommandOption("--show-key")]
    [Description("Print the first configured API key. Without it the key is not shown.")]
    public bool ShowKey { get; init; }

    [CommandOption("--check")]
    [Description("Also call the running server with the configured key and confirm it serves these models.")]
    public bool Check { get; init; }

    [CommandOption("--json")]
    [Description("Machine-readable output.")]
    public bool Json { get; init; }
}

public sealed class ConnectCommand : AsyncCommand<ConnectSettings>
{
    public override async Task<int> ExecuteAsync(CommandContext context, ConnectSettings s)
    {
        if (!s.Target.Equals("copilot", StringComparison.OrdinalIgnoreCase))
        {
            Console.Error.WriteLine($"Unknown target '{s.Target}'. Use `conduit connect copilot`.");
            return 2;
        }

        ConduitConfig config;
        try { config = ConduitConfig.Load(s.ConfigPath); }
        catch (ConfigException e)
        {
            Console.Error.WriteLine(e.Message);
            return 1;
        }

        var info = await ConnectInfo.BuildAsync(config, Drivers.All(), s.Host, s.ShowKey, CancellationToken.None);
        IReadOnlyList<(bool Ok, string Message)> verify = [];
        if (s.Check) verify = await ConnectInfo.VerifyAsync(info, config.Server.ApiKeys.FirstOrDefault(), CancellationToken.None);

        if (s.Json) Console.WriteLine(ToJson(info, verify));
        else Print(info, verify);
        return info.Problems.Count > 0 || verify.Any(v => !v.Ok) ? 1 : 0;
    }

    private static void Print(ConnectInfo i, IReadOnlyList<(bool Ok, string Message)> verify)
    {
        AnsiConsole.MarkupLine("[bold]GitHub Copilot app[/]: Settings > Model providers > Add provider > Custom endpoint\n");
        void Row(string label, string value) => AnsiConsole.MarkupLine($"  [grey]{label,-16}[/] {Markup.Escape(value)}");
        Row("Display name", i.DisplayName);
        Row("Base URL", i.BaseUrl);
        Row("Wire API", i.WireApi);
        Row("API key", !i.KeyRequired ? "leave blank (none is configured)"
            : i.Key ?? "one of server.api-keys (not shown; rerun with --show-key to print the first)");
        Row("Custom headers", "leave blank");

        AnsiConsole.MarkupLine("\nThen use the sync icon next to the provider to list models, and add the ones you want:");
        foreach (var m in i.Models)
            AnsiConsole.MarkupLine($"  [green]{Markup.Escape(m.Id),-28}[/] {Markup.Escape(m.Name)}  [grey]({m.ContextWindow / 1000}k context)[/]");

        if (i.Notes.Count > 0) AnsiConsole.WriteLine();
        foreach (var n in i.Notes) AnsiConsole.MarkupLine($"[blue]note[/] {Markup.Escape(n)}");
        foreach (var p in i.Problems) AnsiConsole.MarkupLine($"[red]problem[/] {Markup.Escape(p)}");
        if (verify.Count > 0) AnsiConsole.WriteLine();
        foreach (var (ok, message) in verify) AnsiConsole.MarkupLine($"{(ok ? "[green]ok  [/]" : "[red]FAIL[/]")} {Markup.Escape(message)}");
    }

    private static string ToJson(ConnectInfo i, IReadOnlyList<(bool Ok, string Message)> verify)
    {
        var o = new JsonObject
        {
            ["displayName"] = i.DisplayName,
            ["baseUrl"] = i.BaseUrl,
            ["wireApi"] = i.WireApi,
            ["keyRequired"] = i.KeyRequired,
            ["apiKey"] = i.Key,
            ["models"] = new JsonArray(i.Models.Select(m => (JsonNode?)new JsonObject
            {
                ["id"] = m.Id, ["name"] = m.Name, ["contextWindow"] = m.ContextWindow, ["reasoning"] = m.Reasoning,
            }).ToArray()),
            ["notes"] = new JsonArray(i.Notes.Select(n => (JsonNode?)JsonValue.Create(n)).ToArray()),
            ["problems"] = new JsonArray(i.Problems.Select(n => (JsonNode?)JsonValue.Create(n)).ToArray()),
            ["checks"] = new JsonArray(verify.Select(v => (JsonNode?)new JsonObject { ["ok"] = v.Ok, ["message"] = v.Message }).ToArray()),
        };
        return o.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
    }
}
