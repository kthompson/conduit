using System.Text;
using System.Text.Json.Nodes;

namespace Conduit.Capture;

/// <summary>Appends one JSON object per line to <c>&lt;output dir&gt;/&lt;timestamp&gt;.jsonl</c>, flushing every record.</summary>
public sealed class CaptureStore : IDisposable
{
    private readonly object _gate = new();
    private readonly StreamWriter _writer;

    public string FilePath { get; }

    public CaptureStore(string directory)
    {
        Directory.CreateDirectory(directory);
        var stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");
        var path = Path.Combine(directory, stamp + ".jsonl");
        for (var n = 2; File.Exists(path); n++)
            path = Path.Combine(directory, $"{stamp}-{n}.jsonl");
        FilePath = Path.GetFullPath(path);
        _writer = new StreamWriter(
            new FileStream(FilePath, FileMode.CreateNew, FileAccess.Write, FileShare.ReadWrite),
            new UTF8Encoding(false)
        )
        {
            AutoFlush = true,
            NewLine = "\n",
        };
    }

    public void Append(JsonObject record)
    {
        var line = record.ToJsonString(Wire.WireJson.Opts);
        lock (_gate)
            _writer.WriteLine(line);
    }

    public void Dispose()
    {
        lock (_gate)
            _writer.Dispose();
    }
}
