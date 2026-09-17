import { describe, expect, it } from "vitest";

import { ContextEpochManager } from "./context-epoch-manager.js";

describe("ContextEpochManager", () => {
  it("shares an epoch until the thirty-minute user inactivity boundary", () => {
    let id = 0;
    const manager = new ContextEpochManager({
      generateId: () => `epoch-${++id}`,
    });
    const startedAt = new Date("2026-09-16T00:00:00.000Z");

    const first = manager.acceptUserInput(startedAt);
    const continued = manager.acceptUserInput(new Date(startedAt.getTime() + 29 * 60_000 + 59_000));
    const next = manager.acceptUserInput(new Date(startedAt.getTime() + 59 * 60_000 + 59_000));

    expect(first.id).toBe("epoch-1");
    expect(continued.id).toBe(first.id);
    expect(next.id).toBe("epoch-2");
  });

  it("does not create or extend an epoch when only inspected", () => {
    let id = 0;
    const manager = new ContextEpochManager({
      generateId: () => `epoch-${++id}`,
    });
    const startedAt = new Date("2026-09-16T00:00:00.000Z");

    expect(manager.current(startedAt)).toBeNull();
    const epoch = manager.acceptUserInput(startedAt);
    expect(manager.current(new Date(startedAt.getTime() + 29 * 60_000))).toEqual(epoch);
    expect(manager.current(new Date(startedAt.getTime() + 30 * 60_000))).toBeNull();
    expect(id).toBe(1);
  });

  it("never moves the user-input watermark backward", () => {
    let id = 0;
    const manager = new ContextEpochManager({
      generateId: () => `epoch-${++id}`,
    });
    const startedAt = new Date("2026-09-16T00:00:00.000Z");
    manager.acceptUserInput(startedAt);
    const current = manager.acceptUserInput(new Date(startedAt.getTime() + 30 * 60_000 + 1_000));

    expect(manager.acceptUserInput(new Date(startedAt.getTime() + 29 * 60_000 + 59_000))).toEqual(
      current,
    );
    expect(manager.current(new Date(startedAt.getTime() + 60 * 60_000))).toEqual(current);
  });
});
