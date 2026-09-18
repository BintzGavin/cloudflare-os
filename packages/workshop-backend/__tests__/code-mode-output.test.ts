import { describe, expect, it, vi } from "vitest";
import { codeModeImageContent, decodeCodeModeImages } from "../src/code-mode-output.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const IMAGE = {type: "image", mimeType: "image/png", data: PNG};

describe("returned code images", () => {
  it("preserves exact image bytes", () => {
    expect(decodeCodeModeImages([IMAGE])).toEqual({
      images: [{mimeType: "image/png", content: Uint8Array.fromBase64(PNG)}], notes: [],
    });
  });

  it.each([
    {label: "invalid alphabet", image: {...IMAGE, data: "not-base64!"}},
    {label: "incomplete quartet", image: {...IMAGE, data: "A"}},
    {label: "invalid trailing bits", image: {...IMAGE, data: "AB=="}},
    {label: "wrong MIME signature", image: {...IMAGE, data: "YWJjZA=="}},
    {label: "unsupported image", image: {...IMAGE, mimeType: "image/svg+xml"}},
    {label: "missing MIME", image: {data: PNG}},
    {label: "missing data", image: {mimeType: "image/png"}},
    {label: "non-object block", image: null},
    {label: "oversized image", image: {...IMAGE, data: "A".repeat(20971521)}},
  ])("omits $label with a short note and keeps the valid image beside it", ({image}) => {
    let result = decodeCodeModeImages([image, IMAGE]);
    expect(result.images).toEqual([{mimeType: "image/png", content: Uint8Array.fromBase64(PNG)}]);
    expect(result.notes).toEqual([expect.stringMatching(/^\[Image 1 omitted: .{1,100}\]$/)]);
  });

  it("admits the exact byte limit and rejects one byte beyond it", () => {
    let bytes = new Uint8Array(15 * 1024 * 1024);
    bytes.set([0x89, 0x50, 0x4e, 0x47]);
    expect(decodeCodeModeImages([{...IMAGE, data: bytes.toBase64()}]).images).toHaveLength(1);
    let tooMany = new Uint8Array(bytes.length + 1);
    tooMany.set(bytes);
    expect(decodeCodeModeImages([{...IMAGE, data: tooMany.toBase64()}]).images).toHaveLength(0);
  });

  it("bounds all returned images together to 15 MiB", () => {
    let bytes = new Uint8Array(8 * 1024 * 1024);
    bytes.set([0x89, 0x50, 0x4e, 0x47]);
    let image = {...IMAGE, data: bytes.toBase64()};
    let result = decodeCodeModeImages([image, image, IMAGE]);
    expect(result.images.map(attachment => attachment.content.length)).toEqual([bytes.length, 68]);
    expect(result.notes).toEqual([expect.stringContaining("Image 2 omitted:")]);
  });

  it("considers only the first five images, however many follow", () => {
    let result = decodeCodeModeImages(Array.from({length: 5000}, () => ({...IMAGE})));
    expect(result.images).toHaveLength(5);
    expect(result.notes).toEqual([expect.stringContaining("at most five")]);
  });

  it("rejects anything but the harness's image list", () => {
    expect(() => decodeCodeModeImages({content: [IMAGE]})).toThrow("Invalid code output");
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
