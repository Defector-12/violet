import type { ContextSessionRepository, ResolvedContext } from "@violet/domain";

export class InMemoryContextSessionRepository implements ContextSessionRepository {
  readonly #contexts = new Map<string, ResolvedContext>();

  async delete(sessionId: string): Promise<void> {
    this.#contexts.delete(sessionId);
  }

  async get(sessionId: string): Promise<ResolvedContext | null> {
    return this.#contexts.get(sessionId) ?? null;
  }

  async put(context: ResolvedContext): Promise<void> {
    this.#contexts.set(context.sessionId, context);
  }
}
