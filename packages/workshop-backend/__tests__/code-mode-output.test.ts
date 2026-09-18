import { describe, expect, it, vi } from "vitest";
import { codeModeImageContent, decodeCodeModeOutput } from "../src/code-mode-output.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const IMAGE = {type: "image", mimeType: "image/png", data: PNG};

describe("explicit code output", () => {
  it("preserves text and exact image bytes without putting base64 into text", () => {
    let result = decodeCodeModeOutput({content: [{type: "text", text: "Captured."}, IMAGE]});
    expect(result.output).toBe("Captured.");
    expect(result.images).toEqual([{mimeType: "image/png", content: Uint8Array.fromBase64(PNG)}]);
  });

  it.each([
    {label: "invalid alphabet", image: {...IMAGE, data: "not-base64!"}},
    {label: "incomplete quartet", image: {...IMAGE, data: "A"}},
    {label: "invalid trailing bits", image: {...IMAGE, data: "AB=="}},
    {label: "wrong MIME signature", image: {...IMAGE, data: "YWJjZA=="}},
    {label: "unsupported image", image: {...IMAGE, mimeType: "image/svg+xml"}},
    {label: "missing MIME", image: {type: "image", data: PNG}},
    {label: "oversized image", image: {...IMAGE, data: "A".repeat(1398105)}},
  ])("retains useful text when rejecting $label", ({image}) => {
    let result = decodeCodeModeOutput({content: [{type: "text", text: "Useful text."}, image]});
    expect(result.images).toEqual([]);
    expect(result.output).toContain("Useful text.");
    expect(result.output).toContain("Image omitted:");
    expect(result.output.length).toBeLessThan(250);
  });

  it("admits the exact byte limit and rejects one byte beyond it", () => {
    let bytes = new Uint8Array(1024 * 1024);
    bytes.set([0x89, 0x50, 0x4e, 0x47]);
    expect(decodeCodeModeOutput({content: [{...IMAGE, data: bytes.toBase64()}]}).images)
        .toHaveLength(1);
    let tooMany = new Uint8Array(bytes.length + 1);
    tooMany.set(bytes);
    expect(decodeCodeModeOutput({content: [{...IMAGE, data: tooMany.toBase64()}]}).images)
        .toHaveLength(0);
  });

  it("keeps five images and reports the omitted sixth", () => {
    let result = decodeCodeModeOutput({content: Array.from({length: 6}, () => ({...IMAGE}))});
    expect(result.images).toHaveLength(5);
    expect(result.output).toContain("Too many images");
  });

  it("does not recursively interpret arbitrary return values", () => {
    expect(() => decodeCodeModeOutput({nested: {content: [IMAGE]}})).toThrow("Invalid code output");
  });

  it("bounds the combined text across content blocks", () => {
    let result = decodeCodeModeOutput({content: [
      {type: "text", text: "a".repeat(65536)}, {type: "text", text: "b".repeat(65536)},
    ]});
    expect(result.output.length).toBeLessThan(65600);
    expect(result.output).toContain("Output text truncated");
  });

  it("retains the producing tool's failure alongside its content", () => {
    let result = decodeCodeModeOutput({isError: true, content: [{type: "text", text: "Capture failed."}]});
    expect(result.output).toBe("Capture failed.");
    expect(result.error).toBe("Returned tool result reported an error.");
  });
});

describe("image replay", () => {
  const attachment = {id: "saved-image", mimeType: "image/png", size: 68};

  it("loads a stored image exactly once and sends the original bytes", async () => {
    let load = vi.fn(async () => Uint8Array.fromBase64(PNG));
    expect(await codeModeImageContent([attachment], true, load)).toEqual([IMAGE]);
    expect(load).toHaveBeenCalledExactlyOnceWith("saved-image");
  });

  it("uses staged bytes for the live result without trying to read committed storage", async () => {
    let load = vi.fn(async () => { throw new Error("Not committed yet."); });
    expect(await codeModeImageContent([
      {...attachment, content: Uint8Array.fromBase64(PNG)},
    ], true, load)).toEqual([IMAGE]);
    expect(load).not.toHaveBeenCalled();
  });

  it("tells a non-vision model that the image was omitted, without loading it", async () => {
    let load = vi.fn(async () => Uint8Array.fromBase64(PNG));
    let result = await codeModeImageContent([attachment], false, load);
    expect(result).toEqual([{type: "text", text: expect.stringContaining("does not accept image input")}]);
    expect(load).not.toHaveBeenCalled();
  });

  it("reports unavailable evidence without fabricating replacement image data", async () => {
    let result = await codeModeImageContent([attachment], true, async () => {
      throw new Error("Missing content.");
    });
    expect(result).toEqual([{type: "text", text: expect.stringContaining("not fetched again")}]);
  });
});
