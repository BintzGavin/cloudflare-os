import { describe, expect, it, vi } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import {
  codeModeImageContent, decodeCodeModeImages, MAX_MODEL_IMAGE_BYTES, pruneImageInput,
} from "../src/code-mode-output.js";

const PNG = Uint8Array.fromBase64(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=");
const MIB = 1024 * 1024;

// A Blob whose bytes start like a PNG, padded to `size`.
function png(size = PNG.length): Blob {
  let bytes = new Uint8Array(size);
  bytes.set(PNG);
  return new Blob([bytes]);
}

describe("returned code images", () => {
  it("recognizes an image by its content and keeps its exact bytes", async () => {
    // The declared type is not consulted: bytes that begin like a PNG are a PNG.
    expect(await decodeCodeModeImages([new Blob([PNG], {type: "image/jpeg"})])).toEqual({
      images: [{mimeType: "image/png", content: PNG}], notes: [],
    });
  });

  it.each([
    {label: "bytes of no accepted image format", value: new Blob([new TextEncoder().encode("hi")])},
    {label: "a value the harness would not produce", value: {mimeType: "image/png", data: PNG}},
    {label: "an image over the execution's allowance", value: png(5 * MIB + 1)},
  ])("omits $label with a note and keeps the valid image beside it", async ({value}) => {
    let result = await decodeCodeModeImages([value, png()]);
    expect(result.images).toEqual([{mimeType: "image/png", content: PNG}]);
    expect(result.notes).toEqual([expect.stringMatching(/^\[Image 1 omitted: .{1,100}\]$/)]);
  });

  it("admits an image of exactly the allowance, and names the limit one byte beyond", async () => {
    expect((await decodeCodeModeImages([png(5 * MIB)])).images).toHaveLength(1);
    expect(await decodeCodeModeImages([png(5 * MIB + 1)])).toEqual({
      images: [], notes: [expect.stringContaining("limited to 5 MiB per execution")],
    });
  });

  it("bounds all of an execution's images together, keeping the ones that fit", async () => {
    let result = await decodeCodeModeImages([png(3 * MIB), png(3 * MIB), png()]);
    expect(result.images.map(image => image.content.byteLength)).toEqual([3 * MIB, PNG.length]);
    expect(result.notes).toEqual([expect.stringContaining("Image 2 omitted:")]);
  });

  it("considers only the first five images, however many follow", async () => {
    let result = await decodeCodeModeImages(Array.from({length: 50}, () => png()));
    expect(result.images).toHaveLength(5);
    expect(result.notes).toEqual([expect.stringContaining("at most 5")]);
  });
});

describe("image model input", () => {
  const attachment = {id: "saved-image", mimeType: "image/png", size: PNG.length};
  const IMAGE = {type: "image", mimeType: "image/png", data: PNG.toBase64()};

  it("sends the staged bytes on the live turn, and loads stored bytes on replay", async () => {
    let load = vi.fn(async () => PNG);
    expect(await codeModeImageContent([{...attachment, content: PNG}], true, load)).toEqual([IMAGE]);
    expect(load).not.toHaveBeenCalled();
    expect(await codeModeImageContent([attachment], true, load)).toEqual([IMAGE]);
    expect(load).toHaveBeenCalledExactlyOnceWith("saved-image");
  });

  it("tells a model without image input what it is missing, without loading anything", async () => {
    let load = vi.fn(async () => PNG);
    expect(await codeModeImageContent([attachment], false, load)).toEqual([
      {type: "text", text: expect.stringContaining("does not accept image input")},
    ]);
    expect(load).not.toHaveBeenCalled();
  });

  it("marks an image whose bytes are gone rather than failing the replay", async () => {
    let missing = async () => { throw new Error("gone"); };
    expect(await codeModeImageContent([attachment], true, missing))
        .toEqual([{type: "text", text: "[Image no longer available.]"}]);
  });
});

describe("model image budget", () => {
  const image = (bytes: number) => {
    let data = new Uint8Array(bytes);
    data.set(PNG);
    return {type: "image" as const, mimeType: "image/png", data: data.toBase64()};
  };
  const toolResult = (...content: Extract<Message, {role: "toolResult"}>["content"]): Message =>
    ({role: "toolResult", toolCallId: "call", toolName: "executeCode", content, isError: false,
      timestamp: 0});
  const kinds = (messages: Message[]) => messages.map(message =>
    typeof message.content === "string" ? [] : message.content.map(part => part.type));

  it("leaves a request within the budget untouched", () => {
    let messages = [toolResult(image(MIB)), toolResult(image(MIB), image(MIB))];
    let before = structuredClone(messages);
    pruneImageInput(messages);
    expect(messages).toEqual(before);
  });

  it("keeps the newest returned images and marks the ones that no longer fit", () => {
    let messages: Message[] = [
      toolResult(image(2 * MIB)),
      toolResult({type: "text", text: "Captured."}, image(2 * MIB), image(MIB), image(MIB)),
    ];
    // 1 + 1 + 2 MiB fit newest-first; the oldest 2 MiB does not.
    pruneImageInput(messages);
    expect(kinds(messages)).toEqual([["text"], ["text", "image", "image", "image"]]);
    expect(messages[0].content[0]).toEqual({type: "text", text:
        "[image image/png no longer shown: model input keeps the newest 5 MiB of returned images.]"});
  });

  it("leaves a message's own attachments alone, however large, and does not count them", () => {
    let attached: Message = {role: "user", timestamp: 0,
      content: [{type: "text", text: "Look."}, image(3 * MIB), image(3 * MIB)]};
    let messages = [attached, toolResult(...Array.from({length: 5}, () => image(MIB)))];
    let before = structuredClone(attached);
    pruneImageInput(messages);
    expect(attached).toEqual(before);
    expect(kinds(messages)[1]).toEqual(["image", "image", "image", "image", "image"]);
  });

  it("counts decoded bytes exactly, so images that sum to the budget all fit", () => {
    let messages = [toolResult(...Array.from({length: MAX_MODEL_IMAGE_BYTES / MIB}, () => image(MIB)))];
    pruneImageInput(messages);
    expect(kinds(messages)).toEqual([["image", "image", "image", "image", "image"]]);
  });

  it("never sends an image larger than the whole budget, and keeps older ones that fit", () => {
    let messages = [toolResult(image(MIB)), toolResult(image(MAX_MODEL_IMAGE_BYTES + 1))];
    pruneImageInput(messages);
    expect(kinds(messages)).toEqual([["image"], ["text"]]);
  });
});
