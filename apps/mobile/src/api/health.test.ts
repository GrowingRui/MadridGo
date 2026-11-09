import { fetchHealth, parseHealth } from './health';

const okBody = {
  status: 'ok',
  version: '0.1.0',
  environment: 'development',
  checked_at: '2026-11-09T14:41:15Z',
  checks: {
    database: { status: 'ok', latency_ms: 14.1, detail: 'postgis 3.5.2' },
    redis: { status: 'ok', latency_ms: 1.7, detail: null },
  },
};

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    ({
      status,
      json: async () => body,
    }) as Response) as unknown as typeof fetch;
}

describe('parseHealth', () => {
  it('accepts a valid body', () => {
    expect(parseHealth(okBody)?.checks.database.detail).toBe('postgis 3.5.2');
  });

  it.each([
    null,
    'text',
    {},
    { ...okBody, status: 'great' },
    { ...okBody, checks: { db: { status: 'maybe' } } },
  ])('rejects malformed body %#', (body) => {
    expect(parseHealth(body)).toBeNull();
  });
});

describe('fetchHealth', () => {
  it('reports healthy on 200 ok', async () => {
    const out = await fetchHealth('http://x', 1000, fakeFetch(200, okBody));
    expect(out.kind).toBe('healthy');
  });

  it('reports degraded on 503 with a valid body', async () => {
    const body = {
      ...okBody,
      status: 'error',
      checks: { redis: { status: 'error', latency_ms: null, detail: 'down' } },
    };
    const out = await fetchHealth('http://x', 1000, fakeFetch(503, body));
    expect(out.kind).toBe('degraded');
  });

  it('reports unreachable on network error', async () => {
    const failing = (async () => {
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch;
    const out = await fetchHealth('http://x', 1000, failing);
    expect(out).toEqual({ kind: 'unreachable', reason: 'Cannot reach the server' });
  });

  it('reports unreachable on timeout', async () => {
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      })) as unknown as typeof fetch;
    const out = await fetchHealth('http://x', 20, hanging);
    expect(out).toEqual({ kind: 'unreachable', reason: 'No response within 0.02s' });
  });

  it('reports unreachable on an unexpected body', async () => {
    const out = await fetchHealth('http://x', 1000, fakeFetch(502, '<html>bad gateway</html>'));
    expect(out).toEqual({ kind: 'unreachable', reason: 'Unexpected response (HTTP 502)' });
  });
});
