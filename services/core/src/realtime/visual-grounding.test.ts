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
    expect(
      JSON.parse(
        formatVisualResult(grounded, "右下角绿色按钮有什么作用", {
          x: 0.96,
          y: 0.95,
        }),
      ),
    ).toMatchObject({
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
          { x: 0.11, y: 0.11 },
        ),
      ),
    ).toMatchObject({ status: "unavailable" });
  });

  it("rejects a visual answer without a captured pointer", () => {
    expect(JSON.parse(formatVisualResult(grounded, "这个按钮有什么作用"))).toMatchObject({
      status: "unavailable",
    });
  });

  it("accepts a target whose bounds contain the captured pointer", () => {
    expect(
      JSON.parse(
        formatVisualResult(grounded, "这个按钮有什么作用", {
          x: 0.96,
          y: 0.95,
        }),
      ),
    ).toMatchObject({ status: "ready" });
  });

  it("rejects a target whose bounds do not contain the captured pointer", () => {
    expect(
      JSON.parse(
        formatVisualResult(grounded, "这个按钮有什么作用", {
          x: 0.1,
          y: 0.1,
        }),
      ),
    ).toMatchObject({ status: "unavailable" });
  });

  it("rejects an ungrounded answer when a pointer was captured", () => {
    expect(
      JSON.parse(
        formatVisualResult(
          {
            ...grounded,
            target: {
              kind: "button",
            },
          },
          "这个按钮有什么作用",
          { x: 0.96, y: 0.95 },
        ),
      ),
    ).toMatchObject({ status: "unavailable" });
  });

  it("rejects an artificial pointer marker as the semantic target", () => {
    expect(
      JSON.parse(
        formatVisualResult(
          {
            ...grounded,
            target: {
              bounds: { height: 0.1, width: 0.1, x: 0.45, y: 0.45 },
              kind: "pointer-marker",
            },
          },
          "这个是什么？",
          { x: 0.5, y: 0.5 },
        ),
      ),
    ).toMatchObject({ status: "unavailable" });
  });

  it("rejects a non-text target for a selection question", () => {
    expect(
      JSON.parse(
        formatVisualResult(
          {
            ...grounded,
            target: {
              bounds: { height: 0.1, width: 0.4, x: 0.1, y: 0.7 },
              kind: "button",
              text: "pkill -x Violet",
            },
          },
          "我框选的内容是什么？",
          { x: 0.25, y: 0.75 },
        ),
      ),
    ).toMatchObject({ status: "unavailable" });
  });

  it("requires transcribed text for a selection question", () => {
    expect(
      JSON.parse(
        formatVisualResult(
          {
            ...grounded,
            target: {
              bounds: { height: 0.1, width: 0.4, x: 0.1, y: 0.7 },
              kind: "text-selection",
            },
          },
          "我选中的代码是什么意思？",
          { x: 0.25, y: 0.75 },
        ),
      ),
    ).toMatchObject({ status: "unavailable" });
  });

  it("accepts transcribed text evidence for a selection question", () => {
    expect(
      JSON.parse(
        formatVisualResult(
          {
            ...grounded,
            target: {
              bounds: { height: 0.1, width: 0.4, x: 0.1, y: 0.7 },
              kind: "code-block",
              text: "pkill -x Violet",
            },
          },
          "我选中的代码是什么意思？",
          { x: 0.25, y: 0.75 },
        ),
      ),
    ).toMatchObject({ status: "ready" });
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
