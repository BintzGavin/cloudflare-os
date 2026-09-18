import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import type { ChatAttachmentRef, ChatAttachmentUpload } from "@gadgets/workshop-shared/api";
import {
  isAllowedChatAttachmentImageMimeType,
  MAX_CHAT_ATTACHMENTS_PER_MESSAGE, validateChatAttachmentUpload,
} from "./chat-attachment-validation";

/**
 * Decoded image bytes one execution may return, and one model request may carry. The limit comes
 * from the consumer: Anthropic rejects an inline image over 10 MB of base64, Gemini a whole
 * request over 20 MB, and AI Gateway drops the log of a request over 10 MB, which the overseer
 * reads for its cost. Providers downsample to about 2576 px anyway, which this covers as PNG.
 * One limit for both means every stored image is one the model saw.
 */
export const MAX_CODE_IMAGE_BYTES = 5 * 1024 * 1024;

const LIMIT = `${MAX_CODE_IMAGE_BYTES / 1024 / 1024} MiB`;

/** Recorded console output and staged image references from one code execution. */
export type CodeModeOutput = {
  output: string;
  attachments?: ChatAttachmentRef[];
};

/**
 * Validate the image blocks the code-mode harness lifted out of an execution's return value.
 * The harness shares an isolate with the agent's code, so every limit is enforced here. A
 * rejected image becomes a note for the model rather than failing the execution.
 */
export function decodeCodeModeImages(value: unknown): {
  images: ChatAttachmentUpload[]; notes: string[];
} {
  if (!Array.isArray(value)) throw new Error("Invalid code output images.");
  let images: ChatAttachmentUpload[] = [];
  let notes: string[] = [];
  let remainingBytes = MAX_CODE_IMAGE_BYTES;
  // The model can act on this in the same step, and nothing it cannot see is stored.
  let tooLarge = `Images are limited to ${LIMIT} per execution; ask for a smaller or more ` +
      "compressed one.";
  for (let [index, block] of value.slice(0, MAX_CHAT_ATTACHMENTS_PER_MESSAGE).entries()) {
    try {
      if (typeof block?.data !== "string") throw new Error("Image data is missing.");
      // Checked on the encoded length first, so an oversized string is never decoded.
      if (block.data.length > Math.ceil(remainingBytes / 3) * 4) throw new Error(tooLarge);
      if (typeof block.mimeType !== "string" ||
          !isAllowedChatAttachmentImageMimeType(block.mimeType)) {
        throw new Error("Unsupported image format; use PNG, JPEG, or WebP.");
      }
      let content = Uint8Array.fromBase64(block.data, {lastChunkHandling: "strict"});
      if (content.byteLength > remainingBytes) throw new Error(tooLarge);
      images.push(validateChatAttachmentUpload(
          {mimeType: block.mimeType, content}, undefined, remainingBytes));
      remainingBytes -= content.byteLength;
    } catch (error) {
      notes.push(`[Image ${index + 1} omitted: ` +
          `${error instanceof Error ? error.message : "invalid image"}]`);
    }
  }
  if (value.length > MAX_CHAT_ATTACHMENTS_PER_MESSAGE) {
    notes.push("[Later images omitted: at most five can be returned per execution.]");
  }
  return {images, notes};
}

/** Build model input from the same image bytes used for the chat preview. */
export async function codeModeImageContent(
    attachments: ChatAttachmentRef[] | undefined, acceptsImages: boolean,
    load: (id: string) => Promise<Uint8Array>): Promise<(TextContent | ImageContent)[]> {
  if (!attachments?.length) return [];
  if (!acceptsImages) {
    return [{type: "text", text: "[Images omitted: this model does not accept image input. " +
        "The images remain available in the chat preview.]"}];
  }
  return Promise.all(attachments.map(async (attachment): Promise<TextContent | ImageContent> => {
    try {
      let content = attachment.content ?? await load(attachment.id);
      return {type: "image", mimeType: attachment.mimeType, data: content.toBase64()};
    } catch {
      return {type: "text", text: "[Image unavailable in stored history; it was not fetched again.]"};
    }
  }));
}

/**
 * Keep the newest images within MAX_CODE_IMAGE_BYTES and replace the rest with a marker, as
 * compaction does for summarized history. History replays every stored image into every request,
 * and compaction cannot bound them: it weighs tokens, which an image's byte size barely moves.
 * Without this, enough images would fail each later request and the chat could never recover.
 * Mutates in place so the dropped base64 is freed from the isolate, not only hidden from one
 * request.
 */
export function pruneImageInput(messages: Message[]): void {
  let remaining = Math.ceil(MAX_CODE_IMAGE_BYTES / 3) * 4;
  for (let message of messages.toReversed()) {
    if (message.role === "assistant" || typeof message.content === "string") continue;
    for (let [index, part] of [...message.content.entries()].toReversed()) {
      if (part.type !== "image") continue;
      if (part.data.length <= remaining) {
        remaining -= part.data.length;
      } else {
        message.content[index] = {type: "text", text:
            `[${part.mimeType} no longer shown: model input keeps the newest ${LIMIT} of images.]`};
      }
    }
  }
}
