import type { ResolvedContext } from "@violet/domain";

export function formatVisualResult(context: ResolvedContext, question: string): string {
  if (!context.answer) {
    return context.summary.includes("Selected text:")
      ? JSON.stringify({
          evidence: context.summary,
          status: "ready",
        })
      : unavailable("The current view could not be understood reliably.");
  }
  if ((context.confidence ?? 0) < 0.7) {
    return unavailable("The visual model could not locate the requested target reliably.");
  }

  const targetRequired =
    /(?:鼠标|光标|按钮|图标|徽标|选中|高亮|pointer|cursor|button|icon|badge|selected|highlighted)/iu.test(
      question,
    );
  if (targetRequired && !context.target?.bounds) {
    return unavailable("The visual answer did not include a verifiable target location.");
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
