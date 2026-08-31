const visualReferencePatterns = [
  /(?:屏幕上|画面中|当前窗口|当前页面|桌面上|我.{0,4}(?:选中|高亮)|鼠标|光标|左上角|右上角|左下角|右下角)/u,
  /(?:这个|那个)(?:词|按钮|图标|数字|代码|图片|图表|区域|位置)/u,
  /(?:红|绿|蓝|黄|白|黑|紫|橙)色(?:按钮|图标|徽标|区域)/u,
  /\b(?:current (?:screen|window|page)|selected|highlighted|mouse|pointer|cursor)\b/iu,
  /\b(?:this|that) (?:button|icon|badge|word|line|code|image|chart|area)\b/iu,
  /\b(?:top|bottom)[ -]?(?:left|right)\b/iu,
];

export function explicitlyRequiresCurrentView(value: string): boolean {
  const text = value.trim();
  return text.length > 0 && visualReferencePatterns.some((pattern) => pattern.test(text));
}
