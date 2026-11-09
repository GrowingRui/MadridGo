// Small fetch wrapper: base URL, timeout and typed errors. The app only talks to the MadridGo
// backend; it never calls transport providers directly.

import { getApiBaseUrl } from './health';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function getJson<T>(
  path: string,
  params: Record<string, string | number | undefined> = {},
  timeoutMs = 8000,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const query = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  const url = `${getApiBaseUrl()}${path}${query ? `?${query}` : ''}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { detail?: unknown } | null;
      const detail = typeof body?.detail === 'string' ? body.detail : `HTTP ${res.status}`;
      throw new ApiError(detail, res.status);
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const aborted = err instanceof Error && err.name === 'AbortError';
    throw new ApiError(
      aborted ? 'The server took too long to answer' : 'Cannot reach MadridGo',
      null,
    );
  } finally {
    clearTimeout(timer);
  }
}
