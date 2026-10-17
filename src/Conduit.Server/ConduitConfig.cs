using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Conduit.Provider.Core;
using Hocon;

namespace Conduit.Server;

public sealed class ConfigException(string message, Exception? inner = null)
    : Exception(message, inner);

public sealed record ServerSettings(
    string Host,
    int Port,
    IReadOnlyList<string> ApiKeys,
    string DataDirectory
)
{
    public bool IsLoopback => Host is "127.0.0.1" or "localhost" or "::1" or "[::1]";
}

public sealed record ConduitConfig(
    ServerSettings Server,
    IReadOnlyList<ProviderInstanceConfig> Instances
)
{
    private static readonly Regex InstanceId = new("^[a-zA-Z][a-zA-Z0-9_-]{0,63}$");

    public static string DefaultPath =>
        Path.Combine(
            Environment.GetEnvironmentVariable("XDG_CONFIG_HOME") is { Length: > 0 } x
                ? x
                : Path.Combine(Home, ".config"),
            "conduit",
            "conduit.conf"
        );

    private static string Home => Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

    /// <summary>
    /// Reads the main file plus every <c>instances.d/*.conf</c> beside it (the files the setup wizard owns). They are parsed as
    /// one document, so objects merge. HOCON libraries are read-only: this never rewrites what the user wrote.
    /// </summary>
    public static ConduitConfig Load(string path)
    {
        if (!File.Exists(path))
            throw new ConfigException($"Config file not found: {path}");
        var text = File.ReadAllText(path);
        var dir = Path.Combine(Path.GetDirectoryName(Path.GetFullPath(path))!, "instances.d");
        if (Directory.Exists(dir))
            foreach (var f in Directory.EnumerateFiles(dir, "*.conf").Order(StringComparer.Ordinal))
                text += "\n" + File.ReadAllText(f);
        return Parse(text);
    }

    public static ConduitConfig Parse(string text)
    {
        HoconRoot root;
        try
        {
            root = HoconParser.Parse(text);
        }
        catch (Exception e) when (e is HoconException or HoconParserException)
        {
            throw new ConfigException($"Invalid config: {e.Message}", e);
        }

        var listen = root.HasPath("server.listen")
            ? root.GetString("server.listen")
            : "127.0.0.1:8787";
        var (host, port) = SplitListen(listen);
        var keys = root.HasPath("server.api-keys")
            ? root.GetStringList("server.api-keys").Where(k => k.Length > 0).ToList()
            : [];
        var data = root.HasPath("server.data-dir")
            ? Expand(root.GetString("server.data-dir"))
            : Path.Combine(Home, ".local", "share", "conduit");
        var server = new ServerSettings(host, port, keys, data);

        var instances = new List<ProviderInstanceConfig>();
        if (root.HasPath("provider-instances"))
            foreach (var (id, field) in root.GetObject("provider-instances"))
            {
                if (!InstanceId.IsMatch(id))
                    throw new ConfigException(
                        $"Invalid instance id '{id}': use letters, digits, '-' and '_' (max 64), starting with a letter."
                    );
                if (field.Value.Type != HoconType.Object)
                    throw new ConfigException($"provider-instances.{id} must be an object.");
                instances.Add(ParseInstance(id, field.Value));
            }
        return new ConduitConfig(server, instances);
    }

    private static ProviderInstanceConfig ParseInstance(string id, HoconValue value)
    {
        var o = (JsonObject)HoconJson.ToJson(value)!;
        var driver =
            o["driver"]?.GetValue<string>()
            ?? throw new ConfigException($"provider-instances.{id} is missing 'driver'.");
        var env = new Dictionary<string, string>();
        if (o["environment"] is JsonArray a)
            foreach (var e in a)
                env[e!["name"]!.GetValue<string>()] = e["value"]!.GetValue<string>();
        var mode = o["mode"]?.GetValue<string>() ?? "model";
        if (mode is not ("model" or "agent"))
            throw new ConfigException(
                $"provider-instances.{id}.mode must be 'model' or 'agent', not '{mode}'."
            );
        return new ProviderInstanceConfig(
            id,
            driver,
            o["display-name"]?.GetValue<string>(),
            o["enabled"]?.GetValue<bool>() ?? true,
            mode,
            env,
            o["config"] as JsonObject ?? []
        );
    }

    private static (string Host, int Port) SplitListen(string listen)
    {
        var i = listen.LastIndexOf(':');
        if (i < 0 || !int.TryParse(listen[(i + 1)..], out var port) || port is < 0 or > 65535)
            throw new ConfigException(
                $"server.listen must look like 127.0.0.1:8787, not '{listen}'."
            );
        return (listen[..i], port);
    }

    private static string Expand(string p) => p.StartsWith('~') ? Home + p[1..] : p;
}

internal static class HoconJson
{
    public static JsonNode? ToJson(HoconValue v) =>
        v.Type switch
        {
            HoconType.Object => new JsonObject(
                v.GetObject().Select(kv => KeyValuePair.Create(kv.Key, ToJson(kv.Value.Value)))
            ),
            HoconType.Array => new JsonArray(v.GetArray().Select(ToJson).ToArray()),
            HoconType.Boolean => JsonValue.Create(v.GetBoolean()),
            HoconType.Number => int.TryParse(v.GetString(), out var i) ? JsonValue.Create(i)
            : long.TryParse(v.GetString(), out var l) ? JsonValue.Create(l)
            : JsonValue.Create(v.GetDouble()),
            _ => JsonValue.Create(v.GetString()),
        };
}
