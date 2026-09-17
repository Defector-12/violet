export interface ContextCheckpoint {
  readonly content: string;
  readonly contextEpochId: string;
  readonly deletionRevision: number;
  readonly fromSequence: number;
  readonly throughSequence: number;
  readonly updatedAt: Date;
}

export type SaveContextCheckpoint = ContextCheckpoint;

export interface ContextCheckpointRepository {
  deletionRevision(): Promise<number>;
  get(contextEpochId: string): Promise<ContextCheckpoint | null>;
  save(checkpoint: SaveContextCheckpoint): Promise<boolean>;
}
