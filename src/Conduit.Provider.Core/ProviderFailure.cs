namespace Conduit.Provider.Core;

public enum FailureKind
{
    /// <summary>The runtime failed or produced something unusable.</summary>
    Failed,

    /// <summary>The instance cannot serve requests right now (missing binary, not signed in).</summary>
    Unavailable,

    /// <summary>A subscription usage limit; <see cref="ProviderFailure.RetryAfter"/> says when it resets.</summary>
    UsageLimit,

    /// <summary>The request cannot be served as sent (unknown model, unsupported input).</summary>
    BadRequest,
}

/// <summary>Providers throw this; the OpenAI layer maps it to an HTTP status and error object.</summary>
public sealed class ProviderFailure(
    FailureKind kind,
    string message,
    TimeSpan? retryAfter = null,
    Exception? inner = null
) : Exception(message, inner)
{
    public FailureKind Kind { get; } = kind;
    public TimeSpan? RetryAfter { get; } = retryAfter;
}
