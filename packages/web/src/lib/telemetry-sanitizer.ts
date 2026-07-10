// packages/web/src/lib/telemetry-sanitizer.ts

const SAFE_TELEMETRY_KEYS = [
  'platform',
  'reason',
  'href',
  'timestamp',
  'extensionVersion',
  'selector',
  'tier',
  'strategy',
  'event',
  'detail',
  'sessionMessageCount',
];

export function sanitizeTelemetry(data: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const key of SAFE_TELEMETRY_KEYS) {
    if (data[key] !== undefined) {
      sanitized[key] = data[key];
    }
  }
  return sanitized;
}

