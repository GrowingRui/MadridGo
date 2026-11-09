import { planJourneys } from './journeys';

const ok = (body: unknown) =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);

const url = (fetchImpl: jest.Mock) => (fetchImpl.mock.calls[0] as unknown[])[0] as string;

describe('planJourneys', () => {
  it('asks for journeys between two stops at a time', async () => {
    const fetchImpl = jest.fn(() => ok({ journeys: [] }));
    await planJourneys(
      { from: 'crtm:par_8_16825', to: 'renfe:18000', at: Date.parse('2026-11-09T19:00:00Z') },
      fetchImpl,
    );
    expect(url(fetchImpl)).toMatch(
      /\/journeys\?from=crtm%3Apar_8_16825&to=renfe%3A18000&at=2026-11-09T19%3A00%3A00\.000Z$/,
    );
  });

  it('leaves out the time for "now" and when paging with a cursor', async () => {
    const now = jest.fn(() => ok({ journeys: [] }));
    await planJourneys({ from: 'a', to: 'b', at: null }, now);
    expect(url(now)).toMatch(/\/journeys\?from=a&to=b$/);

    const paged = jest.fn(() => ok({ journeys: [] }));
    await planJourneys({ from: 'a', to: 'b', at: 1, cursor: 'a:XYZ=', sort: 'fastest' }, paged);
    expect(url(paged)).toMatch(/\/journeys\?from=a&to=b&sort=fastest&cursor=a%3AXYZ%3D$/);
  });
});
