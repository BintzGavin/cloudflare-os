import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ChatAttachmentRef, ChatAttachmentUpload } from "@gadgets/workshop-shared/api";
import {
  isAllowedChatAttachmentImageMimeType,
  MAX_CHAT_ATTACHMENTS_PER_MESSAGE, validateChatAttachmentUpload,
} from "./chat-attachment-validation";

/** Decoded image budget per execution; base64 and framing must fit in a 32 MiB RPC. */
export const MAX_CODE_IMAGE_BYTES = 15 * 1024 * 1024;

/** Recorded text and staged image references from one code execution. */
export type CodeModeOutput = {
  output: string;
  attachments?: ChatAttachmentRef[];
  error?: string;
};

/** Decode only the explicit content envelope, never arbitrary objects or console logs. */
export function decodeCodeModeOutput(value: unknown): {
  output: string; images: ChatAttachmentUpload[]; error?: string;
} {
  if (typeof value !== "object" || value === null ||
      !("content" in value) || !Array.isArray(value.content)) {
    throw new Error("Invalid code output envelope.");
  }
  let text: string[] = [];
  let images: ChatAttachmentUpload[] = [];
  let remainingText = 65536;
  let remainingImageBytes = MAX_CODE_IMAGE_BYTES;
  for (let block of value.content.slice(0, 64)) {
    if (typeof block !== "object" || block === null) {
      text.push("[Unsupported output content.]");
    } else if (block.type === "text" && typeof block.text === "string") {
      let kept = block.text.slice(0, remainingText);
      text.push(kept);
      remainingText -= kept.length;
      if (kept.length < block.text.length) text.push("[Output text truncated.]");
    } else if (block.type === "image") {
      try {
        if (images.length >= MAX_CHAT_ATTACHMENTS_PER_MESSAGE) {
          throw new Error("Too many images; at most five can be returned per execution.");
        }
        if (typeof block.data !== "string" ||
            block.data.length > Math.ceil(remainingImageBytes / 3) * 4) {
          throw new Error("Image data is missing or too large.");
        }
        if (typeof block.mimeType !== "string" ||
            !isAllowedChatAttachmentImageMimeType(block.mimeType)) {
          throw new Error("Unsupported image format; use PNG, JPEG, or WebP.");
        }
        if (/[^A-Za-z0-9+/=]/.test(block.data)) {
          throw new Error("Invalid image base64.");
        }
        let content = Uint8Array.fromBase64(block.data, {lastChunkHandling: "strict"});
        images.push(validateChatAttachmentUpload(
            {mimeType: block.mimeType, content}, undefined, remainingImageBytes));
        remainingImageBytes -= content.byteLength;
      } catch (error) {
        text.push(`[Image omitted: ${error instanceof Error ? error.message : "invalid image"}]`);
      }
    } else {
      text.push("[Unsupported output content; return text or image blocks.]");
    }
  }
  if (value.content.length > 64) text.push("[Additional output content omitted.]");
  return {
    output: text.join("\n"), images,
    ...("isError" in value && value.isError === true
      ? {error: "Returned tool result reported an error."} : {}),
  };
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
