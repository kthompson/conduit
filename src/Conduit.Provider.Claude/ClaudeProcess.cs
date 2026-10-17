using System.Diagnostics;
using System.Text;
using Conduit.Provider.Core;

namespace Conduit.Provider.Claude;

/// <summary>Everything needed to start one <c>claude</c> process.</summary>
public sealed record ClaudeInvocation(
    string Binary,
    IReadOnlyList<string> Args,
    string WorkingDirectory,
    IReadOnlyDictionary<string, string> Env,
    string? Stdin);

/// <summary>The seam between the driver and the real process, so tests can replay recorded stream-json.</summary>
public interface IClaudeProcess
{
    /// <summary>Stdout lines as they arrive. Throws <see cref="ProviderFailure"/> if the process cannot start or dies without output.</summary>
    IAsyncEnumerable<string> RunAsync(ClaudeInvocation invocation, CancellationToken ct);

    /// <summary>Run to completion and return stdout. Used by probes only.</summary>
    Task<(int ExitCode, string Output)> RunToEndAsync(ClaudeInvocation invocation, CancellationToken ct);
}

public sealed class SystemClaudeProcess : IClaudeProcess
{
    public async IAsyncEnumerable<string> RunAsync(ClaudeInvocation inv, [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
    {
        using var process = Start(inv);
        // Kill only the process we spawned, and only when the caller goes away or stops reading.
        using var kill = ct.Register(() => TryKill(process));
        var stderr = new StringBuilder();
        process.ErrorDataReceived += (_, e) => { if (e.Data is not null) lock (stderr) stderr.AppendLine(e.Data); };
        process.BeginErrorReadLine();

        if (inv.Stdin is not null) await process.StandardInput.WriteAsync(inv.Stdin.AsMemory(), ct);
        process.StandardInput.Close();

        var any = false;
        try
        {
            while (await process.StandardOutput.ReadLineAsync(ct) is { } line)
            {
                any = true;
                yield return line;
            }
        }
        finally
        {
            if (!process.HasExited) TryKill(process);
        }

        await process.WaitForExitAsync(CancellationToken.None);
        if (!any && process.ExitCode != 0)
            throw new ProviderFailure(FailureKind.Failed, $"claude exited with code {process.ExitCode}: {Tail(stderr)}");
    }

    public async Task<(int ExitCode, string Output)> RunToEndAsync(ClaudeInvocation inv, CancellationToken ct)
    {
        using var process = Start(inv);
        using var kill = ct.Register(() => TryKill(process));
        process.StandardInput.Close();
        var output = await process.StandardOutput.ReadToEndAsync(ct);
        await process.WaitForExitAsync(ct);
        return (process.ExitCode, output);
    }

    private static Process Start(ClaudeInvocation inv)
    {
        var psi = new ProcessStartInfo(inv.Binary)
        {
            WorkingDirectory = inv.WorkingDirectory,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        foreach (var a in inv.Args) psi.ArgumentList.Add(a);
        foreach (var (k, v) in inv.Env) psi.Environment[k] = v;
        try { return Process.Start(psi) ?? throw new ProviderFailure(FailureKind.Unavailable, $"Could not start '{inv.Binary}'."); }
        catch (System.ComponentModel.Win32Exception e)
        {
            throw new ProviderFailure(FailureKind.Unavailable, $"Could not start '{inv.Binary}': {e.Message}", inner: e);
        }
    }

    private static void TryKill(Process p)
    {
        try { if (!p.HasExited) p.Kill(entireProcessTree: true); }
        catch (InvalidOperationException) { }
    }

    private static string Tail(StringBuilder sb)
    {
        lock (sb)
        {
            var s = sb.ToString().Trim();
            return s.Length <= 500 ? s : s[^500..];
        }
    }
}
