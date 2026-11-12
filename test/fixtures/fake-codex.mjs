#!/usr/bin/env node
// A scripted stand-in for `codex app-server`, speaking the JSON-RPC shapes the real one uses.
// The user's message picks the behavior; every method it receives is appended to $FAKE_CODEX_LOG.
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

const log = (line) => {
  if (process.env.FAKE_CODEX_LOG) appendFileSync(process.env.FAKE_CODEX_LOG, line + "\n");
};
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const home = process.env.CODEX_HOME ?? "";
let login = "ok";
try {
  login = readFileSync(path.join(home, "auth.json"), "utf8").trim();
} catch {}

let threadId = "thread-1";
let injected = [];
let nextServerId = 100;
const waiting = new Map();

const usage = (total) => ({
  method: "thread/tokenUsage/updated",
  params: {
    threadId,
    turnId: "turn-1",
    tokenUsage: {
      total: {
        totalTokens: total.input + total.output,
        inputTokens: total.input,
        cachedInputTokens: total.cached,
        cacheWriteInputTokens: 0,
        outputTokens: total.output,
        reasoningOutputTokens: 0,
      },
      last: {},
      modelContextWindow: 258400,
    },
  },
});
let cumulative = { input: 0, cached: 0, output: 0 };
const addUsage = (input, cached, output) => {
  cumulative = {
    input: cumulative.input + input,
    cached: cumulative.cached + cached,
    output: cumulative.output + output,
  };
  send(usage(cumulative));
};

const say = (text) => {
  for (const delta of text.match(/.{1,6}/gs) ?? []) {
    send({
      method: "item/agentMessage/delta",
      params: { threadId, turnId: "turn-1", itemId: "m1", delta },
    });
  }
};
const completed = (status = "completed", error = null) =>
  send({
    method: "turn/completed",
    params: { threadId, turn: { id: "turn-1", items: [], status, error } },
  });

const call = (tool, args) =>
  new Promise((resolve) => {
    const id = nextServerId++;
    waiting.set(id, resolve);
    send({
      method: "item/tool/call",
      id,
      params: {
        threadId,
        turnId: "turn-1",
        callId: `call_${id}`,
        namespace: null,
        tool,
        arguments: args,
      },
    });
  });
const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextServerId++;
    waiting.set(id, resolve);
    send({ method, id, params: { threadId, turnId: "turn-1", ...params } });
  });

const outputText = (response) =>
  response.result.contentItems.map((c) => c.text ?? c.imageUrl).join("|");

async function turn(text) {
  send({
    method: "turn/started",
    params: { threadId, turn: { id: "turn-1", status: "inProgress" } },
  });
  if (text.startsWith("ping")) {
    send({
      method: "item/reasoning/summaryTextDelta",
      params: { threadId, turnId: "turn-1", itemId: "r1", delta: "thinking", summaryIndex: 0 },
    });
    say("pong");
    addUsage(100, 40, 7);
    return completed();
  }
  if (text.startsWith("tool ")) {
    const [, name, json] = text.split(" ");
    const response = await call(name, JSON.parse(json));
    say(`got: ${outputText(response)}`);
    addUsage(200, 100, 12);
    return completed();
  }
  if (text.startsWith("two-tools")) {
    const [a, b] = await Promise.all([call("lookup", { n: 1 }), call("lookup", { n: 2 })]);
    say(`got: ${outputText(a)} + ${outputText(b)}`);
    return completed();
  }
  if (text.startsWith("approve")) {
    const decision = await request("item/commandExecution/requestApproval", {
      command: "rm -rf /",
    });
    say(`decision: ${decision.result.decision}`);
    return completed();
  }
  if (text.startsWith("history")) {
    say(`injected: ${injected.map((i) => i.type).join(",")}`);
    return completed();
  }
  if (text.startsWith("limit") || login === "limited") {
    const error = {
      message: "You've hit your usage limit.",
      codexErrorInfo: "usageLimitExceeded",
      additionalDetails: null,
      misalignment: null,
    };
    send({
      method: "account/rateLimits/updated",
      params: {
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 4_102_444_800 },
          secondary: null,
        },
      },
    });
    send({ method: "error", params: { error, willRetry: false, threadId, turnId: "turn-1" } });
    return completed("failed", error);
  }
  if (text.startsWith("exit")) process.exit(3);
  if (text.startsWith("hang")) return;
  say("unknown prompt");
  return completed();
}

const reply = (id, result) => send({ id, result });

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined) {
    // A response to one of our server requests.
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
    return;
  }
  log(message.method);
  const { id, params } = message;
  switch (message.method) {
    case "initialize":
      return reply(id, { userAgent: "fake-codex", codexHome: home });
    case "initialized":
      return;
    case "account/read":
      if (login === "anonymous") return reply(id, { account: null, requiresOpenaiAuth: true });
      return reply(id, {
        account: { type: "chatgpt", email: "dev@example.com", planType: "plus" },
        requiresOpenaiAuth: true,
      });
    case "account/rateLimits/read":
      return reply(id, {
        ordinaryUsageAllowed: true,
        rateLimits: {
          limitId: "codex",
          limitName: null,
          primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_900_000_000 },
          secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 1_900_100_000 },
        },
        rateLimitsByLimitId: null,
      });
    case "model/list":
      return reply(id, {
        data: [
          {
            id: "m1",
            model: "gpt-fake",
            displayName: "GPT Fake",
            hidden: false,
            supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
          },
          {
            id: "m2",
            model: "gpt-secret",
            displayName: "Hidden",
            hidden: true,
            supportedReasoningEfforts: [],
          },
        ],
        nextCursor: null,
      });
    case "thread/start":
      threadId = `thread-${Math.random().toString(36).slice(2, 8)}`;
      log(
        `dynamicTools=${(params.dynamicTools ?? []).map((t) => t.name).join(",")} environments=${JSON.stringify(params.environments)} sandbox=${params.sandbox}`,
      );
      return reply(id, { thread: { id: threadId } });
    case "thread/inject_items":
      injected = params.items;
      return reply(id, {});
    case "turn/start": {
      reply(id, { turn: { id: "turn-1", items: [], status: "inProgress" } });
      const text = params.input.map((i) => i.text ?? "").join("");
      log(`turn effort=${params.effort ?? "none"} text=${text.slice(0, 40)}`);
      return void turn(text);
    }
    default:
      return send({ id, error: { code: -32601, message: `unknown method ${message.method}` } });
  }
});
