import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ChatAttachmentRef, ChatAttachmentUpload } from "@gadgets/workshop-shared/api";
import {
  isAllowedChatAttachmentImageMimeType,
  MAX_CHAT_ATTACHMENTS_PER_MESSAGE, validateChatAttachmentUpload,
} from "./chat-attachment-validation";

/** Decoded image budget per execution; base64 and framing must fit in a 32 MiB RPC. */
export const MAX_CODE_IMAGE_BYTES = 15 * 1024 * 1024;

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
  for (let [index, block] of value.slice(0, MAX_CHAT_ATTACHMENTS_PER_MESSAGE).entries()) {
    try {
      if (typeof block?.data !== "string" ||
          block.data.length > Math.ceil(remainingBytes / 3) * 4) {
        throw new Error("Image data is missing or too large.");
      }
      if (typeof block.mimeType !== "string" ||
          !isAllowedChatAttachmentImageMimeType(block.mimeType)) {
        throw new Error("Unsupported image format; use PNG, JPEG, or WebP.");
      }
      let content = Uint8Array.fromBase64(block.data, {lastChunkHandling: "strict"});
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
