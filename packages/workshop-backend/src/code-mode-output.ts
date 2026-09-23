import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import type { ChatAttachmentRef, ChatAttachmentUpload } from "@gadgets/workshop-shared/api";
import {
  detectChatAttachmentImageMimeType, MAX_CHAT_ATTACHMENT_TOTAL_BYTES,
  MAX_CHAT_ATTACHMENTS_PER_MESSAGE, validateChatAttachmentUpload,
} from "./chat-attachment-validation";

/** What one executeCode run produced: its console log, and the images it returned, staged. */
export type CodeModeOutput = {
  output: string;
  attachments?: ChatAttachmentRef[];
};

/**
 * Validate what the code-mode harness returned as images. The harness shares an isolate with the
 * agent's code, so nothing about the array is trusted: each entry must be a Blob holding a PNG,
 * JPEG, or WebP, within the count and bytes a message's attachments may hold, and a rejected one
 * becomes a note for the model rather than a failed execution.
 */
export async function decodeCodeModeImages(returned: unknown[])
    : Promise<{images: ChatAttachmentUpload[], notes: string[]}> {
  let images: ChatAttachmentUpload[] = [];
  let notes: string[] = [];
  let remaining = MAX_CHAT_ATTACHMENT_TOTAL_BYTES;
  for (let [index, value] of returned.slice(0, MAX_CHAT_ATTACHMENTS_PER_MESSAGE).entries()) {
    try {
      if (!(value instanceof Blob)) throw new Error("Not an image.");
      // Checked before the bytes are read, so an oversized image is never copied.
      if (value.size > remaining) {
        throw new Error(`Images are limited to ${MAX_CHAT_ATTACHMENT_TOTAL_BYTES / 1024 / 1024} ` +
            "MiB per execution; return a smaller or more compressed one.");
      }
      let content = await value.bytes();
      let mimeType = detectChatAttachmentImageMimeType(content);
      if (mimeType === undefined) throw new Error("Not a PNG, JPEG, or WebP image.");
      images.push(validateChatAttachmentUpload({mimeType, content}));
      remaining -= content.byteLength;
    } catch (error) {
      notes.push(`[Image ${index + 1} omitted: ` +
          `${error instanceof Error ? error.message : "invalid image"}]`);
    }
  }
  if (returned.length > MAX_CHAT_ATTACHMENTS_PER_MESSAGE) {
    notes.push(`[Later images omitted: at most ${MAX_CHAT_ATTACHMENTS_PER_MESSAGE} can be ` +
        "returned per execution.]");
  }
  return {images, notes};
}

/**
 * The model-input parts for an execution's images: from the bytes still in hand on the live
 * turn, or from committed storage on replay.
 */
export async function codeModeImageContent(
    attachments: ChatAttachmentRef[] | undefined, acceptsImages: boolean,
    load: (id: string) => Promise<Uint8Array>): Promise<(TextContent | ImageContent)[]> {
  if (!attachments?.length) return [];
  if (!acceptsImages) {
    return [{type: "text", text: "[Images omitted: this model does not accept image input. " +
        "They remain visible to the user in the chat.]"}];
  }
  return Promise.all(attachments.map(async (attachment): Promise<TextContent | ImageContent> => {
    try {
      let content = attachment.content ?? await load(attachment.id);
      return {type: "image", mimeType: attachment.mimeType, data: content.toBase64()};
    } catch {
      return {type: "text", text: "[Image no longer available.]"};
    }
  }));
}

/**
 * Decoded bytes of returned images one model request carries. History replays every stored
 * image into every request, and compaction cannot bound them: it weighs tokens, which an image's
 * byte size barely moves. A person attaching images is paced by the chat; an agent returning
 * them is not, so only the latter are bounded. The limit comes from the consumers: AI Gateway
 * keeps no log of a request over 10 MB, which the overseer reads for the cost, and Gemini rejects
 * a request over 20 MB. 5 MiB of bytes is 6.7 MiB of base64, with room for text.
 */
export const MAX_MODEL_IMAGE_BYTES = 5 * 1024 * 1024;

function decodedBase64Length(data: string): number {
  let padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor(data.length * 3 / 4) - padding;
}

/**
 * Keep the newest returned images within MAX_MODEL_IMAGE_BYTES and replace the rest with a
 * marker, as compaction does for summarized history. A message's own attachments are left alone.
 * Mutates in place, so the dropped base64 is freed from the isolate rather than only left out of
 * one request.
 */
export function pruneImageInput(messages: Message[]): void {
  let remaining = MAX_MODEL_IMAGE_BYTES;
  for (let message of messages.toReversed()) {
    if (message.role !== "toolResult") continue;
    for (let [index, part] of [...message.content.entries()].toReversed()) {
      if (part.type !== "image") continue;
      let bytes = decodedBase64Length(part.data);
      if (bytes <= remaining) {
        remaining -= bytes;
      } else {
        message.content[index] = {type: "text", text: `[image ${part.mimeType} no longer ` +
            `shown: model input keeps the newest ${MAX_MODEL_IMAGE_BYTES / 1024 / 1024} MiB ` +
            "of returned images.]"};
      }
    }
  }
}
