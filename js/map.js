/* global maplibregl */

// Kaart in tabletop-stijl: perkamentkleuren, gekanteld beeld en 3D-gebouwen.

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const C = { paper: '#ead9b0', land: '#e2d1a5', green: '#c3cb92', water: '#9cb9b4', build: '#d3bd8e', road: '#f8eed3', casing: '#a88f5f', ink: '#5a4226', halo: '#f2e5c2' };

const RASTER = {
  version: 8,
  sources: { osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, attribution: '© OpenStreetMap' } },
  layers: [{ id: 'osm', type: 'raster', source: 'osm', paint: { 'raster-saturation': -0.7, 'raster-hue-rotate': 15, 'raster-contrast': -0.1 } }],
};

let styleP;
function tabletopStyle() {
  return styleP || (styleP = (async () => {
    try {
      const s = await (await fetch(STYLE_URL)).json();
      s.layers = s.layers.filter(l => !['boundary', 'aeroway', 'poi', 'aerodrome_label'].includes(l['source-layer']));
      for (const l of s.layers) {
        const sl = l['source-layer'] || '', p = (l.paint = l.paint || {});
        if (l.type === 'background') p['background-color'] = C.paper;
        else if (l.type === 'fill') {
          delete p['fill-pattern'];
          p['fill-color'] = sl === 'water' ? C.water : sl === 'building' ? C.build : (sl === 'park' || sl === 'landcover') ? C.green : C.land;
          if (sl === 'building') p['fill-outline-color'] = C.casing;
        } else if (l.type === 'line') {
          delete p['line-pattern'];
          p['line-color'] = (sl === 'waterway' || sl === 'water') ? C.water : /casing|outline/.test(l.id) ? C.casing : sl === 'transportation' ? C.road : C.casing;
        } else if (l.type === 'symbol') {
          p['text-color'] = C.ink; p['text-halo-color'] = C.halo; p['text-halo-width'] = 1.4;
        } else if (l.type === 'fill-extrusion') {
          p['fill-extrusion-color'] = C.build; p['fill-extrusion-opacity'] = 0.9;
        }
      }
      return s;
    } catch (e) { console.warn('Kaartstijl niet geladen, terugval op OSM-tegels', e); return RASTER; }
  })());
}

const fc = features => ({ type: 'FeatureCollection', features });

function circle(center, radius, n = 72) {
  const kx = 111320 * Math.cos(center.lat * Math.PI / 180), ky = 110540, pts = [];
  for (let i = 0; i <= n; i++) { const a = 2 * Math.PI * i / n; pts.push([center.lng + radius * Math.cos(a) / kx, center.lat + radius * Math.sin(a) / ky]); }
  return pts;
}

export async function makeMap(el, { center, onZone, flat = false }) {
  const style = structuredClone(await tabletopStyle());
  const view = { pitch: flat ? 0 : 52, bearing: flat ? 0 : -14 };
  const map = new maplibregl.Map({ container: el, style, center: [center.lng, center.lat], zoom: 14, ...view, maxPitch: 70, attributionControl: { compact: true } });
  await new Promise(r => map.once('load', r));

  el.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
  const before = map.getStyle()?.layers?.find(l => l.type === 'fill-extrusion')?.id;
  map.addSource('zones', { type: 'geojson', data: fc([]) });
  map.addSource('ring', { type: 'geojson', data: fc([]) });
  map.addLayer({ id: 'zfill', type: 'fill', source: 'zones', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['get', 'op'] } }, before);
  map.addLayer({ id: 'zline', type: 'line', source: 'zones', layout: { 'line-join': 'round' }, paint: { 'line-color': '#3b2a17', 'line-width': 2.4, 'line-opacity': 0.8 } }, before);
  map.addLayer({ id: 'zsel', type: 'line', source: 'zones', filter: ['==', ['get', 'id'], ''], layout: { 'line-join': 'round' }, paint: { 'line-color': '#fffbe8', 'line-width': 5 } }, before);
  map.addLayer({ id: 'ring', type: 'line', source: 'ring', paint: { 'line-color': '#7a2b22', 'line-width': 3, 'line-dasharray': [2, 2] } });
  if (onZone) map.on('click', 'zfill', e => onZone(e.features[0].properties.id));

  const chips = {}, groups = {};
  return {
    map,
    fit(c, radius) {
      const px = Math.min(el.clientWidth, el.clientHeight) || 360;
      const zoom = Math.log2(156543.03 * Math.cos(c.lat * Math.PI / 180) * px / (radius * 2.25)) - 1; // -1: tegels van 512 px
      map.jumpTo({ center: [c.lng, c.lat], zoom, ...view });
    },
    setRing(c, radius) { map.getSource('ring').setData(fc([{ type: 'Feature', geometry: { type: 'LineString', coordinates: circle(c, radius) }, properties: {} }])); },
    setZones(list, sel) {
      map.getSource('zones').setData(fc(list.map(z => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [z.poly] }, properties: { id: z.id, color: z.color, op: z.op } }))));
      map.setFilter('zsel', ['==', ['get', 'id'], sel || '']);
    },
    setChips(list) {
      for (const c of list) {
        let ch = chips[c.id];
        if (!ch) {
          const outer = document.createElement('div'), inner = document.createElement('div');
          outer.appendChild(inner);
          outer.addEventListener('click', e => { e.stopPropagation(); onZone?.(c.id); });
          ch = chips[c.id] = { inner, html: '' };
          new maplibregl.Marker({ element: outer }).setLngLat([c.lng, c.lat]).addTo(map);
        }
        if (ch.html !== c.html + c.cls) { ch.html = c.html + c.cls; ch.inner.className = 'zchip ' + c.cls; ch.inner.style.setProperty('--c', c.color); ch.inner.innerHTML = c.html; }
      }
    },
    setMarkers(group, list) {
      (groups[group] || []).forEach(m => m.remove());
      groups[group] = list.map(it => {
        const outer = document.createElement('div'); outer.innerHTML = it.html;
        return new maplibregl.Marker({ element: outer, anchor: it.anchor || 'center' }).setLngLat([it.lng, it.lat]).addTo(map);
      });
    },
    remove() { map.remove(); },
  };
}
