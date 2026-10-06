import { Delaunay } from 'https://cdn.jsdelivr.net/npm/d3-delaunay@6/+esm';

// Verdeelt een cirkel rond het centrum in zones: organische (Voronoi) gebieden
// waarvan de kernen op echte plekken liggen en de grenzen langs echte straten lopen.

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const RIM_N = 64;

export function dist(a, b) { // meter tussen twee {lat,lng}
  const kx = 111320 * Math.cos(a.lat * Math.PI / 180), ky = 110540;
  return Math.hypot((a.lng - b.lng) * kx, (a.lat - b.lat) * ky);
}

function makeProj(c) {
  const kx = 111320 * Math.cos(c.lat * Math.PI / 180), ky = 110540;
  return {
    to: (lng, lat) => [(lng - c.lng) * kx, (lat - c.lat) * ky],
    from: ([x, y]) => [+(c.lng + x / kx).toFixed(5), +(c.lat + y / ky).toFixed(5)],
  };
}

function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

async function fetchOsm(c, R) {
  const a = `(around:${Math.round(R + 80)},${c.lat},${c.lng})`;
  const q = `[out:json][timeout:20];
way["highway"~"^(primary|secondary|tertiary|residential|unclassified|pedestrian|living_street)$"]${a};
out geom;
(
  node["place"~"^(neighbourhood|quarter|suburb|square)$"]["name"]${a};
  way["place"="square"]["name"]${a};
  nwr["leisure"="park"]["name"]${a};
  nwr["amenity"~"^(place_of_worship|townhall|theatre|library|university|marketplace)$"]["name"]${a};
  nwr["tourism"~"^(attraction|museum)$"]["name"]${a};
  nwr["historic"~"^(castle|monument|city_gate|tower|fort|ruins|church|monastery)$"]["name"]${a};
  nwr["railway"="station"]["name"]${a};
);
out center tags;`;
  let last;
  for (const url of OVERPASS) {
    try {
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 15000);
      const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), signal: ctl.signal });
      clearTimeout(to);
      if (!r.ok) throw new Error('Overpass ' + r.status);
      return await r.json();
    } catch (e) { last = e; console.warn(url, e); }
  }
  throw last;
}

function parseOsm(osm, proj) {
  const nodes = new Map(), roads = [], pois = [];
  const node = (id, g) => {
    let n = nodes.get(id);
    if (!n) { const [x, y] = proj.to(g.lon, g.lat); n = { id, x, y, adj: [] }; nodes.set(id, n); }
    return n;
  };
  for (const e of osm?.elements || []) {
    const t = e.tags || {};
    if (e.type === 'way' && t.highway && e.geometry && e.nodes) {
      let prev = null;
      e.nodes.forEach((id, i) => {
        const g = e.geometry[i]; if (!g) { prev = null; return; }
        const n = node(id, g);
        if (prev) { const d = Math.hypot(n.x - prev.x, n.y - prev.y); prev.adj.push([n, d]); n.adj.push([prev, d]); }
        prev = n;
      });
      if (t.name) { const g = e.geometry[e.geometry.length >> 1]; const [x, y] = proj.to(g.lon, g.lat); roads.push({ name: t.name, x, y }); }
    } else if (t.name) {
      const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
      if (lat == null) continue;
      const [x, y] = proj.to(lon, lat);
      pois.push({ name: t.name, x, y });
    }
  }
  return { nodes: [...nodes.values()], roads, pois };
}

function pickSeeds(count, R, pois, rand) {
  const cands = pois.filter(p => Math.hypot(p.x, p.y) < R * 0.82).map(p => ({ ...p, poi: true }));
  for (let i = 0; i < 600; i++) {
    const r = R * 0.86 * Math.sqrt(rand()), a = rand() * 2 * Math.PI;
    cands.push({ x: r * Math.cos(a), y: r * Math.sin(a) });
  }
  let first = cands.filter(c => c.poi).sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y))[0] || { x: 0, y: 0 };
  const seeds = [first];
  const md = cands.map(c => Math.hypot(c.x - first.x, c.y - first.y));
  while (seeds.length < count) {
    let bi = 0, bs = -1;
    cands.forEach((c, i) => { const s = md[i] * (c.poi ? 1.3 : 1); if (s > bs) { bs = s; bi = i; } });
    const s = cands[bi]; seeds.push(s);
    cands.forEach((c, i) => { md[i] = Math.min(md[i], Math.hypot(c.x - s.x, c.y - s.y)); });
  }
  return seeds;
}

function clipToCircle(poly, R) {
  let out = poly;
  for (let i = 0; i < RIM_N && out.length; i++) {
    const a1 = 2 * Math.PI * i / RIM_N, a2 = 2 * Math.PI * (i + 1) / RIM_N;
    const ax = R * Math.cos(a1), ay = R * Math.sin(a1), bx = R * Math.cos(a2), by = R * Math.sin(a2);
    const side = p => (bx - ax) * (p[1] - ay) - (by - ay) * (p[0] - ax); // >=0 is binnen (cirkel loopt tegenwijzerzin)
    const res = [];
    for (let j = 0; j < out.length; j++) {
      const p = out[j], q = out[(j + 1) % out.length], sp = side(p), sq = side(q);
      if (sp >= 0) res.push(p);
      if ((sp >= 0) !== (sq >= 0)) { const k = sp / (sp - sq); res.push([p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k]); }
    }
    out = res;
  }
  return out;
}

function route(a, b, maxLen) { // Dijkstra over het stratennet
  const distTo = new Map([[a, 0]]), prev = new Map(), heap = [[0, a]];
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last; let i = 0;
      for (;;) { let l = 2 * i + 1, r = l + 1, m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[i], heap[m]] = [heap[m], heap[i]]; i = m; }
    }
    return top;
  };
  const push = it => { heap.push(it); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[i], heap[p]] = [heap[p], heap[i]]; i = p; } };
  while (heap.length) {
    const [d, n] = pop();
    if (n === b) { const path = []; for (let c = b; c; c = prev.get(c)) path.push([c.x, c.y]); return path.reverse(); }
    if (d > distTo.get(n) || d > maxLen) continue;
    for (const [m, w] of n.adj) { const nd = d + w; if (nd < (distTo.get(m) ?? Infinity)) { distTo.set(m, nd); prev.set(m, n); push([nd, m]); } }
  }
  return null;
}

export async function generateZones(center, radius, count) {
  const proj = makeProj(center), R = radius;
  let osm = null;
  try { osm = await fetchOsm(center, R); } catch (e) { console.warn('Geen straatdata, zones worden puur organisch', e); }
  const { nodes, roads, pois } = parseOsm(osm, proj);
  const rand = rng(Math.round(center.lat * 1e4) ^ Math.round(center.lng * 1e4) ^ (count * 7919));
  const seeds = pickSeeds(count, R, pois, rand);
  const vor = Delaunay.from(seeds.map(s => [s.x, s.y])).voronoi([-R - 1, -R - 1, R + 1, R + 1]);

  // Hoekpunten: gedeeld tussen buurzones, en waar mogelijk vastgeklikt op een kruispunt.
  const rimR = R * Math.cos(Math.PI / RIM_N) - 1;
  const verts = new Map();
  const vert = p => {
    const key = Math.round(p[0] * 5) + ',' + Math.round(p[1] * 5);
    let v = verts.get(key);
    if (!v) {
      v = { key, p, rim: Math.hypot(p[0], p[1]) >= rimR, node: null };
      let bd = v.rim ? 90 : 160;
      for (const n of nodes) { const d = Math.hypot(n.x - p[0], n.y - p[1]); if (d < bd && Math.hypot(n.x, n.y) < R) { bd = d; v.node = n; } }
      verts.set(key, v);
    }
    return v;
  };
  const pos = v => (v.node && !v.rim ? [v.node.x, v.node.y] : v.p);
  const edges = new Map();
  const edge = (a, b) => {
    if (a.key > b.key) return edge(b, a).slice().reverse();
    const k = a.key + '|' + b.key;
    if (edges.has(k)) return edges.get(k);
    let path;
    if (a.rim && b.rim) path = [a.p, b.p];
    else {
      const A = a.node ? [a.node.x, a.node.y] : a.p, B = b.node ? [b.node.x, b.node.y] : b.p;
      const straight = Math.hypot(A[0] - B[0], A[1] - B[1]);
      const mid = (a.node && b.node && a.node !== b.node && route(a.node, b.node, straight * 2 + 80)) || [A, B];
      path = [...(a.rim && a.node ? [a.p] : []), ...mid, ...(b.rim && b.node ? [b.p] : [])];
    }
    edges.set(k, path);
    return path;
  };

  const used = new Set();
  const zones = seeds.map((s, i) => {
    const cell = vor.cellPolygon(i);
    const raw = cell ? clipToCircle(cell.slice(0, -1), R) : [];
    const vs = raw.map(vert).filter((v, j, arr) => v !== arr[(j + 1) % arr.length]);
    let pts = [];
    vs.forEach((v, j) => { pts.push(...edge(v, vs[(j + 1) % vs.length])); });
    pts = pts.filter((p, j) => { const q = pts[(j + 1) % pts.length]; return Math.hypot(p[0] - q[0], p[1] - q[1]) > 3; });
    if (pts.length < 3) pts = raw.length >= 3 ? raw : vs.map(pos);

    let name = s.poi ? s.name : null;
    if (!name || used.has(name)) {
      name = roads.map(r => ({ r, d: Math.hypot(r.x - s.x, r.y - s.y) })).sort((a, b) => a.d - b.d).find(o => !used.has(o.r.name) && o.d < R / 2)?.r.name;
    }
    if (!name) name = 'Zone ' + (i + 1);
    used.add(name);
    const ring = pts.map(proj.from); ring.push(ring[0]);
    return { id: 'z' + i, name, poly: ring, c: proj.from([s.x, s.y]) };
  });
  return { zones, osm: !!osm };
}

function inPoly(lng, lat, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > lat) !== (yj > lat) && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function zoneAt(zones, center, radius, lng, lat) {
  if (dist(center, { lat, lng }) > radius + 15) return null;
  const hit = zones.find(z => inPoly(lng, lat, z.poly));
  if (hit) return hit.id;
  let best = null, bd = Infinity;
  for (const z of zones) { const d = dist({ lat, lng }, { lng: z.c[0], lat: z.c[1] }); if (d < bd) { bd = d; best = z; } }
  return best?.id || null;
}

// Startpunten zo ver mogelijk uit elkaar.
export function pickStarts(zones, center, n) {
  const P = z => ({ lng: z.c[0], lat: z.c[1] });
  const picked = [zones.slice().sort((a, b) => dist(center, P(b)) - dist(center, P(a)))[0]];
  while (picked.length < n && picked.length < zones.length) {
    let best = null, bs = -1;
    for (const z of zones) {
      if (picked.includes(z)) continue;
      const s = Math.min(...picked.map(p => dist(P(p), P(z))));
      if (s > bs) { bs = s; best = z; }
    }
    picked.push(best);
  }
  return picked;
}
