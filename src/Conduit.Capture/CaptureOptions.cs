using System.Net;

namespace Conduit.Capture;

public sealed class CaptureOptions
{
    /// <summary>Bind address. Loopback by default.</summary>
    public string Host { get; set; } = "127.0.0.1";

    /// <summary>Port; 0 picks a free one (used by tests).</summary>
    public int Port { get; set; } = 8788;

    /// <summary>Listen on all interfaces so a remote device can reach the server. Requires <see cref="Key"/>.</summary>
    public bool Lan { get; set; }

    /// <summary>If set, requests must present it as a bearer token / x-api-key. Otherwise any key is accepted.</summary>
    public string? Key { get; set; }

    /// <summary>Scenario used when a request does not pick one (see <see cref="ScenarioSpec"/>).</summary>
    public string DefaultScenario { get; set; } = "text";

    /// <summary>Where <c>&lt;timestamp&gt;.jsonl</c> capture files (and the diagnostic log) are written.</summary>
    public string OutputDirectory { get; set; } = "captures";

    /// <summary>Base model ids advertised by <c>/v1/models</c>. Each also gets <c>id@scenario</c> variants.</summary>
    public IList<string> Models { get; set; } = new List<string> { "capture" };

    public int ContextLength { get; set; } = 200_000;
    public int MaxOutputTokens { get; set; } = 32_000;

    /// <summary>Advertise tool calling / streaming / reasoning support in the model capability blob.</summary>
    public bool AdvertiseToolCalling { get; set; } = true;

    /// <summary>Serve this JSON file verbatim as the <c>/v1/models</c> body instead of the generated list.</summary>
    public string? ModelsFile { get; set; }

    /// <summary>Send SSE keep-alive comments during pauses in the <c>slow</c> scenario.</summary>
    public bool KeepAlive { get; set; } = true;

    public TimeSpan KeepAliveInterval { get; set; } = TimeSpan.FromSeconds(15);

    /// <summary>The <c>slow</c> scenario sends this many chunks...</summary>
    public int SlowChunks { get; set; } = 6;

    /// <summary>...with this pause before each one (default 30 s, so the total is 3 minutes).</summary>
    public TimeSpan SlowPause { get; set; } = TimeSpan.FromSeconds(30);

    /// <summary>Request bodies larger than this are rejected by Kestrel.</summary>
    public long MaxBodyBytes { get; set; } = 256L * 1024 * 1024;

    public bool IsLoopbackHost => IsLoopback(Host);

    /// <summary>Address the server actually binds.</summary>
    public IPAddress BindAddress
    {
        get
        {
            if (Lan) return IPAddress.Any;
            if (string.Equals(Host, "localhost", StringComparison.OrdinalIgnoreCase)) return IPAddress.Loopback;
            return IPAddress.TryParse(Host, out var ip) ? ip : IPAddress.Loopback;
        }
    }

    /// <summary>Returns an error message, or null if the options are usable.</summary>
    public string? Validate()
    {
        if (Port is < 0 or > 65535) return $"Port {Port} is out of range.";
        if (!string.Equals(Host, "localhost", StringComparison.OrdinalIgnoreCase) && !IPAddress.TryParse(Host, out _))
            return $"Host '{Host}' is not an IP address or 'localhost'.";
        var exposed = Lan || !IsLoopbackHost;
        if (exposed && string.IsNullOrEmpty(Key))
            return "Listening beyond loopback (--lan or a non-loopback --host) requires --key.";
        if (Models.Count == 0) return "At least one model id is required.";
        if (SlowChunks < 1) return "SlowChunks must be at least 1.";
        if (SlowPause < TimeSpan.Zero || KeepAliveInterval <= TimeSpan.Zero) return "Pause/interval durations must be positive.";
        if (ModelsFile is not null && !File.Exists(ModelsFile)) return $"Models file '{ModelsFile}' does not exist.";
        return null;
    }

    private static bool IsLoopback(string host) =>
        string.Equals(host, "localhost", StringComparison.OrdinalIgnoreCase)
        || (IPAddress.TryParse(host, out var ip) && IPAddress.IsLoopback(ip));
}

public sealed class CaptureConfigException(string message) : Exception(message);
