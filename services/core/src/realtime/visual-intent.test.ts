import { describe, expect, it } from "vitest";

import { explicitlyRequiresCurrentView } from "./visual-intent.js";

describe("explicitlyRequiresCurrentView", () => {
  it("detects explicit visual references", () => {
    expect(explicitlyRequiresCurrentView("我鼠标位置的 33 是什么意思")).toBe(true);
    expect(explicitlyRequiresCurrentView("右下角绿色按钮有什么作用")).toBe(true);
    expect(explicitlyRequiresCurrentView("What does this selected line mean?")).toBe(true);
  });

  it("does not route ordinary conversation to screen capture", () => {
    expect(explicitlyRequiresCurrentView("给我解释一下闭包是什么")).toBe(false);
    expect(explicitlyRequiresCurrentView("今天天气怎么样")).toBe(false);
  });
});
