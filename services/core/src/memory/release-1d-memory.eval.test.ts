import { describe, expect, it } from "vitest";
import { distribution, loadMemoryFixtures } from "./eval-memory.js";

describe("memory evaluation evidence", () => {
  it("loads the complete fixed corpus with source quotes and valid correction/deletion targets", async () => {
    const fixtures = await loadMemoryFixtures();
    expect(fixtures).toHaveLength(180);
    expect(fixtures.filter((fixture) => fixture.sensitivity === "controlled")).toHaveLength(4);
    for (const origin of ["secret", "assistant", "tool", "visual", "cancelled"])
      expect(fixtures.filter((fixture) => fixture.origin === origin)).toHaveLength(4);
  });

  it("retains slow trials in nearest-rank tail statistics instead of reporting a best run", () => {
    const samples = [...Array.from({ length: 98 }, () => 2), 500, 1000];
    const before = [...samples];
    expect(distribution(samples)).toEqual({ count: 100, p50: 2, p95: 2, p99: 500, max: 1000 });
    expect(samples).toEqual(before);
    expect(() => distribution([])).toThrow();
    expect(() => distribution([Number.NaN])).toThrow();
  });
});
