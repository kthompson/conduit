using System.Security.Cryptography;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Conduit.Capture.Wire;

/// <summary>Which on-the-wire shape a reasoning delta takes. Renderers ignore shapes that are not theirs.</summary>
public enum ReasoningShape
{
    ChatReasoningContent,   // delta.reasoning_content   (DeepSeek and most OpenAI-compatible servers)
    ChatReasoning,          // delta.reasoning           (OpenRouter and others)
    ChatReasoningDetails,   // delta.reasoning_details[] (OpenRouter structured form)
    ResponsesSummary,       // response.reasoning_summary_text.delta
    ResponsesText,          // response.reasoning_text.delta
    AnthropicThinking,      // content_block thinking + thinking_delta
}

/// <summary>Wire-neutral description of what a scenario "says". Renderers turn these into a protocol.</summary>
public abstract record ScriptEvent;

public sealed record TextDelta(string Text) : ScriptEvent;
public sealed record ReasoningDelta(string Text, ReasoningShape Shape) : ScriptEvent;
public sealed record ToolCallEvent(string Id, string Name, string ArgumentsJson) : ScriptEvent;

/// <summary>Wait before the next event. When <paramref name="KeepAlive"/> is set, SSE comments are sent while waiting.</summary>
public sealed record Pause(TimeSpan Duration, bool KeepAlive) : ScriptEvent;

/// <summary>End of a normal turn. <paramref name="Reason"/> is "stop" or "tool_calls".</summary>
public sealed record Finish(string Reason) : ScriptEvent;

/// <summary>A failure after streaming started. The driver aborts the connection after sending it.</summary>
public sealed record StreamError(string Message) : ScriptEvent;

/// <summary>One SSE frame: an event with data, or a comment line.</summary>
public sealed record SseFrame(string? Event, string? Data, string? Comment = null)
{
    public byte[] ToBytes()
    {
        var sb = new System.Text.StringBuilder();
        if (Comment is not null) sb.Append(": ").Append(Comment).Append("\n\n");
        else
        {
            if (Event is not null) sb.Append("event: ").Append(Event).Append('\n');
            sb.Append("data: ").Append(Data).Append("\n\n");
        }
        return System.Text.Encoding.UTF8.GetBytes(sb.ToString());
    }
}

public sealed class RenderContext
{
    public required string Id { get; init; }
    public required string Model { get; init; }
    public long Created { get; init; } = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
    public bool IncludeUsage { get; init; }
    public int PromptTokens { get; init; }
}

public interface IWireRenderer
{
    /// <summary>Frames sent before any scenario event (message start, response.created, ...).</summary>
    IEnumerable<SseFrame> Begin();

    IEnumerable<SseFrame> Render(ScriptEvent ev);

    bool Finished { get; }

    /// <summary>The complete non-streaming response object, available once <see cref="Finished"/>.</summary>
    JsonObject? Final { get; }

    JsonObject ErrorBody(string type, string code, string message);
}

internal static class WireJson
{
    public static readonly JsonSerializerOptions Opts = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        WriteIndented = false,
    };

    public static string S(JsonNode node) => node.ToJsonString(Opts);

    public static string NewId(string prefix, int length = 24)
    {
        const string alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
        Span<char> chars = stackalloc char[length];
        for (var i = 0; i < length; i++) chars[i] = alphabet[RandomNumberGenerator.GetInt32(alphabet.Length)];
        return prefix + new string(chars);
    }

    public static int EstimateTokens(int chars) => Math.Max(1, chars / 4);
}
