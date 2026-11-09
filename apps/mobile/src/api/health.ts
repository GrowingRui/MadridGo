// Client for the backend /health endpoint.
// The app never talks to transport data providers directly: everything goes through the backend.

export type CheckStatus = 'ok' | 'error';

export interface CheckResult {
  status: CheckStatus;
  latency_ms: number | null;
  detail: string | null;
}

export interface HealthResponse {
  status: CheckStatus;
  version: string;
  environment: string;
  checked_at: string;
  checks: Record<string, CheckResult>;
}

export type HealthOutcome =
  | { kind: 'healthy'; health: HealthResponse }
  | { kind: 'degraded'; health: HealthResponse }
  | { kind: 'unreachable'; reason: string };

export const DEFAULT_TIMEOUT_MS = 5000;

export function getApiBaseUrl(): string {
  // EXPO_PUBLIC_* values are inlined into the bundle and are public: never put secrets there.
  const url = process.env.EXPO_PUBLIC_API_URL ?? 'http://127.0.0.1:8000';
  return url.replace(/\/+$/, '');
}

function isCheckResult(value: unknown): value is CheckResult {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.status === 'ok' || v.status === 'error';
}

export function parseHealth(body: unknown): HealthResponse | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (b.status !== 'ok' && b.status !== 'error') return null;
  if (typeof b.version !== 'string' || typeof b.checked_at !== 'string') return null;
  if (typeof b.checks !== 'object' || b.checks === null) return null;
  const checks = b.checks as Record<string, unknown>;
  if (!Object.values(checks).every(isCheckResult)) return null;
  return {
    status: b.status,
    version: b.version,
    environment: typeof b.environment === 'string' ? b.environment : 'unknown',
    checked_at: b.checked_at,
    checks: checks as Record<string, CheckResult>,
  };
}

export async function fetchHealth(
  baseUrl: string = getApiBaseUrl(),
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
): Promise<HealthOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // The backend returns 503 with a valid body when a dependency is down, so parse both.
    const res = await fetchImpl(`${baseUrl}/health`, { signal: controller.signal });
    const health = parseHealth(await res.json().catch(() => null));
    if (!health) return { kind: 'unreachable', reason: `Unexpected response (HTTP ${res.status})` };
    return health.status === 'ok' ? { kind: 'healthy', health } : { kind: 'degraded', health };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return {
      kind: 'unreachable',
      reason: aborted ? `No response within ${timeoutMs / 1000}s` : 'Cannot reach the server',
    };
  } finally {
    clearTimeout(timer);
  }
}
