using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Conduit.Provider.Core;

namespace Conduit.Provider.Claude;

/// <summary>Turns a stateless OpenAI conversation into the system prompt and stdin prompt for one <c>claude -p</c> run.</summary>
public static class PromptBuilder
{
    public const string ToolOpen = "<tool_call>";
    public const string ToolClose = "</tool_call>";

    public sealed record Built(string SystemPrompt, string Prompt);

    public static Built Build(CompletionRequest request)
    {
        var system = new StringBuilder();
        foreach (var m in request.Messages.Where(m => m.Role == "system"))
            if (!string.IsNullOrWhiteSpace(m.Text)) system.AppendLine(m.Text).AppendLine();

        if (request.Tools.Count > 0 && request.ToolChoice != "none") system.Append(ToolProtocol(request));

        var turns = request.Messages.Where(m => m.Role != "system").ToList();
        // One plain user message needs no transcript framing.
        if (turns is [{ Role: "user", ToolCalls: null } only]) return new Built(system.ToString().TrimEnd(), only.Text ?? "");

        var sb = new StringBuilder("Here is the conversation so far. Reply as the assistant to the last message only.\n\n");
        foreach (var t in turns) Render(sb, t);
        return new Built(system.ToString().TrimEnd(), sb.ToString().TrimEnd());
    }

    private static void Render(StringBuilder sb, ChatMessage m)
    {
        switch (m.Role)
        {
            case "user":
                sb.Append("[user]\n").Append(m.Text).Append("\n\n");
                break;
            case "assistant":
                sb.Append("[assistant]\n");
                if (!string.IsNullOrEmpty(m.Text)) sb.Append(m.Text).Append('\n');
                if (m.ToolCalls is not null)
                    foreach (var c in m.ToolCalls) sb.Append(Call(c)).Append('\n');
                sb.Append('\n');
                break;
            case "tool":
                sb.Append("[tool result for ").Append(m.ToolCallId).Append("]\n").Append(m.Text).Append("\n\n");
                break;
        }
    }

    /// <summary>The wire form of a call, in the history and in what the model is asked to produce.</summary>
    public static string Call(ToolCall c)
    {
        var args = SafeParse(c.ArgumentsJson) ?? new JsonObject();
        return ToolOpen + new JsonObject { ["name"] = c.Name, ["arguments"] = args }.ToJsonString() + ToolClose;
    }

    private static JsonNode? SafeParse(string json)
    {
        try { return JsonNode.Parse(json); }
        catch (JsonException) { return null; }
    }

    private static string ToolProtocol(CompletionRequest request)
    {
        var sb = new StringBuilder();
        sb.AppendLine("# Tool calling");
        sb.AppendLine("You are the model inside a harness that runs tools for you. You cannot run anything yourself and must never claim to have run a tool.");
        sb.AppendLine($"To call a tool, write one block per call, exactly like this: {ToolOpen}{{\"name\":\"TOOL_NAME\",\"arguments\":{{...}}}}{ToolClose}");
        sb.AppendLine("The arguments must be a JSON object that follows the tool's schema. Several independent calls may be written one after another.");
        sb.AppendLine("Write nothing after your last tool call: the harness will run it and send the result back. If you need no tool, just answer in plain text.");
        if (request.ToolChoice == "required") sb.AppendLine("You must call at least one tool in this reply.");
        else if (request.ToolChoice is { } c && c.StartsWith("fn:")) sb.AppendLine($"You must call the tool '{c[3..]}' in this reply.");
        sb.AppendLine();
        sb.AppendLine("Available tools (name, description, JSON schema of the arguments):");
        foreach (var t in request.Tools)
        {
            var spec = new JsonObject { ["name"] = t.Name };
            if (t.Description is not null) spec["description"] = t.Description;
            if (t.ParametersJson is not null && SafeParse(t.ParametersJson) is { } p) spec["parameters"] = p;
            sb.AppendLine(spec.ToJsonString());
        }
        return sb.ToString();
    }
}
