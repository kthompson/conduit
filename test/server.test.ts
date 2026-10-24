import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { defaultConfig } from "../src/config.ts";
import { MockProvider } from "../src/providers/mock/provider.ts";
import { startServer, type ConduitServer } from "../src/server.ts";

let server: ConduitServer;
let captureDir: string;

before(async () => {
  captureDir = mkdtempSync(path.join(tmpdir(), "conduit-test-"));
  const config = defaultConfig();
  config.server.port = 0;
  config.server.apiKey = "secret";
  config.defaultProvider = "mock";
  config.capture = { enabled: true, dir: captureDir };
  server = await startServer(config, { mock: new MockProvider({ delayMs: 0 }) });
});

after(() => server.close());

const post = (body: unknown, key = "secret") =>
  fetch(`${server.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });

const tools = [
  { type: "function", function: { name: "get_weather", parameters: { type: "object" } } },
];

test("rejects a wrong API key", async () => {
  const res = await post({ model: "mock", messages: [{ role: "user", content: "hi" }] }, "nope");
  assert.equal(res.status, 401);
});

test("lists models", async () => {
  const res = await fetch(`${server.url}/v1/models`, {
    headers: { authorization: "Bearer secret" },
  });
  const body = (await res.json()) as { data: Array<{ id: string }> };
  assert.deepEqual(
    body.data.map((m) => m.id),
    ["mock"],
  );
});

test("non-streaming completion describes the request", async () => {
  const res = await post({ model: "mock", messages: [{ role: "user", content: "hi" }] });
  const body = (await res.json()) as {
    choices: Array<{ message: { content: string }; finish_reason: string }>;
  };
  assert.equal(res.status, 200);
  assert.match(body.choices[0]!.message.content, /conduit mock/);
  assert.equal(body.choices[0]!.finish_reason, "stop");
});

test("streams a simulated tool call in OpenAI chunk format", async () => {
  const res = await post({
    model: "mock",
    stream: true,
    tools,
    messages: [{ role: "user", content: '/tool get_weather {"city":"Paris"}' }],
  });
  const text = await res.text();
  const chunks = text
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)));
  assert.ok(text.trimEnd().endsWith("data: [DONE]"));
  const toolDeltas = chunks.flatMap((c) => c.choices[0]?.delta.tool_calls ?? []);
  assert.equal(toolDeltas[0].function.name, "get_weather");
  assert.equal(
    toolDeltas.map((d: { function: { arguments: string } }) => d.function.arguments).join(""),
    '{"city":"Paris"}',
  );
  assert.equal(chunks.at(-1).choices[0].finish_reason, "tool_calls");
});

test("validates the body and 404s unknown routes", async () => {
  assert.equal((await post({ model: "mock", messages: [] })).status, 400);
  const res = await fetch(`${server.url}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer secret" },
    body: "{}",
  });
  assert.equal(res.status, 404);
});

test("captures every exchange with secrets redacted", () => {
  const [run] = readdirSync(captureDir);
  const files = readdirSync(path.join(captureDir, run!));
  assert.ok(files.some((f) => f.includes("post-v1_responses")));
  const record = JSON.parse(readFileSync(path.join(captureDir, run!, files[0]!), "utf8"));
  assert.match(record.request.headers.authorization, /^<redacted/);
});
