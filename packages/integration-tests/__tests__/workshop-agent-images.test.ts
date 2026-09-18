import { expect, it } from "vitest";
import { z } from "zod";
import { openAgentSession, type WorkshopAgentSession } from "../src/agent-session.js";
import { startTestGatekeeperHarness, TEST_VENDOR_ID } from "../src/harness.js";
import { scriptedChatCompletions, type ChatCompletionStep, type ScriptedChatCompletions } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const MODEL_ID = "image-transport-fixture";
const REQUEST = z.object({messages: z.array(z.object({
  content: z.union([z.string(), z.array(z.object({
    type: z.string(), image_url: z.object({url: z.string()}).optional(),
  }))]).nullish(),
}))});

function imageUrls(request: unknown): string[] {
  return REQUEST.parse(request).messages.flatMap(message =>
    Array.isArray(message.content) ? message.content.flatMap(part =>
      part.type === "image_url" && part.image_url ? [part.image_url.url] : []) : []);
}

async function withAgent(script: ChatCompletionStep[],
    run: (session: WorkshopAgentSession, model: ScriptedChatCompletions) => Promise<void>) {
  const model = scriptedChatCompletions(script);
  const network = new NetworkInterceptor({handlers: [model.handler]});
  network.install();
  const harness = await startTestGatekeeperHarness({enableGadgetExecution: true});
  try {
    await using session = await openAgentSession(harness.url, {
      modelId: MODEL_ID,
      userModel: {
        profile: {type: "agent", id: MODEL_ID, name: "Image fixture"},
        config: {provider: "ollama", model: MODEL_ID, apiUrl: "http://image-fixture.invalid", apiToken: ""},
      },
      ambientVendorIds: [TEST_VENDOR_ID],
    });
    await run(session, model);
    expect(model.remainingSteps()).toBe(0);
  } finally {
    await harness.server.close();
    network.uninstall();
    expect(network.getUnmockedCalls()).toEqual([]);
  }
}

it("delivers binding images to the provider and the chat, then replays without capturing again", () =>
  withAgent([
    {toolCall: {id: "capture-image", name: "executeCode", arguments: {
      code: "export default async function(self, env) { " +
          "console.log('before capture'); return await env.TEST_AMBIENT.readImage(); }",
    }}},
    {text: "Image received."},
    {text: "The recorded image is still available."},
  ], async (session, model) => {
    const result = await session.runTurn("Capture an image from the test binding.");
    expect(result.outcome).toEqual({status: "completed"});
    expect(model.requests).toHaveLength(2);
    expect(imageUrls(model.requests[1])).toEqual([`data:image/png;base64,${PNG}`]);
    const calls = result.history.flatMap(message => message.type === "message" ? message.toolCalls ?? [] : []);
    expect(calls).toContainEqual(expect.objectContaining({
      toolCallId: "capture-image", toolName: "executeCode",
      output: expect.stringContaining("before capture"),
      attachments: [expect.objectContaining({
        mimeType: "image/png", content: Uint8Array.from(Buffer.from(PNG, "base64")),
      })],
    }));
    const capture = calls.find(call => call.toolCallId === "capture-image");
    expect(capture?.toolName === "executeCode" && capture.output).not.toContain(PNG);
    const replay = await session.runTurn("Use the recorded image without capturing again.");
    expect(replay.outcome).toEqual({status: "completed"});
    expect(model.requests).toHaveLength(3);
    expect(imageUrls(model.requests[2])).toEqual([`data:image/png;base64,${PNG}`]);
    const replayCalls = replay.history.flatMap(message => message.type === "message" ? message.toolCalls ?? [] : []);
    expect(replayCalls.filter(call => call.toolCallId === "capture-image")).toHaveLength(1);
  }));

it.each([
  {id: "failed-capture", code: 'return {isError: true, content: [{type: "text", text: "Capture failed."}]};'},
  {id: "ordinary-return", code: 'console.log("ordinary output"); return 7;'},
  {id: "oversized-image", code: 'return {content: [{type: "text", text: "Text survives."}, ' +
      '{type: "image", mimeType: "image/png", data: "A".repeat(20971521)}]};'},
  {id: "structured-result", code: 'return {structuredContent: {total: 3}, content: [' +
      '{type: "resource", resource: {uri: "doc://1", text: "Embedded body."}}, ' +
      `{type: "image", mimeType: "image/png", data: "${PNG}"}]};`},
])("preserves the output contract for $id", ({id, code}) => withAgent([
  {toolCall: {id, name: "executeCode", arguments: {code: `export default async function() { ${code} }`}}},
  {text: "Result recorded."},
], async (session, model) => {
  const result = await session.runTurn(`Run the ${id} scenario.`);
  expect(result.outcome).toEqual({status: "completed"});
  const calls = result.history.flatMap(message => message.type === "message" ? message.toolCalls ?? [] : []);
  const call = calls.find(call => call.toolCallId === id);
  if (call?.toolName !== "executeCode") throw new Error("Missing executed code result.");
  // Returning a result never turns a completed execution into a failed tool call.
  expect(call.error).toBeUndefined();
  if (id === "failed-capture") {
    expect(call.output).toContain('"isError":true');
    expect(call.output).toContain("Capture failed.");
  } else if (id === "ordinary-return") {
    expect(call.output).toContain("ordinary output");
    expect(call.output).toContain("Return value: 7");
  } else if (id === "oversized-image") {
    expect(call.output).toContain("Text survives.");
    expect(call.output).toContain("[Image 1 omitted:");
    expect(call.output!.length).toBeLessThan(300);
    expect(imageUrls(model.requests.at(-1))).toEqual([]);
  } else {
    // Only image data leaves the logged value; everything else reaches the model as before.
    expect(call.output).toContain('"structuredContent":{"total":3}');
    expect(call.output).toContain("Embedded body.");
    expect(call.output).toContain('"data":"[image 1]"');
    expect(call.output).not.toContain(PNG);
    expect(imageUrls(model.requests.at(-1))).toEqual([`data:image/png;base64,${PNG}`]);
  }
}));


it("carries a 15 MiB image through WorkerLoader, storage, and model replay", () =>
  withAgent([
    {toolCall: {id: "large-image", name: "executeCode", arguments: {
      code: `export default async function() {
        let bytes = new Uint8Array(15 * 1024 * 1024);
        bytes.set(Uint8Array.fromBase64("${PNG}"));
        bytes[bytes.length - 1] = 127;
        return {content: [{type: "image", mimeType: "image/png", data: bytes.toBase64()}]};
      }`,
    }}},
    {text: "Large image received."},
    {text: "The saved large image is still available."},
  ], async (session, model) => {
    const result = await session.runTurn("Return a large image.");
    expect(result.outcome).toEqual({status: "completed"});
    const first = imageUrls(model.requests[1]);
    expect(first).toHaveLength(1);
    const bytes = Buffer.from(first[0].split(",")[1], "base64");
    expect(bytes.length).toBe(15 * 1024 * 1024);
    expect(bytes[bytes.length - 1]).toBe(127);
    const calls = result.history.flatMap(message => message.type === "message" ? message.toolCalls ?? [] : []);
    const call = calls.find(call => call.toolCallId === "large-image");
    if (call?.toolName !== "executeCode") throw new Error("Missing image result.");
    expect(call.attachments?.[0].size).toBe(bytes.length);
    expect(call.attachments?.[0].content).toBeUndefined();
    expect((await session.runTurn("Reuse the recorded image.")).outcome).toEqual({status: "completed"});
    expect(imageUrls(model.requests[2])[0] === first[0]).toBe(true);
  }));
