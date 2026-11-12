import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { defaultConfig } from "../src/config.ts";
import { MockProvider } from "../src/providers/mock/provider.ts";
import type { ModelEntry, Provider, TurnInput } from "../src/providers/types.ts";
import { startServer, type ConduitServer } from "../src/server.ts";

/** A provider that answers with its own name and the effort and model it was routed. */
function fake(name: string, prefix: string, models: ModelEntry[], effort?: string): Provider {
  return {
    name,
    settings: { effort, reasoning: "reasoning_content", contextWindow: 100_000 },
    owns: (model) => model.startsWith(prefix),
    listModels: () => Promise.resolve(models),
    async *turn(input: TurnInput) {
      yield { type: "text", delta: `${name}:${input.upstreamModel}:${input.effort ?? "-"}` };
      yield { type: "done", finishReason: "stop", usage: undefined };
    },
    close: () => Promise.resolve(),
  };
}

let server: ConduitServer;

before(async () => {
  const config = defaultConfig();
  config.server.port = 0;
  config.defaultProvider = "claude";
  server = await startServer(config, {
    mock: new MockProvider({ delayMs: 0 }),
    claude: fake("claude", "claude-", [{ id: "claude-a", ownedBy: "anthropic" }], "medium"),
    codex: fake("codex", "gpt-", [{ id: "gpt-a", ownedBy: "openai", contextWindow: 5 }], "low"),
  });
});

after(() => server.close());

async function ask(model: string, extra: object = {}) {
  const res = await fetch(`${server.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], ...extra }),
  });
  return (await res.json()) as { choices: Array<{ message: { content: string } }> };
}

test("each model goes to the provider that owns it, with that provider's default effort", async () => {
  assert.equal((await ask("claude-a")).choices[0]?.message.content, "claude:claude-a:medium");
  assert.equal((await ask("gpt-a")).choices[0]?.message.content, "codex:gpt-a:low");
});

test("a request's own effort, or an effort suffix, beats the provider default", async () => {
  assert.equal(
    (await ask("gpt-a", { reasoning_effort: "high" })).choices[0]?.message.content,
    "codex:gpt-a:high",
  );
  assert.equal((await ask("gpt-a:ultra")).choices[0]?.message.content, "codex:gpt-a:ultra");
});

test("a model nobody owns goes to the default provider", async () => {
  assert.equal((await ask("mystery")).choices[0]?.message.content, "claude:mystery:medium");
});

test("/v1/models merges every provider and uses each one's context window", async () => {
  const res = await fetch(`${server.url}/v1/models`);
  const { data } = (await res.json()) as {
    data: Array<{ id: string; owned_by: string; context_window?: number }>;
  };
  const byId = new Map(data.map((m) => [m.id, m]));
  assert.equal(byId.get("claude-a")?.context_window, 100_000);
  assert.equal(byId.get("gpt-a")?.context_window, 5);
  assert.equal(byId.get("gpt-a")?.owned_by, "openai");
  assert.ok(byId.has("mock"));
});

test("a provider that cannot list its models does not hide the others", async () => {
  const config = defaultConfig();
  config.server.port = 0;
  const broken: Provider = {
    ...fake("codex", "gpt-", []),
    listModels: () => Promise.reject(new Error("no codex")),
  };
  const s = await startServer(config, {
    claude: fake("claude", "claude-", [{ id: "claude-a", ownedBy: "anthropic" }]),
    codex: broken,
  });
  try {
    const res = await fetch(`${s.url}/v1/models`);
    const { data } = (await res.json()) as { data: Array<{ id: string }> };
    assert.deepEqual(
      data.map((m) => m.id),
      ["claude-a"],
    );
  } finally {
    await s.close();
  }
});
