import type { ChatCompletionRequest, FinishReason, Usage } from "../openai/types.ts";
import type { Trace } from "../capture/recorder.ts";

/** Normalized output of one provider turn, independent of the client wire format. */
export type TurnEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_call_start"; index: number; id: string; name: string }
  | { type: "tool_call_args"; index: number; delta: string }
  | { type: "done"; finishReason: FinishReason; usage: Usage | undefined }
  | { type: "error"; message: string };

export interface TurnInput {
  request: ChatCompletionRequest;
  /** Model id after config routing; what the provider should run. */
  upstreamModel: string;
  effort: string | undefined;
  /** Aborted when the client disconnects. */
  signal: AbortSignal;
  trace: Trace;
}

export interface ModelEntry {
  id: string;
  ownedBy: string;
  displayName?: string;
  supportedEfforts?: string[];
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface Provider {
  readonly name: string;
  listModels(): Promise<ModelEntry[]>;
  /** Runs one turn. The stream always ends with a `done` or `error` event. */
  turn(input: TurnInput): AsyncIterable<TurnEvent>;
  close(): Promise<void>;
}
