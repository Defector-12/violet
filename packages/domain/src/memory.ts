export type MemoryKind = "preference" | "fact" | "goal" | "relationship";
export type MemorySensitivity = "normal" | "controlled";

export interface MemoryContent {
  readonly content: string;
  readonly kind: MemoryKind;
  readonly sensitivity: MemorySensitivity;
}

export interface MemorySource {
  readonly eventId: string;
  readonly startByte: number;
  readonly endByte: number;
}

export interface Memory extends MemoryContent {
  readonly id: string;
  readonly version: number;
  readonly state: "current" | "superseded";
  readonly origin: "explicit" | "automatic";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sources: readonly MemorySource[];
}

export interface MemoryState {
  readonly instanceId: string;
  readonly revision: number;
  readonly deletionRevision: number;
  readonly restoreEpoch: number;
}

export interface MemorySnapshot extends MemoryState {
  readonly memories: readonly Memory[];
  /** Earlier contexts remain valid across automatic additions only. */
  readonly minimumContextRevision?: number;
}

export interface MemorySummary {
  readonly content: string;
  readonly revision: number;
}

export interface MemoryChange {
  readonly id: string;
  readonly version: number;
  readonly kind: "created" | "corrected" | "source_added";
}

export interface MemoryWrite extends MemoryContent {
  readonly source: MemorySource & { readonly quote: string };
  readonly target?: {
    readonly id: string;
    readonly version: number;
    readonly action: "correct" | "add_source";
  };
}

export interface MemoryWriteRequest {
  readonly requestId: string;
  readonly sourceEventId: string;
  readonly expectedRevision: number;
  readonly writes: readonly MemoryWrite[];
  readonly automaticJob?: MemoryJob;
}

export interface MemorySettings {
  readonly instanceId: string;
  readonly revision: number;
  readonly enabled: boolean;
  readonly memoryRevision: number;
}

export interface MemorySettingsUpdate {
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly enabled: boolean;
}

export interface MemoryJob {
  readonly requestId: string;
  readonly sourceEventId: string;
  readonly claimId: string;
  readonly settingsRevision: number;
  readonly deletionRevision: number;
  readonly attempt: number;
}

export type MemoryDeletionTarget =
  | { readonly kind: "memory"; readonly id: string; readonly version: number }
  | { readonly kind: "source"; readonly eventId: string }
  | { readonly kind: "all" };

export interface MemoryDeletionPreview extends MemoryState {
  readonly id: string;
  readonly target: MemoryDeletionTarget;
  readonly nextRestoreEpoch: number;
  readonly eventSequence: number;
  readonly requestIds: readonly string[];
  readonly eventIds: readonly string[];
  readonly deletedMemoryIds: readonly string[];
  readonly retainedMemoryIds: readonly string[];
  readonly createdAt: string;
}

export interface MemoryDeletionStatus {
  readonly id: string;
  readonly instanceId: string;
  readonly restoreEpoch: number;
  readonly status: "pending" | "running" | "complete" | "failed";
  readonly failureCode?: string;
}

export interface MemoryRepository {
  settings(): Promise<MemorySettings>;
  updateSettings(input: MemorySettingsUpdate): Promise<MemorySettings>;
  recoverJobs(): Promise<void>;
  claimJob(): Promise<MemoryJob | null>;
  finishJob(job: MemoryJob, outcome: "skipped" | "retry", failureCode: string): Promise<void>;
  state(): Promise<MemoryState>;
  snapshot(): Promise<MemorySnapshot>;
  get(id: string): Promise<readonly Memory[]>;
  supersededSourceEventIds(): Promise<readonly string[]>;
  changesForRequest(requestId: string): Promise<readonly MemoryChange[] | null>;
  write(input: MemoryWriteRequest, signal?: AbortSignal): Promise<readonly MemoryChange[]>;
  summary(): Promise<MemorySummary | null>;
  saveSummary(summary: MemorySummary): Promise<boolean>;
  previewDeletion(id: string, target: MemoryDeletionTarget): Promise<MemoryDeletionPreview>;
  getDeletionPreview(id: string): Promise<MemoryDeletionPreview | null>;
  confirmDeletion(input: {
    readonly id: string;
    readonly instanceId: string;
    readonly minimumRestoreEpoch: number;
    readonly deviceId: string;
  }): Promise<MemoryDeletionStatus>;
  deletionStatus(id: string): Promise<MemoryDeletionStatus | null>;
  setCleanupStatus(
    id: string,
    status: MemoryDeletionStatus["status"],
    failureCode?: string,
  ): Promise<MemoryDeletionStatus>;
}

export class MemoryConflictError extends Error {
  constructor(message = "Memory changed; refresh before trying again") {
    super(message);
    this.name = "MemoryConflictError";
  }
}

export class MemorySourceError extends Error {
  constructor(message = "Memory requires an undeleted final user source") {
    super(message);
    this.name = "MemorySourceError";
  }
}
