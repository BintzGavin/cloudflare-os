import { isTextLikeAttachmentMimeType } from "@gadgets/workshop-shared/api";
import type { AiModelConfig, AiModelProvider, ChatAttachmentUpload } from "@gadgets/workshop-shared/api";
import { PDF_MIME_TYPE } from "./chat-attachment-pdf";

/** Bounds attachment storage and the bytes replayed into model requests. */
export const MAX_CHAT_ATTACHMENT_BYTES = 1024 * 1024;

/** Maximum number of attachments in a message or one code execution's output. */
export const MAX_CHAT_ATTACHMENTS_PER_MESSAGE = 5;

const IMAGE_SIGNATURES = new Map<string, readonly (number | null)[]>([
  ["image/jpeg", [0xFF, 0xD8, 0xFF]],
  ["image/png", [0x89, 0x50, 0x4E, 0x47]],
  ["image/webp", [
    0x52, 0x49, 0x46, 0x46,
    null, null, null, null,
    0x57, 0x45, 0x42, 0x50,
  ]],
]);

// Magic-number prefixes checked at upload. Like the image signatures, the PDF one ("%PDF-")
// only stops mislabeled uploads at the door; nothing here parses the content.
const CONTENT_SIGNATURES = new Map<string, readonly (number | null)[]>([
  ...IMAGE_SIGNATURES,
  [PDF_MIME_TYPE, [0x25, 0x50, 0x44, 0x46, 0x2D]],
]);

const isTextOrImageMime = (mimeType: string) =>
  isTextLikeAttachmentMimeType(mimeType) || IMAGE_SIGNATURES.has(mimeType);

const isTextImageOrPdfMime = (mimeType: string) =>
  isTextOrImageMime(mimeType) || mimeType === PDF_MIME_TYPE;

// pi-ai encodes only text and image content parts, so text + images are universal. PDFs ride an
// image part and are bridged to a provider's native document input where one exists: Gemini takes
// application/pdf inline data as-is, and Anthropic/OpenAI payloads are rewritten in flight (see
// chat-attachment-pdf.ts). Workers AI and Ollama chat endpoints have no document input at all.
const ATTACHMENT_SUPPORT_BY_PROVIDER = {
  anthropic: isTextImageOrPdfMime,
  openai: isTextImageOrPdfMime,
  google: isTextImageOrPdfMime,
  cloudflare: isTextOrImageMime,
  ollama: isTextOrImageMime,
} satisfies Record<AiModelProvider, (mimeType: string) => boolean>;

function sanitizeChatAttachmentMimeType(mimeType: string | undefined): string {
  if (!mimeType || /[\r\n]/.test(mimeType)) return "application/octet-stream";
  return mimeType.split(";", 1)[0].trim().toLowerCase() || "application/octet-stream";
}

function sanitizeChatAttachmentName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  let result = name.replace(/[\r\n]/g, " ").slice(0, 255).trim();
  return result || undefined;
}

/** Reject an attachment type that the selected provider cannot accept. */
export function assertChatAttachmentSupportedByProvider(
  provider: AiModelProvider | undefined,
  mimeType: string,
  byteLength: number,
): void {
  if (byteLength > MAX_CHAT_ATTACHMENT_BYTES) {
    throw new Error("Chat attachment is too large.");
  }

  if (!provider) {
    if (isTextOrImageMime(mimeType)) return;
    throw new Error("Unsupported file type");
  }

  if (ATTACHMENT_SUPPORT_BY_PROVIDER[provider](mimeType)) return;

  throw new Error("Unsupported file type");
}

/** Throw if the bytes don't begin with the magic number for their declared type. */
function assertChatAttachmentSignature(mimeType: string, content: Uint8Array): void {
  let signature = CONTENT_SIGNATURES.get(mimeType);
  if (!signature) return;
  for (let [index, expected] of signature.entries()) {
    if (expected !== null && content[index] !== expected) {
      throw new Error("Chat attachment content does not match its MIME type.");
    }
  }
}

/** Normalize and validate attachment bytes before staging them in chat storage. */
export function validateChatAttachmentUpload(
  attachment: ChatAttachmentUpload,
  provider?: AiModelConfig["provider"],
): ChatAttachmentUpload {
  attachment.name = sanitizeChatAttachmentName(attachment.name);
  attachment.mimeType = sanitizeChatAttachmentMimeType(attachment.mimeType);
  assertChatAttachmentSupportedByProvider(provider, attachment.mimeType, attachment.content.byteLength);
  assertChatAttachmentSignature(attachment.mimeType, attachment.content);
  return attachment;
}

/**
 * Normalize and validate an image for the code-result path: the MIME must be an accepted image
 * encoding and the bytes must match it. Returns the normalized MIME. Unlike a chat upload, the
 * caller (decodeCodeModeImages) enforces its own, larger size budget, so no size check here.
 */
export function validateCodeImageAttachment(mimeType: string, content: Uint8Array): string {
  mimeType = sanitizeChatAttachmentMimeType(mimeType);
  if (!IMAGE_SIGNATURES.has(mimeType)) {
    throw new Error("Unsupported image format; use PNG, JPEG, or WebP.");
  }
  assertChatAttachmentSignature(mimeType, content);
  return mimeType;
}

/** Whether a MIME type is one of the image encodings Workshop accepts for chat attachments. */
export function isAllowedChatAttachmentImageMimeType(mimeType: string | undefined): boolean {
  return IMAGE_SIGNATURES.has(sanitizeChatAttachmentMimeType(mimeType));
}
