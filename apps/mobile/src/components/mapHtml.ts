// The map page shown inside a WebView (app) or an iframe (website): MapLibre GL JS with the
// OpenFreeMap "positron" style. It talks to the app with small JSON messages:
//   app -> map: {type:'center', lat, lon, zoom?} | {type:'me', lat, lon} | {type:'stops', stops}
//   map -> app: {type:'ready'} | {type:'moved', lat, lon, zoom} | {type:'stop', id}
// Loading MapLibre from a CDN keeps it out of the app bundle and works in Expo Go.

import { modeColors } from '../theme';

export const MAPLIBRE_VERSION = '5.24.0';
export const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';
export const MADRID = { lat: 40.4168, lon: -3.7038, zoom: 12 };
/** Stops are drawn from this zoom on (closer in there are too many to read). */
export const STOPS_MIN_ZOOM = 14;

export function mapHtml(labels: { departures: string; zoomIn: string }): string {
  const cdn = `https://unpkg.com/maplibre-gl@${MAPLIBRE_VERSION}/dist`;
  const colors = {
    rail: modeColors.rail.bg,
    metro: modeColors.metro.bg,
    light_rail: modeColors.light_rail.bg,
    bus: modeColors.bus.bg,
  };
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<link rel="stylesheet" href="${cdn}/maplibre-gl.css">
<script src="${cdn}/maplibre-gl.js"></script>
<style>
  html, body, #map { margin: 0; padding: 0; width: 100%; height: 100%; font-family: system-ui, sans-serif; }
  .maplibregl-popup-content { border-radius: 10px; padding: 10px 12px; }
  .pop-name { font-weight: 700; font-size: 15px; color: #16181D; margin-bottom: 6px; }
  .pop-btn { background: #0B3A82; color: #fff; border: 0; border-radius: 8px; padding: 7px 12px;
    font-size: 14px; font-weight: 600; cursor: pointer; }
  #hint { position: absolute; left: 50%; bottom: 28px; transform: translateX(-50%);
    background: rgba(22,24,29,0.78); color: #fff; font-size: 13px; padding: 6px 12px;
    border-radius: 999px; pointer-events: none; white-space: nowrap; }
  .me { width: 16px; height: 16px; border-radius: 50%; background: #1A73E8;
    border: 3px solid #fff; box-shadow: 0 0 0 6px rgba(26,115,232,0.25); }
</style>
</head><body>
<div id="map"></div>
<div id="hint">${escapeHtml(labels.zoomIn)}</div>
<script>
(function () {
  var COLORS = ${JSON.stringify(colors)};
  function send(msg) {
    var s = JSON.stringify(msg);
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(s);
    else if (window.parent !== window) window.parent.postMessage({ madridgoMap: s }, '*');
  }
  var map = new maplibregl.Map({
    container: 'map', style: '${MAP_STYLE}',
    center: [${MADRID.lon}, ${MADRID.lat}], zoom: ${MADRID.zoom},
    attributionControl: { compact: true }
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'bottom-right');
  var me = null, popup = null, hint = document.getElementById('hint');

  map.on('load', function () {
    map.addSource('stops', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'stops', type: 'circle', source: 'stops', paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 5, 17, 9],
      'circle-color': ['match', ['get', 'mode'],
        'rail', COLORS.rail, 'metro', COLORS.metro, 'light_rail', COLORS.light_rail, COLORS.bus],
      'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
    map.addLayer({ id: 'stop-names', type: 'symbol', source: 'stops', minzoom: 15.5, layout: {
      'text-field': ['get', 'name'], 'text-size': 12, 'text-offset': [0, 1.2], 'text-anchor': 'top',
      'text-font': ['Noto Sans Regular'], 'text-optional': true },
      paint: { 'text-color': '#16181D', 'text-halo-color': '#fff', 'text-halo-width': 1.5 } });
    map.on('click', 'stops', function (e) {
      var f = e.features && e.features[0]; if (!f) return;
      var div = document.createElement('div');
      var name = document.createElement('div'); name.className = 'pop-name';
      name.textContent = f.properties.name; div.appendChild(name);
      var btn = document.createElement('button'); btn.className = 'pop-btn';
      btn.textContent = ${JSON.stringify(labels.departures)};
      btn.onclick = function () { send({ type: 'stop', id: f.properties.id }); };
      div.appendChild(btn);
      if (popup) popup.remove();
      popup = new maplibregl.Popup({ offset: 10 }).setLngLat(f.geometry.coordinates).setDOMContent(div).addTo(map);
    });
    map.on('mouseenter', 'stops', function () { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'stops', function () { map.getCanvas().style.cursor = ''; });
    send({ type: 'ready' });
    moved();
  });

  function moved() {
    var c = map.getCenter(), z = map.getZoom();
    hint.style.display = z < ${STOPS_MIN_ZOOM} ? 'block' : 'none';
    send({ type: 'moved', lat: c.lat, lon: c.lng, zoom: z });
  }
  map.on('moveend', moved);

  window.madridgoMap = function (msg) {
    if (msg.type === 'center') {
      map.flyTo({ center: [msg.lon, msg.lat], zoom: msg.zoom || 16, speed: 1.6 });
    } else if (msg.type === 'me') {
      if (!me) {
        var el = document.createElement('div'); el.className = 'me';
        me = new maplibregl.Marker({ element: el });
      }
      me.setLngLat([msg.lon, msg.lat]).addTo(map);
    } else if (msg.type === 'stops') {
      var src = map.getSource('stops'); if (!src) return;
      src.setData({ type: 'FeatureCollection', features: msg.stops.map(function (s) {
        return { type: 'Feature', geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
          properties: { id: s.id, name: s.name, mode: s.mode } };
      }) });
    }
  };
  window.addEventListener('message', function (e) {
    if (e.data && typeof e.data.madridgoApp === 'string') window.madridgoMap(JSON.parse(e.data.madridgoApp));
  });
})();
</script>
</body></html>`;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
