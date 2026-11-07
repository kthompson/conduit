import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultConfig } from "../src/config.ts";
import { CodexProvider } from "../src/providers/codex/provider.ts";
import { fetchCodexUsage } from "../src/providers/codex/usage.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import { ProviderStore } from "../src/providers/store.ts";
import { fakeCodex, turn, user } from "./fixtures/codex.ts";

test("a rate-limited login hands the conversation to the next Codex login", async () => {
  const limited = fakeCodex("limited");
  const spare = fakeCodex("ok");
  const store = new ProviderStore(limited.file("providers.json"));
  store.add({ type: "codex", name: "Limited", configDir: limited.home });
  store.add({ type: "codex", name: "Spare", configDir: spare.home });
  const registry = new ProviderRegistry(store, { ...defaultConfig(), codex: limited.config });
  const provider = new CodexProvider(limited.config, registry);
  try {
    const out = await turn(provider, [user("hello there")]);
    assert.equal(out.text, "unknown prompt");
    assert.equal(registry.statusOf(store.get("limited")!).health, "rate_limited");
    assert.equal(registry.statusOf(store.get("spare")!).counters.requests, 1);
    // The Claude login is never a candidate for a Codex conversation.
    assert.equal(registry.pick(new Set(["limited", "spare"]), "codex"), undefined);
  } finally {
    await provider.close();
  }
});

test("models come from model/list; hidden ones are left out", async () => {
  const { config } = fakeCodex();
  const provider = new CodexProvider(config);
  try {
    const models = await provider.listModels();
    assert.deepEqual(models, [
      {
        id: "gpt-fake",
        ownedBy: "openai",
        displayName: "GPT Fake",
        supportedEfforts: ["low", "high"],
      },
    ]);
    assert.ok(provider.owns("gpt-fake"));
    assert.ok(provider.owns("gpt-6-luna"));
    assert.ok(!provider.owns("claude-opus-5"));
  } finally {
    await provider.close();
  }
});

test("usage reads the account and plan windows", async () => {
  const { config } = fakeCodex();
  const usage = await fetchCodexUsage(config);
  assert.equal(usage.account?.email, "dev@example.com");
  assert.equal(usage.account?.plan, "plus");
  assert.deepEqual(
    usage.windows.map((w) => [w.label, w.percent]),
    [
      ["5-hour session", 42],
      ["Weekly", 10],
    ],
  );
  assert.equal(usage.windows[0]?.resetsAt, new Date(1_900_000_000_000).toISOString());
});

test("usage reports a logged-out Codex as no account", async () => {
  const { config } = fakeCodex("anonymous");
  const usage = await fetchCodexUsage(config);
  assert.equal(usage.account, undefined);
  assert.match(usage.error ?? "", /codex login/);
});

test("with no Codex login there is no Codex process: no models, and a clear error for a request", async () => {
  const { config } = fakeCodex();
  const store = new ProviderStore(fakeCodex().file("providers.json"));
  const registry = new ProviderRegistry(store, { ...defaultConfig(), codex: config });
  const provider = new CodexProvider({ ...config, binary: "/nonexistent/codex" }, registry);
  try {
    assert.deepEqual(await provider.listModels(), []);
    const out = await turn(provider, [user("ping")]);
    assert.match(out.error?.message ?? "", /No codex login is configured.*web UI/);
  } finally {
    await provider.close();
  }
});

test("a Codex login added while the server runs is used by the next request", async () => {
  const { config, home } = fakeCodex();
  const store = new ProviderStore(fakeCodex().file("providers.json"));
  const registry = new ProviderRegistry(store, { ...defaultConfig(), codex: config });
  const provider = new CodexProvider(config, registry);
  try {
    assert.deepEqual(await provider.listModels(), []);
    store.add({ type: "codex", name: "Added later", configDir: home });
    assert.equal((await provider.listModels())[0]?.id, "gpt-fake");
    assert.equal((await turn(provider, [user("ping")])).text, "pong");
  } finally {
    await provider.close();
  }
});
