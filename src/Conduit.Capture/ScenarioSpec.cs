namespace Conduit.Capture;

/// <summary>
/// A scenario name plus an optional variant, written <c>name</c> or <c>name-variant</c>
/// (e.g. <c>slow-nokeepalive</c>, <c>error-429</c>). Picked per request from, in order:
/// <c>?scenario=</c>, the <c>X-Capture-Scenario</c> header, an <c>@spec</c> suffix on the model id, then the server default.
/// </summary>
public readonly record struct ScenarioSpec(string Name, string? Variant)
{
    public static readonly string[] Names = ["text", "slow", "progress", "reasoning", "toolcall", "error", "echo"];

    /// <summary>The specs advertised as <c>model@spec</c> ids so an app's model picker can switch scenarios.</summary>
    public static readonly string[] Advertised =
    [
        "text", "slow", "slow-nokeepalive", "progress", "reasoning", "toolcall",
        "error", "error-429", "error-500", "error-mid", "echo",
    ];

    public bool IsKnown => Array.IndexOf(Names, Name) >= 0;

    public override string ToString() => Variant is null ? Name : $"{Name}-{Variant}";

    public static ScenarioSpec Parse(string? raw)
    {
        raw = (raw ?? "").Trim().ToLowerInvariant();
        if (raw.Length == 0) return new ScenarioSpec("text", null);
        var dash = raw.IndexOf('-');
        return dash < 0 ? new ScenarioSpec(raw, null) : new ScenarioSpec(raw[..dash], raw[(dash + 1)..]);
    }

    /// <summary>Splits <c>model@spec</c> into the model id and the spec (null when there is no suffix).</summary>
    public static (string Model, ScenarioSpec? Spec) SplitModel(string? model)
    {
        if (string.IsNullOrEmpty(model)) return ("", null);
        var at = model.LastIndexOf('@');
        if (at <= 0 || at == model.Length - 1) return (model, null);
        return (model[..at], Parse(model[(at + 1)..]));
    }
}
