const PATTERNS: Array<[RegExp, string]> = [
  [/sk-ant-[A-Za-z0-9_-]{10,}/g, 'sk-ant-***'],
  [/sk-[A-Za-z0-9]{20,}/g, 'sk-***'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, 'gh*_***'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_***'],
  [/AKIA[0-9A-Z]{16}/g, 'AKIA***'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, 'xox*-***'],
  [/lin_api_[A-Za-z0-9]{10,}/g, 'lin_api_***'],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, '$1***'],
  [/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g, '$1***$2'],
  [/((?:api[_-]?key|token|secret|password|passwd|pwd|authorization)\s*[=:]\s*["']?)([^\s"'&,;]{6,})/gi, '$1***'],
  [/(https?:\/\/[^\s:@/]+:)[^\s@/]+(@)/g, '$1***$2'],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v);
    return out as T;
  }
  return value;
}
