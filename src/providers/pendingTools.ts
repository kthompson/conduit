import { createHash } from "node:crypto";
import type { ToolResultContent } from "./conversation.ts";

export interface ToolResult {
  content: ToolResultContent[];
  isError: boolean;
}

const errorResult = (message: string): ToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

/**
 * Tool calls the model has made that the HTTP client has not answered yet.
 * The model's runtime asks for a result as soon as a call is complete, but the
 * client only runs tools after the HTTP response ends, so each call waits here
 * until `deliver` hands over the client's result.
 */
export class PendingToolCalls {
  private readonly results = new Map<string, ToolResult>();
  private readonly waiters = new Map<string, (result: ToolResult) => void>();

  deliver(callId: string, content: ToolResultContent[]): void {
    const result: ToolResult = { content, isError: false };
    const waiter = this.waiters.get(callId);
    if (waiter) {
      this.waiters.delete(callId);
      waiter(result);
    } else {
      this.results.set(callId, result);
    }
  }

  /** Resolves with the client's result for `callId`, or an error result if cancelled. */
  wait(callId: string, signal?: AbortSignal): Promise<ToolResult> {
    const ready = this.results.get(callId);
    if (ready) {
      this.results.delete(callId);
      return Promise.resolve(ready);
    }
    return new Promise((resolve) => {
      this.waiters.set(callId, resolve);
      signal?.addEventListener(
        "abort",
        () => {
          if (this.waiters.get(callId) === resolve) {
            this.waiters.delete(callId);
            resolve(errorResult("Tool call was cancelled."));
          }
        },
        { once: true },
      );
    });
  }

  /** Ends every waiting call, e.g. when the session closes. */
  cancelAll(reason: string): void {
    for (const [id, waiter] of this.waiters) {
      this.waiters.delete(id);
      waiter(errorResult(reason));
    }
    this.results.clear();
  }
}

/** A tool name safe for a model runtime: no odd characters, and short enough with `prefixLength` taken. */
export function aliasFor(name: string, prefixLength = 0, maxLength = 64): string {
  const safe = name.replaceAll(/[^a-zA-Z0-9_-]/g, "_");
  if (prefixLength + safe.length <= maxLength) return safe;
  const digest = createHash("sha256").update(name).digest("hex").slice(0, 8);
  return `${safe.slice(0, maxLength - prefixLength - 9)}_${digest}`;
}

export const NO_RESULT_TEXT = "The client did not return a result for this tool call.";
