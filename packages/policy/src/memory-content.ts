// Keep credential signatures aligned with the device's LocalContextPrivacy gate.
const absoluteSecrets = [
  /(?<![A-Za-z0-9])(?:[A-Za-z0-9]+[_-])*(?:password|passwd|token|secret|api[_-]?key|access[_-]?key)(?:[_-][A-Za-z0-9]+)*\s*(?:[:=：]|is\b|是|为)\s*\S+/i,
  /(?:密码|口令|验证码|私钥|访问密钥)\s*(?:是|为|[:=：])\s*\S+/u,
  /\bBearer\s+\S+/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|ak)-[A-Za-z0-9_-]{16,}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
];

const controlledSensitive = [
  /\b[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/,
  /\b(?:\d[ -]?){13,19}\b/,
  /身份证|护照|病历|诊断|病史|过敏|疾病|用药|药物|医疗|银行账户|银行卡|财务|收入|薪资|隐私/u,
  /服(?:用|食)[^。！？\n]{0,20}药|服药|吃药/u,
  /\b(passport|medical|diagnosis|allerg(?:y|ies|ic)|medication|health condition|bank account|salary|income|private information)\b/i,
];

export type MemoryContentClassification = "secret" | "controlled" | "normal";

export function classifyMemoryContent(content: string): MemoryContentClassification {
  const normalized = content.normalize("NFKC");
  if (absoluteSecrets.some((pattern) => pattern.test(normalized))) {
    return "secret";
  }
  return controlledSensitive.some((pattern) => pattern.test(normalized)) ? "controlled" : "normal";
}

export class MemorySecretError extends Error {
  constructor() {
    super("Violet cannot store credentials or absolute secrets");
    this.name = "MemorySecretError";
  }
}

export function assertMemoryContentAllowed(content: string): void {
  if (classifyMemoryContent(content) === "secret") {
    throw new MemorySecretError();
  }
}
