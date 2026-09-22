import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
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
