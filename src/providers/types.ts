import type { ReasoningOutput } from "../config.ts";
import type { ChatCompletionRequest, FinishReason, Usage } from "../openai/types.ts";
import type { Trace } from "../capture/recorder.ts";

/** Normalized output of one provider turn, independent of the client wire format. */
export type TurnEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_call_start"; index: number; id: string; name: string }
  | { type: "tool_call_args"; index: number; delta: string }
  | { type: "done"; finishReason: FinishReason; usage: Usage | undefined }
  | { type: "error"; message: string; failure?: TurnFailure };

/** Why a turn failed, when the cause means this provider (not the request) is the problem. */
export interface TurnFailure {
  kind: "rate_limit" | "auth";
  /** Unix milliseconds when a rate limit lifts, if the provider said. */
  resetsAt?: number;
}

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

/** How a provider's output and defaults are presented to clients. */
export interface ProviderSettings {
  /** Effort used when the request does not carry one. */
  effort: string | undefined;
  /** How thinking is surfaced in chat completion output. */
  reasoning: ReasoningOutput;
  /** Context window advertised for models that have not reported their own. */
  contextWindow: number | undefined;
}

export interface Provider {
  readonly name: string;
  readonly settings: ProviderSettings;
  /** Whether this provider serves `model`, judged from its id alone. */
  owns(model: string): boolean;
  listModels(): Promise<ModelEntry[]>;
  /** Runs one turn. The stream always ends with a `done` or `error` event. */
  turn(input: TurnInput): AsyncIterable<TurnEvent>;
  close(): Promise<void>;
}
