import { describe, expect, it } from "vitest";

import { assertCompleteRecordedScenarios } from "./eval-phase1-checkpoints.mjs";

const complete = [{ id: "AURORA-17" }, { id: "ORCHID-42" }, { id: "NEBULA-9" }];

describe("Phase 1 checkpoint evaluation evidence", () => {
  it("requires every expected scenario exactly once", () => {
    expect(() => assertCompleteRecordedScenarios(complete)).not.toThrow();
    expect(() => assertCompleteRecordedScenarios(complete.slice(0, 2))).toThrow(
      "incomplete or duplicated",
    );
    expect(() => assertCompleteRecordedScenarios([complete[0], complete[0], complete[2]])).toThrow(
      "incomplete or duplicated",
    );
  });
});
