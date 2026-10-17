namespace Conduit.OpenAi;

/// <summary>Public model ids are <c>&lt;instanceId&gt;/&lt;modelSlug&gt;</c>, or just <c>&lt;instanceId&gt;</c> for the instance default.</summary>
public static class ModelIds
{
    public static string Join(string instanceId, string slug) => $"{instanceId}/{slug}";

    public static (string InstanceId, string? Slug) Split(string model)
    {
        var i = model.IndexOf('/');
        return i < 0 ? (model, null) : (model[..i], model[(i + 1)..]);
    }
}
