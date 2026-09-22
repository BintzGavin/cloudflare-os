import { expect, it } from "vitest";
import { z } from "zod";
import type { AiChatMessage } from "@gadgets/workshop-shared/api";
import { openAgentSession, type WorkshopAgentSession } from "../src/agent-session.js";
import { startTestGatekeeperHarness, TEST_VENDOR_ID } from "../src/harness.js";
import {
  scriptedChatCompletions, type ChatCompletionStep, type ScriptedChatCompletions,
} from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PNG_BYTES = Uint8Array.from(Buffer.from(PNG, "base64"));
const MODEL_ID = "image-transport-fixture";
const REQUEST = z.object({messages: z.array(z.object({
  content: z.union([z.string(), z.array(z.object({
    type: z.string(), image_url: z.object({url: z.string()}).optional(),
  }))]).nullish(),
}))});

// The images a chat-completions request carries, as data URLs.
function imageUrls(request: unknown): string[] {
  return REQUEST.parse(request).messages.flatMap(message =>
    Array.isArray(message.content) ? message.content.flatMap(part =>
      part.type === "image_url" && part.image_url ? [part.image_url.url] : []) : []);
}

function executeCodeCalls(history: AiChatMessage[]) {
  return history.flatMap(message => message.type === "message" ? message.toolCalls ?? [] : [])
      .flatMap(call => call.toolName === "executeCode" ? [call] : []);
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

it("shows a binding's image to the model and the chat, and replays it without reading again", () =>
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
    const [call] = executeCodeCalls(result.history);
    expect(call).toMatchObject({
      toolCallId: "capture-image",
      output: "before capture",
      attachments: [{mimeType: "image/png", size: PNG_BYTES.length}],
    });
    // Delivered to the client with the bytes inlined, as a message's own image attachments are.
    expect(Array.from(call.attachments![0].content!)).toEqual(Array.from(PNG_BYTES));

    const replay = await session.runTurn("Use the recorded image without capturing again.");
    expect(replay.outcome).toEqual({status: "completed"});
    expect(model.requests).toHaveLength(3);
    expect(imageUrls(model.requests[2])).toEqual([`data:image/png;base64,${PNG}`]);
    expect(executeCodeCalls(replay.history)).toHaveLength(1);
  }));

it.each([
  {id: "raw-bytes", images: 1, code: `return Uint8Array.fromBase64("${PNG}");`},
  {id: "two-images", images: 2, code: `let a = Uint8Array.fromBase64("${PNG}"); ` +
      "let b = a.slice(); b[b.length - 1] ^= 1; return [a.buffer, new Blob([b])];"},
  {id: "ordinary-return", images: 0, code: 'console.log("ordinary output"); return 7;',
    output: "ordinary output\nReturn value: 7"},
  {id: "not-an-image", images: 0, code: 'return new TextEncoder().encode("hello");',
    output: "[Image 1 omitted: Not a PNG, JPEG, or WebP image.]"},
  {id: "oversized-image", images: 0, output: "[Image 1 omitted: Images are limited to 5 MiB per execution",
    code: `let bytes = new Uint8Array(5 * 1024 * 1024 + 1); bytes.set(Uint8Array.fromBase64("${PNG}")); return bytes;`},
])("handles a $id return value", ({id, images, code, output}) => withAgent([
  {toolCall: {id, name: "executeCode", arguments: {code: `export default async function() { ${code} }`}}},
  {text: "Result recorded."},
], async (session, model) => {
  const result = await session.runTurn(`Run the ${id} scenario.`);
  expect(result.outcome).toEqual({status: "completed"});
  const [call] = executeCodeCalls(result.history);
  // Whatever the code returned, a completed execution is never a failed tool call.
  expect(call.error).toBeUndefined();
  if (output !== undefined) expect(call.output).toContain(output);
  expect(call.attachments ?? []).toHaveLength(images);
  expect(imageUrls(model.requests[1])).toHaveLength(images);
  expect(call.output).not.toContain(PNG);
}));

it("carries an image larger than one storage chunk through RPC, storage, and model replay", () =>
  withAgent([
    {toolCall: {id: "large-image", name: "executeCode", arguments: {code: `export default async function() {
      let bytes = new Uint8Array(3 * 1024 * 1024);
      bytes.set(Uint8Array.fromBase64("${PNG}"));
      bytes[bytes.length - 1] = 127;
      return bytes;
    }`}}},
    {text: "Large image received."},
    {text: "The saved image is still available."},
  ], async (session, model) => {
    const result = await session.runTurn("Return a large image.");
    expect(result.outcome).toEqual({status: "completed"});
    const [url] = imageUrls(model.requests[1]);
    const sent = Buffer.from(url.split(",")[1], "base64");
    expect(sent.length).toBe(3 * 1024 * 1024);
    expect(sent.at(-1)).toBe(127);
    const [call] = executeCodeCalls(result.history);
    // Over the inline size: the client gets the reference and fetches the bytes on demand.
    expect(call.attachments?.[0]).toMatchObject({mimeType: "image/png", size: 3 * 1024 * 1024});
    expect(call.attachments?.[0].content).toBeUndefined();
    expect((await session.runTurn("Look at it again.")).outcome).toEqual({status: "completed"});
    expect(imageUrls(model.requests[2])).toEqual([url]);
  }));

it("rejects a capability smuggled through the harness and still finishes the execution", () =>
  withAgent([
    {toolCall: {id: "smuggled-capability", name: "executeCode", arguments: {code: `
      import {RpcTarget} from "cloudflare:workers";
      // The harness runs in this isolate, so its instanceof check can be made to pass for a stub.
      globalThis.Blob = class extends RpcTarget {};
      export default async function() { return new Blob(); }
    `}}},
    {text: "Nothing to see."},
  ], async (session, model) => {
    const result = await session.runTurn("Return something that is not a Blob.");
    expect(result.outcome).toEqual({status: "completed"});
    const [call] = executeCodeCalls(result.history);
    expect(call.error).toBeUndefined();
    expect(call.output).toContain("[Image 1 omitted: Not an image.]");
    expect(call.attachments).toBeUndefined();
    expect(imageUrls(model.requests[1])).toEqual([]);
  }));
