import { expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import type { AiChatMessage, ChatAttachmentRef } from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

type Impl = OverseerDurableObject["impl"];
const MIB = 1024 * 1024;

// PNG-headed bytes of the given size, with a recognizable tail.
function png(size: number): Uint8Array {
  let bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes[size - 1] = 0x7f;
  return bytes;
}

// Deep equality over millions of elements is slow in vitest; a byte scan is not.
function sameBytes(actual: Uint8Array, expected: Uint8Array): boolean {
  return actual.byteLength === expected.byteLength && actual.every((byte, i) => byte === expected[i]);
}

function message(chatId: number, attachments: ChatAttachmentRef[]): AiChatMessage {
  return {type: "message", chatId, sequence: 0, timestamp: new Date(), message: "",
    author: {type: "user", id: "u", name: "U"}, attachments} as AiChatMessage;
}

it("stores an attachment larger than one chunk in pieces and reads it back whole, across a restart", async () => {
  let name = crypto.randomUUID();
  let large = png(3 * MIB + 7);
  let small = png(64);
  let largeId = "", smallId = "";
  await runInDurableObject(env.TEST_OVERSEER.getByName(name), async instance => {
    let impl: Impl = instance["impl"];
    let largeRef = impl.stageChatAttachment({mimeType: "image/png", content: large});
    let smallRef = impl.stageChatAttachment({mimeType: "image/png", content: small});
    ({id: largeId} = largeRef);
    ({id: smallId} = smallRef);
    expect(largeRef.size).toBe(large.byteLength);
    // The record holds the first chunk; the other three live beside it.
    expect(impl.storage.chatAttachmentContent.get(largeId)?.data.byteLength).toBe(MIB);
    expect([...impl.storage.chatAttachmentChunks.list({prefix: `${largeId}:`})]).toHaveLength(3);
    expect(impl.storage.chatAttachmentContent.get(smallId)?.size).toBeUndefined();

    let refs = impl.canonicalizeChatAttachmentRefs([{id: largeId}, {id: smallId}])!;
    expect(refs.map(ref => ref.size)).toEqual([large.byteLength, small.byteLength]);
    impl.commitChatAttachments(1, refs);
    expect(sameBytes(await impl.getChatAttachmentData(1, largeId), large)).toBe(true);
  });

  await abortAllDurableObjects();
  await runInDurableObject(env.TEST_OVERSEER.getByName(name), async instance => {
    let impl: Impl = instance["impl"];
    expect(sameBytes(await impl.getChatAttachmentData(1, largeId), large)).toBe(true);
    await expect(impl.getChatAttachmentData(2, largeId)).rejects.toThrow("not found");
    // Clients get small images inline and fetch large ones on demand.
    let refs: ChatAttachmentRef[] = [
      {id: largeId, mimeType: "image/png", size: large.byteLength},
      {id: smallId, mimeType: "image/png", size: small.byteLength},
    ];
    let hydrated = impl.hydrateChatMessageForClient(message(1, refs));
    expect(hydrated.type === "message" && hydrated.attachments?.map(a => a.content?.byteLength))
        .toEqual([undefined, small.byteLength]);
    // Another chat's message cannot inline this chat's bytes.
    let other = impl.hydrateChatMessageForClient(message(2, refs));
    expect(other.type === "message" && other.attachments?.every(a => a.content === undefined)).toBe(true);
  });
});

it("removes an attachment's chunks with it, when swept or deleted", async () => {
  await runInDurableObject(env.TEST_OVERSEER.getByName(crypto.randomUUID()), async instance => {
    let impl: Impl = instance["impl"];
    let swept = impl.stageChatAttachment({mimeType: "image/png", content: png(2 * MIB + 1)});
    let record = impl.storage.chatAttachmentContent.get(swept.id)!;
    impl.storage.chatAttachmentContent.put({...record, state: {type: "staged", uploadedAt: 0, mimeType: "image/png"}});
    let kept = impl.stageChatAttachment({mimeType: "image/png", content: png(2 * MIB + 1)});
    impl.sweepStagedChatAttachments();
    expect(impl.storage.chatAttachmentContent.get(swept.id)).toBeUndefined();
    expect([...impl.storage.chatAttachmentChunks.list({prefix: `${swept.id}:`})]).toEqual([]);
    expect([...impl.storage.chatAttachmentChunks.list({prefix: `${kept.id}:`})]).toHaveLength(2);

    impl.deleteChatAttachmentContent(kept.id);
    expect([...impl.storage.chatAttachmentChunks.list()]).toEqual([]);
    expect(impl.storage.chatAttachmentContent.get(kept.id)).toBeUndefined();
  });
});
