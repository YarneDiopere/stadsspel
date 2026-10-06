import { db, isLocal } from './db.js';
import { TEAMS, UNITS, DURATIONS, DEFAULT_TASKS, REWARD, START_POWER } from './data.js';
import { generateZones, zoneAt, pickStarts, dist } from './zones.js';
import { makeMap } from './map.js';
import { prepareMedia, verify } from './ai.js';
import { playIntro } from './intro.js';

/* ---------- helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const params = new URLSearchParams(location.search);
const NS = 'ss' + (params.get('p') || '') + '-'; // ?p=2 geeft een tweede speler op hetzelfde toestel (testen)
const ls = (k, v) => v === undefined ? localStorage.getItem(NS + k) : v === null ? localStorage.removeItem(NS + k) : localStorage.setItem(NS + k, v);
const rid = () => Math.random().toString(36).slice(2, 10);
const slug = s => s.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const fmtTime = ms => { const s = Math.max(0, Math.ceil(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s % 60).padStart(2, '0'); };
const fmtDur = m => m < 60 ? m + ' min' : (m % 60 ? Math.floor(m / 60) + 'u' + m % 60 : m / 60 + ' uur');

function toast(msg, color) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg; if (color) t.style.setProperty('--c', color);
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 5000);
}

/* ---------- state ---------- */
const S = {
  pid: ls('pid') || (ls('pid', rid()), ls('pid')),
  code: '', room: null, unsub: [], sheet: null, sel: null, pos: null, zoneId: null,
  map: null, deploy: {}, photos: {}, others: {}, logSeen: null, busy: null, archive: {},
  draft: null,
};
const R = () => 'rooms/' + S.code;
const meta = () => S.room?.meta || {};
const Me = () => S.room?.players?.[S.pid];
const myTeam = () => { const m = Me(); return m?.team ? S.room.teams?.[m.team] : null; };
const plays = p => !!p && (!p.sup || p.plays);
const phase = () => { const m = meta(); return m.phase === 'playing' && db.now() >= m.endsAt ? 'ended' : m.phase; };
const zones = () => { if (S._zj !== S.room.zonesJson) { S._zj = S.room.zonesJson; S._z = JSON.parse(S._zj || '[]'); } return S._z; };
const zoneById = id => zones().find(z => z.id === id);
const zst = id => S.room.zstate?.[id] || { owner: '', power: 0 };
const canAct = id => !!id && (!meta().gps || !!Me()?.sup || S.zoneId === id);
const target = () => (S.sel && canAct(S.sel) ? S.sel : S.zoneId);
const log = (m, t) => db.push(R() + '/log', { m, t: t || '', ts: db.now() });

/* ---------- acties via data-act ---------- */
const A = {};
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (el && !el.disabled) A[el.dataset.act]?.(el.dataset, el);
});
document.addEventListener('input', e => {
  const f = e.target.dataset?.f;
  if (f && S.draft) { S.draft[f] = e.target.type === 'range' || e.target.type === 'number' ? +e.target.value : e.target.value; syncCreate(f); }
  if (e.target.id === 'loc') searchPlace(e.target.value);
});
document.addEventListener('change', e => {
  const d = e.target.dataset || {};
  if (d.chg) A[d.chg]?.(d, e.target);
  if (d.file && e.target.files[0]) { onFile(d.file, e.target.files[0]); e.target.value = ''; }
});

/* ---------- start, meedoen ---------- */
function go(view) {
  S.view = view; $('#screen').hidden = false; $('#game').hidden = true;
  ({ home: viewHome, join: viewJoin, create: viewCreate })[view]();
  window.scrollTo(0, 0);
}
A.go = d => go(d.v);

function viewHome() {
  $('#screen').innerHTML = `<section class="hero">
    <div class="crest">⚔️</div>
    <h1>Stadsspel</h1>
    <p class="sub">Verover de stad, zone per zone</p>
    <button class="btn big" data-act="go" data-v="create">Spel aanmaken</button>
    <button class="btn big alt" data-act="go" data-v="join">Meedoen</button>
    ${isLocal ? '<p class="note">Demo-modus: er is nog geen Firebase gekoppeld, dus spellen blijven op dit toestel.</p>' : ''}
  </section>`;
}

function viewJoin() {
  $('#screen').innerHTML = `<section class="card narrow">
    <button class="back" data-act="go" data-v="home">‹ Terug</button>
    <h2>Meedoen</h2>
    <label>Roomcode<input id="jcode" class="code-in" maxlength="4" autocapitalize="characters" autocomplete="off" placeholder="ABCD" value="${esc(params.get('code') || '')}"></label>
    <label>Je naam<input id="jname" maxlength="20" placeholder="Voornaam" value="${esc(ls('name') || '')}"></label>
    <button class="btn big" data-act="join">Naar de lobby</button>
  </section>`;
}

A.join = async () => {
  const code = $('#jcode').value.trim().toUpperCase(), name = $('#jname').value.trim();
  if (code.length !== 4 || !name) return toast('Vul een code van 4 letters en je naam in');
  if (!await db.get(`rooms/${code}/meta`)) return toast('Geen spel gevonden met code ' + code);
  ls('name', name);
  const cur = await db.get(`rooms/${code}/players/${S.pid}`);
  await db.update(`rooms/${code}/players/${S.pid}`, cur ? { name } : { name, sup: false, plays: true, team: '' });
  enterRoom(code);
};

function enterRoom(code) {
  leaveRoom(true);
  S.code = code; ls('code', code); S.logSeen = null;
  S.unsub.push(db.on(R(), r => { S.room = r; onRoom(); }));
}

function leaveRoom(keep) {
  S.unsub.forEach(u => u()); S.unsub = [];
  if (S.map) { S.map.remove(); S.map = null; } S.mapLoading = false; S.posSub = false;
  if (S.watch != null) { navigator.geolocation.clearWatch(S.watch); S.watch = null; }
  Object.assign(S, { room: null, sheet: null, sel: null, zoneId: null, others: {}, photos: {}, endShown: false });
  $('#sheet').hidden = true;
  if (!keep) { S.code = ''; ls('code', null); go('home'); }
}
A.leave = () => { if (confirm('Wil je dit spel verlaten?')) leaveRoom(); };

/* ---------- spel aanmaken ---------- */
async function viewCreate() {
  const d = S.draft = S.draft || { name: ls('name') || '', hostPlays: 'nee', mode: 'leger', place: null, radius: 600, zoneCount: 18, duration: 120, customDur: 100, teamMode: 'random', teamCount: 4, useArchive: 'ja', gps: 'ja', key: ls('gkey') || '', tasks: [], tdiff: 1 };
  const seg = (f, opts) => `<div class="seg" data-seg="${f}">${opts.map(([v, l]) => `<button type="button" data-act="seg" data-v="${v}" class="${String(d[f]) === String(v) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  $('#screen').innerHTML = `<section class="card">
    <button class="back" data-act="go" data-v="home">‹ Terug</button>
    <h2>Nieuw spel</h2>

    <h3>Jij</h3>
    <label>Je naam<input data-f="name" maxlength="20" placeholder="Voornaam" value="${esc(d.name)}"></label>
    <p class="hint">Jij bent leiding. Speel je zelf ook mee in een groep?</p>
    ${seg('hostPlays', [['nee', 'Enkel leiding'], ['ja', 'Ik speel mee']])}
    <p class="hint">Andere leiding duid je aan in de lobby, zodra iedereen binnen is.</p>

    <h3>Spelmodus</h3>
    ${seg('mode', [['leger', '⚔️ Leger'], ['verover', '🏰 Verover']])}
    <p class="hint" data-if="mode=leger">Opdrachten leveren goud op. Met goud koop je soldaten, die je inzet in de zone waar je staat.</p>
    <p class="hint" data-if="mode=verover">Geen winkel: elke goedgekeurde opdracht telt meteen als sterkte in de zone waar je staat.</p>

    <h3>Speelveld</h3>
    <label>Centrum van het spel<input id="loc" autocomplete="off" placeholder="Zoek een stad, plein of adres" value="${esc(d.place?.name || '')}"></label>
    <div id="sugg" class="sugg"></div>
    <div id="pmap" class="pmap" hidden></div>
    <label>Straal: <b id="radv"></b><input type="range" data-f="radius" min="300" max="1500" step="50" value="${d.radius}"></label>
    <label>Aantal zones: <b id="zcv"></b><input type="range" data-f="zoneCount" min="8" max="40" step="1" value="${d.zoneCount}"></label>
    <p class="hint">Moet je in een zone staan om er iets te doen?</p>
    ${seg('gps', [['ja', '📍 Ja, gps-controle'], ['nee', 'Nee, tikken volstaat']])}

    <h3>Speelduur</h3>
    ${seg('duration', [...DURATIONS.map(m => [m, fmtDur(m)]), ['custom', 'Eigen tijd']])}
    <label data-if="duration=custom">Aantal minuten<input type="number" data-f="customDur" min="5" max="600" value="${d.customDur}"></label>

    <h3>Groepen</h3>
    ${seg('teamMode', [['random', '🎲 Willekeurig'], ['manual', '✋ Leiding verdeelt']])}
    <p class="hint" data-if="teamMode=manual">Je wijst iedereen toe in de lobby.</p>
    <label>Aantal groepen: <b id="tcv"></b><input type="range" data-f="teamCount" min="2" max="8" step="1" value="${d.teamCount}"></label>

    <h3>Opdrachten</h3>
    ${seg('useArchive', [['ja', `Eigen + archief (<span id="arcn">…</span>)`], ['nee', 'Enkel eigen opdrachten']])}
    <p class="hint">Het archief bevat de standaardopdrachten en alles wat ooit in een spel is toegevoegd. Nieuwe opdrachten komen er automatisch bij.</p>
    <div id="ctasks"></div>
    <div class="addtask">
      <input id="tt" maxlength="60" placeholder="Titel van de opdracht">
      <input id="td" maxlength="200" placeholder="Wat moeten ze doen?">
      <input id="tc" maxlength="200" placeholder="Wat moet er op de foto te zien zijn? (voor de AI)">
      ${seg('tdiff', [[1, '⭐ Makkelijk'], [2, '⭐⭐ Gemiddeld'], [3, '⭐⭐⭐ Moeilijk']])}
      <button class="btn alt" type="button" data-act="addDraftTask">+ Opdracht toevoegen</button>
    </div>

    <h3>Automatische controle</h3>
    <label>Gemini API-key (optioneel)<input data-f="key" autocomplete="off" placeholder="AIza…" value="${esc(d.key)}"></label>
    <p class="hint">Gratis aan te maken op aistudio.google.com/apikey. Zonder key keurt de leiding alles zelf goed. De key wordt met de spelers van dit spel gedeeld.</p>

    <button class="btn big" data-act="create">Spel aanmaken</button>
  </section>`;
  syncCreate(); renderDraftTasks();
  if (d.place) showPreview();
  S.archive = await db.get('archive').catch(() => null) || {};
  const n = $('#arcn'); if (n) n.textContent = mergedArchive().length;
}

function mergedArchive() {
  const all = {};
  DEFAULT_TASKS.forEach(t => { all[slug(t.title)] = t; });
  Object.entries(S.archive || {}).forEach(([k, t]) => { all[k] = t; });
  return Object.values(all);
}

function syncCreate(changed) {
  const d = S.draft; if (!d || S.view !== 'create') return;
  $$('[data-if]').forEach(el => { const [f, v] = el.dataset.if.split('='); el.hidden = String(d[f]) !== v; });
  $('#radv').textContent = d.radius + ' m'; $('#zcv').textContent = d.zoneCount; $('#tcv').textContent = d.teamCount;
  if (changed === 'radius' && S.pmap && d.place) { S.pmap.setRing(d.place, d.radius); S.pmap.fit(d.place, d.radius); }
}

A.seg = (d, el) => {
  const f = el.parentElement.dataset.seg, v = el.dataset.v;
  S.draft[f] = /^\d+$/.test(v) ? +v : v;
  $$('button', el.parentElement).forEach(b => b.classList.toggle('on', b === el));
  syncCreate(f);
};

let searchTimer;
function searchPlace(q) {
  clearTimeout(searchTimer);
  const box = $('#sugg');
  if (q.trim().length < 3) { box.innerHTML = ''; return; }
  searchTimer = setTimeout(async () => {
    try {
      const j = await (await fetch('https://photon.komoot.io/api/?limit=6&lat=50.85&lon=4.35&q=' + encodeURIComponent(q))).json();
      S.sugg = j.features.map(f => {
        const p = f.properties, parts = [p.name, p.street && p.street !== p.name ? p.street : null, p.city || p.county, p.country].filter((x, i, a) => x && a.indexOf(x) === i);
        return { name: parts.join(', '), lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] };
      }).filter((s, i, arr) => arr.findIndex(o => o.name === s.name) === i);
      box.innerHTML = S.sugg.map((s, i) => `<button type="button" data-act="pickPlace" data-i="${i}">📍 ${esc(s.name)}</button>`).join('') || '<p class="hint">Niets gevonden</p>';
    } catch { box.innerHTML = '<p class="hint">Zoeken lukt even niet</p>'; }
  }, 350);
}
A.pickPlace = d => { S.draft.place = S.sugg[+d.i]; $('#loc').value = S.draft.place.name; $('#sugg').innerHTML = ''; showPreview(); };

async function showPreview() {
  const d = S.draft, el = $('#pmap'); el.hidden = false;
  if (S.pmap && S.pmap.el !== el) { S.pmap.remove(); S.pmap = null; }
  if (!S.pmap) {
    if (S.pmapLoading) return;
    S.pmapLoading = true;
    try { S.pmap = await makeMap(el, { center: d.place, flat: true }); S.pmap.el = el; } finally { S.pmapLoading = false; }
  }
  if (!d.place) return;
  S.pmap.setRing(d.place, d.radius); S.pmap.fit(d.place, d.radius);
}

function renderDraftTasks() {
  $('#ctasks').innerHTML = S.draft.tasks.map((t, i) => `<div class="trow"><div><b>${esc(t.title)}</b> ${'⭐'.repeat(t.diff)}<br><small>${esc(t.desc)}</small></div><button class="x" data-act="delDraftTask" data-i="${i}">✕</button></div>`).join('');
}
A.addDraftTask = () => {
  const title = $('#tt').value.trim(), desc = $('#td').value.trim(), check = $('#tc').value.trim();
  if (!title) return toast('Geef de opdracht een titel');
  S.draft.tasks.push({ title, desc, check, diff: S.draft.tdiff });
  $('#tt').value = $('#td').value = $('#tc').value = '';
  renderDraftTasks();
};
A.delDraftTask = d => { S.draft.tasks.splice(+d.i, 1); renderDraftTasks(); };

const withReward = t => ({ title: t.title, desc: t.desc || '', check: t.check || '', diff: t.diff || 1, reward: t.reward || REWARD[t.diff || 1] });

A.create = async (_, btn) => {
  const d = S.draft, name = d.name.trim();
  if (!name) return toast('Vul je naam in');
  if (!d.place) return toast('Kies een centrum voor het spel uit de suggesties');
  const list = [...d.tasks, ...(d.useArchive === 'ja' ? mergedArchive().filter(a => !d.tasks.some(t => slug(t.title) === slug(a.title))) : [])];
  if (!list.length) return toast('Voeg minstens één opdracht toe of gebruik het archief');
  const duration = d.duration === 'custom' ? Math.max(5, +d.customDur || 60) : d.duration;
  btn.disabled = true; btn.textContent = 'De stad wordt verdeeld…';
  try {
    const { zones: zs, osm } = await generateZones(d.place, d.radius, d.zoneCount);
    let code; do { code = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.random() * 24 | 0]).join(''); } while (await db.get(`rooms/${code}/meta`));
    const tasks = {}; list.forEach((t, i) => { tasks['t' + i] = withReward(t); });
    ls('name', name); if (d.key) ls('gkey', d.key);
    await db.set('rooms/' + code, {
      meta: { code, host: S.pid, mode: d.mode, center: d.place, radius: d.radius, duration, phase: 'lobby', teamMode: d.teamMode, teamCount: d.teamCount, gps: d.gps === 'ja', key: d.key.trim(), osm, createdAt: db.now() },
      zonesJson: JSON.stringify(zs), tasks,
      players: { [S.pid]: { name, sup: true, plays: d.hostPlays === 'ja', team: '' } },
    });
    for (const t of d.tasks) await db.set('archive/' + slug(t.title), withReward(t));
    if (S.pmap) { S.pmap.remove(); S.pmap = null; }
    S.draft = null;
    enterRoom(code);
  } catch (e) { console.error(e); toast('Aanmaken mislukt: ' + e.message); btn.disabled = false; btn.textContent = 'Spel aanmaken'; }
};

/* ---------- room updates ---------- */
function onRoom() {
  if (!S.room || !Me()) { if (S.code) { toast('Dit spel bestaat niet meer'); leaveRoom(); } return; }
  const me = Me(), m = meta();

  // meldingen uit het logboek
  const keys = Object.keys(S.room.log || {});
  if (S.logSeen) keys.filter(k => !S.logSeen.has(k)).forEach(k => { const l = S.room.log[k]; toast(l.m, S.room.teams?.[l.t]?.color); });
  S.logSeen = new Set(keys);

  if (m.phase !== 'lobby') {
    if (me.sup && !S.posSub) { S.posSub = true; S.unsub.push(db.on('pos/' + S.code, v => { S.others = v || {}; updateMap(); })); }
    const T = myTeam();
    if (T && ((m.phase === 'travel' && T.arrived) || m.phase === 'playing') && !ls('intro-' + S.code)) { ls('intro-' + S.code, '1'); playIntro(m.mode); }
    if (phase() === 'ended' && !S.endShown) { S.endShown = true; S.sheet = { t: 'score' }; }
  }
  render();
}

function render() {
  const inGame = meta().phase !== 'lobby';
  $('#screen').hidden = inGame; $('#game').hidden = !inGame;
  if (!inGame) return renderLobby();
  ensureMap(); startGps(); renderHud(); updateMap();
  if (S.sheet && !(S.sheet.t === 'sup' && S.sheet.tab === 'task')) renderSheet();
}

/* ---------- lobby ---------- */
function renderLobby() {
  const m = meta(), me = Me(), host = m.host === S.pid, P = Object.entries(S.room.players);
  const teamSel = (pid, p) => `<select data-chg="setTeam" data-p="${pid}"><option value="">Groep…</option>${TEAMS.slice(0, m.teamCount).map((t, i) => `<option value="t${i}" ${p.team === 't' + i ? 'selected' : ''}>${t.name}</option>`).join('')}</select>`;
  const link = location.origin + location.pathname + '?code=' + m.code;
  $('#screen').innerHTML = `<section class="card">
    <button class="back" data-act="leave">‹ Verlaten</button>
    <p class="sub center">Roomcode</p>
    <div class="bigcode">${m.code}</div>
    <button class="btn ghost small center" data-act="copy" data-t="${esc(link)}">🔗 Kopieer uitnodigingslink</button>
    <div class="facts">
      <span>${m.mode === 'leger' ? '⚔️ Leger' : '🏰 Verover'}</span><span>📍 ${esc(m.center.name.split(',')[0])}</span><span>⏳ ${fmtDur(m.duration)}</span>
      <span>🗺️ ${zones().length} zones</span><span>🎯 ${Object.keys(S.room.tasks || {}).length} opdrachten</span>
    </div>
    ${m.osm ? '' : `<p class="note">Straatdata was niet bereikbaar: de zones zijn organisch getekend zonder straten te volgen.${host ? ' <button class="btn small" data-act="regen">Opnieuw proberen</button>' : ''}</p>`}

    <h3>Deelnemers (${P.length})</h3>
    ${P.map(([pid, p]) => `<div class="prow">
      <div><b>${esc(p.name)}</b>${pid === S.pid ? ' (jij)' : ''} ${p.sup ? `<span class="tag">👑 leiding${p.plays ? ' · speelt mee' : ''}</span>` : ''}
        ${m.teamMode === 'manual' && plays(p) && p.team && !host ? `<span class="tag" style="--c:${TEAMS[+p.team.slice(1)]?.color}">${TEAMS[+p.team.slice(1)]?.name}</span>` : ''}</div>
      ${host ? `<div class="pctl">
        ${pid !== S.pid ? `<button class="mini ${p.sup ? 'on' : ''}" data-act="togSup" data-p="${pid}">👑</button>` : ''}
        ${p.sup ? `<button class="mini ${p.plays ? 'on' : ''}" data-act="togPlays" data-p="${pid}">speelt mee</button>` : ''}
        ${m.teamMode === 'manual' && plays(p) ? teamSel(pid, p) : ''}
      </div>` : ''}
    </div>`).join('')}

    ${host ? `<h3>Groepen</h3>
      <div class="stepper"><button data-act="teamCount" data-d="-1">−</button><b>${m.teamCount} groepen</b><button data-act="teamCount" data-d="1">+</button></div>
      <p class="hint">${m.teamMode === 'random' ? 'De groepen worden willekeurig verdeeld bij de start.' : 'Wijs hierboven elke speler een groep toe.'}</p>
      <button class="btn big" data-act="startTravel">Stuur de groepen op pad</button>`
    : `<p class="note">${me.sup ? 'Je bent leiding. ' : ''}Wacht tot de leiding het spel start…</p>`}
  </section>`;
}
A.regen = async (_, btn) => {
  const m = meta(); btn.disabled = true; btn.textContent = 'Bezig…';
  const { zones: zs, osm } = await generateZones(m.center, m.radius, zones().length);
  await db.update(R(), { zonesJson: JSON.stringify(zs), 'meta/osm': osm });
  if (!osm) toast('Nog steeds geen straatdata. Probeer het zo meteen opnieuw.');
};
A.copy = d => navigator.clipboard?.writeText(d.t).then(() => toast('Link gekopieerd'), () => toast(d.t));
A.togSup = d => { const p = S.room.players[d.p]; db.update(`${R()}/players/${d.p}`, { sup: !p.sup, plays: p.sup ? true : false }); };
A.togPlays = d => db.update(`${R()}/players/${d.p}`, { plays: !S.room.players[d.p].plays });
A.setTeam = (d, el) => db.set(`${R()}/players/${d.p}/team`, el.value);
A.teamCount = d => db.set(R() + '/meta/teamCount', Math.min(8, Math.max(2, meta().teamCount + +d.d)));

A.startTravel = async () => {
  const m = meta(), playing = Object.entries(S.room.players).filter(([, p]) => plays(p));
  if (!playing.length) return toast('Er speelt nog niemand mee');
  const assign = {};
  if (m.teamMode === 'random') {
    const n = Math.min(m.teamCount, playing.length);
    playing.map(p => [Math.random(), p]).sort((a, b) => a[0] - b[0]).forEach(([, [pid]], i) => { assign[pid] = 't' + (i % n); });
  } else {
    const missing = playing.filter(([, p]) => !p.team || +p.team.slice(1) >= m.teamCount);
    if (missing.length) return toast('Nog geen groep voor: ' + missing.map(([, p]) => p.name).join(', '));
    playing.forEach(([pid, p]) => { assign[pid] = p.team; });
  }
  const used = [...new Set(Object.values(assign))].sort();
  const starts = pickStarts(zones(), m.center, used.length);
  const upd = { 'meta/phase': 'travel' };
  used.forEach((t, i) => {
    const T = TEAMS[+t.slice(1)];
    upd['teams/' + t] = { name: T.name, color: T.color, money: 0, units: { a: m.mode === 'leger' ? START_POWER : 0, b: 0, c: 0 }, start: starts[i % starts.length].id, arrived: false };
  });
  Object.keys(S.room.players).forEach(pid => { upd[`players/${pid}/team`] = assign[pid] || ''; });
  zones().forEach(z => { upd['zstate/' + z.id] = { owner: '', power: 0 }; });
  await db.update(R(), upd);
};

/* ---------- kaart & gps ---------- */
function ensureMap() {
  if (S.map || S.mapLoading) return;
  S.mapLoading = true;
  const m = meta();
  makeMap($('#map'), { center: m.center, onZone: id => { S.sel = id; S.deploy = {}; openSheet({ t: 'zone', zid: id }); updateMap(); } }).then(mp => {
    if (!S.room) return mp.remove();
    S.map = mp; mp.setRing(m.center, m.radius); mp.fit(m.center, m.radius); updateMap();
  });
}

function updateMap() {
  if (!S.map || !S.room) return;
  const teams = S.room.teams || {}, me = Me(), T = myTeam();
  S.map.setZones(zones().map(z => { const t = teams[zst(z.id).owner]; return { id: z.id, poly: z.poly, color: t ? t.color : '#8a7a5c', op: t ? 0.55 : 0.1 }; }), S.sel);
  S.map.setChips(zones().map(z => {
    const s = zst(z.id), t = teams[s.owner];
    return { id: z.id, lng: z.c[0], lat: z.c[1], color: t ? t.color : '#8a7a5c', cls: (t ? 'own' : '') + (z.id === S.zoneId ? ' here' : ''), html: (t ? `<b>${s.power}</b>` : '') + `<span>${esc(z.name)}</span>` };
  }));
  S.map.setMarkers('me', S.pos ? [{ ...S.pos, html: `<div class="me-dot" style="--c:${T?.color || '#3b2a17'}"></div>` }] : []);
  const start = T && meta().phase === 'travel' ? zoneById(T.start) : null;
  S.map.setMarkers('start', start ? [{ lng: start.c[0], lat: start.c[1], anchor: 'bottom', html: '<div class="flag">🚩</div>' }] : []);
  S.map.setMarkers('others', me?.sup ? Object.entries(S.others).filter(([pid, o]) => pid !== S.pid && db.now() - o.ts < 180000).map(([, o]) => ({ lng: o.lng, lat: o.lat, anchor: 'bottom', html: `<div class="pin" style="--c:${teams[o.team]?.color || '#3b2a17'}">${esc(o.name)}</div>` })) : []);
}

function startGps() {
  if (S.watch != null || !navigator.geolocation) return;
  let lastWrite = 0;
  S.watch = navigator.geolocation.watchPosition(p => {
    const m = meta(); if (!m.center) return;
    S.pos = { lat: p.coords.latitude, lng: p.coords.longitude };
    S.zoneId = zoneAt(zones(), m.center, m.radius, S.pos.lng, S.pos.lat);
    if (db.now() - lastWrite > 20000) { lastWrite = db.now(); const me = Me(); db.set(`pos/${S.code}/${S.pid}`, { ...S.pos, ts: lastWrite, name: me.name, team: me.team || '' }); }
    renderHud(); updateMap();
    if (S.sheet?.t === 'zone' || S.sheet?.t === 'task') renderSheet();
  }, e => { S.gpsErr = e.code === 1 ? 'Geef toegang tot je locatie om te kunnen spelen' : 'Geen gps-signaal'; renderHud(); }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
}

/* ---------- HUD ---------- */
function renderHud() {
  if (!S.room || meta().phase === 'lobby') return;
  const m = meta(), me = Me(), T = myTeam(), ph = phase(), teams = S.room.teams || {};
  const pending = Object.values(S.room.subs || {}).filter(s => s.status === 'pending').length;
  let banner = '';
  if (plays(me) && !T) {
    banner = `<b>Kies je groep</b><div class="pick">${Object.entries(teams).map(([id, t]) => `<button class="btn small" style="--c:${t.color}" data-act="pickTeam" data-t="${id}">${t.name}</button>`).join('')}</div>`;
  } else if (ph === 'travel') {
    if (T && !T.arrived) {
      const z = zoneById(T.start), d = S.pos ? Math.round(dist(S.pos, { lng: z.c[0], lat: z.c[1] })) : null;
      banner = `🚩 Ga met je groep naar <b>${esc(z.name)}</b>${d != null && S.zoneId !== T.start ? ` · nog ${d} m` : ''}
        <button class="btn small" data-act="arrive" ${canAct(T.start) ? '' : 'disabled'}>We zijn er!</button>${m.gps && !S.pos ? `<small>${esc(S.gpsErr || 'Wachten op gps…')}</small>` : ''}`;
    } else if (T) banner = '✅ Jullie staan klaar. Wacht op het startsein van de leiding.';
    if (me.sup) {
      const all = Object.values(teams), n = all.filter(t => t.arrived).length;
      banner += `<div>${T ? '' : `Groepen op hun startpunt: <b>${n}/${all.length}</b>`} <button class="btn small" data-act="startGame">▶ Start het spel</button></div>`;
    }
  } else if (ph === 'playing') {
    if (!T && !me.sup) banner = '';
    else if (S.zoneId) { const z = zoneById(S.zoneId), s = zst(S.zoneId), o = teams[s.owner]; banner = `📍 <b>${esc(z.name)}</b> · ${o ? `<span class="tag" style="--c:${o.color}">${o.name} · ${s.power}</span>` : 'onbezet'} <button class="btn small" data-act="openZone" data-z="${S.zoneId}">Bekijk</button>`; }
    else if (!m.gps || me.sup) banner = 'Tik op een zone op de kaart.';
    else banner = S.pos ? 'Je bent buiten het speelveld.' : esc(S.gpsErr || 'Wachten op gps…');
  } else banner = `🏁 <b>Het spel is afgelopen!</b> <button class="btn small" data-act="sheet" data-t="score">Eindstand</button>`;

  $('#hud').innerHTML = `<div class="top">
      <div class="chip" style="--c:${T?.color || '#5a3d22'}">${T ? esc(T.name) : me.sup ? '👑 Leiding' : '…'}</div>
      ${T && m.mode === 'leger' ? `<div class="stat">💰 ${T.money}</div>` : ''}
      <div class="stat" id="timer"></div>
      <button class="iconbtn" data-act="sheet" data-t="menu">☰</button>
    </div>
    ${banner ? `<div class="banner">${banner}</div>` : ''}
    <nav class="nav">
      ${T ? `<button data-act="sheet" data-t="tasks">🎯<span>Opdrachten</span></button>` : ''}
      ${T && m.mode === 'leger' ? `<button data-act="sheet" data-t="shop">🛒<span>Winkel</span></button>` : ''}
      <button data-act="sheet" data-t="score">🏆<span>Stand</span></button>
      ${me.sup ? `<button data-act="sheet" data-t="sup">👑<span>Leiding</span>${pending ? `<i class="badge">${pending}</i>` : ''}</button>` : ''}
    </nav>`;
  tick();
}

function tick() {
  const el = $('#timer'), m = meta(); if (!S.room) return;
  if (el) el.textContent = m.phase === 'playing' ? '⏳ ' + fmtTime(m.endsAt - db.now()) : m.phase === 'travel' ? '⏳ ' + fmtDur(m.duration) : '🏁';
  if (m.phase === 'playing' && db.now() >= m.endsAt) {
    if (Me()?.sup) db.set(R() + '/meta/phase', 'ended');
    else if (!S.endShown) onRoom();
  }
}
setInterval(tick, 1000);

A.pickTeam = d => db.set(`${R()}/players/${S.pid}/team`, d.t);
A.arrive = () => db.set(`${R()}/teams/${Me().team}/arrived`, true);
A.openZone = d => { S.sel = d.z; S.deploy = {}; openSheet({ t: 'zone', zid: d.z }); updateMap(); };

A.startGame = async () => {
  const teams = S.room.teams || {}, waiting = Object.values(teams).filter(t => !t.arrived).map(t => t.name);
  if (waiting.length && !confirm(`Nog niet op het startpunt: ${waiting.join(', ')}. Toch starten?`)) return;
  const now = db.now(), upd = { 'meta/phase': 'playing', 'meta/startedAt': now, 'meta/endsAt': now + meta().duration * 60000 };
  Object.entries(teams).forEach(([id, t]) => { upd['zstate/' + t.start] = { owner: id, power: START_POWER }; upd[`teams/${id}/arrived`] = true; });
  await db.update(R(), upd);
  log('Het spel is begonnen. Verover de stad!');
};

/* ---------- sheets ---------- */
function openSheet(s) { S.sheet = s; S.busy = null; renderSheet(); }
A.sheet = d => openSheet({ t: d.t, tab: 'subs' });
A.close = () => { S.sheet = null; S.sel = null; $('#sheet').hidden = true; updateMap(); };
A.tab = d => { S.sheet.tab = d.tab; renderSheet(); };

function renderSheet() {
  const el = $('#sheet'), s = S.sheet; if (!s) { el.hidden = true; return; }
  const body = ({ tasks: shTasks, task: shTask, shop: shShop, zone: shZone, sup: shSup, score: shScore, menu: shMenu })[s.t]();
  const top = $('.sheet-body', el)?.scrollTop || 0;
  el.hidden = false;
  el.innerHTML = `<div class="sheet-card"><button class="x close" data-act="close">✕</button><div class="sheet-body">${body}</div></div>`;
  $('.sheet-body', el).scrollTop = top;
}

const statusTag = st => ({ checking: '⏳ wordt bekeken', pending: '⏳ bij de leiding', ai_rejected: '✗ afgekeurd door AI', rejected: '✗ afgekeurd', approved: '✓ goedgekeurd' }[st] || '');
const prize = t => meta().mode === 'leger' ? `💰 ${t.reward}` : `⚔️ +${t.diff}`;
function lastSubs() {
  const last = {};
  Object.entries(S.room.subs || {}).forEach(([id, s]) => { if (s.team === Me().team && (!last[s.task] || s.ts > last[s.task].ts)) last[s.task] = { ...s, id }; });
  return last;
}

function shTasks() {
  const T = myTeam(), done = T.done || {}, last = lastSubs();
  const list = Object.entries(S.room.tasks || {}).map(([id, t]) => ({ id, ...t }));
  const allDone = list.every(t => done[t.id]);
  list.sort((a, b) => (allDone ? 0 : !!done[a.id] - !!done[b.id]) || a.diff - b.diff);
  return `<h2>Opdrachten</h2>
    <p class="hint">${meta().mode === 'leger' ? 'Elke goedgekeurde opdracht levert goud op.' : 'Elke goedgekeurde opdracht telt als sterkte in de zone waar je staat.'}${allDone ? ' Alles gedaan: je mag opnieuw beginnen.' : ''}</p>
    ${list.map(t => { const d = done[t.id] && !allDone, st = last[t.id]?.status; return `<button class="titem ${d ? 'done' : ''}" data-act="openTask" data-id="${t.id}">
      <div><b>${esc(t.title)}</b><small>${esc(t.desc)}</small>${d ? '<em>✓ voltooid</em>' : st && st !== 'approved' ? `<em>${statusTag(st)}</em>` : ''}</div><span class="prize">${prize(t)}</span></button>`; }).join('')}`;
}
A.openTask = d => openSheet({ t: 'task', id: d.id });

function shTask() {
  const t = S.room.tasks[S.sheet.id], T = myTeam(), last = lastSubs()[S.sheet.id], m = meta(), ph = phase();
  const list = Object.keys(S.room.tasks), allDone = list.every(id => T.done?.[id]);
  const done = T.done?.[S.sheet.id] && !allDone, zid = target(), z = zid && zoneById(zid);
  const upload = `<label class="btn big filebtn">📷 Foto of filmpje maken<input type="file" accept="image/*,video/*" capture="environment" data-file="${S.sheet.id}" hidden></label><p class="hint">Filmpjes: hou ze korter dan 15 seconden.</p>`;
  let action;
  if (S.busy) action = `<div class="busy"><div class="spin"></div>${esc(S.busy)}</div>`;
  else if (ph !== 'playing') action = `<p class="note">${ph === 'ended' ? 'Het spel is afgelopen.' : 'Het spel is nog niet gestart.'}</p>`;
  else if (last?.status === 'pending' || last?.status === 'checking') action = '<p class="note">⏳ Jullie bewijs ligt bij de leiding.</p>';
  else if (done) action = '<p class="note">✓ Deze opdracht is al voltooid.</p>';
  else if (m.mode === 'verover' && !z) action = '<p class="note">Ga eerst in een zone staan: de opdracht telt voor de zone waar je bent.</p>';
  else if (last?.status === 'ai_rejected') action = `<p class="note bad">✗ ${esc(last.ai || 'Niet goedgekeurd')}</p><button class="btn alt" data-act="askSup" data-s="${last.id}">Vraag de leiding om te kijken</button>${upload}`;
  else action = (last?.status === 'rejected' ? '<p class="note bad">✗ Afgekeurd door de leiding. Probeer opnieuw.</p>' : '') + upload;
  return `<button class="back" data-act="sheet" data-t="tasks">‹ Alle opdrachten</button>
    <h2>${esc(t.title)}</h2><p>${esc(t.desc)}</p>
    <div class="facts"><span>${'⭐'.repeat(t.diff)}</span><span>${prize(t)}</span>${m.mode === 'verover' && z ? `<span>📍 voor ${esc(z.name)}</span>` : ''}</div>
    ${action}`;
}
A.askSup = d => db.update(`${R()}/subs/${d.s}`, { status: 'pending' });

async function onFile(tid, file) {
  const task = S.room.tasks[tid], me = Me(), m = meta();
  if (!task || phase() !== 'playing') return;
  const zone = m.mode === 'verover' ? target() : (S.zoneId || '');
  if (m.mode === 'verover' && !zone) return toast('Ga eerst in een zone staan');
  const busy = msg => { S.busy = msg; if (S.sheet?.t === 'task') renderSheet(); };
  busy('Bewijs wordt verwerkt…');
  try {
    const media = await prepareMedia(file);
    const sid = await db.push(R() + '/subs', { team: me.team, task: tid, zone: zone || '', by: me.name, status: 'checking', ts: db.now(), video: media.video });
    if (media.thumb) await db.set(`photos/${S.code}/${sid}`, media.thumb);
    let res = null;
    if (m.key && media.ai) { busy('De scheidsrechter bekijkt je bewijs…'); try { res = await verify(m.key, task, media.ai); } catch (e) { console.warn(e); } }
    if (res?.ok) { await db.update(`${R()}/subs/${sid}`, { ai: res.reden }); await approve(sid); }
    else if (res) await db.update(`${R()}/subs/${sid}`, { status: 'ai_rejected', ai: res.reden });
    else await db.update(`${R()}/subs/${sid}`, { status: 'pending' });
  } catch (e) { console.error(e); toast('Er ging iets mis: ' + e.message); }
  busy(null);
}

async function approve(sid) {
  const r = await db.tx(`${R()}/subs/${sid}/status`, s => (s === 'approved' ? undefined : 'approved'));
  if (!r.committed) return;
  const sub = await db.get(`${R()}/subs/${sid}`), task = S.room.tasks[sub.task], T = S.room.teams[sub.team];
  await db.set(`${R()}/teams/${sub.team}/done/${sub.task}`, true);
  if (meta().mode === 'leger') {
    await db.tx(`${R()}/teams/${sub.team}/money`, v => (v || 0) + task.reward);
    log(`${T.name} voltooide "${task.title}" (+${task.reward} goud)`, sub.team);
  } else if (sub.zone) await combat(sub.zone, sub.team, task.diff);
}

// Aanval min verdediging: wie overblijft houdt de zone.
async function combat(zid, tid, P) {
  let before;
  await db.tx(`${R()}/zstate/${zid}`, z => {
    z = z || { owner: '', power: 0 }; before = { ...z };
    if (z.owner === tid) return { owner: tid, power: z.power + P };
    if (P > z.power) return { owner: tid, power: P - z.power };
    return { owner: z.owner, power: z.power - P };
  });
  const T = S.room.teams[tid].name, Z = zoneById(zid).name, old = S.room.teams[before.owner]?.name;
  if (before.owner === tid) log(`${T} versterkt ${Z} (+${P})`, tid);
  else if (P > before.power) log(old ? `${T} verovert ${Z} van ${old}! (${P} − ${before.power} = ${P - before.power})` : `${T} verovert ${Z}`, tid);
  else log(`${T} valt ${Z} aan, maar ${old} houdt stand (${before.power} − ${P} = ${before.power - P})`, before.owner);
}

function shShop() {
  const T = myTeam(), u = T.units || {};
  return `<h2>Winkel</h2><p class="hint">Jullie hebben <b>💰 ${T.money}</b> goud.</p>
    ${UNITS.map(x => `<div class="unit"><div class="uicon">${x.icon}</div>
      <div><b>${x.name}</b> <span class="tag">kracht ${x.power}</span><small>${x.desc} In bezit: <b>${u[x.id] || 0}</b></small></div>
      <div class="ubuy"><button class="btn small" data-act="buy" data-u="${x.id}" data-n="1" ${T.money >= x.price ? '' : 'disabled'}>💰 ${x.price}</button>
      <button class="btn small alt" data-act="buy" data-u="${x.id}" data-n="5" ${T.money >= x.price * 5 ? '' : 'disabled'}>×5</button></div></div>`).join('')}
    <p class="hint">Soldaten zet je in door in een zone te staan en erop te tikken.</p>`;
}
A.buy = async d => {
  const x = UNITS.find(u => u.id === d.u), n = +d.n, tid = Me().team;
  if (phase() !== 'playing') return toast('De winkel is enkel open tijdens het spel');
  const r = await db.tx(`${R()}/teams/${tid}/money`, v => ((v || 0) >= x.price * n ? v - x.price * n : undefined));
  if (!r.committed) return toast('Niet genoeg goud');
  await db.tx(`${R()}/teams/${tid}/units/${x.id}`, v => (v || 0) + n);
};

function shZone() {
  const zid = S.sheet.zid, z = zoneById(zid), s = zst(zid), teams = S.room.teams || {}, o = teams[s.owner], T = myTeam(), me = Me(), m = meta(), ph = phase();
  let body = '';
  if (T && ph === 'playing') {
    const mine = s.owner === me.team;
    if (!canAct(zid)) body = '<p class="note">Je moet in deze zone staan om hier iets te doen.</p>';
    else if (m.mode === 'verover') body = `<p>${mine ? 'Versterk deze zone' : 'Verover deze zone'} door hier een opdracht uit te voeren.</p><button class="btn big" data-act="sheet" data-t="tasks">🎯 Kies een opdracht</button>`;
    else {
      const u = T.units || {}, d = S.deploy, P = UNITS.reduce((a, x) => a + (d[x.id] || 0) * x.power, 0);
      const out = mine ? `Zone wordt ${s.power + P} sterk` : P > s.power ? `${P} − ${s.power} = ${P - s.power}: de zone is van jullie!` : `${s.power} − ${P} = ${s.power - P}: de verdediger houdt stand`;
      body = `<p class="hint">Hoeveel soldaten zet je in?</p>
        ${UNITS.map(x => `<div class="unit"><div class="uicon">${x.icon}</div><div><b>${x.name}</b><small>kracht ${x.power} · in bezit ${u[x.id] || 0}</small></div>
          <div class="stepper"><button data-act="dep" data-u="${x.id}" data-d="-1">−</button><b>${d[x.id] || 0}</b><button data-act="dep" data-u="${x.id}" data-d="1">+</button><button class="max" data-act="dep" data-u="${x.id}" data-d="99">max</button></div></div>`).join('')}
        ${P ? `<p class="note">${out}</p>` : ''}
        <button class="btn big" data-act="deploy" ${P ? '' : 'disabled'}>${mine ? '🛡️ Verdedig' : o ? '⚔️ Val aan' : '🏳️ Verover'}${P ? ` met kracht ${P}` : ''}</button>
        ${Object.values(u).some(v => v > 0) ? '' : '<p class="hint">Geen soldaten meer? Doe opdrachten en koop er in de winkel.</p>'}`;
    }
  }
  return `<h2>${esc(z.name)}</h2>
    <div class="facts">${o ? `<span class="tag" style="--c:${o.color}">${o.name}</span><span>🛡️ sterkte ${s.power}</span>` : '<span>🏳️ Onbezet</span>'}${zid === S.zoneId ? '<span>📍 Je bent hier</span>' : ''}</div>${body}`;
}
A.dep = d => {
  const have = myTeam().units?.[d.u] || 0;
  S.deploy[d.u] = Math.min(have, Math.max(0, (S.deploy[d.u] || 0) + +d.d));
  renderSheet();
};
A.deploy = async () => {
  const zid = S.sheet.zid, tid = Me().team, d = { ...S.deploy };
  const P = UNITS.reduce((a, x) => a + (d[x.id] || 0) * x.power, 0);
  if (!P || !canAct(zid) || phase() !== 'playing') return;
  const r = await db.tx(`${R()}/teams/${tid}/units`, u => {
    u = u || {};
    for (const k in d) if ((u[k] || 0) < d[k]) return;
    const n = { a: 0, b: 0, c: 0, ...u }; for (const k in d) n[k] -= d[k];
    return n;
  });
  if (!r.committed) return toast('Niet genoeg soldaten');
  S.deploy = {};
  await combat(zid, tid, P);
};

function score() {
  const teams = S.room.teams || {};
  return Object.entries(teams).map(([id, t]) => {
    const own = zones().filter(z => zst(z.id).owner === id);
    return { id, ...t, zones: own.length, power: own.reduce((a, z) => a + zst(z.id).power, 0) };
  }).sort((a, b) => b.zones - a.zones || b.power - a.power);
}
function shScore() {
  const sc = score(), ended = phase() === 'ended';
  return `<h2>${ended ? '🏁 Eindstand' : 'Stand'}</h2>
    ${ended && sc[0] ? `<div class="winner" style="--c:${sc[0].color}">👑 ${esc(sc[0].name)} wint!</div>` : ''}
    ${sc.map((t, i) => `<div class="srow" style="--c:${t.color}"><span class="rank">${i + 1}</span><b>${esc(t.name)}</b><span>🗺️ ${t.zones}</span><span>🛡️ ${t.power}</span></div>`).join('')}
    <p class="hint">Gerangschikt op aantal zones, daarna op totale sterkte.</p>`;
}

function shMenu() {
  const m = meta();
  return `<h2>Menu</h2>
    <div class="facts"><span>Code <b>${m.code}</b></span><span>${m.mode === 'leger' ? '⚔️ Leger' : '🏰 Verover'}</span></div>
    <button class="btn big alt" data-act="replay">🎬 Speluitleg opnieuw bekijken</button>
    <button class="btn big alt" data-act="recenter">🧭 Kaart centreren</button>
    <button class="btn big ghost" data-act="leave">Spel verlaten</button>`;
}
A.replay = () => { A.close(); playIntro(meta().mode); };
A.recenter = () => { A.close(); S.map?.fit(meta().center, meta().radius); };

/* ---------- leiding ---------- */
function shSup() {
  const tab = S.sheet.tab || 'subs', teams = S.room.teams || {}, m = meta(), ph = phase();
  const tabs = [['subs', 'Inzendingen'], ['teams', 'Groepen'], ['task', 'Opdracht +'], ['spel', 'Spel']];
  let body = '';
  if (tab === 'subs') {
    const order = { pending: 0, checking: 1, ai_rejected: 2 };
    const subs = Object.entries(S.room.subs || {}).map(([id, s]) => ({ id, ...s })).sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3) || b.ts - a.ts).slice(0, 40);
    body = subs.map(s => { const t = S.room.tasks[s.task] || {}, T = teams[s.team] || {}, open = s.status !== 'approved' && s.status !== 'rejected';
      return `<div class="sub-card ${open ? '' : 'closed'}">
        <div><span class="tag" style="--c:${T.color}">${esc(T.name)}</span> <b>${esc(t.title)}</b> <span class="prize">${prize(t)}</span></div>
        <small>${esc(t.check || t.desc)}</small>
        <small>door ${esc(s.by)} · ${new Date(s.ts).toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit' })}${s.video ? ' · 🎥 video (enkel een beeld bewaard)' : ''}${s.zone ? ' · 📍 ' + esc(zoneById(s.zone)?.name) : ''}</small>
        <small><b>${statusTag(s.status)}</b>${s.ai ? ' · AI: ' + esc(s.ai) : ''}</small>
        ${S.photos[s.id] ? `<img src="${S.photos[s.id]}" alt="bewijs">` : `<button class="btn small ghost" data-act="photo" data-s="${s.id}">📷 Bekijk bewijs</button>`}
        ${open ? `<div class="row"><button class="btn small" data-act="approve" data-s="${s.id}">✓ Goedkeuren</button><button class="btn small alt" data-act="reject" data-s="${s.id}">✗ Afkeuren</button></div>` : ''}
      </div>`; }).join('') || '<p class="note">Nog geen inzendingen.</p>';
  } else if (tab === 'teams') {
    body = Object.entries(teams).map(([id, t]) => {
      const members = Object.values(S.room.players).filter(p => p.team === id).map(p => p.name).join(', ');
      return `<div class="sub-card"><div><span class="tag" style="--c:${t.color}">${esc(t.name)}</span> ${m.mode === 'leger' ? `💰 ${t.money}` : ''} ${ph === 'travel' ? (t.arrived ? '✅ op startpunt' : `🚶 onderweg naar ${esc(zoneById(t.start)?.name)}`) : ''}</div>
        <small>${esc(members) || 'geen spelers'}</small>
        <div class="row">${m.mode === 'leger' ? `<button class="btn small" data-act="money" data-t="${id}" data-d="20">+20 goud</button><button class="btn small alt" data-act="money" data-t="${id}" data-d="-20">−20 goud</button>` : ''}
        ${ph === 'travel' && !t.arrived ? `<button class="btn small ghost" data-act="markArrived" data-t="${id}">Is aangekomen</button>` : ''}</div></div>`;
    }).join('');
  } else if (tab === 'task') {
    body = `<p class="hint">Voeg tijdens het spel een opdracht toe. Ze komt ook in het archief.</p>
      <div class="addtask"><input id="st" maxlength="60" placeholder="Titel"><input id="sd" maxlength="200" placeholder="Wat moeten ze doen?"><input id="sc" maxlength="200" placeholder="Wat moet er op de foto te zien zijn?">
      <select id="sdiff"><option value="1">⭐ Makkelijk</option><option value="2">⭐⭐ Gemiddeld</option><option value="3">⭐⭐⭐ Moeilijk</option></select>
      <button class="btn" data-act="supAddTask">Toevoegen</button></div>`;
  } else {
    body = `<div class="facts"><span>Code <b>${m.code}</b></span><span>${{ travel: 'Groepen onderweg', playing: 'Bezig', ended: 'Afgelopen' }[ph]}</span></div>
      ${ph === 'travel' ? '<button class="btn big" data-act="startGame">▶ Start het spel</button>' : ''}
      ${ph === 'playing' ? `<div class="row"><button class="btn alt" data-act="addTime" data-m="10">+10 min</button><button class="btn alt" data-act="addTime" data-m="-10">−10 min</button></div><button class="btn big" data-act="stopGame">⏹ Stop het spel</button>` : ''}
      ${ph === 'ended' ? '<p class="note">Het spel is afgelopen.</p>' : ''}`;
  }
  return `<h2>Leiding</h2><div class="tabs">${tabs.map(([k, l]) => `<button class="${k === tab ? 'on' : ''}" data-act="tab" data-tab="${k}">${l}</button>`).join('')}</div>${body}`;
}
A.photo = async d => { S.photos[d.s] = await db.get(`photos/${S.code}/${d.s}`) || 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><text x="10" y="35">Geen beeld beschikbaar</text></svg>'); renderSheet(); };
A.approve = d => approve(d.s);
A.reject = d => db.tx(`${R()}/subs/${d.s}/status`, s => (s === 'approved' ? undefined : 'rejected'));
A.money = d => db.tx(`${R()}/teams/${d.t}/money`, v => Math.max(0, (v || 0) + +d.d));
A.markArrived = d => db.set(`${R()}/teams/${d.t}/arrived`, true);
A.addTime = d => db.tx(R() + '/meta/endsAt', v => (v ? v + d.m * 60000 : undefined));
A.stopGame = () => { if (confirm('Het spel nu stopzetten?')) { db.set(R() + '/meta/phase', 'ended'); log('De leiding heeft het spel stopgezet.'); } };
A.supAddTask = async () => {
  const title = $('#st').value.trim(); if (!title) return toast('Geef de opdracht een titel');
  const t = withReward({ title, desc: $('#sd').value.trim(), check: $('#sc').value.trim(), diff: +$('#sdiff').value });
  await db.set(`${R()}/tasks/x${rid()}`, t);
  await db.set('archive/' + slug(title), t);
  log(`Nieuwe opdracht: "${title}"`);
  S.sheet.tab = 'subs'; renderSheet();
};

/* ---------- boot ---------- */
(async () => {
  const saved = ls('code'), link = (params.get('code') || '').toUpperCase();
  if (saved && (!link || link === saved) && await db.get(`rooms/${saved}/players/${S.pid}`).catch(() => null)) return enterRoom(saved);
  go(link ? 'join' : 'home');
})();
