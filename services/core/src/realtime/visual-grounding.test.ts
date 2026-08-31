import type { ResolvedContext } from "@violet/domain";
import { describe, expect, it } from "vitest";

import { formatVisualResult } from "./visual-grounding.js";

const grounded: ResolvedContext = {
  answer: "右下角绿色上箭头是发送按钮。",
  confidence: 0.94,
  eventId: "event",
  expiresAt: new Date("2026-08-31T00:05:00.000Z"),
  sessionId: "session",
  summary: "右下角绿色上箭头是发送按钮。",
  target: {
    bounds: { height: 0.04, width: 0.03, x: 0.95, y: 0.93 },
    color: "green",
    kind: "button",
  },
};

describe("formatVisualResult", () => {
  it("accepts grounded answers that match position and color", () => {
    expect(JSON.parse(formatVisualResult(grounded, "右下角绿色按钮有什么作用"))).toMatchObject({
      answer: "右下角绿色上箭头是发送按钮。",
      status: "ready",
    });
  });

  it("rejects answers whose evidence conflicts with the question", () => {
    expect(
      JSON.parse(
        formatVisualResult(
          {
            ...grounded,
            target: {
              bounds: { height: 0.04, width: 0.03, x: 0.1, y: 0.1 },
              color: "white",
              kind: "button",
            },
          },
          "右下角绿色按钮有什么作用",
        ),
      ),
    ).toMatchObject({ status: "unavailable" });
  });

  it("keeps exact Accessibility text as evidence for Qwen", () => {
    expect(
      JSON.parse(
        formatVisualResult(
          {
            eventId: "event",
            expiresAt: new Date("2026-08-31T00:05:00.000Z"),
            sessionId: "session",
            summary: "Selected text:\nephemeral",
          },
          "这个词是什么意思",
        ),
      ),
    ).toEqual({
      evidence: "Selected text:\nephemeral",
      status: "ready",
    });
  });
});
