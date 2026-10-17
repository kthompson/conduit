namespace Conduit.Provider.Core;

/// <summary>One message of an OpenAI-style conversation, already normalized (content parts flattened to text).</summary>
public sealed record ChatMessage(
    string Role,
    string? Text,
    IReadOnlyList<ToolCall>? ToolCalls = null,
    string? ToolCallId = null
);

/// <summary>A tool call the model made (assistant side), or is being asked about (tool result side via <see cref="ChatMessage.ToolCallId"/>).</summary>
public sealed record ToolCall(string Id, string Name, string ArgumentsJson);

/// <summary>A function the caller offers. <see cref="ParametersJson"/> is the JSON Schema object, verbatim.</summary>
public sealed record ToolSpec(string Name, string? Description, string? ParametersJson);

/// <summary>What a provider instance needs to produce one assistant turn. Stateless: the caller resends the whole history.</summary>
public sealed record CompletionRequest(
    string Model,
    IReadOnlyList<ChatMessage> Messages,
    IReadOnlyList<ToolSpec> Tools,
    string? ToolChoice = null,
    int? MaxTokens = null,
    string? ReasoningEffort = null
);

public enum FinishReason
{
    Stop,
    Length,
    ToolCalls,
}

/// <summary>The internal item stream. The OpenAI layer serializes it; providers only produce it.</summary>
public abstract record CompletionEvent;

public sealed record TextDelta(string Text) : CompletionEvent;

public sealed record ReasoningDelta(string Text) : CompletionEvent;

public sealed record ToolCallEvent(ToolCall Call) : CompletionEvent;

public sealed record UsageEvent(int PromptTokens, int CompletionTokens) : CompletionEvent;

public sealed record Finish(FinishReason Reason) : CompletionEvent;
