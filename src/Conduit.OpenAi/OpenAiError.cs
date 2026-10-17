using System.Text.Json.Nodes;
using Conduit.Provider.Core;

namespace Conduit.OpenAi;

/// <summary>An error that becomes an OpenAI-shaped <c>{"error":{...}}</c> body with an HTTP status.</summary>
public sealed class OpenAiError(int status, string type, string code, string message, TimeSpan? retryAfter = null) : Exception(message)
{
    public int Status { get; } = status;
    public string Type { get; } = type;
    public string Code { get; } = code;
    public TimeSpan? RetryAfter { get; } = retryAfter;

    public JsonObject ToJson() => Body(Type, Code, Message);

    public static JsonObject Body(string type, string code, string message) => new()
    {
        ["error"] = new JsonObject { ["message"] = message, ["type"] = type, ["param"] = null, ["code"] = code },
    };

    public static OpenAiError BadRequest(string message, string code = "invalid_request") =>
        new(400, "invalid_request_error", code, message);

    public static OpenAiError NotFound(string message, string code = "not_found") =>
        new(404, "invalid_request_error", code, message);

    public static OpenAiError Unauthorized(string message) =>
        new(401, "invalid_request_error", "invalid_api_key", message);

    public static OpenAiError From(ProviderFailure f) => f.Kind switch
    {
        FailureKind.UsageLimit => new(429, "rate_limit_error", "usage_limit", f.Message, f.RetryAfter),
        FailureKind.Unavailable => new(503, "server_error", "provider_unavailable", f.Message),
        FailureKind.BadRequest => new(400, "invalid_request_error", "unsupported", f.Message),
        _ => new(502, "server_error", "provider_failed", f.Message),
    };
}
