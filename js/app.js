import { db, isLocal } from './db.js';
import { aiProxyUrl } from './config.js';
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

// Zet HTML enkel als die verschilt van wat er al staat, zodat open invoervelden en de camera-knop niet telkens vervangen worden.
function setHTML(el, html) {
  if (el._h === html) return false;
  el._h = html; el.innerHTML = html;
  return true;
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
const seesPower = owner => !!Me()?.sup || (!!owner && owner === Me()?.team) || phase() === 'ended';
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
  S.view = view; $('#screen').hidden = false; $('#game').hidden = true; $('#screen')._h = null;
  ({ home: viewHome, join: viewJoin, create: viewCreate, archive: viewArchive })[view]();
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
    <div class="homelinks"><button class="btn ghost small" data-act="go" data-v="archive">📚 Archief</button></div>
    ${isLocal ? '<p class="note">Demo-modus: er is nog geen Firebase gekoppeld, dus spellen blijven op dit toestel.</p>' : ''}
  </section>`;
}

// Archief: afgelopen spellen en alle opdrachten die ooit gebruikt zijn.
async function viewArchive(tab = 'games') {
  const frame = body => { $('#screen').innerHTML = `<section class="card">
    <button class="back" data-act="go" data-v="home">‹ Terug</button>
    <h2>Archief</h2>
    <div class="tabs"><button class="${tab === 'games' ? 'on' : ''}" data-act="arch" data-tab="games">Spellen</button><button class="${tab === 'tasks' ? 'on' : ''}" data-act="arch" data-tab="tasks">Opdrachten</button></div>
    ${body}</section>`; };
  frame('<div class="busy"><div class="spin"></div>Laden…</div>');
  const [hist, arc] = await Promise.all([db.get('history').catch(() => null), db.get('archive').catch(() => null)]);
  if (S.view !== 'archive') return;
  S.archive = arc || {};
  if (tab === 'tasks') {
    const list = mergedArchive().sort((a, b) => a.diff - b.diff || a.title.localeCompare(b.title));
    const ed = S.archEdit, cur = ed && ed !== 'new' ? list.find(t => t.key === ed) : null;
    const form = !ed ? '<button class="btn alt" data-act="archEdit" data-k="new">+ Nieuwe opdracht</button>' : `<div class="addtask">
        <b>${cur ? 'Opdracht wijzigen' : 'Nieuwe opdracht'}</b>
        <input id="at" maxlength="60" placeholder="Titel" value="${esc(cur?.title || '')}">
        <input id="ad" maxlength="200" placeholder="Wat moeten ze doen?" value="${esc(cur?.desc || '')}">
        <input id="ac" maxlength="200" placeholder="Wat moet er op de foto te zien zijn?" value="${esc(cur?.check || '')}">
        <select id="adiff">${[1, 2, 3].map(n => `<option value="${n}" ${(cur?.diff || 1) === n ? 'selected' : ''}>${'⭐'.repeat(n)} ${['Makkelijk', 'Gemiddeld', 'Moeilijk'][n - 1]}</option>`).join('')}</select>
        <div class="row"><button class="btn" data-act="archSave">Opslaan</button><button class="btn ghost" data-act="archEdit" data-k="">Annuleren</button></div>
      </div>`;
    return frame(`<p class="hint">${list.length} opdrachten. Elke opdracht die in een spel wordt toegevoegd komt hier bij.</p>${form}` +
      list.map(t => `<div class="titem arc"><div><b>${esc(t.title)}</b> ${'⭐'.repeat(t.diff || 1)}<small>${esc(t.desc)}</small></div>
        <div class="row"><button class="mini" data-act="archEdit" data-k="${esc(t.key)}">✏️</button><button class="mini" data-act="archDel" data-k="${esc(t.key)}" data-t="${esc(t.title)}">🗑️</button></div></div>`).join(''));
  }
  const games = Object.entries(hist || {}).map(([id, g]) => ({ id, ...g })).sort((a, b) => b.date - a.date);
  frame(games.map(g => `<div class="sub-card">
      <div><b>${g.title ? esc(g.title) : '📍 ' + esc((g.place || '').split(',')[0])}</b> <span class="tag">${g.mode === 'leger' ? 'Leger' : 'Verover'}</span></div>
      <small>${new Date(g.date).toLocaleDateString('nl-BE', { day: 'numeric', month: 'long', year: 'numeric' })} · ${fmtDur(g.duration)} · ${g.players} deelnemers · ${g.zones} zones</small>
      ${scoreRows(g.score || [], true)}
      <div class="row"><button class="btn small ghost" data-act="histRename" data-id="${esc(g.id)}" data-t="${esc(g.title || (g.place || '').split(',')[0])}">✏️ Naam wijzigen</button><button class="btn small ghost" data-act="histDel" data-id="${esc(g.id)}">🗑️ Verwijderen</button></div>
    </div>`).join('') || '<p class="note">Nog geen afgelopen spellen. Een spel komt hier te staan zodra het afgelopen is.</p>');
}
A.arch = d => { S.archEdit = null; viewArchive(d.tab); };
A.archEdit = d => { S.archEdit = d.k || null; viewArchive('tasks').then(() => S.archEdit && window.scrollTo(0, 0)); };
A.archSave = async () => {
  const title = $('#at').value.trim(); if (!title) return toast('Geef de opdracht een titel');
  const key = S.archEdit === 'new' ? slug(title) : S.archEdit;
  await db.set('archive/' + key, withReward({ title, desc: $('#ad').value.trim(), check: $('#ac').value.trim(), diff: +$('#adiff').value }));
  S.archEdit = null; viewArchive('tasks');
};
A.archDel = async d => {
  if (!await mayDelete() || !confirm(`"${d.t}" uit het archief verwijderen?`)) return;
  await db.set('archive/' + d.k, { deleted: true, title: d.t });
  viewArchive('tasks');
};
A.histRename = async d => {
  const t = prompt('Naam van dit spel', d.t);
  if (t && t.trim()) { await db.set(`history/${d.id}/title`, t.trim().slice(0, 60)); viewArchive(); }
};
A.histDel = async d => {
  if (await mayDelete() && confirm('Dit spel uit het archief verwijderen? Dat kan niet ongedaan gemaakt worden.')) { await db.set('history/' + d.id, null); viewArchive(); }
};

// Bewaart de eindstand in het archief. Elke leiding mag dit doen; het resultaat is hetzelfde.
function saveHistory() {
  if (S.histSaved || !Me()?.sup) return;
  S.histSaved = true;
  const m = meta();
  db.set(`history/${m.code}-${m.createdAt}`, {
    code: m.code, place: m.center.name, mode: m.mode, date: m.startedAt || m.createdAt, duration: m.duration,
    players: Object.keys(S.room.players).length, zones: zones().length,
    score: score().map(t => ({ name: t.name, color: t.color, zones: t.zones, power: t.power })),
  }).catch(e => console.warn(e));
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
  S.pendSeen = null;
  Object.assign(S, { room: null, sheet: null, sel: null, zoneId: null, others: {}, photos: {}, endShown: false, histSaved: false });
  $('#hud')._h = $('#sheet')._h = $('#screen')._h = null;
  $('#sheet').hidden = true;
  if (!keep) { S.code = ''; ls('code', null); go('home'); }
}
A.leave = () => { if (confirm('Wil je dit spel verlaten?')) leaveRoom(); };

/* ---------- spel aanmaken ---------- */
const STEPS = ['Start', 'Speelveld', 'Tijd & groepen', 'Opdrachten', 'Overzicht'];

async function viewCreate() {
  const d = S.draft = S.draft || { step: 0, name: ls('name') || '', hostPlays: 'nee', mode: 'leger', place: null, radius: 600, zoneCount: 18, duration: 120, customDur: 100, teamMode: 'random', teamCount: 4, useArchive: 'ja', gps: 'ja', tasks: [], tdiff: 1, skip: {} };
  const seg = (f, opts, cls = '') => `<div class="seg ${cls}" data-seg="${f}">${opts.map(([v, l]) => `<button type="button" data-act="seg" data-v="${v}" class="${String(d[f]) === String(v) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  const card = (icon, title, text) => `<span class="cicon">${icon}</span><span><b>${title}</b><small>${text}</small></span>`;
  $('#screen').innerHTML = `<section class="card wizard">
    <button class="back" data-act="go" data-v="home">‹ Annuleren</button>
    <div class="steps">${STEPS.map((l, i) => `<button type="button" data-act="step" data-n="${i}"><i>${i + 1}</i><span>${l}</span></button>`).join('')}</div>

    <div class="step" data-step="0">
      <h2>Wie ben jij?</h2>
      <label>Je naam<input data-f="name" maxlength="20" placeholder="Voornaam" value="${esc(d.name)}"></label>
      <p class="q">Speel je zelf mee?</p>
      ${seg('hostPlays', [['nee', card('👑', 'Enkel leiding', 'Je volgt alles op de kaart en keurt opdrachten goed.')], ['ja', card('🏃', 'Ik speel mee', 'Je zit in een groep én je bent leiding.')]], 'cards')}
      <p class="hint">Andere leiding duid je straks aan in de lobby.</p>
      <p class="q">Welk spel spelen jullie?</p>
      ${seg('mode', [['leger', card('⚔️', 'Leger', 'Opdrachten leveren goud op. Daarmee koop je soldaten en val je zones aan.')], ['verover', card('🏰', 'Verover', 'Geen winkel: elke goedgekeurde opdracht versterkt meteen de zone waar je staat.')]], 'cards')}
    </div>

    <div class="step" data-step="1">
      <h2>Waar spelen jullie?</h2>
      <label>Centrum van het spel<input id="loc" autocomplete="off" placeholder="Typ een stad, plein of adres…" value="${esc(d.place?.name || '')}"></label>
      <div id="sugg" class="sugg"></div>
      <div id="pmap" class="pmap" hidden></div>
      <label>Hoe groot? <b id="radv"></b><input type="range" data-f="radius" min="300" max="1500" step="50" value="${d.radius}"><span class="ends"><i>klein</i><i>groot</i></span></label>
      <label>Aantal zones: <b id="zcv"></b><input type="range" data-f="zoneCount" min="8" max="40" step="1" value="${d.zoneCount}"><span class="ends"><i>8</i><i>40</i></span></label>
      <p class="q">Moeten spelers echt in een zone staan?</p>
      ${seg('gps', [['ja', card('📍', 'Ja, met gps', 'De app controleert de locatie. Aangeraden.')], ['nee', card('👆', 'Nee', 'Op een zone tikken volstaat. Handig om binnen te testen.')]], 'cards')}
    </div>

    <div class="step" data-step="2">
      <h2>Hoe lang duurt het spel?</h2>
      ${seg('duration', [...DURATIONS.map(m => [m, fmtDur(m)]), ['custom', 'Anders…']], 'grid')}
      <label data-if="duration=custom">Aantal minuten<input type="number" data-f="customDur" min="5" max="600" value="${d.customDur}"></label>
      <p class="hint">De klok start pas wanneer jij het startsein geeft. Je kan later nog tijd bijtellen of het spel stoppen.</p>
      <h2 class="gap">Hoe maken we de groepen?</h2>
      ${seg('teamMode', [['random', card('🎲', 'Willekeurig', 'De app verdeelt iedereen eerlijk bij de start.')], ['manual', card('✋', 'Zelf verdelen', 'Je zet elke speler in de lobby in een groep.')]], 'cards')}
      <label>Aantal groepen: <b id="tcv"></b><input type="range" data-f="teamCount" min="2" max="8" step="1" value="${d.teamCount}"><span class="ends"><i>2</i><i>8</i></span></label>
    </div>

    <div class="step" data-step="3">
      <h2>Welke opdrachten?</h2>
      ${seg('useArchive', [['ja', card('📚', 'Archief + eigen opdrachten', '<span id="arcn">…</span> opdrachten uit vorige spellen, plus wat je hieronder toevoegt.')], ['nee', card('✏️', 'Enkel eigen opdrachten', 'Alleen wat je hieronder zelf toevoegt.')]], 'cards')}
      <details class="arcbox" data-if="useArchive=ja"><summary>📖 Bekijk het archief en vink af wat je niet wil</summary><div id="arclist"></div></details>
      <p class="q">Eigen opdrachten <span id="ctn"></span></p>
      <div id="ctasks"></div>
      <div class="addtask">
        <input id="tt" maxlength="60" placeholder="Titel, bv. Handtekeningenjacht">
        <input id="td" maxlength="200" placeholder="Wat moeten ze doen?">
        <input id="tc" maxlength="200" placeholder="Wat moet er op de foto te zien zijn?">
        ${seg('tdiff', [[1, '⭐ Makkelijk'], [2, '⭐⭐ Gemiddeld'], [3, '⭐⭐⭐ Moeilijk']])}
        <button class="btn alt" type="button" data-act="addDraftTask">+ Toevoegen</button>
      </div>
      <p class="hint">Nieuwe opdrachten komen automatisch in het archief.</p>
    </div>

    <div class="step" data-step="4">
      <h2>Klopt alles?</h2>
      <div id="summary"></div>
      <button class="btn big" data-act="create">Spel aanmaken</button>
    </div>

    <div class="wnav">
      <button class="btn ghost" type="button" data-act="step" data-rel="-1" id="wprev">‹ Vorige</button>
      <button class="btn" type="button" data-act="step" data-rel="1" id="wnext">Volgende ›</button>
    </div>
  </section>`;
  syncCreate(); renderDraftTasks(); showStep();
  S.archive = await db.get('archive').catch(() => null) || {};
  renderArcList();
}

function draftTasks() {
  const d = S.draft;
  return [...d.tasks, ...(d.useArchive === 'ja' ? mergedArchive().filter(a => !d.skip[a.key] && !d.tasks.some(t => slug(t.title) === slug(a.title))) : [])];
}
const draftDuration = () => (S.draft.duration === 'custom' ? Math.max(5, +S.draft.customDur || 60) : S.draft.duration);

// Geeft de eerste stap terug waar nog iets ontbreekt, of -1.
function firstInvalid(upTo) {
  const d = S.draft;
  if (upTo > 0 && !d.name.trim()) { toast('Vul eerst je naam in'); return 0; }
  if (upTo > 1 && !d.place) { toast('Kies een centrum uit de suggesties'); return 1; }
  if (upTo > 3 && !draftTasks().length) { toast('Voeg minstens één opdracht toe of gebruik het archief'); return 3; }
  return -1;
}

function showStep() {
  const d = S.draft, n = d.step;
  $$('.step').forEach(el => { el.hidden = +el.dataset.step !== n; });
  $$('.steps button').forEach((b, i) => { b.classList.toggle('on', i === n); b.classList.toggle('done', i < n); });
  $('#wprev').hidden = n === 0; $('#wnext').hidden = n === STEPS.length - 1;
  if (n === 1 && d.place) showPreview().then(() => S.pmap?.map.resize());
  if (n === 4) {
    const row = (step, icon, label, val) => `<button type="button" class="sumrow" data-act="step" data-n="${step}"><span>${icon}</span><span><small>${label}</small><b>${val}</b></span><em>Wijzig</em></button>`;
    $('#summary').innerHTML =
      row(0, '👤', 'Leiding', `${esc(d.name)} · ${d.hostPlays === 'ja' ? 'speelt mee' : 'speelt niet mee'}`) +
      row(0, d.mode === 'leger' ? '⚔️' : '🏰', 'Spel', d.mode === 'leger' ? 'Leger' : 'Verover') +
      row(1, '📍', 'Speelveld', `${esc(d.place.name.split(',')[0])} · ${d.radius} m · ${d.zoneCount} zones${d.gps === 'ja' ? '' : ' · zonder gps'}`) +
      row(2, '⏳', 'Speelduur', fmtDur(draftDuration())) +
      row(2, '👥', 'Groepen', `${d.teamCount} groepen · ${d.teamMode === 'random' ? 'willekeurig' : 'zelf verdelen'}`) +
      row(3, '🎯', 'Opdrachten', `${draftTasks().length} opdrachten${d.tasks.length ? ` (${d.tasks.length} eigen)` : ''}`);
  }
  window.scrollTo(0, 0);
}
A.step = d => {
  const cur = S.draft.step;
  let n = d.rel ? cur + +d.rel : +d.n;
  n = Math.max(0, Math.min(STEPS.length - 1, n));
  if (n > cur) { const bad = firstInvalid(n); if (bad >= 0) n = bad; }
  S.draft.step = n; showStep();
};

// Standaardopdrachten uit de code, aangevuld en overschreven door wat in de database staat.
function mergedArchive() {
  const all = {};
  DEFAULT_TASKS.forEach(t => { all[slug(t.title)] = t; });
  Object.entries(S.archive || {}).forEach(([k, t]) => { all[k] = t; });
  return Object.entries(all).filter(([, t]) => !t.deleted).map(([key, t]) => ({ key, ...t }));
}

// Verwijderen uit het archief zit achter een wachtwoord (enkel de hash staat in de code).
const DEL_HASH = 'ae9aa92f1ff9ddcc45c72a701c8b62912ef7544383cef8ef36577c1ec5d51a1b';
async function mayDelete() {
  if (S.delOk) return true;
  const pw = prompt('Wachtwoord om te verwijderen');
  if (pw == null) return false;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('stadsspel:' + pw));
  S.delOk = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('') === DEL_HASH;
  if (!S.delOk) toast('Verkeerd wachtwoord');
  return S.delOk;
}

function renderArcList() {
  const el = $('#arclist'); if (!el) return;
  const d = S.draft, list = mergedArchive().sort((a, b) => a.diff - b.diff || a.title.localeCompare(b.title));
  $('#arcn').textContent = list.filter(t => !d.skip[t.key]).length;
  el.innerHTML = list.map(t => `<label class="arcrow"><input type="checkbox" data-chg="arcTog" data-k="${esc(t.key)}" ${d.skip[t.key] ? '' : 'checked'}><span><b>${esc(t.title)}</b> ${'⭐'.repeat(t.diff || 1)}<small>${esc(t.desc)}</small></span></label>`).join('');
}
A.arcTog = (d, el) => { if (el.checked) delete S.draft.skip[d.k]; else S.draft.skip[d.k] = true; $('#arcn').textContent = mergedArchive().filter(t => !S.draft.skip[t.key]).length; };

function syncCreate(changed) {
  const d = S.draft; if (!d || S.view !== 'create') return;
  $$('[data-if]').forEach(el => { const [f, v] = el.dataset.if.split('='); el.hidden = String(d[f]) !== v; });
  $$('input[type=range]').forEach(r => r.style.setProperty('--p', (r.value - r.min) / (r.max - r.min) * 100 + '%'));
  $('#radv').textContent = `${d.radius} m rond het centrum (±${Math.round(d.radius * 2 / 75)} min wandelen van rand tot rand)`; $('#zcv').textContent = d.zoneCount; $('#tcv').textContent = d.teamCount;
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
  $('#ctn').textContent = S.draft.tasks.length ? `(${S.draft.tasks.length})` : '';
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
  const bad = firstInvalid(STEPS.length);
  if (bad >= 0) { d.step = bad; return showStep(); }
  const list = draftTasks(), duration = draftDuration();
  btn.disabled = true; btn.textContent = 'De stad wordt verdeeld…';
  try {
    const { zones: zs, osm } = await generateZones(d.place, d.radius, d.zoneCount);
    let code; do { code = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.random() * 24 | 0]).join(''); } while (await db.get(`rooms/${code}/meta`));
    const tasks = {}; list.forEach((t, i) => { tasks['t' + i] = withReward(t); });
    ls('name', name);
    await db.set('rooms/' + code, {
      meta: { code, host: S.pid, mode: d.mode, center: d.place, radius: d.radius, duration, phase: 'lobby', teamMode: d.teamMode, teamCount: d.teamCount, gps: d.gps === 'ja', osm, createdAt: db.now() },
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

  // nieuw bewijs dat op de leiding wacht
  const waiting = Object.entries(S.room.subs || {}).filter(([, s]) => s.status === 'pending');
  if (S.pendSeen && me.sup) waiting.filter(([id]) => !S.pendSeen.has(id)).forEach(([id, s]) => notifySup(id, s));
  S.pendSeen = new Set(waiting.map(([id]) => id));

  if (m.phase !== 'lobby') {
    if (me.sup && !S.posSub) { S.posSub = true; S.unsub.push(db.on('pos/' + S.code, v => { S.others = v || {}; updateMap(); })); }
    const T = myTeam();
    if (T && ((m.phase === 'travel' && T.arrived) || m.phase === 'playing') && !ls('intro-' + S.code)) { ls('intro-' + S.code, '1'); playIntro(m.mode); }
    if (phase() === 'ended') saveHistory();
    if (phase() === 'ended' && !S.endShown) { S.endShown = true; S.sheet = { t: 'score' }; }
  }
  render();
}

// Trilling, geluid en (als het mag) een systeemmelding. Werkt zolang de app open of op de achtergrond staat.
async function notifySup(sid, sub) {
  const body = `${S.room.teams?.[sub.team]?.name || 'Een groep'} · ${S.room.tasks?.[sub.task]?.title || 'opdracht'}`;
  try { navigator.vibrate?.([200, 100, 200]); } catch { /* niet ondersteund */ }
  try {
    const ac = S.audio || (S.audio = new (window.AudioContext || window.webkitAudioContext)());
    [0, 0.18].forEach((t, i) => { const o = ac.createOscillator(), g = ac.createGain(); o.frequency.value = i ? 990 : 740; g.gain.value = 0.15; o.connect(g).connect(ac.destination); o.start(ac.currentTime + t); o.stop(ac.currentTime + t + 0.14); });
  } catch { /* geen geluid */ }
  if (window.Notification?.permission === 'granted') {
    try { (await navigator.serviceWorker.ready).showNotification('Nieuw bewijs om na te kijken', { body, tag: 'sub-' + sid, renotify: true }); } catch (e) { console.warn(e); }
  }
}
A.notifOn = async () => {
  try { S.audio = S.audio || new (window.AudioContext || window.webkitAudioContext)(); } catch { /* geen geluid */ }
  const r = await Notification.requestPermission();
  toast(r === 'granted' ? 'Meldingen staan aan' : 'Meldingen zijn geweigerd in je browser');
  renderSheet();
};

function render() {
  const inGame = meta().phase !== 'lobby';
  $('#screen').hidden = inGame; $('#game').hidden = !inGame;
  if (!inGame) return renderLobby();
  ensureMap(); startGps(); renderHud(); updateMap();
  if (S.sheet && !(S.sheet.t === 'sup' && S.sheet.tab === 'task')) renderSheet();
}

/* ---------- lobby ---------- */
function renderLobby() {
  const m = meta(), me = Me(), host = m.host === S.pid, P = Object.entries(S.room.players), manual = m.teamMode === 'manual';
  const link = location.origin + location.pathname + '?code=' + m.code;
  const teams = TEAMS.slice(0, m.teamCount);
  const validTeam = p => !!p.team && +p.team.slice(1) < m.teamCount;
  const row = ([pid, p]) => {
    const self = pid === S.pid;
    const role = self && host ? '' : `<select data-chg="setRole" data-p="${pid}">
      <option value="sup" ${p.sup ? 'selected' : ''}>👑 Leiding</option>
      ${manual ? `<option value="" ${!p.sup && !validTeam(p) ? 'selected' : ''}>Nog geen groep</option>` + teams.map((t, i) => `<option value="t${i}" ${!p.sup && p.team === 't' + i ? 'selected' : ''}>${t.name}</option>`).join('')
      : `<option value="play" ${p.sup ? '' : 'selected'}>🎲 Speler</option>`}
    </select>`;
    const supTeam = p.sup && p.plays && manual ? `<select data-chg="setTeam" data-p="${pid}"><option value="">Groep…</option>${teams.map((t, i) => `<option value="t${i}" ${p.team === 't' + i ? 'selected' : ''}>${t.name}</option>`).join('')}</select>` : '';
    return `<div class="prow"><div><b>${esc(p.name)}</b>${self ? ' (jij)' : ''}${pid === m.host ? ' <span class="tag">host</span>' : ''}</div>
      ${host ? `<div class="pctl">${p.sup ? `<button class="mini ${p.plays ? 'on' : ''}" data-act="togPlays" data-p="${pid}">speelt mee</button>` : ''}${supTeam}${role}</div>`
      : p.sup && p.plays ? '<span class="tag">speelt mee</span>' : ''}</div>`;
  };
  const group = (title, color, list, empty) => `<div class="grp" style="--c:${color}"><h4>${title} <span>${list.length}</span></h4>${list.map(row).join('') || `<p class="hint">${empty}</p>`}</div>`;
  const sups = P.filter(([, p]) => p.sup), players = P.filter(([, p]) => !p.sup);
  let groups = group('👑 Leiding', '#5a3d22', sups, '');
  if (manual) {
    groups += teams.map((t, i) => {
      const extra = sups.filter(([, p]) => p.plays && p.team === 't' + i).map(([, p]) => `<p class="hint">👑 ${esc(p.name)} speelt mee</p>`).join('');
      return group(t.name, t.color, players.filter(([, p]) => p.team === 't' + i), extra ? '' : 'Nog niemand') + extra;
    }).join('');
    const rest = players.filter(([, p]) => !validTeam(p));
    if (rest.length) groups += group('Nog geen groep', '#8a7a5c', rest, '');
  } else groups += group('🎲 Spelers', '#a3322a', players, 'Nog niemand. Deel de code!') + `<p class="hint">Bij de start worden de spelers willekeurig verdeeld over ${m.teamCount} groepen.</p>`;

  setHTML($('#screen'), `<section class="card">
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
    ${host ? '<p class="hint">Kies per deelnemer of die leiding is of meespeelt. Leiding die ook wil spelen: tik op "speelt mee".</p>' : ''}
    ${groups}

    ${host ? `<h3>Groepen</h3>
      <div class="stepper"><button data-act="teamCount" data-d="-1">−</button><b>${m.teamCount} groepen</b><button data-act="teamCount" data-d="1">+</button></div>
      <button class="btn big" data-act="startTravel">Stuur de groepen op pad</button>`
    : `<p class="note">${me.sup ? 'Je bent leiding. ' : ''}Wacht tot de leiding het spel start…</p>`}
  </section>`);
}
A.setRole = (d, el) => {
  const v = el.value, path = `${R()}/players/${d.p}`;
  if (v === 'sup') db.update(path, { sup: true, plays: false });
  else db.update(path, { sup: false, plays: true, team: v.startsWith('t') ? v : '' });
};
A.regen = async (_, btn) => {
  const m = meta(); btn.disabled = true; btn.textContent = 'Bezig…';
  const { zones: zs, osm } = await generateZones(m.center, m.radius, zones().length);
  await db.update(R(), { zonesJson: JSON.stringify(zs), 'meta/osm': osm });
  if (!osm) toast('Nog steeds geen straatdata. Probeer het zo meteen opnieuw.');
};
A.copy = d => navigator.clipboard?.writeText(d.t).then(() => toast('Link gekopieerd'), () => toast(d.t));
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
    return { id: z.id, lng: z.c[0], lat: z.c[1], color: t ? t.color : '#8a7a5c', cls: (t ? 'own' : '') + (z.id === S.zoneId ? ' here' : ''), html: (t ? `<b>${seesPower(s.owner) ? s.power : '🛡️'}</b>` : '') + `<span>${esc(z.name)}</span>` };
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
      banner = `🚩 Ga met je groep naar <b>${esc(z.name)}</b>${d != null && S.zoneId !== T.start ? ` · nog ±${Math.max(10, Math.round(d / 10) * 10)} m` : ''}
        <button class="btn small" data-act="arrive" ${canAct(T.start) ? '' : 'disabled'}>We zijn er!</button>${m.gps && !S.pos ? `<small>${esc(S.gpsErr || 'Wachten op gps…')}</small>` : ''}`;
    } else if (T) banner = '✅ Jullie staan klaar. Wacht op het startsein van de leiding.';
    if (me.sup) {
      const all = Object.values(teams), n = all.filter(t => t.arrived).length;
      banner += `<div>${T ? '' : `Groepen op hun startpunt: <b>${n}/${all.length}</b>`} <button class="btn small" data-act="startGame">▶ Start het spel</button></div>`;
    }
  } else if (ph === 'playing') {
    if (!T && !me.sup) banner = '';
    else if (S.zoneId) { const z = zoneById(S.zoneId), s = zst(S.zoneId), o = teams[s.owner]; banner = `📍 <b>${esc(z.name)}</b> · ${o ? `<span class="tag" style="--c:${o.color}">${o.name}${seesPower(s.owner) ? ' · ' + s.power : ''}</span>` : 'onbezet'} <button class="btn small" data-act="openZone" data-z="${S.zoneId}">Bekijk</button>`; }
    else if (!m.gps || me.sup) banner = 'Tik op een zone op de kaart.';
    else banner = S.pos ? 'Je bent buiten het speelveld.' : esc(S.gpsErr || 'Wachten op gps…');
  } else banner = `🏁 <b>Het spel is afgelopen!</b> <button class="btn small" data-act="sheet" data-t="score">Eindstand</button>`;

  setHTML($('#hud'), `<div class="top">
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
    </nav>`);
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
  // Het kader wordt één keer opgebouwd (met inschuif-animatie); daarna verandert enkel de inhoud.
  if (el.hidden || !$('.sheet-body', el)) {
    el.hidden = false;
    el.innerHTML = '<div class="sheet-card anim"><button class="x close" data-act="close">✕</button><div class="sheet-body"></div></div>';
  }
  const b = $('.sheet-body', el), top = b.scrollTop, same = S.sheetKey === s.t + (s.id || s.zid || s.tab || '');
  if (setHTML(b, body)) b.scrollTop = same ? top : 0;
  S.sheetKey = s.t + (s.id || s.zid || s.tab || '');
}

const statusTag = st => ({ uploading: '⏳ wordt verstuurd', checking: '⏳ wordt nagekeken', pending: '⏳ bij de leiding', ai_rejected: '✗ afgekeurd door AI', rejected: '✗ afgekeurd', approved: '✓ goedgekeurd' }[st] || '');
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
  else if (last?.status === 'checking' || last?.status === 'uploading') action = '<div class="busy"><div class="spin"></div>De scheidsrechter bekijkt jullie bewijs…</div>';
  else if (last?.status === 'pending') action = `<p class="note">⏳ Jullie bewijs ligt bij de leiding.${last.aiErr ? `<small>De automatische controle lukte niet (${esc(last.aiErr)}), dus de leiding beslist.</small>` : ''}</p>`;
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
    const sid = await db.push(R() + '/subs', { team: me.team, task: tid, zone: zone || '', by: me.name, status: 'uploading', ts: db.now(), video: media.video });
    if (media.thumb) await db.set(`photos/${S.code}/${sid}`, media.thumb);
    if (aiProxyUrl && media.ai) {
      busy('De scheidsrechter bekijkt je bewijs…');
      let res = null, err = '';
      try { res = await verify(aiProxyUrl, S.code, task, media.ai); } catch (e) { console.warn(e); err = e.message; }
      if (res?.ok) { await db.update(`${R()}/subs/${sid}`, { ai: res.reden }); await approve(sid); }
      else if (res) await db.update(`${R()}/subs/${sid}`, { status: 'ai_rejected', ai: res.reden });
      else await db.update(`${R()}/subs/${sid}`, { status: 'pending', aiErr: err });
    } else await db.update(`${R()}/subs/${sid}`, { status: 'pending' });
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
  const won = before.owner !== tid && P > before.power, mineNow = Me()?.team === tid;
  if (before.owner === tid) log(`${T} versterkt ${Z}`, tid);
  else if (won) log(old ? `${T} verovert ${Z} van ${old}!` : `${T} verovert ${Z}`, tid);
  else log(`${T} valt ${Z} aan, maar ${old} houdt stand`, before.owner);
  // Enkel de aanvaller zelf krijgt cijfers, en alleen over wat nu van hem is.
  if (mineNow && won && old) toast(`Gewonnen! Er blijven ${P - before.power} van jullie soldaten over in ${Z}.`);
  if (mineNow && !won && before.owner !== tid) toast(`Aanval op ${Z} mislukt: de verdediging was te sterk.`);
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
      const out = mine ? `Zone wordt ${s.power + P} sterk` : !o ? 'Deze zone is onbezet: ze wordt van jullie.' : 'Jullie weten niet hoeveel verdedigers hier staan. Is jullie aanval sterker, dan is de zone van jullie.';
      body = `<p class="hint">Hoeveel soldaten zet je in?</p>
        ${UNITS.map(x => `<div class="unit"><div class="uicon">${x.icon}</div><div><b>${x.name}</b><small>kracht ${x.power} · in bezit ${u[x.id] || 0}</small></div>
          <div class="stepper"><button data-act="dep" data-u="${x.id}" data-d="-1">−</button><b>${d[x.id] || 0}</b><button data-act="dep" data-u="${x.id}" data-d="1">+</button><button class="max" data-act="dep" data-u="${x.id}" data-d="99">max</button></div></div>`).join('')}
        ${P ? `<p class="note">${out}</p>` : ''}
        <button class="btn big" data-act="deploy" ${P ? '' : 'disabled'}>${mine ? '🛡️ Verdedig' : o ? '⚔️ Val aan' : '🏳️ Verover'}${P ? ` met kracht ${P}` : ''}</button>
        ${Object.values(u).some(v => v > 0) ? '' : '<p class="hint">Geen soldaten meer? Doe opdrachten en koop er in de winkel.</p>'}`;
    }
  }
  return `<h2>${esc(z.name)}</h2>
    <div class="facts">${o ? `<span class="tag" style="--c:${o.color}">${o.name}</span><span>🛡️ sterkte ${seesPower(s.owner) ? s.power : 'geheim'}</span>` : '<span>🏳️ Onbezet</span>'}${zid === S.zoneId ? '<span>📍 Je bent hier</span>' : ''}</div>${body}`;
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
    return { id, ...t, zones: own.length, power: own.reduce((a, z) => a + zst(z.id).power, 0), secret: !seesPower(id) };
  }).sort((a, b) => b.zones - a.zones || b.power - a.power);
}
// Gelijke stand (zelfde aantal zones en zelfde sterkte) geeft een gedeelde plaats.
const sameScore = (a, b) => a.zones === b.zones && a.power === b.power;
function scoreRows(sc, final) {
  const winners = sc.filter(t => sameScore(t, sc[0]));
  const head = !final || !sc.length ? '' : winners.length > 1
    ? `<div class="winner" style="--c:#5a3d22">🤝 Gelijkspel: ${winners.map(t => esc(t.name)).join(' en ')}</div>`
    : `<div class="winner" style="--c:${sc[0].color}">👑 ${esc(sc[0].name)} wint!</div>`;
  return head + sc.map(t => `<div class="srow" style="--c:${t.color}"><span class="rank">${sc.findIndex(o => sameScore(o, t)) + 1}</span><b>${esc(t.name)}</b><span>🗺️ ${t.zones}</span>${t.secret ? '' : `<span>🛡️ ${t.power}</span>`}</div>`).join('');
}
function shScore() {
  const ended = phase() === 'ended';
  return `<h2>${ended ? '🏁 Eindstand' : 'Stand'}</h2>
    ${scoreRows(score(), ended)}
    <p class="hint">Gerangschikt op aantal zones, daarna op totale sterkte.${ended ? '' : ' De sterkte van andere groepen blijft geheim tot het einde.'}</p>`;
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
    const order = { pending: 0, checking: 1, uploading: 1, ai_rejected: 2 };
    const subs = Object.entries(S.room.subs || {}).map(([id, s]) => ({ id, ...s })).sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3) || b.ts - a.ts).slice(0, 40);
    body = subs.map(s => { const t = S.room.tasks[s.task] || {}, T = teams[s.team] || {}, open = s.status !== 'approved' && s.status !== 'rejected';
      return `<div class="sub-card ${open ? '' : 'closed'}">
        <div><span class="tag" style="--c:${T.color}">${esc(T.name)}</span> <b>${esc(t.title)}</b> <span class="prize">${prize(t)}</span></div>
        <small>${esc(t.check || t.desc)}</small>
        <small>door ${esc(s.by)} · ${new Date(s.ts).toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit' })}${s.video ? ' · 🎥 video (enkel een beeld bewaard)' : ''}${s.zone ? ' · 📍 ' + esc(zoneById(s.zone)?.name) : ''}</small>
        <small><b>${statusTag(s.status)}</b>${s.ai ? ' · AI: ' + esc(s.ai) : ''}${s.aiErr ? ' · AI lukte niet: ' + esc(s.aiErr) : ''}</small>
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
  const notif = !('Notification' in window) ? '<p class="hint">🔔 Meldingen: zet deze site eerst op je beginscherm (Deel → Zet op beginscherm) en open ze van daar.</p>'
    : Notification.permission === 'granted' ? '' : '<button class="btn alt small" data-act="notifOn">🔔 Meldingen bij nieuw bewijs aanzetten</button>';
  body = notif + body;
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
navigator.serviceWorker?.register('sw.js').catch(e => console.warn(e));
(async () => {
  const saved = ls('code'), link = (params.get('code') || '').toUpperCase();
  if (saved && (!link || link === saved) && await db.get(`rooms/${saved}/players/${S.pid}`).catch(() => null)) return enterRoom(saved);
  go(link ? 'join' : 'home');
})();
