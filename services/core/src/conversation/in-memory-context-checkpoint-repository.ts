import type {
  ContextCheckpoint,
  ContextCheckpointRepository,
  SaveContextCheckpoint,
} from "@violet/domain";

export class InMemoryContextCheckpointRepository implements ContextCheckpointRepository {
  readonly #checkpoints = new Map<string, ContextCheckpoint>();
  #deletionRevision = 0;

  async deletionRevision(): Promise<number> {
    return this.#deletionRevision;
  }

  async get(contextEpochId: string): Promise<ContextCheckpoint | null> {
    const checkpoint = this.#checkpoints.get(contextEpochId);
    return checkpoint ? copy(checkpoint) : null;
  }

  async save(checkpoint: SaveContextCheckpoint): Promise<boolean> {
    if (checkpoint.deletionRevision !== this.#deletionRevision) {
      return false;
    }
    const existing = this.#checkpoints.get(checkpoint.contextEpochId);
    if (existing && existing.throughSequence > checkpoint.throughSequence) {
      return false;
    }
    this.#checkpoints.set(checkpoint.contextEpochId, copy(checkpoint));
    return true;
  }

  setDeletionRevision(revision: number): void {
    this.#deletionRevision = revision;
  }
}

function copy(checkpoint: ContextCheckpoint): ContextCheckpoint {
  return {
    ...checkpoint,
    updatedAt: new Date(checkpoint.updatedAt),
  };
}
