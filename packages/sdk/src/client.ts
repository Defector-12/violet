import {
  type ApiError,
  assertChatStreamEvent,
  assertContextReceipt,
  assertCoreStatus,
  assertHealth,
  assertMemoryDeletionPreview,
  assertMemoryDeletionStatus,
  assertMemoryDetail,
  assertMemoryList,
  assertMemoryMutation,
  assertMemorySettings,
  type ChatRequest,
  type ChatStreamEvent,
  type ContextEnvelope,
  type ContextReceipt,
  type CoreStatus,
  type Health,
  type MemoryCorrection,
  type MemoryDeletionConfirmation,
  type MemoryDeletionPreview,
  type MemoryDeletionPreviewRequest,
  type MemoryDeletionStatus,
  type MemoryDetail,
  type MemoryList,
  type MemoryMutation,
  type MemorySettings,
  type MemorySettingsUpdate,
} from "@violet/protocol";

export interface VioletClientOptions {
  readonly baseUrl: string;
  readonly deviceToken?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export class VioletApiError extends Error {
  readonly code: string;
  readonly requestId: string | undefined;
  readonly retryable: boolean;
  readonly status: number;

  constructor(status: number, error: Partial<ApiError>) {
    super(error.message ?? `Violet API request failed with status ${status}`);
    this.name = "VioletApiError";
    this.code = error.code ?? "UNKNOWN_API_ERROR";
    this.requestId = error.requestId;
    this.retryable = error.retryable ?? false;
    this.status = status;
  }
}

export class VioletClient {
  readonly #baseUrl: URL;
  readonly #deviceToken: string | undefined;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: VioletClientOptions) {
    this.#baseUrl = new URL(options.baseUrl);
    this.#deviceToken = options.deviceToken;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async getHealth(signal?: AbortSignal): Promise<Health> {
    const response = await this.#fetch(this.#url("/v1/health/live"), {
      ...(signal ? { signal } : {}),
    });
    const value = await this.#json(response);
    assertHealth(value);
    return value;
  }

  async getStatus(signal?: AbortSignal): Promise<CoreStatus> {
    const response = await this.#fetch(this.#url("/v1/status"), {
      headers: this.#headers(),
      ...(signal ? { signal } : {}),
    });
    const value = await this.#json(response);
    assertCoreStatus(value);
    return value;
  }

  async submitContext(envelope: ContextEnvelope, signal?: AbortSignal): Promise<ContextReceipt> {
    const response = await this.#fetch(this.#url("/v1/context/envelopes"), {
      body: JSON.stringify(envelope),
      headers: {
        ...this.#headers(),
        "content-type": "application/json",
      },
      method: "POST",
      ...(signal ? { signal } : {}),
    });
    const value = await this.#json(response);
    assertContextReceipt(value);
    return value;
  }

  async deleteContext(sessionId: string, signal?: AbortSignal): Promise<void> {
    const response = await this.#fetch(
      this.#url(`/v1/context/sessions/${encodeURIComponent(sessionId)}`),
      {
        headers: this.#headers(),
        method: "DELETE",
        ...(signal ? { signal } : {}),
      },
    );
    if (!response.ok) {
      throw await this.#apiError(response);
    }
  }

  async listMemories(signal?: AbortSignal): Promise<MemoryList> {
    const value = await this.#memoryRequest("/v1/memories", "GET", undefined, signal);
    assertMemoryList(value);
    return value;
  }

  async getMemorySettings(signal?: AbortSignal): Promise<MemorySettings> {
    const value = await this.#memoryRequest("/v1/memory-settings", "GET", undefined, signal);
    assertMemorySettings(value);
    return value;
  }

  async updateMemorySettings(
    input: MemorySettingsUpdate,
    signal?: AbortSignal,
  ): Promise<MemorySettings> {
    const value = await this.#memoryRequest("/v1/memory-settings", "POST", input, signal);
    assertMemorySettings(value);
    return value;
  }

  async getMemory(id: string, reveal = false, signal?: AbortSignal): Promise<MemoryDetail> {
    const value = await this.#memoryRequest(
      `/v1/memories/${encodeURIComponent(id)}?reveal=${reveal}`,
      "GET",
      undefined,
      signal,
    );
    assertMemoryDetail(value);
    return value;
  }

  async correctMemory(
    id: string,
    input: MemoryCorrection,
    signal?: AbortSignal,
  ): Promise<MemoryMutation> {
    const value = await this.#memoryRequest(
      `/v1/memories/${encodeURIComponent(id)}/corrections`,
      "POST",
      input,
      signal,
    );
    assertMemoryMutation(value);
    return value;
  }

  async previewMemoryDeletion(
    input: MemoryDeletionPreviewRequest,
    signal?: AbortSignal,
  ): Promise<MemoryDeletionPreview> {
    const value = await this.#memoryRequest("/v1/memory-deletions/previews", "POST", input, signal);
    assertMemoryDeletionPreview(value);
    return value;
  }

  async getMemoryDeletionPreview(id: string, signal?: AbortSignal): Promise<MemoryDeletionPreview> {
    const value = await this.#memoryRequest(
      `/v1/memory-deletions/${encodeURIComponent(id)}/preview`,
      "GET",
      undefined,
      signal,
    );
    assertMemoryDeletionPreview(value);
    return value;
  }

  async confirmMemoryDeletion(
    id: string,
    input: MemoryDeletionConfirmation,
    signal?: AbortSignal,
  ): Promise<MemoryDeletionStatus> {
    const value = await this.#memoryRequest(
      `/v1/memory-deletions/${encodeURIComponent(id)}/confirm`,
      "POST",
      input,
      signal,
    );
    assertMemoryDeletionStatus(value);
    return value;
  }

  async getMemoryDeletionStatus(id: string, signal?: AbortSignal): Promise<MemoryDeletionStatus> {
    const value = await this.#memoryRequest(
      `/v1/memory-deletions/${encodeURIComponent(id)}`,
      "GET",
      undefined,
      signal,
    );
    assertMemoryDeletionStatus(value);
    return value;
  }

  async retryMemoryBackupCleanup(id: string, signal?: AbortSignal): Promise<MemoryDeletionStatus> {
    const value = await this.#memoryRequest(
      `/v1/memory-deletions/${encodeURIComponent(id)}/retry`,
      "POST",
      undefined,
      signal,
    );
    assertMemoryDeletionStatus(value);
    return value;
  }

  async #memoryRequest(
    path: string,
    method: "GET" | "POST",
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.#json(
      await this.#fetch(this.#url(path), {
        method,
        headers: {
          ...this.#headers(),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal ? { signal } : {}),
      }),
    );
  }

  async *streamChat(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatStreamEvent> {
    const response = await this.#fetch(this.#url("/v1/chat/stream"), {
      body: JSON.stringify(request),
      headers: {
        ...this.#headers(),
        "content-type": "application/json",
      },
      method: "POST",
      ...(signal ? { signal } : {}),
    });

    if (!response.ok) {
      throw await this.#apiError(response);
    }
    if (!response.body) {
      throw new VioletApiError(response.status, {
        code: "EMPTY_RESPONSE_BODY",
        message: "Violet Core returned an empty stream",
        retryable: true,
      });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: !done });
      }

      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          yield this.#parseEvent(line);
        }
        newlineIndex = buffer.indexOf("\n");
      }

      if (done) {
        break;
      }
    }

    if (buffer.trim().length > 0) {
      yield this.#parseEvent(buffer.trim());
    }
  }

  async #apiError(response: Response): Promise<VioletApiError> {
    let value: Partial<ApiError> = {};
    try {
      value = (await response.json()) as Partial<ApiError>;
    } catch {
      value = {};
    }
    return new VioletApiError(response.status, value);
  }

  #headers(): Record<string, string> {
    return this.#deviceToken ? { authorization: `Bearer ${this.#deviceToken}` } : {};
  }

  async #json(response: Response): Promise<unknown> {
    if (!response.ok) {
      throw await this.#apiError(response);
    }
    return response.json();
  }

  #parseEvent(line: string): ChatStreamEvent {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new VioletApiError(502, {
        code: "INVALID_STREAM_JSON",
        message: "Violet Core returned malformed stream data",
        retryable: true,
      });
    }
    assertChatStreamEvent(value);
    return value;
  }

  #url(path: string): URL {
    return new URL(path, this.#baseUrl);
  }
}
