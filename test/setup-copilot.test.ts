import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { copilotEfforts, promptBudget, setupCopilot } from "../src/setup-copilot.ts";

function makeDb() {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "conduit-")), "data.db");
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE model_providers (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT 'openai',
    settings_json TEXT NOT NULL DEFAULT '{}', account_id TEXT);
    CREATE TABLE provider_models (id TEXT PRIMARY KEY NOT NULL, provider_id TEXT NOT NULL, model_id TEXT NOT NULL,
    wire_model TEXT, display_name TEXT NOT NULL, max_prompt_tokens INTEGER, max_output_tokens INTEGER,
    wire_api_override TEXT, created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '',
    supported_reasoning_efforts TEXT, UNIQUE (provider_id, model_id));`);
  db.close();
  return file;
}

const model = {
  id: "m",
  displayName: "M",
  contextWindow: 1_000_000,
  maxOutputTokens: 64_000,
  efforts: ["low", "high"],
};

test("promptBudget reserves the output tokens", () => {
  assert.equal(promptBudget(model), 936_000);
  assert.equal(promptBudget({ contextWindow: undefined, maxOutputTokens: 1 }), null);
});

test("dry run changes nothing; write upserts idempotently", () => {
  const dbPath = makeDb();
  const opts = { dbPath, baseUrl: "http://127.0.0.1:4100/v1", models: [model], efforts: true };
  setupCopilot({ ...opts, write: false });
  const count = (t: string) => {
    const db = new DatabaseSync(dbPath);
    const n = (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
    db.close();
    return n;
  };
  assert.equal(count("model_providers"), 0);
  setupCopilot({ ...opts, write: true });
  setupCopilot({ ...opts, write: true });
  assert.equal(count("model_providers"), 1);
  assert.equal(count("provider_models"), 1);
  const db = new DatabaseSync(dbPath);
  const row = db.prepare("SELECT * FROM provider_models").get() as Record<string, unknown>;
  db.close();
  assert.equal(row.max_prompt_tokens, 936_000);
  assert.equal(row.supported_reasoning_efforts, '["low","high"]');
});

test("only efforts Copilot's SDK defines are written, in its order", () => {
  assert.deepEqual(copilotEfforts(["max", "low", "turbo", "xhigh"]), ["low", "xhigh", "max"]);
  assert.deepEqual(copilotEfforts(undefined), []);
});

test("efforts are written by default and skipped when disabled", () => {
  const dbPath = makeDb();
  const base = { dbPath, baseUrl: "http://127.0.0.1:4100/v1", models: [model], write: true };
  const read = () => {
    const db = new DatabaseSync(dbPath);
    const r = db.prepare("SELECT supported_reasoning_efforts AS e FROM provider_models").get() as {
      e: string | null;
    };
    db.close();
    return r.e;
  };
  setupCopilot({ ...base, efforts: false });
  assert.equal(read(), null);
  setupCopilot({ ...base, efforts: true });
  assert.equal(read(), '["low","high"]');
});
