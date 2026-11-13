// Small fetch wrapper: base URL, timeout and typed errors. The app only talks to the MadridGo
// backend; it never calls transport providers directly.

import { currentLang, t } from '../i18n';
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
  params: Record<string, string | number | readonly string[] | undefined> = {},
  timeoutMs = 8000,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  // A list is sent as the same name repeated (?avoid=a&avoid=b), as FastAPI reads it.
  const query = Object.entries(params)
    .flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x] as const) : [[k, v] as const]))
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  const url = `${getApiBaseUrl()}${path}${query ? `?${query}` : ''}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // The server writes its messages (notices, live data status) in the app's language.
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { 'Accept-Language': currentLang() },
    });
    if (!res.ok) {
      // The server's own detail is for developers (English); the user gets a translated line.
      throw new ApiError(t('error.server', { status: res.status }), res.status);
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const aborted = err instanceof Error && err.name === 'AbortError';
    throw new ApiError(aborted ? t('error.timeout') : t('error.unreachable'), null);
  } finally {
    clearTimeout(timer);
  }
}
