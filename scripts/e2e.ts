const base = process.argv[2] ?? "http://127.0.0.1:4198/v1";
const tools = [{ type: "function", function: { name: "get_weather", description: "Get current weather for a city", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } }];
const messages: any[] = [
  { role: "system", content: "You are a terse assistant. Use tools when helpful." },
  { role: "user", content: "What's the weather in Paris and in Tokyo? Call get_weather for both cities in parallel." },
];
async function stream(body: any) {
  const res = await fetch(`${base}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }) });
  const text = await res.text();
  let content = "", reasoning = "", finish = null, usage = null; const calls: any[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    const j = JSON.parse(line.slice(6));
    if (j.error) throw new Error(JSON.stringify(j.error));
    if (j.usage) usage = j.usage;
    const c = j.choices?.[0]; if (!c) continue;
    if (c.delta.content) content += c.delta.content;
    if (c.delta.reasoning_content) reasoning += c.delta.reasoning_content;
    for (const t of c.delta.tool_calls ?? []) {
      calls[t.index] ??= { id: t.id, type: "function", function: { name: t.function?.name, arguments: "" } };
      calls[t.index].function.arguments += t.function?.arguments ?? "";
    }
    if (c.finish_reason) finish = c.finish_reason;
  }
  return { content, reasoning, finish, usage, calls };
}
const t0 = Date.now();
const r1 = await stream({ model: "haiku", messages, tools });
console.log("R1", Date.now() - t0, "ms", r1.finish, JSON.stringify(r1.calls), JSON.stringify(r1.content), r1.usage);
messages.push({ role: "assistant", content: r1.content || null, tool_calls: r1.calls });
for (const c of r1.calls) messages.push({ role: "tool", tool_call_id: c.id, content: `${JSON.parse(c.function.arguments).city}: 21C, sunny` });
const t1 = Date.now();
const r2 = await stream({ model: "haiku", messages, tools });
console.log("R2", Date.now() - t1, "ms", r2.finish, JSON.stringify(r2.content), r2.usage);
messages.push({ role: "assistant", content: r2.content });
messages.push({ role: "user", content: "Which of the two cities did I ask about first? One word." });
const t2 = Date.now();
const r3 = await stream({ model: "haiku", messages, tools });
console.log("R3", Date.now() - t2, "ms", r3.finish, JSON.stringify(r3.content));
// Cold start: same history, different model -> new session from transcript
const t3 = Date.now();
const r4 = await stream({ model: "sonnet", messages, tools });
console.log("R4 (cold, sonnet)", Date.now() - t3, "ms", r4.finish, JSON.stringify(r4.content));
// Non-streaming without tools
const r5 = await (await fetch(`${base}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "haiku", messages: [{ role: "user", content: "Say just: pong" }] }) })).json();
console.log("R5", JSON.stringify(r5.choices[0].message), r5.usage);
