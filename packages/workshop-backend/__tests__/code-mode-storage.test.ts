import { expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import type { AiChatMessageBody, ChatAttachmentRef } from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

type Impl = OverseerDurableObject["impl"];
const PNG = Uint8Array.fromBase64(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=");
const AUTHOR = {type: "agent" as const, id: "image-fixture", name: "Image fixture"};
const EMPTY_STEP = {
  changes: [], createdGadgets: [], createdWorktrees: [], addedBindings: [], worktreeCommits: [],
};

// Stage an image the way executeCodeMode does, in a chat that exists.
function stage(impl: Impl): ChatAttachmentRef {
  impl.storage.chatMeta.put({id: 1, title: "Images", started: new Date(), lastActive: new Date()});
  return impl.stageChatAttachment({mimeType: "image/png", content: PNG});
}

function message(attachment: ChatAttachmentRef): AiChatMessageBody {
  return {type: "message", message: "", toolCalls: [{
    toolCallId: "image", toolName: "executeCode", input: {code: "return image;"},
    output: "Captured.", attachments: [attachment],
  }]};
}

it("commits a returned image with its step, and serves it after a restart", async () => {
  let name = crypto.randomUUID();
  let imageId = "";
  await runInDurableObject(env.TEST_OVERSEER.getByName(name), async instance => {
    let impl = instance["impl"];
    let attachment = stage(impl);
    imageId = attachment.id;
    await expect(impl.getChatAttachmentData(1, imageId)).rejects.toThrow("not found");
    await impl.commitAgentStep(1, AUTHOR, [message(attachment)], EMPTY_STEP);
    let stored = [...impl.storage.chats.list()];
    expect(stored).toHaveLength(1);
    // The log holds the reference; the bytes stay in attachment storage.
    expect(JSON.stringify(stored)).not.toContain('"content"');
    expect(await impl.getChatAttachmentData(1, imageId)).toEqual(PNG);
  });

  await abortAllDurableObjects();
  await runInDurableObject(env.TEST_OVERSEER.getByName(name), async instance => {
    let impl = instance["impl"];
    expect(await impl.getChatAttachmentData(1, imageId)).toEqual(PNG);
    await expect(impl.getChatAttachmentData(2, imageId)).rejects.toThrow("not found");
    // Delivered to clients with the bytes inlined, like a message's own image attachments.
    expect(impl.hydrateChatMessageForClient([...impl.storage.chats.list()][0])).toMatchObject({
      toolCalls: [{attachments: [{id: imageId, mimeType: "image/png", content: PNG}]}],
    });
  });
});

it("rolls the image back when a later message of the same step cannot commit", async () => {
  await runInDurableObject(env.TEST_OVERSEER.getByName(crypto.randomUUID()), async instance => {
    let impl = instance["impl"];
    let attachment = stage(impl);
    await expect(impl.commitAgentStep(1, AUTHOR, [
      message(attachment), message({...attachment, id: crypto.randomUUID()}),
    ], EMPTY_STEP)).rejects.toThrow("no longer available");
    expect([...impl.storage.chats.list()]).toEqual([]);
    expect(impl.storage.chatAttachmentContent.get(attachment.id)?.state.type).toBe("staged");
    await expect(impl.getChatAttachmentData(1, attachment.id)).rejects.toThrow("not found");
  });
});

it("sweeps an image whose step never committed, but not a committed one", async () => {
  await runInDurableObject(env.TEST_OVERSEER.getByName(crypto.randomUUID()), async instance => {
    let impl = instance["impl"];
    let committed = stage(impl);
    await impl.commitAgentStep(1, AUTHOR, [message(committed)], EMPTY_STEP);
    let abandoned = impl.stageChatAttachment({mimeType: "image/png", content: PNG});
    impl.storage.chatAttachmentContent.put({
      fileId: abandoned.id, data: PNG,
      state: {type: "staged", uploadedAt: 0, mimeType: "image/png"},
    });
    impl.sweepStagedChatAttachments();
    expect(impl.storage.chatAttachmentContent.get(abandoned.id)).toBeUndefined();
    expect(await impl.getChatAttachmentData(1, committed.id)).toEqual(PNG);
  });
});
