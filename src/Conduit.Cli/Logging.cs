using Serilog;
using Serilog.Events;

namespace Conduit.Cli;

internal static class Logging
{
    private const string ConsoleTemplate = "[{Timestamp:HH:mm:ss} {Level:u3}] {Message:lj}{NewLine}{Exception}";
    private const string FileTemplate = "{Timestamp:yyyy-MM-dd HH:mm:ss.fff} [{Level:u3}] {SourceContext}: {Message:lj}{NewLine}{Exception}";

    /// <summary>
    /// Serilog is the application logger: console for the operator, a rolling file next to the captures for later.
    /// The capture library only sees <c>Microsoft.Extensions.Logging</c>; <c>AddSerilog</c> routes it here.
    /// </summary>
    public static void Configure(string logDirectory, bool verbose)
    {
        Directory.CreateDirectory(logDirectory);
        Log.Logger = new LoggerConfiguration()
            .MinimumLevel.Is(verbose ? LogEventLevel.Debug : LogEventLevel.Information)
            .MinimumLevel.Override("Microsoft", LogEventLevel.Warning)
            .Enrich.FromLogContext()
            .WriteTo.Console(outputTemplate: ConsoleTemplate)
            .WriteTo.File(Path.Combine(logDirectory, "capture-.log"),
                rollingInterval: RollingInterval.Day, retainedFileCountLimit: 14, outputTemplate: FileTemplate)
            .CreateLogger();
    }
}
