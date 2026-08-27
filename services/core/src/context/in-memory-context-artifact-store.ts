import type { ContextArtifactStore } from "@violet/domain";

export class InMemoryContextArtifactStore implements ContextArtifactStore {
  readonly #sessionIds = new Set<string>();

  async deleteSession(sessionId: string): Promise<void> {
    this.#sessionIds.delete(sessionId);
  }

  async put(input: Parameters<ContextArtifactStore["put"]>[0]): Promise<void> {
    this.#sessionIds.add(input.sessionId);
  }
}
