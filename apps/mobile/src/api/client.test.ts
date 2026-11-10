import { setLanguageForTests } from '../i18n';
import { ApiError, getJson } from './client';

const json = (status: number, body: unknown) =>
  Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) } as Response);

describe('getJson', () => {
  it('builds the query string and skips empty params', async () => {
    const fetchImpl = jest.fn(() => json(200, [{ id: 'x' }]));
    const data = await getJson(
      '/stops/search',
      { q: 'plaza castilla', limit: 5, x: '' },
      1000,
      fetchImpl,
    );
    expect(data).toEqual([{ id: 'x' }]);
    const url = (fetchImpl.mock.calls[0] as unknown[])[0] as string;
    expect(url).toMatch(/\/stops\/search\?q=plaza%20castilla&limit=5$/);
  });

  it('reports server errors in the app language, not the server detail', async () => {
    const fetchImpl = jest.fn(() => json(404, { detail: 'Stop not found' }));
    await expect(getJson('/stops/nope', {}, 1000, fetchImpl)).rejects.toEqual(
      new ApiError('The server could not answer this request (HTTP 404).', 404),
    );
  });

  it('asks the server for messages in the app language', async () => {
    const fetchImpl = jest.fn(() => json(200, []));
    await getJson('/feeds', {}, 1000, fetchImpl);
    setLanguageForTests('es');
    await getJson('/feeds', {}, 1000, fetchImpl);
    setLanguageForTests('en');
    const headers = fetchImpl.mock.calls.map(
      (c) => ((c as unknown[])[1] as RequestInit).headers as Record<string, string>,
    );
    expect(headers.map((h) => h['Accept-Language'])).toEqual(['en', 'es']);
  });

  it('reports network failures without leaking internals', async () => {
    const fetchImpl = jest.fn(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(getJson('/feeds', {}, 1000, fetchImpl)).rejects.toMatchObject({
      message: 'Cannot reach MadridGo',
      status: null,
    });
  });
});
