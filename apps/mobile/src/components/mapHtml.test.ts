import { MAPLIBRE_SRI, MAPLIBRE_VERSION, mapHtml } from './mapHtml';

const labels = { departures: 'Departures', zoomIn: 'Zoom in' };

describe('mapHtml', () => {
  it('has an integrity hash for the pinned MapLibre version', () => {
    expect(MAPLIBRE_SRI[MAPLIBRE_VERSION]).toBeDefined();
  });

  it('loads MapLibre script and stylesheet with integrity checks', () => {
    const html = mapHtml(labels);
    const sri = MAPLIBRE_SRI[MAPLIBRE_VERSION];
    expect(html).toContain(`integrity="${sri.js}" crossorigin="anonymous"`);
    expect(html).toContain(`integrity="${sri.css}" crossorigin="anonymous"`);
    expect(html).not.toContain('integrity="undefined"');
    expect(html).toContain(`maplibre-gl@${MAPLIBRE_VERSION}/dist`);
  });
});
