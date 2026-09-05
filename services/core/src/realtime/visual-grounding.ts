import type { NormalizedPoint, ResolvedContext } from "@violet/domain";

export function formatVisualResult(
  context: ResolvedContext,
  question: string,
  focusPoint?: NormalizedPoint,
): string {
  if (!context.answer) {
    return context.summary.includes("Selected text:")
      ? JSON.stringify({
          evidence: context.summary,
          status: "ready",
        })
      : unavailable("The current view could not be understood reliably.");
  }
  if (!focusPoint) {
    return unavailable("The captured visual context did not include a pointer.");
  }
  if ((context.confidence ?? 0) < 0.7) {
    return unavailable("The visual model could not locate the requested target reliably.");
  }

  if (!context.target?.bounds) {
    return unavailable("The visual answer did not include a target for the captured pointer.");
  }
  if (isArtificialPointerTarget(context.target.kind)) {
    return unavailable("The visual model identified the pointer annotation instead of its target.");
  }
  if (
    isSelectionQuestion(question) &&
    (!isTextTarget(context.target.kind) || !context.target.text?.trim())
  ) {
    return unavailable("The visual model did not return the selected text as evidence.");
  }
  if (!containsPoint(context.target.bounds, focusPoint)) {
    return unavailable("The located target does not contain the captured pointer.");
  }
  if (context.target?.bounds && !matchesPosition(question, context.target.bounds)) {
    return unavailable("The located target does not match the requested screen position.");
  }
  if (!matchesColor(question, context.target?.color)) {
    return unavailable("The located target does not match the requested color.");
  }

  return JSON.stringify({
    answer: context.answer,
    confidence: context.confidence,
    status: "ready",
    ...(context.target ? { target: context.target } : {}),
  });
}

function isArtificialPointerTarget(kind: string): boolean {
  return /(?:pointer|cursor|marker|annotation|ring|指针|光标|定位环|标记|注释)/iu.test(kind);
}

function isSelectionQuestion(question: string): boolean {
  return (
    /选区|(?:(?:选中|框选|高亮|选的).{0,8}(?:内容|文字|文本|代码|单词|词语|段落|命令|行)|(?:内容|文字|文本|代码|单词|词语|段落|命令|行).{0,8}(?:选中|框选|高亮))/u.test(
      question,
    ) ||
    /\bselection\b|(?:\b(?:selected|highlighted)\s+(?:content|text|code|word|paragraph|command|line)\b)|(?:\b(?:content|text|code|word|paragraph|command|line)\b.{0,24}\bselected\b)/iu.test(
      question,
    )
  );
}

function isTextTarget(kind: string): boolean {
  return ["text-selection", "text", "code-block"].includes(kind.trim().toLowerCase());
}

function containsPoint(
  bounds: {
    readonly height: number;
    readonly width: number;
    readonly x: number;
    readonly y: number;
  },
  point: NormalizedPoint,
): boolean {
  return (
    point.x >= bounds.x &&
    point.x <= bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y <= bounds.y + bounds.height
  );
}

function matchesPosition(
  question: string,
  bounds: {
    readonly height: number;
    readonly width: number;
    readonly x: number;
    readonly y: number;
  },
): boolean {
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  const expectsLeft = /(?:左(?:侧|边|上|下)|\bleft\b)/iu.test(question);
  const expectsRight = /(?:右(?:侧|边|上|下)|\bright\b)/iu.test(question);
  const expectsTop = /(?:(?:左|右)上|顶部|上方|\btop\b)/iu.test(question);
  const expectsBottom = /(?:(?:左|右)下|底部|下方|\bbottom\b)/iu.test(question);
  return (
    (!expectsLeft || centerX < 0.5) &&
    (!expectsRight || centerX >= 0.5) &&
    (!expectsTop || centerY < 0.5) &&
    (!expectsBottom || centerY >= 0.5)
  );
}

function matchesColor(question: string, observed?: string): boolean {
  const expected = colorMention(question);
  if (!expected) {
    return true;
  }
  if (!observed) {
    return false;
  }
  return colorMention(observed) === expected;
}

function colorMention(value: string): string | undefined {
  const colors: readonly (readonly [RegExp, string])[] = [
    [/(?:绿色|绿|green)/iu, "green"],
    [/(?:红色|红|red)/iu, "red"],
    [/(?:蓝色|蓝|blue)/iu, "blue"],
    [/(?:黄色|黄|yellow)/iu, "yellow"],
    [/(?:白色|白|white)/iu, "white"],
    [/(?:黑色|黑|black)/iu, "black"],
    [/(?:紫色|紫|purple)/iu, "purple"],
    [/(?:橙色|橙|orange)/iu, "orange"],
  ];
  return colors.find(([pattern]) => pattern.test(value))?.[1];
}

function unavailable(message: string): string {
  return JSON.stringify({ message, status: "unavailable" });
}
