import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import type { ChatAttachmentRef, ChatAttachmentUpload } from "@gadgets/workshop-shared/api";
import {
  isAllowedChatAttachmentImageMimeType,
  MAX_CHAT_ATTACHMENTS_PER_MESSAGE, validateChatAttachmentUpload,
} from "./chat-attachment-validation";

/** Decoded image budget per execution; base64 and framing must fit in a 32 MiB RPC. */
export const MAX_CODE_IMAGE_BYTES = 15 * 1024 * 1024;

/**
 * Decoded image bytes one model request may carry. Anthropic rejects an inline image over 10 MB
 * of base64 and Gemini a whole request over 20 MB. History replays every stored image into every
 * request, so exceeding either would fail each later request and the chat could never recover.
 */
export const MAX_MODEL_IMAGE_BYTES = 7 * 1024 * 1024;

const mib = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

function tooLargeForModel(mimeType: string, bytes: number): TextContent {
  return {type: "text", text: `[${mimeType} of ${mib(bytes)} MiB is too large for model input; ` +
      `ask for one under ${mib(MAX_MODEL_IMAGE_BYTES)} MiB. The user can still open it.]`};
}

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
    // Checked before loading: replay must not read bytes that pruneImageInput would then drop.
    if (attachment.size > MAX_MODEL_IMAGE_BYTES) {
      return tooLargeForModel(attachment.mimeType, attachment.size);
    }
    try {
      let content = attachment.content ?? await load(attachment.id);
      return {type: "image", mimeType: attachment.mimeType, data: content.toBase64()};
    } catch {
      return {type: "text", text: "[Image unavailable in stored history; it was not fetched again.]"};
    }
  }));
}

/**
 * Keep the newest images within MAX_MODEL_IMAGE_BYTES and replace the rest with a marker, as
 * compaction does for summarized history. Compaction itself cannot bound them: it weighs tokens,
 * which an image's byte size barely moves. Mutates in place so the dropped base64 is freed from
 * the isolate rather than only hidden from one request.
 */
export function pruneImageInput(messages: Message[]): void {
  let remaining = Math.ceil(MAX_MODEL_IMAGE_BYTES / 3) * 4;
  for (let message of messages.toReversed()) {
    if (message.role === "assistant" || typeof message.content === "string") continue;
    for (let [index, part] of [...message.content.entries()].toReversed()) {
      if (part.type !== "image") continue;
      if (part.data.length <= remaining) {
        remaining -= part.data.length;
      } else {
        let bytes = Math.floor(part.data.length / 4) * 3;
        message.content[index] = bytes > MAX_MODEL_IMAGE_BYTES
          ? tooLargeForModel(part.mimeType, bytes)
          : {type: "text", text: `[${part.mimeType} no longer shown: model input keeps the ` +
              `newest ${mib(MAX_MODEL_IMAGE_BYTES)} MiB of images.]`};
      }
    }
  }
}
