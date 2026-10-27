import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defaultConfig } from "../src/config.ts";
import { classifyFailure } from "../src/providers/claude/session.ts";
import type { ProviderUsage } from "../src/providers/claude/usage.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import { DEFAULT_PROVIDER_ID, ProviderStore, slugify } from "../src/providers/store.ts";

function tmp() {
  return mkdtempSync(path.join(tmpdir(), "conduit-providers-"));
}

function storeIn(dir: string) {
  return new ProviderStore(path.join(dir, "providers.json"));
}

test("a fresh store holds only the default provider", () => {
  const store = storeIn(tmp());
  assert.deepEqual(
    store.list().map((e) => e.id),
    [DEFAULT_PROVIDER_ID],
  );
});

test("add creates the login directory, appends in priority order and persists", () => {
  const dir = tmp();
  const store = storeIn(dir);
  const work = store.add({ type: "claude", name: "Work Max", configDir: path.join(dir, "work") });
  assert.equal(work.id, "work-max");
  assert.ok(existsSync(path.join(dir, "work")));
  const again = storeIn(dir);
  assert.deepEqual(
    again.list().map((e) => e.id),
    [DEFAULT_PROVIDER_ID, "work-max"],
  );
  assert.equal(JSON.parse(readFileSync(path.join(dir, "providers.json"), "utf8")).version, 1);
});

test("add rejects duplicate names and directories", () => {
  const dir = tmp();
  const store = storeIn(dir);
  store.add({ type: "claude", name: "A", configDir: path.join(dir, "a") });
  assert.throws(
    () => store.add({ type: "claude", name: "a", configDir: path.join(dir, "b") }),
    /already exists/,
  );
  assert.throws(
    () => store.add({ type: "claude", name: "B", configDir: path.join(dir, "a") }),
    /already uses/,
  );
});

test("ids stay unique when names slugify the same", () => {
  const dir = tmp();
  const store = storeIn(dir);
  const a = store.add({ type: "claude", name: "My Login", configDir: path.join(dir, "1") });
  const b = store.add({ type: "claude", name: "my-login!", configDir: path.join(dir, "2") });
  assert.notEqual(a.id, b.id);
  assert.equal(slugify("***"), "provider");
});

test("move reorders priority and clamps at the ends", () => {
  const dir = tmp();
  const store = storeIn(dir);
  store.add({ type: "claude", name: "A", configDir: path.join(dir, "a") });
  store.add({ type: "claude", name: "B", configDir: path.join(dir, "b") });
  store.move("b", "up");
  assert.deepEqual(
    storeIn(dir)
      .list()
      .map((e) => e.id),
    [DEFAULT_PROVIDER_ID, "b", "a"],
  );
  store.move(DEFAULT_PROVIDER_ID, "up");
  store.move("a", "down");
  assert.deepEqual(
    store.list().map((e) => e.id),
    [DEFAULT_PROVIDER_ID, "b", "a"],
  );
});

test("update toggles enabled; the default provider cannot be removed", () => {
  const store = storeIn(tmp());
  store.update(DEFAULT_PROVIDER_ID, { enabled: false });
  assert.equal(store.get(DEFAULT_PROVIDER_ID)?.enabled, false);
  assert.throws(() => store.remove(DEFAULT_PROVIDER_ID), /cannot be removed/);
});

test("remove leaves the login directory on disk", () => {
  const dir = tmp();
  const store = storeIn(dir);
  store.add({ type: "claude", name: "Tmp", configDir: path.join(dir, "tmp") });
  store.remove("tmp");
  assert.equal(store.get("tmp"), undefined);
  assert.ok(existsSync(path.join(dir, "tmp")));
});

test("a corrupt file is reported, not silently replaced", () => {
  const dir = tmp();
  storeIn(dir).add({ type: "claude", name: "A", configDir: path.join(dir, "a") });
  const file = path.join(dir, "providers.json");
  const bad = JSON.stringify({ version: 1, providers: [{ id: "x", type: "nope" }] });
  writeFileSync(file, bad);
  assert.throws(() => new ProviderStore(file));
});

function registryWith(names: string[], now: () => number = Date.now) {
  const dir = tmp();
  const store = storeIn(dir);
  for (const name of names) {
    store.add({ type: "claude", name, configDir: path.join(dir, slugify(name)) });
  }
  const usage: ProviderUsage = {
    fetchedAt: 0,
    account: {
      email: "a@b.c",
      organization: undefined,
      plan: "max",
      auth: "x",
      billedToApi: false,
    },
    windows: [],
    extraUsage: undefined,
    error: undefined,
  };
  let fetches = 0;
  const registry = new ProviderRegistry(store, defaultConfig().claude, {
    now,
    fetchUsage: () => {
      fetches++;
      return Promise.resolve({ ...usage, fetchedAt: now() });
    },
  });
  return { registry, store, fetches: () => fetches };
}

test("pick follows priority order and skips disabled providers", () => {
  const { registry, store } = registryWith(["A", "B"]);
  assert.equal(registry.pick()?.id, DEFAULT_PROVIDER_ID);
  store.update(DEFAULT_PROVIDER_ID, { enabled: false });
  assert.equal(registry.pick()?.id, "a");
  store.move("b", "up");
  assert.equal(registry.pick()?.id, "b");
});

test("a rate-limited provider is skipped until its limit lifts", () => {
  let now = 1_000;
  const { registry } = registryWith(["A"], () => now);
  registry.markFailed(DEFAULT_PROVIDER_ID, "rate_limit", "limit", 5_000);
  assert.equal(registry.pick()?.id, "a");
  assert.equal(registry.statusOf(registry.store.get(DEFAULT_PROVIDER_ID)!).health, "rate_limited");
  now = 6_000;
  assert.equal(registry.pick()?.id, DEFAULT_PROVIDER_ID);
});

test("when everything is rate limited, the soonest to lift is used", () => {
  const { registry } = registryWith(["A"], () => 0);
  registry.markFailed(DEFAULT_PROVIDER_ID, "rate_limit", "x", 9_000);
  registry.markFailed("a", "rate_limit", "x", 4_000);
  assert.equal(registry.pick()?.id, "a");
});

test("auth failures are avoided until verified; exclusions are honored", () => {
  const { registry } = registryWith(["A"]);
  registry.markFailed(DEFAULT_PROVIDER_ID, "auth", "logged out");
  assert.equal(registry.pick()?.id, "a");
  assert.equal(registry.pick(new Set(["a"])), undefined);
  registry.markHealthy(DEFAULT_PROVIDER_ID);
  assert.equal(registry.pick()?.id, DEFAULT_PROVIDER_ID);
});

test("each provider gets its own Claude config dir; the default keeps the shared config", () => {
  const { registry, store } = registryWith(["A"]);
  const a = store.get("a");
  assert.ok(a && a.type === "claude");
  assert.equal(registry.claudeConfig(a).env.CLAUDE_CONFIG_DIR, a.configDir);
  const base = registry.claudeConfig(store.get(DEFAULT_PROVIDER_ID)!);
  assert.equal(base.env.CLAUDE_CONFIG_DIR, undefined);
});

test("recordTurn accumulates counters", () => {
  const { registry } = registryWith([]);
  registry.recordTurn(DEFAULT_PROVIDER_ID, { prompt: 10, completion: 5, cached: 4 });
  registry.recordTurn(DEFAULT_PROVIDER_ID, undefined);
  const [status] = registry.status();
  assert.equal(status?.counters.requests, 2);
  assert.equal(status?.counters.inputTokens, 10);
  assert.equal(status?.counters.cachedTokens, 4);
});

test("usage is cached briefly and forced fetches bypass the cache", async () => {
  let now = 0;
  const { registry, fetches } = registryWith([], () => now);
  await registry.usage(DEFAULT_PROVIDER_ID);
  await registry.usage(DEFAULT_PROVIDER_ID);
  assert.equal(fetches(), 1);
  await registry.usage(DEFAULT_PROVIDER_ID, { force: true });
  assert.equal(fetches(), 2);
  now = 120_000;
  await registry.usage(DEFAULT_PROVIDER_ID);
  assert.equal(fetches(), 3);
});

test("verify succeeds with an account and clears failure marks", async () => {
  const { registry } = registryWith([]);
  registry.markFailed(DEFAULT_PROVIDER_ID, "auth", "logged out");
  const result = await registry.verify(DEFAULT_PROVIDER_ID);
  assert.equal(result.ok, true);
  assert.match(result.message, /a@b\.c/);
  assert.equal(registry.pick()?.id, DEFAULT_PROVIDER_ID);
});

test("classifyFailure separates rate limits from login problems", () => {
  assert.deepEqual(classifyFailure("rate_limit", "x", 5), { kind: "rate_limit", resetsAt: 5 });
  assert.equal(classifyFailure(undefined, "You've hit your usage limit")?.kind, "rate_limit");
  assert.equal(classifyFailure("authentication_failed", "x")?.kind, "auth");
  assert.equal(classifyFailure(undefined, "Not logged in · Please run /login")?.kind, "auth");
  assert.equal(classifyFailure(undefined, "context too long"), undefined);
});
