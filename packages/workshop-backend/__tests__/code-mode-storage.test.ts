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
const PNG = Uint8Array.fromBase64("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=");
const AUTHOR = {type: "agent" as const, id: "image-fixture", name: "Image fixture"};
const EMPTY_STEP = {changes: [], createdGadgets: [], createdWorktrees: [], addedBindings: [], worktreeCommits: []};

function seed(impl: Impl): ChatAttachmentRef {
  impl.storage.chatMeta.put({id: 1, title: "Images", started: new Date(), lastActive: new Date()});
  let id = crypto.randomUUID();
  impl.storage.chatAttachmentContent.put({
    fileId: id, data: PNG,
    state: {type: "staged", uploadedAt: Date.now(), mimeType: "image/png"},
  });
  return {id, mimeType: "image/png", size: PNG.length, content: PNG};
}

function message(attachment: ChatAttachmentRef): AiChatMessageBody {
  return {type: "message", message: "", toolCalls: [{
    toolCallId: "image", toolName: "executeCode", input: {code: "return image;"},
    output: "Captured.", attachments: [attachment],
  }]};
}

it("commits image references with the step and restores bytes after a Durable Object restart", async () => {
  let name = crypto.randomUUID();
  let imageId = "";
  await runInDurableObject(env.TEST_OVERSEER.getByName(name), async instance => {
    let impl = instance["impl"];
    let attachment = seed(impl);
    imageId = attachment.id;
    await expect(impl.getChatAttachmentData(1, imageId)).rejects.toThrow("not found");
    await impl.commitAgentStep(1, AUTHOR, [message(attachment)], EMPTY_STEP);
    let stored = [...impl.storage.chats.list()];
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain('"content"');
    expect(await impl.getChatAttachmentData(1, imageId)).toEqual(PNG);
  });

  await abortAllDurableObjects();
  await runInDurableObject(env.TEST_OVERSEER.getByName(name), async instance => {
    let impl = instance["impl"];
    expect(await impl.getChatAttachmentData(1, imageId)).toEqual(PNG);
    await expect(impl.getChatAttachmentData(2, imageId)).rejects.toThrow("not found");
    let stored = [...impl.storage.chats.list()][0];
    expect(impl.hydrateChatMessageForClient(stored)).toMatchObject({
      toolCalls: [{attachments: [{id: imageId, content: PNG}]}],
    });
    // A reference in a different chat cannot hydrate someone else's bytes either.
    expect(JSON.stringify(impl.hydrateChatMessageForClient({...stored, chatId: 2})))
        .not.toContain('"content"');
  });
});

it("rolls back image commitment when a later message in the same step cannot commit", async () => {
  await runInDurableObject(env.TEST_OVERSEER.getByName(crypto.randomUUID()), async instance => {
    let impl = instance["impl"];
    let attachment = seed(impl);
    await expect(impl.commitAgentStep(1, AUTHOR, [
      message(attachment), message({...attachment, id: crypto.randomUUID()}),
    ], EMPTY_STEP)).rejects.toThrow("no longer available");
    expect([...impl.storage.chats.list()]).toEqual([]);
    expect(impl.storage.chatAttachmentContent.get(attachment.id)?.state.type).toBe("staged");
    await expect(impl.getChatAttachmentData(1, attachment.id)).rejects.toThrow("not found");
  });
});

it("sweeps abandoned images without deleting committed evidence", async () => {
  await runInDurableObject(env.TEST_OVERSEER.getByName(crypto.randomUUID()), async instance => {
    let impl = instance["impl"];
    let committed = seed(impl);
    await impl.commitAgentStep(1, AUTHOR, [message(committed)], EMPTY_STEP);
    let abandoned = crypto.randomUUID();
    impl.storage.chatAttachmentContent.put({
      fileId: abandoned, data: PNG,
      state: {type: "staged", uploadedAt: 0, mimeType: "image/png"},
    });
    impl.sweepStagedChatAttachments();
    expect(impl.storage.chatAttachmentContent.get(abandoned)).toBeUndefined();
    expect(await impl.getChatAttachmentData(1, committed.id)).toEqual(PNG);
  });
});
