import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type {
  ActionDescription, ApprovalQueue, GatekeeperUserVerifier, GitCache, HookController,
  HookDescription, ObservationDescription, ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { TestGitCache } from "./test-git-cache";
import type { GoogleAccessToken } from "../src/google-api";
import type { GoogleDocSession } from "../src/docs-types";
import type { GoogleDocGatekeeperImpl as GoogleDocGatekeeper } from "../src/google";

export { default, GoogleDocGatekeeperImpl } from "../src/google";

export class UserAccount extends DurableObject<Env> {
  async getAccessToken(): Promise<GoogleAccessToken> {
    return { token: "test-access-token", expires: new Date(8640000000000000) };
  }
}

/**
 * Stands in for the Google verifier an observer is checked against; props fix its verdict.
 *
 * An entrypoint rather than a local RpcTarget because the tracker persists the stub it is given,
 * and only a persistent stub can be stored.
 */
export class TestVerifier extends WorkerEntrypoint<Env, { allowed: boolean }> {
  async hasDocAccess(_documentId: string): Promise<boolean> {
    return this.ctx.props.allowed;
  }
}

type GatekeeperProps = { userObjectId: string; documentId: string; creation?: { title: string } };

class TestApprovalQueue extends RpcTarget implements ApprovalQueue {
  actionId?: number;
  readonly observations: ObservationDescription[] = [];

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.observations.push(description);
  }

  async getGitCache(): Promise<GitCache> {
    throw new Error("Unexpected git cache access");
  }

  async submitAction(actionId: number, _description: ActionDescription): Promise<void> {
    this.actionId = actionId;
  }

  async bindHook<Hook extends RpcTarget>(
    _controller: Fetcher<HookController<Hook>>,
    _callback: RpcStub<Hook>,
    _description: HookDescription,
  ): Promise<void> {
    throw new Error("Unexpected hook binding");
  }
}

export class TestHooks extends DurableObject<Env> {
  // `creation` makes the facet a createResource-minted provisional doc gatekeeper. Facets are
  // cached by name, so every call addressing one provisional facet must pass the same creation
  // (the callback re-runs after a Durable Object restart).
  #gatekeeper(facetName: string, creation?: { title: string }) {
    let userObjectId = this.ctx.exports.UserAccount.idFromName("test-user").toString();
    let props: GatekeeperProps = creation
      ? { userObjectId, documentId: `provisional-${facetName}`, creation }
      : { userObjectId, documentId: "doc-1" };
    return this.ctx.facets.get<GoogleDocGatekeeper>(facetName, () => ({
      class: this.ctx.exports.GoogleDocGatekeeperImpl({ props }),
    }));
  }

  /** The error admitting an observer fails with, or null when they are admitted. */
  async addObserver(
      facetName: string, id: string, allowed: boolean, creation?: { title: string },
  ): Promise<string | null> {
    // ctx.exports is typed from the production main module, which has no test-only entrypoint.
    let testExports = this.ctx.exports as unknown as {
      TestVerifier(options: { props: { allowed: boolean } }): Fetcher<GatekeeperUserVerifier>;
    };
    let verifier = testExports.TestVerifier({ props: { allowed } });
    try {
      await this.#gatekeeper(facetName, creation).addObserver(id, verifier);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** Observers a content read withholds the disclosure from. */
  async readContentExclusions(
      facetName: string, creation?: { title: string }): Promise<string[]> {
    let queue = new TestApprovalQueue();
    {
      using approvalQueue = new RpcStub<ApprovalQueue>(queue);
      using session = await this.#gatekeeper(facetName, creation).startSession(
        approvalQueue as unknown as ApprovalQueue,
      ) as GoogleDocSession & Disposable;
      await session.getContent();
    }
    return queue.observations.flatMap(observation => observation.excludeObservers ?? []);
  }

  async submitAppend(
      facetName: string, markdown: string, creation?: { title: string }): Promise<number> {
    let queue = new TestApprovalQueue();
    {
      using approvalQueue = new RpcStub<ApprovalQueue>(queue);
      using session = await this.#gatekeeper(facetName, creation).startSession(
        approvalQueue as unknown as ApprovalQueue,
      ) as GoogleDocSession & Disposable;
      await session.appendText(markdown);
    }
    if (queue.actionId === undefined) throw new Error("Action was not submitted");
    return queue.actionId;
  }

  /** Queue the creation action; null when the call was an idempotent no-op. */
  async submitCreation(facetName: string, title: string): Promise<number | null> {
    let queue = new TestApprovalQueue();
    {
      using approvalQueue = new RpcStub<ApprovalQueue>(queue);
      await this.#gatekeeper(facetName, { title }).submitCreationAction(
        approvalQueue as unknown as ApprovalQueue);
    }
    return queue.actionId ?? null;
  }

  /** The `lastModified` a metadata read reports, as epoch milliseconds. */
  async readMetadata(facetName: string, creation?: { title: string }): Promise<number> {
    using approvalQueue = new RpcStub<ApprovalQueue>(new TestApprovalQueue());
    using session = await this.#gatekeeper(facetName, creation).startSession(
      approvalQueue as unknown as ApprovalQueue,
    ) as GoogleDocSession & Disposable;
    let metadata = await session.getMetadata();
    return metadata.lastModified.valueOf();
  }

  /** The simulated document content a read reports. */
  async readContent(facetName: string, creation?: { title: string }): Promise<string> {
    using approvalQueue = new RpcStub<ApprovalQueue>(new TestApprovalQueue());
    using session = await this.#gatekeeper(facetName, creation).startSession(
      approvalQueue as unknown as ApprovalQueue,
    ) as GoogleDocSession & Disposable;
    let content = await session.getContent();
    return content;
  }

  /** The error message a content read fails with, or null if it succeeds. */
  async readContentError(
      facetName: string, creation?: { title: string }): Promise<string | null> {
    try {
      await this.readContent(facetName, creation);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async describeDoc(
      facetName: string, creation?: { title: string }): Promise<ResourceDescription> {
    return this.#gatekeeper(facetName, creation).describe();
  }

  async applyAction(
      facetName: string, actionId: number, creation?: { title: string },
  ): Promise<string | null> {
    try {
      // The overseer always passes an action-scoped git cache with the apply call, and the
      // validator (sharpened by the `Gatekeeper` interface) requires it, so the test passes a
      // stand-in the same way.
      await this.#gatekeeper(facetName, creation)
          .applyAction(actionId, new RpcStub(new TestGitCache()));
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** Whether the gatekeeper asked for a session restart. */
  async rejectAction(
      facetName: string, actionId: number, creation?: { title: string }): Promise<boolean> {
    let result = await this.#gatekeeper(facetName, creation).rejectAction(actionId);
    return !!(result && result.restart);
  }
}
