import { describe, expect, it, vi } from "vitest";
import { codeModeImageContent, decodeCodeModeImages } from "../src/code-mode-output.js";

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
