import { db, isLocal } from './db.js';
import { aiProxyUrl, vapidKey } from './config.js';
import { TEAMS, UNITS, DURATIONS, DEFAULT_TASKS, DUELS, REWARD, START_POWER } from './data.js';
import { generateZones, zoneAt, pickStarts, dist } from './zones.js';
import { makeMap } from './map.js';
import { prepareMedia, verify } from './ai.js';
import { playIntro } from './intro.js';
import { figure } from './figures.js';

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

// Eigen venster in plaats van de prompt/confirm van de browser.
// Geeft de ingevulde tekst (of true zonder invulveld) terug, en null bij annuleren.
function ask({ title, text = '', input = null, ok = 'OK', cancel = 'Annuleren' }) {
  return new Promise(done => {
    const el = document.createElement('div');
    el.className = 'modal';
    el.innerHTML = `<form class="modal-card"><h2>${esc(title)}</h2>${text ? `<p>${esc(text)}</p>` : ''}
      ${input ? `<input type="${input.type || 'text'}" maxlength="60" autocomplete="off" placeholder="${esc(input.placeholder || '')}" value="${esc(input.value || '')}">` : ''}
      <div class="row"><button type="button" class="btn ghost" data-x>${esc(cancel)}</button><button class="btn">${esc(ok)}</button></div></form>`;
    const inp = $('input', el), close = v => { el.remove(); done(v); };
    el.onsubmit = e => { e.preventDefault(); close(inp ? inp.value : true); };
    el.onclick = e => { if (e.target === el || e.target.closest('[data-x]')) close(null); };
    document.body.appendChild(el);
    (inp || $('.btn:not(.ghost)', el)).focus();
  });
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
const modeLabel = m => ({ leger: '⚔️ Leger', verover: '🏰 Verover', duel: '🤺 Duel' })[m] || m;

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
  if (e.target.id === 'pkcode') S.packCode = e.target.value;
  if (e.target.id === 'newsin') S.newsDraft = e.target.value;
});
document.addEventListener('submit', e => {
  if (e.target.id !== 'chatform') return;
  e.preventDefault();
  const i = $('#chatin'); sendChat(i.value, S.sheet?.tab || 'all'); i.value = ''; i.focus();
});
document.addEventListener('change', e => {
  const d = e.target.dataset || {};
  if (d.chg) A[d.chg]?.(d, e.target);
  if (d.file && e.target.files[0]) { onFile(d.file, e.target.files[0]); e.target.value = ''; }
  if (d.packfile && e.target.files[0]) { onPackFile(e.target.files[0]); e.target.value = ''; }
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
      <div><b>${g.title ? esc(g.title) : '📍 ' + esc((g.place || '').split(',')[0])}</b> <span class="tag">${modeLabel(g.mode)}</span></div>
      <small>${new Date(g.date).toLocaleDateString('nl-BE', { day: 'numeric', month: 'long', year: 'numeric' })} · ${fmtDur(g.duration)} · ${g.players} deelnemers · ${g.zones} zones</small>
      ${scoreRows(g.score || [], true)}
      <div class="row"><button class="btn small ghost" data-act="histRename" data-id="${esc(g.id)}" data-t="${esc(g.title || (g.place || '').split(',')[0])}">✏️ Naam wijzigen</button><button class="btn small ghost" data-act="histDel" data-id="${esc(g.id)}">🗑️ Verwijderen</button></div>
    </div>`).join('') || '<p class="note">Nog geen afgelopen spellen. Een spel komt hier te staan zodra het afgelopen is.</p>');
}
A.arch = d => { S.archEdit = null; viewArchive(d.tab); };
A.archEdit = async d => { if (d.k && d.k !== 'new' && !await mayEdit()) return; S.archEdit = d.k || null; viewArchive('tasks').then(() => S.archEdit && window.scrollTo(0, 0)); };
A.archSave = async () => {
  const title = $('#at').value.trim(); if (!title) return toast('Geef de opdracht een titel');
  const isNew = S.archEdit === 'new', key = isNew ? slug(title) || 'x' + rid() : S.archEdit;
  if (isNew && mergedArchive().some(t => t.key === key)) return toast('Er bestaat al een opdracht met deze titel. Wijzig die, of kies een andere titel.');
  if (!isNew && !await mayEdit()) return;
  await db.set('archive/' + key, withReward({ title, desc: $('#ad').value.trim(), check: $('#ac').value.trim(), diff: +$('#adiff').value }));
  S.archEdit = null; viewArchive('tasks');
};
A.archDel = async d => {
  if (!await mayEdit() || !await ask({ title: 'Opdracht verwijderen?', text: `"${d.t}" verdwijnt uit het archief.`, ok: 'Verwijderen' })) return;
  await db.set('archive/' + d.k, { deleted: true, title: d.t });
  viewArchive('tasks');
};
A.histRename = async d => {
  if (!await mayEdit()) return;
  const t = await ask({ title: 'Naam van dit spel', input: { value: d.t }, ok: 'Opslaan' });
  if (t && t.trim()) { await db.set(`history/${d.id}/title`, t.trim().slice(0, 60)); viewArchive(); }
};
A.histDel = async d => {
  if (await mayEdit() && await ask({ title: 'Spel verwijderen?', text: 'Dit spel verdwijnt uit het archief. Dat kan niet ongedaan gemaakt worden.', ok: 'Verwijderen' })) { await db.set('history/' + d.id, null); viewArchive(); }
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
  S.pendSeen = S.prevOwn = S.reqSeen = S.curSeen = S.taskSeen = S.duelSeen = S.buzzSeen = S.packSeen = S.chatSeen = S.gpsSeen = null;
  Object.assign(S, { room: null, sheet: null, sel: null, zoneId: null, others: {}, photos: {}, endShown: false, histSaved: false });
  $('#hud')._h = $('#sheet')._h = $('#screen')._h = null;
  $('#sheet').hidden = true;
  if (!keep) { S.code = ''; ls('code', null); go('home'); }
}
A.leave = async () => { if (await ask({ title: 'Spel verlaten?', text: 'Met de roomcode kan je later opnieuw meedoen.', ok: 'Verlaten' })) leaveRoom(); };

/* ---------- spel aanmaken ---------- */
const STEPS = ['Start', 'Speelveld', 'Tijd & groepen', 'Opdrachten', 'Overzicht'];

async function viewCreate() {
  const d = S.draft = S.draft || { step: 0, name: ls('name') || '', hostPlays: 'nee', mode: 'duel', place: { name: 'Grote Markt, Poperinge, België', lat: 50.85563, lng: 2.72652 }, radius: 600, zoneCount: 20, duration: 120, customDur: 100, teamMode: 'random', teamCount: 5, ai: 'nee', taskMode: 'list', skipWait: 3, useArchive: 'ja', gps: 'ja', tasks: [], tdiff: 1, skip: {} };
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
      ${seg('mode', [['duel', card('🤺', 'Duel', 'Vrije zones claim je met de opdracht van die zone. Een zone van een andere groep pak je af met een duel. Met buzzer-rondes en pakketjes.')], ['leger', card('⚔️', 'Leger', 'Opdrachten leveren goud op. Daarmee koop je soldaten en val je zones aan.')], ['verover', card('🏰', 'Verover', 'Geen winkel: elke goedgekeurde opdracht versterkt meteen de zone waar je staat.')]], 'cards')}
    </div>

    <div class="step" data-step="1">
      <h2>Waar spelen jullie?</h2>
      <label>Centrum van het spel<input id="loc" autocomplete="off" placeholder="Typ een stad, plein of adres…" value="${esc(d.place?.name || '')}"></label>
      <button type="button" class="btn small ghost" data-act="useMyLoc">📍 Gebruik mijn huidige locatie</button>
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
      <p class="q">Automatische fotocontrole?</p>
      ${seg('ai', [['nee', card('👑', 'Enkel de leiding', 'De leiding keurt elk bewijs zelf goed of af.')], ['ja', card('🤖', 'Met AI', 'Een AI kijkt het bewijs eerst na. Afgekeurd? Dan kan de groep de leiding laten kijken.')]], 'cards')}
      <div data-ifnot="mode=duel">
      <p class="q">Hoe krijgen de groepen hun opdrachten?</p>
      ${seg('taskMode', [['list', card('📜', 'Lijst', 'Elke groep kiest zelf uit alle opdrachten.')], ['random', card('🎲', 'Willekeurig', 'Elke groep krijgt telkens één willekeurige opdracht. Een andere krijgen ze enkel als de leiding dat toestaat.')]], 'cards')}
      <div data-if="taskMode=random">
        <p class="q">Hoe lang moeten ze het proberen voor ze een andere mogen vragen?</p>
        ${seg('skipWait', [[0, 'Meteen'], [1, '1 min'], [3, '3 min'], [5, '5 min'], [10, '10 min'], [15, '15 min']], 'grid')}
        <p class="hint">De leiding kan altijd zelf een opdracht geven aan een groep.</p>
      </div>
      </div>
      <p class="hint" data-if="mode=duel">In modus Duel krijgt elke zone vast één van deze opdrachten.</p>
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
      row(0, '🎮', 'Spel', modeLabel(d.mode)) +
      row(1, '📍', 'Speelveld', `${esc(d.place.name.split(',')[0])} · ${d.radius} m · ${d.zoneCount} zones${d.gps === 'ja' ? '' : ' · zonder gps'}`) +
      row(2, '⏳', 'Speelduur', fmtDur(draftDuration())) +
      row(2, '👥', 'Groepen', `${d.teamCount} groepen · ${d.teamMode === 'random' ? 'willekeurig' : 'zelf verdelen'}`) +
      row(3, '🎯', 'Opdrachten', `${draftTasks().length} opdrachten${d.tasks.length ? ` (${d.tasks.length} eigen)` : ''} · ${d.ai === 'ja' ? '🤖 met AI' : '👑 leiding keurt'} · ${d.mode === 'duel' ? 'één per zone' : d.taskMode === 'random' ? `willekeurig · andere vragen ${d.skipWait ? 'na ' + d.skipWait + ' min' : 'mag meteen'}` : 'zelf kiezen uit de lijst'}`);
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

// Wijzigen en verwijderen in het archief zit achter een wachtwoord (enkel de hash staat in de code).
// Eén keer juist ingeven volstaat: daarna onthoudt dit toestel dat het mag.
const DEL_HASH = 'ae9aa92f1ff9ddcc45c72a701c8b62912ef7544383cef8ef36577c1ec5d51a1b';
async function mayEdit() {
  if (ls('edit-ok')) return true;
  const pw = await ask({ title: '🔒 Wachtwoord', text: 'Het archief wijzigen of iets verwijderen kan enkel met het wachtwoord. Je geeft het op dit toestel maar één keer in.', input: { type: 'password', placeholder: 'Wachtwoord' }, ok: 'Ontgrendelen' });
  if (pw == null) return false;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('stadsspel:' + pw));
  const ok = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('') === DEL_HASH;
  if (ok) ls('edit-ok', '1'); else toast('Verkeerd wachtwoord');
  return ok;
}

// Zet een opdracht uit een spel in het archief, zonder een bestaande met dezelfde titel te overschrijven.
function archiveAdd(t) {
  const k = slug(t.title);
  if (!k || DEFAULT_TASKS.some(d => slug(d.title) === k)) return null;
  return db.tx('archive/' + k, cur => (cur && !cur.deleted ? undefined : withReward(t)));
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
  $$('[data-ifnot]').forEach(el => { const [f, v] = el.dataset.ifnot.split('='); el.hidden = String(d[f]) === v; });
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
A.useMyLoc = (_, btn) => {
  if (!navigator.geolocation) return toast('Je toestel geeft geen locatie door');
  const reset = () => { btn.disabled = false; btn.textContent = '📍 Gebruik mijn huidige locatie'; };
  btn.disabled = true; btn.textContent = '📍 Locatie zoeken…';
  navigator.geolocation.getCurrentPosition(async p => {
    const place = { name: 'Mijn locatie', lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6) };
    try {
      const pr = (await (await fetch(`https://photon.komoot.io/reverse?lon=${place.lng}&lat=${place.lat}`)).json()).features[0]?.properties;
      if (pr) place.name = [pr.name || pr.street, pr.city || pr.county].filter(Boolean).join(', ') || place.name;
    } catch { /* naam blijft "Mijn locatie" */ }
    reset();
    if (!S.draft || !$('#loc')) return;
    S.draft.place = place; $('#loc').value = place.name; $('#sugg').innerHTML = ''; showPreview();
  }, e => { reset(); toast(e.code === 1 ? 'Geef de app toegang tot je locatie' : 'Je locatie werd niet gevonden'); }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
};
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
      meta: { code, host: S.pid, mode: d.mode, center: d.place, radius: d.radius, duration, phase: 'lobby', teamMode: d.teamMode, teamCount: d.teamCount, taskMode: d.mode === 'duel' ? 'list' : d.taskMode, skipWait: d.skipWait, ai: d.ai === 'ja', gps: d.gps === 'ja', osm, createdAt: db.now() },
      zonesJson: JSON.stringify(zs), tasks,
      players: { [S.pid]: { name, sup: true, plays: d.hostPlays === 'ja', team: '' } },
    });
    for (const t of d.tasks) await archiveAdd(t);
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
  if (S.pendSeen && me.sup) waiting.filter(([id]) => !S.pendSeen.has(id)).forEach(([id, s]) => notifySup('sub-' + id, `${S.room.teams?.[s.team]?.name || 'Een groep'} · ${S.room.tasks?.[s.task]?.title || 'opdracht'}`));
  // een groep die een andere opdracht vraagt
  const reqs = Object.entries(S.room.teams || {}).filter(([, t]) => t.skipReq).map(([id, t]) => [id + ':' + t.skipReq, t]);
  if (S.reqSeen && me.sup) reqs.filter(([k]) => !S.reqSeen.has(k)).forEach(([k, t]) => notifySup('skip-' + k, `${t.name} wil een andere opdracht dan "${S.room.tasks?.[t.cur]?.title || '?'}"`, 'Vraag van een groep'));
  S.reqSeen = new Set(reqs.map(([k]) => k));

  // leden krijgen een seintje bij een nieuwe opdracht: hun nieuwe willekeurige opdracht, of een opdracht die de leiding toevoegt
  const mine = myTeam(), cur = mine?.cur || '', tids = Object.keys(S.room.tasks || {});
  if (S.curSeen && cur && cur !== S.curSeen) {
    const title = S.room.tasks?.[cur]?.title || '';
    toast('🎯 Nieuwe opdracht: ' + title, mine.color);
    notifySup('task-' + cur, title, '🎯 Nieuwe opdracht voor jullie groep');
  }
  if (S.taskSeen && mine && m.taskMode !== 'random') tids.filter(id => !S.taskSeen.has(id)).forEach(id => notifySup('task-' + id, S.room.tasks[id].title, '🎯 Nieuwe opdracht'));
  S.curSeen = cur; S.taskSeen = new Set(tids);

  // chat en mededelingen van de leiding
  const seen = S.chatSeen, now = new Set(), open = S.sheet?.t === 'chat' && !$('#sheet').hidden ? S.sheet.tab : null;
  chatChannels().forEach(([ch]) => chatMsgsOf(ch).forEach(c => {
    const k = ch + '/' + c.id; now.add(k);
    if (!seen || seen.has(k) || c.pid === S.pid) return;
    if (c.news) { notifySup('news-' + c.id, c.text, '📢 Mededeling van de leiding'); ask({ title: '📢 Mededeling van de leiding', text: c.text, ok: 'OK', cancel: 'Sluiten' }); }
    else if (open !== ch) { toast(`💬 ${c.by}: ${c.text}`.slice(0, 140), c.sup ? '#5a3d22' : S.room.teams?.[c.team]?.color); notifySup('chat-' + ch, c.text, `💬 ${c.by}${ch === 'all' ? '' : ' (privé)'}`); }
  }));
  S.chatSeen = now;

  // leiding: iemand geeft geen locatie meer door (toegang geweigerd of gps uit)
  if (me.sup) {
    const off = Object.entries(S.room.players || {}).filter(([, p]) => p.gpsOff).map(([pid, p]) => [pid + ':' + p.gpsOff.ts, p]);
    if (S.gpsSeen) off.filter(([k]) => !S.gpsSeen.has(k)).forEach(([k, p]) => notifySup('gps-' + k, `${p.name}${S.room.teams?.[p.team] ? ' (' + S.room.teams[p.team].name + ')' : ''} geeft geen locatie meer door. Kijk even waar die is.`, '📍 Locatie uit'));
    S.gpsSeen = new Set(off.map(([k]) => k));
  }

  // modus Duel: aanval op een zone van jullie, buzzer-ronde, nieuw pakketje
  if (m.mode === 'duel') {
    const live = liveDuels(), b = S.room.buzz, pk = Object.keys(S.room.packs || {});
    if (S.duelSeen && mine) live.filter(x => x.def === me.team && !S.duelSeen.has(x.zid + ':' + x.at)).forEach(x => {
      notifySup('duel-' + x.zid, `${S.room.teams[x.att].name} daagt jullie uit in ${zoneById(x.zid).name}. Ren terug: jullie hebben 3 minuten!`, '⚔️ Jullie zone wordt aangevallen!');
      openSheet({ t: 'duel', zid: x.zid });
    });
    if (S.buzzSeen != null && b?.id && b.id !== S.buzzSeen && mine) notifySup('buzz-' + b.id, `Ren met je hele groep naar ${b.label}!`, '🚨 Buzzer!');
    if (S.packSeen && mine) pk.filter(k => !S.packSeen.has(k)).forEach(k => notifySup('pack-' + k, 'Bekijk de foto bij Pakketjes en ga zoeken!', '📦 Nieuw pakketje verstopt!'));
    if (mine && b?.winner === me.team && !b.claimed && lockable(me.team).length && S.claimShown !== b.id) { S.claimShown = b.id; S.sheet = { t: 'claim' }; }
    S.duelSeen = new Set(live.map(x => x.zid + ':' + x.at)); S.buzzSeen = b?.id || ''; S.packSeen = new Set(pk);
  }
  S.pendSeen = new Set(waiting.map(([id]) => id));
  pushOn();

  // Wordt een zone veroverd, dan marcheren er soldaatjes naartoe vanuit de dichtstbijzijnde zone van die groep.
  const own = {}; zones().forEach(z => { own[z.id] = zst(z.id).owner || ''; });
  if (S.prevOwn && S.map && m.phase === 'playing') zones().forEach(z => {
    const o = own[z.id];
    if (!o || o === S.prevOwn[z.id]) return;
    const d2 = y => (y.c[0] - z.c[0]) ** 2 * 0.4 + (y.c[1] - z.c[1]) ** 2;
    const from = zones().filter(y => y.id !== z.id && S.prevOwn[y.id] === o).sort((a, b) => d2(a) - d2(b))[0];
    if (from) S.map.march(from.c, z.c, figure('squire', S.room.teams?.[o]?.color));
  });
  S.prevOwn = own;

  if (m.phase !== 'lobby') {
    if ((me.sup || m.mode === 'duel') && !S.posSub) { S.posSub = true; S.unsub.push(db.on('pos/' + S.code, v => { S.others = v || {}; updateMap(); if (isDuel()) { renderHud(); if (S.sheet?.t === 'sup' && S.sheet.tab === 'spel') renderSheet(); } })); }
    const T = myTeam();
    if (T && ((m.phase === 'travel' && T.arrived) || m.phase === 'playing') && !ls('intro-' + S.code)) { ls('intro-' + S.code, '1'); playIntro(m.mode); }
    if (phase() === 'ended') saveHistory();
    if (phase() === 'ended' && !S.endShown) { S.endShown = true; S.sheet = { t: 'score' }; }
  }
  render();
}

// Trilling, geluid en (als het mag) een systeemmelding. Werkt zolang de app open of op de achtergrond staat.
async function notifySup(tag, body, title = 'Nieuw bewijs om na te kijken') {
  try { navigator.vibrate?.([200, 100, 200]); } catch { /* niet ondersteund */ }
  try {
    const ac = S.audio || (S.audio = new (window.AudioContext || window.webkitAudioContext)());
    [0, 0.18].forEach((t, i) => { const o = ac.createOscillator(), g = ac.createGain(); o.frequency.value = i ? 990 : 740; g.gain.value = 0.15; o.connect(g).connect(ac.destination); o.start(ac.currentTime + t); o.stop(ac.currentTime + t + 0.14); });
  } catch { /* geen geluid */ }
  if (window.Notification?.permission === 'granted') {
    try { (await navigator.serviceWorker.ready).showNotification(title, { body, tag, renotify: true }); } catch (e) { console.warn(e); }
  }
}
// Echte pushmeldingen (ook met de gsm op slot) via Firebase Cloud Messaging en het tussenstation.
// Staat uit zolang config.js geen vapidKey heeft. Elk toestel dat meldingen toestaat, meldt zich per spel aan;
// het tussenstation beslist wie welke melding krijgt (leiding: bewijs en vragen, leden: nieuwe opdrachten).
async function pushOn() {
  if (!vapidKey || isLocal || S.pushCode === S.code || window.Notification?.permission !== 'granted') return;
  S.pushCode = S.code;
  try { const tok = await db.pushToken(vapidKey); if (tok) await db.set(`${R()}/push/${S.pid}`, tok); } catch (e) { console.warn('Pushmeldingen lukken niet', e); }
}
// soort: 'sub' (bewijs wacht op de leiding), 'skip' (groep vraagt een andere opdracht), 'task' (groep kreeg een opdracht), 'new' (opdracht toegevoegd)
function ping(kind, id, ch) {
  if (aiProxyUrl && vapidKey) fetch(aiProxyUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'notify', code: S.code, kind, id, ch }) }).catch(e => console.warn(e));
}
const notifBtn = () => (!('Notification' in window) || Notification.permission !== 'default' ? '' : '<button class="btn alt small center" data-act="notifOn">🔔 Meldingen bij een nieuwe opdracht aanzetten</button>');
A.notifOn = async () => {
  try { S.audio = S.audio || new (window.AudioContext || window.webkitAudioContext)(); } catch { /* geen geluid */ }
  const r = await Notification.requestPermission();
  toast(r === 'granted' ? 'Meldingen staan aan' : 'Meldingen zijn geweigerd in je browser');
  pushOn();
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
      <span>${modeLabel(m.mode)}</span><span>📍 ${esc(m.center.name.split(',')[0])}</span><span>⏳ ${fmtDur(m.duration)}</span>
      <span>🗺️ ${zones().length} zones</span><span>🎯 ${Object.keys(S.room.tasks || {}).length} opdrachten${m.taskMode === 'random' ? ' · 🎲 willekeurig' : ''}</span>
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
  if (m.mode === 'duel') Object.entries(zoneTasks()).forEach(([z, t]) => { upd['ztask/' + z] = t; });
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
    return { id: z.id, lng: z.c[0], lat: z.c[1], color: t ? t.color : '#8a7a5c', cls: (t ? 'own' : '') + (z.id === S.zoneId ? ' here' : ''), html: (t ? `<b>${isDuel() ? (s.locked ? '🔒' : duelOn(z.id) ? '⚔️' : shielded(s.owner) ? '🛡️' : '🚩') : seesPower(s.owner) ? s.power : '🛡️'}</b>` : isDuel() && duelOn(z.id) ? '<b>⚔️</b>' : '') + `<span>${esc(z.name)}</span>` };
  }));
  S.map.setMarkers('me', S.pos ? [{ ...S.pos, html: `<div class="me-dot" style="--c:${T?.color || '#3b2a17'}"></div>` }] : []);
  const start = T && meta().phase === 'travel' ? zoneById(T.start) : null;
  const bz = isDuel() && buzzOn(); S.lastBuzz = !!bz;
  S.map.setMarkers('buzz', bz ? [{ lng: bz.lng, lat: bz.lat, anchor: 'bottom', html: '<div class="flag">🚨</div>' }] : []);
  S.map.setMarkers('start', start ? [{ lng: start.c[0], lat: start.c[1], anchor: 'bottom', html: '<div class="flag">🚩</div>' }] : []);
  // Leiding ziet iedereen; wie al even geen locatie doorgaf, staat grijs met de laatst gekende plek.
  S.map.setMarkers('others', me?.sup ? Object.entries(S.others).filter(([pid, o]) => pid !== S.pid && db.now() - o.ts < 1800000).map(([pid, o]) => {
    const age = db.now() - o.ts, off = S.room.players?.[pid]?.gpsOff;
    return { lng: o.lng, lat: o.lat, anchor: 'bottom', html: `<div class="pin ${age > 180000 || off ? 'stale' : ''}" style="--c:${teams[o.team]?.color || '#3b2a17'}">${off ? '⚠ ' : ''}${esc(o.name)}${age > 180000 ? ' · ' + Math.round(age / 60000) + ' min' : ''}</div>` };
  }) : []);
  S.map.setMarkers('packs', me?.sup && isDuel() ? Object.values(S.room.packs || {}).filter(p => !p.usedBy && p.lat != null).map(p => ({ lng: p.lng, lat: p.lat, anchor: 'bottom', html: '<div class="flag pack">📦</div>' })) : []);
}

// Locatie kwijt (toegang geweigerd, of al een minuut geen gps): meld het aan de leiding, zodat die kan gaan kijken.
function gpsLost(code) {
  const me = Me();
  if (!S.room || meta().phase === 'lobby' || !plays(me) || me.gpsOff) return;
  if (code !== 1 && db.now() - (S.lastFix || S.gpsStart) < 60000) return;
  db.set(`${R()}/players/${S.pid}/gpsOff`, { code, ts: db.now() }).then(() => ping('gps', S.pid));
}
function startGps() {
  if (S.watch != null || !navigator.geolocation) return;
  let lastWrite = 0;
  S.gpsStart = db.now();
  S.watch = navigator.geolocation.watchPosition(p => {
    const m = meta(); if (!m.center) return;
    S.lastFix = db.now(); S.gpsErr = null;
    if (Me()?.gpsOff) db.set(`${R()}/players/${S.pid}/gpsOff`, null);
    S.pos = { lat: p.coords.latitude, lng: p.coords.longitude };
    S.zoneId = zoneAt(zones(), m.center, m.radius, S.pos.lng, S.pos.lat);
    if (db.now() - lastWrite > (isDuel() && buzzOn() ? 6000 : 20000)) { lastWrite = db.now(); const me = Me(); db.set(`pos/${S.code}/${S.pid}`, { ...S.pos, ts: lastWrite, name: me.name, team: me.team || '' }); }
    renderHud(); updateMap();
    if (S.sheet?.t === 'zone' || S.sheet?.t === 'task' || (S.sheet?.t === 'sup' && S.sheet.tab === 'spel')) renderSheet();
  }, e => { S.gpsErr = e.code === 1 ? 'Geef toegang tot je locatie om te kunnen spelen' : 'Geen gps-signaal'; renderHud(); gpsLost(e.code); }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
}

/* ---------- HUD ---------- */
function renderHud() {
  if (!S.room || meta().phase === 'lobby') return;
  const m = meta(), me = Me(), T = myTeam(), ph = phase(), teams = S.room.teams || {};
  const pending = Object.values(S.room.subs || {}).filter(s => s.status === 'pending').length + Object.values(teams).filter(t => t.skipReq).length;
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
    const db_ = isDuel() ? duelBanner() : '';
    if (!T && !me.sup) banner = db_;
    else if (db_) banner = db_;
    else if (S.zoneId) { const z = zoneById(S.zoneId), s = zst(S.zoneId), o = teams[s.owner]; banner = `📍 <b>${esc(z.name)}</b> · ${o ? `<span class="tag" style="--c:${o.color}">${o.name}${!isDuel() && seesPower(s.owner) ? ' · ' + s.power : ''}${s.locked ? ' 🔒' : ''}</span>` : isDuel() ? 'vrij' : 'onbezet'} <button class="btn small" data-act="openZone" data-z="${S.zoneId}">Bekijk</button>`; }
    else if (!m.gps || me.sup) banner = 'Tik op een zone op de kaart.';
    else banner = S.pos ? 'Je bent buiten het speelveld.' : esc(S.gpsErr || 'Wachten op gps…');
  } else banner = `🏁 <b>Het spel is afgelopen!</b> <button class="btn small" data-act="sheet" data-t="score">Eindstand</button>`;

  setHTML($('#hud'), `<div class="top">
      <div class="chip" style="--c:${T?.color || '#5a3d22'}">${T ? esc(T.name) : me.sup ? '👑 Leiding' : '…'}</div>
      ${T && m.mode === 'leger' ? `<div class="stat">💰 ${T.money}</div>` : ''}
      ${T && isDuel() && shielded(me.team) ? `<div class="stat">🛡️ ${cd(T.shieldUntil)}</div>` : ''}
      <div class="stat" id="timer"></div>
      <button class="iconbtn" data-act="sheet" data-t="menu">☰</button>
    </div>
    ${banner ? `<div class="banner">${banner}</div>` : ''}
    <nav class="nav">
      ${T ? `<button data-act="sheet" data-t="tasks">🎯<span>Opdrachten</span></button>` : ''}
      ${T && m.mode === 'leger' ? `<button data-act="sheet" data-t="shop">🛒<span>Winkel</span></button>` : ''}
      ${T && isDuel() ? `<button data-act="sheet" data-t="packs">📦<span>Pakketjes</span>${Object.values(S.room.packs || {}).some(p => !p.usedBy) ? '<i class="badge">!</i>' : ''}</button>` : ''}
      <button data-act="sheet" data-t="chat">💬<span>Chat</span>${unreadAll() ? `<i class="badge">${unreadAll()}</i>` : ''}</button>
      <button data-act="sheet" data-t="score">🏆<span>Stand</span></button>
      ${me.sup ? `<button data-act="sheet" data-t="sup">👑<span>Leiding</span>${pending ? `<i class="badge">${pending}</i>` : ''}</button>` : ''}
    </nav>`);
  setTimer(); countdowns();
}

function setTimer() {
  const el = $('#timer'), m = meta();
  if (el) el.textContent = m.phase === 'playing' ? '⏳ ' + fmtTime(m.endsAt - db.now()) : m.phase === 'travel' ? '⏳ ' + fmtDur(m.duration) : '🏁';
}
function tick() {
  const m = meta(); if (!S.room) return;
  setTimer();
  if (m.mode === 'duel' && m.phase === 'playing') {
    duelTimeouts(); renderHud();
    if (S.lastBuzz !== !!buzzOn()) updateMap();
  }
  countdowns();
  if (m.phase === 'playing' && db.now() >= m.endsAt) {
    if (Me()?.sup) db.set(R() + '/meta/phase', 'ended');
    else if (!S.endShown) onRoom();
  }
  if (!S.busy && (S.sheet?.t === 'task' || S.sheet?.t === 'tasks')) renderSheet(); // zodat een vastgelopen inzending vanzelf vrijkomt
}
setInterval(tick, 1000);

A.pickTeam = d => db.set(`${R()}/players/${S.pid}/team`, d.t);
A.arrive = () => db.set(`${R()}/teams/${Me().team}/arrived`, true);
A.openZone = d => { S.sel = d.z; S.deploy = {}; openSheet({ t: 'zone', zid: d.z }); updateMap(); };

A.startGame = async () => {
  const teams = S.room.teams || {}, waiting = Object.values(teams).filter(t => !t.arrived).map(t => t.name);
  if (waiting.length && !await ask({ title: 'Toch starten?', text: `Nog niet op het startpunt: ${waiting.join(', ')}.`, ok: 'Start het spel' })) return;
  const now = db.now(), upd = { 'meta/phase': 'playing', 'meta/startedAt': now, 'meta/endsAt': now + meta().duration * 60000 };
  Object.entries(teams).forEach(([id, t]) => { if (meta().mode !== 'duel') upd['zstate/' + t.start] = { owner: id, power: START_POWER }; upd[`teams/${id}/arrived`] = true; });
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
  if (meta().taskMode === 'random' && (s.t === 'tasks' || s.t === 'task') && myTeam()) {
    s.t = 'task'; s.id = S.room.tasks?.[myTeam().cur] ? myTeam().cur : null;
    if (!s.id) ensureCur();
  }
  if (isDuel() && (s.t === 'tasks' || s.t === 'task') && myTeam()) {
    // elke vrije zone heeft haar eigen opdracht: wie de zone verlaat, ziet ze niet meer; wie terugkomt, krijgt dezelfde
    const zid = target(), tid = zid && !zst(zid).owner && S.room.ztask?.[zid];
    if (tid && S.room.tasks?.[tid]) Object.assign(s, { t: 'task', id: tid, zid }); else Object.assign(s, { t: 'tasks', id: null, zid: null });
  }
  // Chat: enkel de berichten verversen, zodat het invulveld en de scrollpositie blijven staan.
  if (s.t === 'chat' && !el.hidden && S.sheetKey === 'chat' + s.tab && $('#chatmsgs', el)) {
    const box = $('#chatmsgs', el), end = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    markRead(s.tab); setHTML($('#chattabs', el), chatTabs(s.tab));
    if (setHTML(box, chatMsgs(s.tab)) && end) box.scrollTop = box.scrollHeight;
    return;
  }
  const body = ({ chat: shChat, tasks: shTasks, task: shTask, duel: shDuel, claim: shClaim, packs: shPacks, shop: shShop, zone: shZone, sup: shSup, score: shScore, menu: shMenu })[s.t]();
  // Het kader wordt één keer opgebouwd (met inschuif-animatie); daarna verandert enkel de inhoud.
  if (el.hidden || !$('.sheet-body', el)) {
    el.hidden = false;
    el.innerHTML = '<div class="sheet-card anim"><button class="x close" data-act="close">✕</button><div class="sheet-body"></div></div>';
  }
  const b = $('.sheet-body', el), top = b.scrollTop, same = S.sheetKey === s.t + (s.id || s.zid || s.tab || '');
  if (setHTML(b, body)) b.scrollTop = same ? top : 0;
  countdowns();
  S.sheetKey = s.t + (s.id || s.zid || s.tab || '');
  if (s.t === 'chat') { const box = $('#chatmsgs', el); if (box) box.scrollTop = box.scrollHeight; }
}

// Een inzending die na anderhalve minuut nog niet nagekeken is, is onderweg blijven steken (app gesloten, geen bereik).
const STUCK_MS = 90000;
const subState = s => ((s.status === 'uploading' || s.status === 'checking') && db.now() - s.ts > STUCK_MS ? 'stuck' : s.status);
const statusTag = st => ({ uploading: '⏳ wordt verstuurd', checking: '⏳ wordt nagekeken', stuck: '⚠ controle onderbroken', pending: '⏳ bij de leiding', ai_rejected: '✗ afgekeurd door AI', rejected: '✗ afgekeurd', approved: '✓ goedgekeurd' }[st] || '');
const prize = t => meta().mode === 'leger' ? `💰 ${t.reward}` : isDuel() ? '🏳️ zone' : `⚔️ +${t.diff}`;
function lastSubs() {
  const last = {};
  Object.entries(S.room.subs || {}).forEach(([id, s]) => { if (s.team === Me().team && (!last[s.task] || s.ts > last[s.task].ts)) last[s.task] = { ...s, id }; });
  return last;
}

function shTasks() {
  if (isDuel()) {
    const zid = target(), o = zid && zst(zid).owner;
    return `<h2>Opdrachten</h2><p class="note">${!zid ? 'Ga in een zone staan: elke vrije zone heeft haar eigen opdracht.' : o === Me().team ? 'Deze zone is al van jullie. Ga naar een vrije zone voor een nieuwe opdracht.' : 'Deze zone is van een andere groep. Pak ze af met een duel: tik op de zone.'}</p>${notifBtn()}`;
  }
  const T = myTeam(), done = T.done || {}, last = lastSubs();
  const list = Object.entries(S.room.tasks || {}).map(([id, t]) => ({ id, ...t }));
  const allDone = list.every(t => done[t.id]);
  list.sort((a, b) => (allDone ? 0 : !!done[a.id] - !!done[b.id]) || a.diff - b.diff);
  return `<h2>Opdrachten</h2>
    <p class="hint">${meta().mode === 'leger' ? 'Elke goedgekeurde opdracht levert goud op.' : 'Elke goedgekeurde opdracht telt als sterkte in de zone waar je staat.'}${allDone ? ' Alles gedaan: je mag opnieuw beginnen.' : ''}</p>${notifBtn()}
    ${list.map(t => { const d = done[t.id] && !allDone, st = last[t.id] && subState(last[t.id]); return `<button class="titem ${d ? 'done' : ''}" data-act="openTask" data-id="${t.id}">
      <div><b>${esc(t.title)}</b><small>${esc(t.desc)}</small>${d ? '<em>✓ voltooid</em>' : st && st !== 'approved' ? `<em>${statusTag(st)}</em>` : ''}</div><span class="prize">${prize(t)}</span></button>`; }).join('')}`;
}
A.openTask = d => openSheet({ t: 'task', id: d.id });

// Willekeurige modus: elke groep heeft één lopende opdracht (teams/<groep>/cur). Na goedkeuring komt er een nieuwe;
// een andere krijgen ze enkel als de leiding dat toestaat, en vragen kan pas na de ingestelde wachttijd (meta.skipWait, in minuten).
// Ligt het bewijs bij de leiding te wachten, dan mag de groep meteen door. De leiding kan ook zelf een opdracht geven.
const skipMs = () => (meta().skipWait ?? 3) * 60000;
function nextTask(T, not) {
  const ids = Object.keys(S.room.tasks || {}), done = T.done || {};
  let pool = ids.filter(id => !done[id] && id !== not);
  if (!pool.length) pool = ids.filter(id => id !== not);
  if (!pool.length) pool = ids;
  return pool[Math.random() * pool.length | 0];
}
async function ensureCur() {
  const tid = Me()?.team, T = myTeam();
  if (!T || S.room.tasks?.[T.cur] || S.curBusy) return;
  S.curBusy = true;
  try {
    const r = await db.tx(`${R()}/teams/${tid}/cur`, c => (c && S.room.tasks[c] ? undefined : nextTask(T)));
    if (r.committed) await db.set(`${R()}/teams/${tid}/curAt`, db.now());
  } finally { S.curBusy = false; }
}
const giveTask = async (tid, task) => { const T = S.room.teams[tid]; await db.update(`${R()}/teams/${tid}`, { cur: task || nextTask(T, T.cur), curAt: db.now(), skipReq: null, skipNo: null }); ping('task', tid); };
A.skipTask = () => giveTask(Me().team);
A.askSkip = async () => { await db.set(`${R()}/teams/${Me().team}/skipReq`, db.now()); ping('skip', Me().team); };
A.skipOk = d => { giveTask(d.t); log(`${S.room.teams[d.t].name} krijgt een andere opdracht`, d.t); };
A.skipNo = d => db.update(`${R()}/teams/${d.t}`, { skipReq: null, skipNo: db.now(), curAt: db.now() });
A.givePick = (d, el) => { (S.give = S.give || {})[d.t] = el.value; };
A.giveTask = d => {
  const task = S.give?.[d.t] || '', ids = d.t === 'all' ? Object.keys(S.room.teams || {}) : [d.t];
  ids.forEach(tid => giveTask(tid, task));
  log(`De leiding geeft ${d.t === 'all' ? 'alle groepen' : S.room.teams[d.t].name} ${task ? `de opdracht "${S.room.tasks[task].title}"` : 'een nieuwe opdracht'}`, d.t === 'all' ? '' : d.t);
};

function shTask() {
  if (!S.sheet.id) return '<h2>Opdracht</h2><div class="busy"><div class="spin"></div>Jullie opdracht wordt gekozen…</div>';
  const t = S.room.tasks[S.sheet.id], T = myTeam(), last = isDuel() ? latestSub(S.sheet.id, S.sheet.zid) : lastSubs()[S.sheet.id], m = meta(), ph = phase();
  const list = Object.keys(S.room.tasks), allDone = list.every(id => T.done?.[id]);
  const done = !isDuel() && T.done?.[S.sheet.id] && !allDone, zid = target(), z = zid && zoneById(zid), st = last && subState(last);
  // Twee knoppen: meteen de camera openen, of een foto of filmpje uit de galerij kiezen.
  const upload = `<div class="pickrow"><label class="btn big filebtn">📷 Camera<input type="file" accept="image/*,video/*" capture="environment" data-file="${S.sheet.id}" hidden></label>
    <label class="btn big alt filebtn">🖼️ Galerij<input type="file" accept="image/*,video/*" data-file="${S.sheet.id}" hidden></label></div><p class="hint">Filmpjes: hou ze korter dan 15 seconden.</p>`;
  let action;
  if (S.busy) action = `<div class="busy"><div class="spin"></div>${esc(S.busy)}</div>`;
  else if (ph !== 'playing') action = `<p class="note">${ph === 'ended' ? 'Het spel is afgelopen.' : 'Het spel is nog niet gestart.'}</p>`;
  else if (st === 'checking' || st === 'uploading') action = '<div class="busy"><div class="spin"></div>De scheidsrechter bekijkt jullie bewijs…</div>';
  else if (st === 'pending') action = `<p class="note">⏳ Jullie bewijs ligt bij de leiding.${last.aiErr ? `<small>De automatische controle lukte niet (${esc(last.aiErr)}), dus de leiding beslist.</small>` : ''}</p>`;
  else if (done) action = '<p class="note">✓ Deze opdracht is al voltooid.</p>';
  else if ((m.mode === 'verover' || isDuel()) && !z) action = '<p class="note">Ga eerst in een zone staan: de opdracht telt voor de zone waar je bent.</p>';
  else if (st === 'stuck') action = `<p class="note bad">⚠ De controle van jullie bewijs is onderbroken. Probeer opnieuw, of laat de leiding kijken.</p><button class="btn alt" data-act="askSup" data-s="${last.id}">Vraag de leiding om te kijken</button>${upload}`;
  else if (st === 'ai_rejected') action = `<p class="note bad">✗ ${esc(last.ai || 'Niet goedgekeurd')}</p><button class="btn alt" data-act="askSup" data-s="${last.id}">Vraag de leiding om te kijken</button>${upload}`;
  else action = (st === 'rejected' ? '<p class="note bad">✗ Afgekeurd door de leiding. Probeer opnieuw.</p>' : '') + upload;
  const rnd = m.taskMode === 'random';
  let skip = '';
  if (rnd && ph === 'playing' && list.length > 1 && !S.busy) {
    const free = st === 'pending' || st === 'stuck', wait = (T.curAt || 0) + skipMs() - db.now();
    if (free || Me().sup) skip = `<button class="btn big ghost" data-act="skipTask">🎲 ${free ? 'Volgende opdracht' : 'Andere opdracht'}</button>`;
    else if (T.skipReq) skip = '<p class="note">⏳ Jullie vraag voor een andere opdracht ligt bij de leiding.</p>';
    else if (wait > 0) skip = `<p class="hint center">${T.skipNo ? '✗ De leiding wil dat jullie deze opdracht doen. ' : ''}🎲 Een andere opdracht vragen kan over ${fmtTime(wait)}</p>`;
    else skip = `<button class="btn big ghost" data-act="askSkip">🎲 Vraag de leiding om een andere opdracht</button>`;
  }
  action += skip + notifBtn();
  return `${isDuel() ? '<p class="hint">🎯 Opdracht van deze zone</p>' : rnd ? '<p class="hint">🎲 Jullie opdracht</p>' : '<button class="back" data-act="sheet" data-t="tasks">‹ Alle opdrachten</button>'}
    <h2>${esc(t.title)}</h2><p>${esc(t.desc)}</p>
    <div class="facts"><span>${'⭐'.repeat(t.diff)}</span><span>${prize(t)}</span>${(m.mode === 'verover' || isDuel()) && z ? `<span>📍 voor ${esc(z.name)}</span>` : ''}</div>
    ${action}`;
}
A.askSup = async d => { await db.update(`${R()}/subs/${d.s}`, { status: 'pending' }); ping('sub', d.s); };

async function onFile(tid, file) {
  const task = S.room.tasks[tid], me = Me(), m = meta();
  if (!task || phase() !== 'playing') return;
  const zone = (m.mode === 'verover' || m.mode === 'duel') ? target() : (S.zoneId || '');
  if ((m.mode === 'verover' || m.mode === 'duel') && !zone) return toast('Ga eerst in een zone staan');
  if (m.mode === 'duel' && zst(zone).owner) return toast('Deze zone is al van een groep');
  const busy = msg => { S.busy = msg; if (S.sheet?.t === 'task') renderSheet(); };
  busy('Bewijs wordt verwerkt…');
  try {
    const media = await prepareMedia(file);
    const sid = await db.push(R() + '/subs', { team: me.team, task: tid, zone: zone || '', by: me.name, status: 'uploading', ts: db.now(), video: media.video });
    if (media.thumb) await db.set(`photos/${S.code}/${sid}`, media.thumb);
    if (aiProxyUrl && media.ai && m.ai) {
      busy('De scheidsrechter bekijkt je bewijs…');
      let res = null, err = '';
      try { res = await verify(aiProxyUrl, S.code, task, media.ai); } catch (e) { console.warn(e); err = e.message; }
      if (res?.ok) { await db.update(`${R()}/subs/${sid}`, { ai: res.reden }); await approve(sid); }
      else if (res) await db.update(`${R()}/subs/${sid}`, { status: 'ai_rejected', ai: res.reden });
      else { await db.update(`${R()}/subs/${sid}`, { status: 'pending', aiErr: err }); ping('sub', sid); }
    } else { await db.update(`${R()}/subs/${sid}`, { status: 'pending' }); ping('sub', sid); }
  } catch (e) { console.error(e); toast('Er ging iets mis: ' + e.message); }
  busy(null);
}

async function approve(sid) {
  const r = await db.tx(`${R()}/subs/${sid}/status`, s => (s === 'approved' ? undefined : 'approved'));
  if (!r.committed) return;
  const sub = await db.get(`${R()}/subs/${sid}`), task = S.room.tasks[sub.task], T = S.room.teams[sub.team];
  await db.set(`${R()}/teams/${sub.team}/done/${sub.task}`, true);
  if (meta().taskMode === 'random' && T.cur === sub.task) { await db.update(`${R()}/teams/${sub.team}`, { cur: nextTask({ done: { ...T.done, [sub.task]: true } }, sub.task), curAt: db.now(), skipReq: null, skipNo: null }); ping('task', sub.team); }
  if (meta().mode === 'leger') {
    await db.tx(`${R()}/teams/${sub.team}/money`, v => (v || 0) + task.reward);
    log(`${T.name} voltooide "${task.title}" (+${task.reward} goud)`, sub.team);
  } else if (isDuel()) {
    if (!sub.zone) return;
    const r = await db.tx(`${R()}/zstate/${sub.zone}`, z => (z?.owner ? undefined : { owner: sub.team, power: 0 }));
    log(r.committed ? `🏳️ ${T.name} claimt ${zoneById(sub.zone).name}` : `${T.name} deed "${task.title}", maar ${zoneById(sub.zone).name} was al geclaimd`, sub.team);
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
  const army = UNITS.reduce((a, x) => a + (u[x.id] || 0) * x.power, 0);
  return `<div class="shophead"><h2>Winkel</h2><span class="purse">💰 ${T.money}</span></div>
    <p class="hint">Jullie leger is samen <b>${army}</b> sterk. Soldaten zet je in door in een zone te staan en erop te tikken.</p>
    <div class="shop">${UNITS.map(x => { const have = u[x.id] || 0, can = T.money >= x.price; return `<div class="ucard ${can ? '' : 'poor'}">
      <span class="upow" title="kracht">⚔ ${x.power}</span>${have ? `<span class="uown">×${have}</span>` : ''}
      ${figure(x.fig, T.color)}
      <b>${x.name}</b><small>${x.desc}</small>
      <div class="ubuy"><button class="btn small" data-act="buy" data-u="${x.id}" data-n="1" ${can ? '' : 'disabled'}>💰 ${x.price}</button>
      <button class="btn small alt" data-act="buy" data-u="${x.id}" data-n="5" ${T.money >= x.price * 5 ? '' : 'disabled'}>×5</button></div></div>`; }).join('')}</div>`;
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
    if (isDuel() && duelOn(zid)) body = duelZoneBody(zid);
    else if (!canAct(zid)) body = '<p class="note">Je moet in deze zone staan om hier iets te doen.</p>';
    else if (isDuel()) body = duelZoneBody(zid);
    else if (m.mode === 'verover') body = `<p>${mine ? 'Versterk deze zone' : 'Verover deze zone'} door hier een opdracht uit te voeren.</p><button class="btn big" data-act="sheet" data-t="tasks">🎯 ${m.taskMode === 'random' ? 'Naar jullie opdracht' : 'Kies een opdracht'}</button>`;
    else {
      const u = T.units || {}, d = S.deploy, P = UNITS.reduce((a, x) => a + (d[x.id] || 0) * x.power, 0);
      const out = mine ? `Zone wordt ${s.power + P} sterk` : !o ? 'Deze zone is onbezet: ze wordt van jullie.' : 'Jullie weten niet hoeveel verdedigers hier staan. Is jullie aanval sterker, dan is de zone van jullie.';
      body = `<p class="hint">Hoeveel soldaten zet je in?</p>
        ${UNITS.filter(x => u[x.id] > 0).map(x => `<div class="unit"><div class="uicon">${figure(x.fig, T.color)}</div><div><b>${x.name}</b><small>kracht ${x.power} · in bezit ${u[x.id] || 0}</small></div>
          <div class="stepper"><button data-act="dep" data-u="${x.id}" data-d="-1">−</button><b>${d[x.id] || 0}</b><button data-act="dep" data-u="${x.id}" data-d="1">+</button><button class="max" data-act="dep" data-u="${x.id}" data-d="99">max</button></div></div>`).join('')}
        ${P ? `<p class="note">${out}</p>` : ''}
        <button class="btn big" data-act="deploy" ${P ? '' : 'disabled'}>${mine ? '🛡️ Verdedig' : o ? '⚔️ Val aan' : '🏳️ Verover'}${P ? ` met kracht ${P}` : ''}</button>
        ${Object.values(u).some(v => v > 0) ? '' : '<p class="hint">Geen soldaten meer? Doe opdrachten en koop er in de winkel.</p>'}`;
    }
  }
  return `<h2>${esc(z.name)}</h2>
    <div class="facts">${o ? `<span class="tag" style="--c:${o.color}">${o.name}</span>${isDuel() ? `${s.locked ? '<span>🔒 vast</span>' : ''}${shielded(s.owner) ? `<span>🛡️ ${cd(o.shieldUntil)}</span>` : ''}` : `<span>🛡️ sterkte ${seesPower(s.owner) ? s.power : 'geheim'}</span>`}` : `<span>🏳️ ${isDuel() ? 'Vrij' : 'Onbezet'}</span>`}${zid === S.zoneId ? '<span>📍 Je bent hier</span>' : ''}</div>${body}`;
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
    const n = { ...u }; for (const k in d) n[k] = (n[k] || 0) - d[k];
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
    return { id, ...t, zones: own.length, power: own.reduce((a, z) => a + zst(z.id).power, 0), secret: isDuel() || !seesPower(id) };
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
    <p class="hint">${isDuel() ? 'Gerangschikt op aantal zones.' : `Gerangschikt op aantal zones, daarna op totale sterkte.${ended ? '' : ' De sterkte van andere groepen blijft geheim tot het einde.'}`}</p>`;
}

function shMenu() {
  const m = meta();
  return `<h2>Menu</h2>
    <div class="facts"><span>Code <b>${m.code}</b></span><span>${modeLabel(m.mode)}</span></div>
    ${notifBtn()}
    <button class="btn big alt" data-act="replay">🎬 Speluitleg opnieuw bekijken</button>
    <button class="btn big alt" data-act="recenter">🧭 Kaart centreren</button>
    <button class="btn big ghost" data-act="leave">Spel verlaten</button>`;
}
A.replay = () => { A.close(); playIntro(meta().mode); };
A.recenter = () => { A.close(); S.map?.fit(meta().center, meta().radius); };

/* ---------- leiding ---------- */
// Keuzelijst waarmee de leiding een groep (of 'all') een bepaalde of een willekeurige opdracht geeft.
function givePicker(tid) {
  const cur = S.give?.[tid] || '';
  return `<div class="row give"><select data-chg="givePick" data-t="${tid}"><option value="">🎲 Willekeurige opdracht</option>${Object.entries(S.room.tasks || {}).map(([id, t]) => `<option value="${id}" ${id === cur ? 'selected' : ''}>${esc(t.title)}</option>`).join('')}</select><button class="btn small" data-act="giveTask" data-t="${tid}">Geef</button></div>`;
}
function shSup() {
  const tab = S.sheet.tab || 'subs', teams = S.room.teams || {}, m = meta(), ph = phase();
  const tabs = isDuel() ? [['subs', 'Inzendingen'], ['teams', 'Groepen'], ['spel', 'Spel'], ['pak', '📦']] : [['subs', 'Inzendingen'], ['teams', 'Groepen'], ['task', 'Opdracht +'], ['spel', 'Spel']];
  let body = '';
  if (tab === 'subs') {
    const order = { pending: 0, stuck: 0, checking: 1, uploading: 1, ai_rejected: 2 };
    const subs = Object.entries(S.room.subs || {}).map(([id, s]) => ({ id, ...s, status: subState(s) })).sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3) || b.ts - a.ts).slice(0, 40);
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
    body = (m.taskMode === 'random' && ph !== 'ended' ? `<div class="sub-card"><div><b>Alle groepen tegelijk</b></div>${givePicker('all')}</div>` : '') + Object.entries(teams).map(([id, t]) => {
      const members = Object.entries(S.room.players).filter(([, p]) => p.team === id).map(([pid, p]) => {
        const o = S.others[pid], age = o ? db.now() - o.ts : 0;
        const st = p.gpsOff ? '<b class="bad">⚠ locatie uit</b>' : !o ? 'nog geen locatie' : age < 90000 ? '📍 nu' : `📍 ${Math.round(age / 60000)} min geleden`;
        return `${esc(p.name)} <span class="hint">${st}</span>`;
      }).join(' · ');
      const give = m.taskMode === 'random' && ph !== 'ended' ? `<small>🎯 Nu bezig met: <b>${esc(S.room.tasks?.[t.cur]?.title || 'nog geen opdracht')}</b></small>${givePicker(id)}` : '';
      return `<div class="sub-card"><div><span class="tag" style="--c:${t.color}">${esc(t.name)}</span> ${m.mode === 'leger' ? `💰 ${t.money}` : ''} ${ph === 'travel' ? (t.arrived ? '✅ op startpunt' : `🚶 onderweg naar ${esc(zoneById(t.start)?.name)}`) : ''}</div>
        <small>${members || 'geen spelers'}</small>${give}
        <div class="row">${m.mode === 'leger' ? `<button class="btn small" data-act="money" data-t="${id}" data-d="20">+20 goud</button><button class="btn small alt" data-act="money" data-t="${id}" data-d="-20">−20 goud</button>` : ''}
        ${ph === 'travel' && !t.arrived ? `<button class="btn small ghost" data-act="markArrived" data-t="${id}">Is aangekomen</button>` : ''}</div></div>`;
    }).join('');
  } else if (tab === 'task') {
    body = `<p class="hint">Voeg tijdens het spel een opdracht toe. Ze komt ook in het archief.</p>
      <div class="addtask"><input id="st" maxlength="60" placeholder="Titel"><input id="sd" maxlength="200" placeholder="Wat moeten ze doen?"><input id="sc" maxlength="200" placeholder="Wat moet er op de foto te zien zijn?">
      <select id="sdiff"><option value="1">⭐ Makkelijk</option><option value="2">⭐⭐ Gemiddeld</option><option value="3">⭐⭐⭐ Moeilijk</option></select>
      <button class="btn" data-act="supAddTask">Toevoegen</button></div>`;
  } else if (tab === 'pak') {
    body = packPanel();
  } else {
    body = `<div class="facts"><span>Code <b>${m.code}</b></span><span>${{ travel: 'Groepen onderweg', playing: 'Bezig', ended: 'Afgelopen' }[ph]}</span></div>
      ${ph === 'travel' ? '<button class="btn big" data-act="startGame">▶ Start het spel</button>' : ''}
      ${ph === 'playing' ? `<div class="row"><button class="btn alt" data-act="addTime" data-m="10">+10 min</button><button class="btn alt" data-act="addTime" data-m="-10">−10 min</button></div><button class="btn big" data-act="stopGame">⏹ Stop het spel</button>` : ''}
      ${ph === 'ended' ? '<p class="note">Het spel is afgelopen.</p>' : ''}
      ${ph !== 'ended' ? `<h3 class="gap">📢 Mededeling</h3><p class="hint">Iedereen krijgt ze meteen te zien, met een melding. Ze komt ook in de algemene chat.</p>
        <div class="row give"><input id="newsin" maxlength="300" autocomplete="off" placeholder="Bv. Nog 10 minuten!" value="${esc(S.newsDraft || '')}"><button class="btn small" data-act="sendNews">Verstuur</button></div>` : ''}
      ${isDuel() && ph === 'playing' ? buzzPanel() : ''}`;
  }
  const notif = !('Notification' in window) ? '<p class="hint">🔔 Meldingen: zet deze site eerst op je beginscherm (Deel → Zet op beginscherm) en open ze van daar.</p>'
    : Notification.permission === 'granted' ? '' : '<button class="btn alt small" data-act="notifOn">🔔 Meldingen bij nieuw bewijs aanzetten</button>';
  const asks = Object.entries(teams).filter(([, t]) => t.skipReq).map(([id, t]) => `<div class="sub-card"><div><span class="tag" style="--c:${t.color}">${esc(t.name)}</span> wil een andere opdracht</div>
      <small>Nu: <b>${esc(S.room.tasks?.[t.cur]?.title || '?')}</b> · ${esc(S.room.tasks?.[t.cur]?.desc || '')}</small>
      <div class="row"><button class="btn small" data-act="skipOk" data-t="${id}">✓ Geef een andere</button><button class="btn small alt" data-act="skipNo" data-t="${id}">✗ Deze blijven doen</button></div></div>`).join('');
  const duels = liveDuels().map(x => `<div class="sub-card"><div>⚔️ <span class="tag" style="--c:${teams[x.att].color}">${esc(teams[x.att].name)}</span> tegen <span class="tag" style="--c:${teams[x.def].color}">${esc(teams[x.def].name)}</span> in <b>${esc(zoneById(x.zid).name)}</b></div>
      <small>${x.status === 'wait' ? `Verdedigers moeten terug zijn binnen ${cd(x.until)}` : `Bezig: ${esc(DUELS[x.game]?.name)}`}</small><div class="row"><button class="btn small" data-act="duelOpen" data-z="${x.zid}">Bekijk</button></div></div>`).join('');
  body = notif + duels + asks + body;
  return `<h2>Leiding</h2><div class="tabs">${tabs.map(([k, l]) => `<button class="${k === tab ? 'on' : ''}" data-act="tab" data-tab="${k}">${l}</button>`).join('')}</div>${body}`;
}
A.photo = async d => { S.photos[d.s] = await db.get(`photos/${S.code}/${d.s}`) || 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><text x="10" y="35">Geen beeld beschikbaar</text></svg>'); renderSheet(); };
A.approve = d => approve(d.s);
A.reject = d => db.tx(`${R()}/subs/${d.s}/status`, s => (s === 'approved' ? undefined : 'rejected'));
A.money = d => db.tx(`${R()}/teams/${d.t}/money`, v => Math.max(0, (v || 0) + +d.d));
A.markArrived = d => db.set(`${R()}/teams/${d.t}/arrived`, true);
A.addTime = d => db.tx(R() + '/meta/endsAt', v => (v ? v + d.m * 60000 : undefined));
A.stopGame = async () => { if (await ask({ title: 'Spel stopzetten?', text: 'De tijd stopt en de eindstand wordt getoond.', ok: 'Stopzetten' })) { db.set(R() + '/meta/phase', 'ended'); log('De leiding heeft het spel stopgezet.'); } };
A.supAddTask = async () => {
  const title = $('#st').value.trim(); if (!title) return toast('Geef de opdracht een titel');
  const t = withReward({ title, desc: $('#sd').value.trim(), check: $('#sc').value.trim(), diff: +$('#sdiff').value });
  const key = 'x' + rid();
  await db.set(`${R()}/tasks/${key}`, t);
  if (meta().taskMode !== 'random') ping('new', key);
  await archiveAdd(t);
  log(`Nieuwe opdracht: "${title}"`);
  S.sheet.tab = 'subs'; renderSheet();
};

/* ---------- modus Duel ---------- */
// Vrije zones claim je met de opdracht van die zone (ztask). Een zone van een andere groep pak je af met een duel:
// de verdedigers krijgen DUEL_MS om terug in de zone te zijn, anders is ze meteen van de aanvallers.
// Daarnaast buzzer-rondes (de eerste volledige groep zet één van haar zones voorgoed vast) en pakketjes met een code (zones even beschermd).
const DUEL_MS = 3 * 60000, SHIELD_MS = 10 * 60000, NEAR_M = 40;
const isDuel = () => meta().mode === 'duel';
const shielded = tid => (S.room?.teams?.[tid]?.shieldUntil || 0) > db.now();
const liveDuels = () => Object.entries(S.room?.duels || {}).filter(([, x]) => x.status !== 'done').map(([zid, x]) => ({ zid, ...x }));
const duelOn = zid => liveDuels().some(x => x.zid === zid);
const myDuel = () => liveDuels().find(x => x.att === Me()?.team || x.def === Me()?.team);
const buzzOn = () => { const b = S.room?.buzz; return b && !b.winner && db.now() < b.until ? b : null; };
const cd = until => `<b class="cd" data-until="${until}"></b>`;
function countdowns() { $$('[data-until]').forEach(el => { el.textContent = fmtTime(+el.dataset.until - db.now()); }); }
const packHash = async code => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('stadsspel-pakket:' + code.trim().toUpperCase())))].map(b => b.toString(16).padStart(2, '0')).join('');
const randCode = () => Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPRSTUVWXYZ23456789'[Math.random() * 31 | 0]).join('');

// Verdeel de opdrachten over de zones: elke zone krijgt er vast één. Zijn er meer zones dan opdrachten, dan komen ze terug.
function zoneTasks() {
  const ids = Object.keys(S.room.tasks || {}), out = {}, mix = a => a.map(v => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map(v => v[1]);
  let bag = [];
  mix(zones()).forEach(z => { if (!bag.length) bag = mix(ids); out[z.id] = bag.pop(); });
  return out;
}
function latestSub(task, zone) {
  let best = null;
  Object.entries(S.room.subs || {}).forEach(([id, s]) => { if (s.team === Me().team && s.task === task && s.zone === zone && (!best || s.ts > best.ts)) best = { ...s, id }; });
  return best;
}
// Zone van eigenaar laten wisselen, behalve als de buzzer ze vergrendeld heeft.
const takeZone = (zid, tid) => db.tx(`${R()}/zstate/${zid}`, z => (z?.locked ? undefined : { owner: tid, power: 0 }));

function duelBanner() {
  const T = myTeam(), me = Me(), teams = S.room.teams || {}, b = buzzOn(), B = S.room.buzz, x = myDuel();
  if (b) {
    if (!T) return `🚨 Buzzer-ronde: iedereen naar <b>${esc(b.label)}</b> · ${cd(b.until)}`;
    const [n, all] = teamHere(me.team);
    return `🚨 <b>Buzzer!</b> Ren met je hele groep naar <b>${esc(b.label)}</b> en druk op de buzzer · ${cd(b.until)}${meta().gps ? ` <span class="tag">${n}/${all} van jullie zijn er</span>` : ''}`;
  }
  if (T && B?.winner === me.team && !B.claimed && lockable(me.team).length) return '🏆 Jullie waren eerst bij de buzzer! <button class="btn small" data-act="sheet" data-t="claim">Zet een zone vast</button>';
  if (T && x) {
    const Z = esc(zoneById(x.zid).name), other = teams[x.att === me.team ? x.def : x.att];
    const open = `<button class="btn small" data-act="duelOpen" data-z="${x.zid}">Bekijk</button>`;
    if (x.status === 'wait') return x.def === me.team ? `⚔️ <b>${esc(teams[x.att].name)}</b> valt <b>${Z}</b> aan! Ren terug: ${cd(x.until)} ${open}` : `⚔️ Wachten op ${esc(other.name)} in <b>${Z}</b> · ${cd(x.until)} ${open}`;
    return `🤺 Duel tegen ${esc(other.name)} in <b>${Z}</b> ${open}`;
  }
  return '';
}

function duelZoneBody(zid) {
  const s = zst(zid), teams = S.room.teams || {}, me = Me(), o = teams[s.owner];
  if (duelOn(zid)) return `<p class="note">⚔️ Hier is een duel bezig.</p><button class="btn big" data-act="duelOpen" data-z="${zid}">Bekijk het duel</button>`;
  if (!o) return `<p>Deze zone is vrij. Doe de opdracht van deze zone om ze te claimen.</p><button class="btn big" data-act="sheet" data-t="tasks">🎯 Opdracht van deze zone</button>`;
  if (s.owner === me.team) return `<p class="note">Deze zone is van jullie.${s.locked ? ' 🔒 Niemand kan ze nog afpakken.' : ''}</p>`;
  if (s.locked) return `<p class="note">🔒 Deze zone is voor de rest van het spel van ${esc(o.name)}.</p>`;
  if (shielded(s.owner)) return `<p class="note">🛡️ ${esc(o.name)} is nog ${cd(o.shieldUntil)} beschermd door een pakketje.</p>`;
  if (liveDuels().some(x => x.att === me.team)) return '<p class="note">Jullie zijn al een duel aan het spelen. Eén tegelijk.</p>';
  return `<p>Deze zone is van ${esc(o.name)}. Pak ze af met een duel: ${esc(o.name)} krijgt een melding en heeft ${DUEL_MS / 60000} minuten om terug te komen. Zijn ze te laat, dan is de zone van jullie.</p>
    <button class="btn big" data-act="challenge" data-z="${zid}">⚔️ Daag ${esc(o.name)} uit</button>`;
}

function canChallenge(zid) {
  const s = zst(zid), me = Me();
  return isDuel() && phase() === 'playing' && !!me?.team && !!s.owner && s.owner !== me.team && !s.locked && !shielded(s.owner) && !duelOn(zid) && !liveDuels().some(x => x.att === me.team) && canAct(zid);
}
A.challenge = async d => {
  const zid = d.z; if (!canChallenge(zid)) return toast('Een duel is hier nu niet mogelijk');
  const def = zst(zid).owner, att = Me().team, now = db.now();
  const r = await db.tx(`${R()}/duels/${zid}`, cur => (cur && cur.status !== 'done' ? undefined : { att, def, game: Math.random() * DUELS.length | 0, at: now, until: now + DUEL_MS, status: 'wait' }));
  if (!r.committed) return toast('Hier is al een duel bezig');
  log(`⚔️ ${S.room.teams[att].name} daagt ${S.room.teams[def].name} uit in ${zoneById(zid).name}!`, att);
  ping('duel', zid);
  openSheet({ t: 'duel', zid });
};
A.duelOpen = d => openSheet({ t: 'duel', zid: d.z });
A.duelHere = d => db.tx(`${R()}/duels/${d.z}`, x => (x && x.status === 'wait' && db.now() <= x.until ? { ...x, status: 'play', arrivedAt: db.now() } : undefined));
async function endDuel(zid, winner, why) {
  const r = await db.tx(`${R()}/duels/${zid}`, x => (x && x.status !== 'done' ? { ...x, status: 'done', winner, endedAt: db.now() } : undefined));
  if (!r.committed) return;
  const x = r.value, T = S.room.teams, Z = zoneById(zid).name;
  if (winner === x.att) { await takeZone(zid, x.att); log(`${why ? why + ': ' : ''}${T[x.att].name} pakt ${Z} af van ${T[x.def].name}!`, x.att); }
  else log(`${T[x.def].name} wint het duel en houdt ${Z}`, x.def);
}
A.duelLost = d => { const x = S.room.duels[d.z]; endDuel(d.z, x.att === Me().team ? x.def : x.att); };
A.duelWin = d => endDuel(d.z, d.t);
// Te laat terug: elk toestel in het spel kan dit afhandelen; de transactie zorgt dat het maar één keer gebeurt.
function duelTimeouts() {
  S.duelEnding = S.duelEnding || {};
  liveDuels().filter(x => x.status === 'wait' && db.now() > x.until && !S.duelEnding[x.zid]).forEach(x => {
    S.duelEnding[x.zid] = true;
    endDuel(x.zid, x.att, `${S.room.teams[x.def].name} was niet op tijd terug`).finally(() => { S.duelEnding[x.zid] = false; });
  });
}
function shDuel() {
  const zid = S.sheet.zid, x = S.room.duels?.[zid], T = S.room.teams || {}, me = Me(), z = zoneById(zid);
  if (!x) return '<h2>Duel</h2><p class="note">Geen duel gevonden.</p>';
  const g = DUELS[x.game] || DUELS[0], mine = me.team === x.att || me.team === x.def;
  let body;
  if (x.status === 'done') body = `<div class="winner" style="--c:${T[x.winner]?.color}">🏆 ${esc(T[x.winner]?.name)} wint</div>`;
  else if (x.status === 'wait') body = `<p class="note">${esc(T[x.def].name)} moet binnen ${cd(x.until)} terug zijn in ${esc(z.name)}. Anders is de zone van ${esc(T[x.att].name)}.</p>` +
    (me.team === x.def ? `<button class="btn big" data-act="duelHere" data-z="${zid}" ${canAct(zid) ? '' : 'disabled'}>📍 We zijn er!</button>${canAct(zid) ? '' : '<p class="hint">Deze knop werkt zodra je in de zone staat.</p>'}` : '');
  else body = '<p>Speel het duel. De groep die verliest, tikt hieronder op "Wij verloren".</p>' + (mine ? `<button class="btn big alt" data-act="duelLost" data-z="${zid}">🏳️ Wij verloren</button>` : '');
  if (me.sup && x.status !== 'done') body += `<p class="q">De leiding beslist</p><div class="row">${[x.att, x.def].map(t => `<button class="btn small" data-act="duelWin" data-z="${zid}" data-t="${t}">${esc(T[t].name)} wint</button>`).join('')}</div>`;
  return `<h2>⚔️ Duel in ${esc(z.name)}</h2>
    <div class="facts"><span class="tag" style="--c:${T[x.att].color}">${esc(T[x.att].name)}</span><span>tegen</span><span class="tag" style="--c:${T[x.def].color}">${esc(T[x.def].name)}</span></div>
    <div class="duelgame"><b>🎲 ${esc(g.name)}</b><small>${esc(g.desc)}</small></div>${body}`;
}

// Buzzer: de leiding start een ronde op haar eigen plek, waar een echte buzzer staat. De groep die als eerste volledig is
// en drukt, duidt de leiding in de app aan. Die groep zet één van haar eigen zones vast tot het einde (of de leiding doet het voor hen).
// Groepen die niet volledig waren, kan de leiding een zone afnemen. Het aantal aanwezigen volgens gps helpt daarbij.
function teamHere(tid) {
  const b = S.room.buzz, mem = Object.entries(S.room.players || {}).filter(([, p]) => p.team === tid && plays(p));
  if (!meta().gps || !b) return [mem.length, mem.length];
  const here = mem.filter(([pid]) => {
    const o = pid === S.pid && S.pos ? { ...S.pos, ts: db.now() } : S.others[pid];
    return o && db.now() - o.ts < 120000 && dist(o, b) <= NEAR_M;
  });
  return [here.length, mem.length];
}
A.bzPick = (d, el) => { (S.bz = S.bz || {})[d.k] = el.value; };
A.takePick = (d, el) => { (S.take = S.take || {})[d.t] = el.value; };
A.claimPick = (d, el) => { S.claimPick = el.value; };
A.buzzStart = async () => {
  // De ronde start altijd op de plek waar de leiding die ze start nu staat.
  const bz = S.bz || {}, at = S.pos;
  if (!at) return toast('Je locatie is nog niet bekend. Geef de app toegang tot je locatie en wacht op gps.');
  const label = zoneById(S.zoneId) ? 'de leiding in ' + zoneById(S.zoneId).name : 'de leiding';
  const id = 'b' + rid(), now = db.now();
  S.claimPick = null; S.take = {};
  await db.set(R() + '/buzz', { id, label, lng: at.lng, lat: at.lat, at: now, until: now + (+bz.min || 5) * 60000 });
  log(`🚨 Buzzer-ronde! Iedereen naar ${label}`);
  ping('buzz', id);
};
A.buzzStop = () => db.set(R() + '/buzz/until', db.now());
A.buzzWin = async d => {
  const r = await db.tx(R() + '/buzz/winner', w => (w ? undefined : d.t));
  if (!r.committed) return;
  await db.update(R() + '/buzz', { pressedAt: db.now(), until: db.now() });
  log(`🚨 ${S.room.teams[d.t].name} drukte als eerste op de buzzer!`, d.t);
};
const lockable = tid => zones().filter(z => zst(z.id).owner === tid && !zst(z.id).locked);
function shClaim() {
  const b = S.room.buzz;
  if (!b || b.winner !== Me().team) return '<h2>Buzzer</h2><p class="note">Er is niets te kiezen.</p>';
  if (b.claimed) return `<h2>🏆 Buzzer</h2><p class="note">${esc(zoneById(b.claimed).name)} blijft tot het einde van het spel van jullie.</p>`;
  const own = lockable(Me().team);
  if (!own.length) return '<h2>🏆 Jullie waren eerst!</h2><p class="note">Jullie hebben nog geen zone die je kan vastzetten. Claim eerst een zone met een opdracht.</p>';
  return '<h2>🏆 Jullie waren eerst!</h2><p>Kies één van jullie zones. Die blijft tot het einde van het spel van jullie: niemand kan ze nog afpakken.</p>' +
    own.map(z => `<button class="titem" data-act="claim" data-z="${z.id}"><div><b>${esc(z.name)}</b></div><span class="prize">🔒 vastzetten</span></button>`).join('');
}
async function claimZone(tid, zid) {
  if (zst(zid).owner !== tid || zst(zid).locked) return toast('Enkel een eigen zone kan vastgezet worden');
  const r = await db.tx(R() + '/buzz/claimed', c => (c ? undefined : zid)); if (!r.committed) return;
  const z = await db.tx(`${R()}/zstate/${zid}`, s => (s && s.owner === tid && !s.locked ? { ...s, locked: true } : undefined));
  if (!z.committed) { await db.set(R() + '/buzz/claimed', null); return toast('Die zone is intussen niet meer van deze groep'); }
  if (duelOn(zid)) await db.update(`${R()}/duels/${zid}`, { status: 'done', winner: tid, endedAt: db.now() });
  log(`🔒 ${S.room.teams[tid].name} zet ${zoneById(zid).name} vast voor de rest van het spel`, tid);
}
A.claim = d => claimZone(Me().team, d.z);
A.claimFor = () => { const b = S.room.buzz; if (b?.winner && S.claimPick) claimZone(b.winner, S.claimPick); else toast('Kies eerst een zone'); };
A.takeAway = async d => {
  const own = zones().filter(z => zst(z.id).owner === d.t && !zst(z.id).locked), zid = S.take?.[d.t] || own[Math.random() * own.length | 0]?.id;
  if (!zid) return toast('Deze groep heeft geen zone die afgenomen kan worden');
  await db.set(`${R()}/zstate/${zid}`, { owner: '', power: 0 });
  await db.set(`${R()}/buzz/taken/${d.t}`, zid);
  log(`De leiding neemt ${zoneById(zid).name} af van ${S.room.teams[d.t].name}: niet volledig bij de buzzer`, d.t);
};
function buzzPanel() {
  const b = S.room.buzz, T = S.room.teams || {}, bz = S.bz || {}, gps = meta().gps;
  let h = '<h3 class="gap">🚨 Buzzer-ronde</h3>';
  if (buzzOn()) return h + `<p class="note">Iedereen naar <b>${esc(b.label)}</b> · nog ${cd(b.until)}</p><p class="hint">Welke groep drukte als eerste op de buzzer? Tik op die groep.</p>` +
    Object.keys(T).map(t => { const [n, a] = teamHere(t); return `<div class="row bzrow"><button class="btn small" data-act="buzzWin" data-t="${t}">🏆 ${esc(T[t].name)}</button>${gps ? `<small>${n}/${a} aanwezig volgens gps</small>` : ''}</div>`; }).join('') +
    '<button class="btn small ghost" data-act="buzzStop">Stop deze ronde zonder winnaar</button>';
  if (b?.winner) {
    const own = lockable(b.winner);
    h += `<p class="note">🏆 ${esc(T[b.winner]?.name)} drukte als eerste${b.claimed ? ` en zette ${esc(zoneById(b.claimed)?.name)} vast voor de rest van het spel.` : own.length ? '. Ze zetten nu één van hun zones vast in hun app, of jij doet het hier voor hen:' : ', maar heeft nog geen zone om vast te zetten.'}</p>`;
    if (!b.claimed && own.length) h += `<div class="row give"><select data-chg="claimPick"><option value="">Kies een zone…</option>${own.map(z => `<option value="${z.id}" ${S.claimPick === z.id ? 'selected' : ''}>${esc(z.name)}</option>`).join('')}</select><button class="btn small" data-act="claimFor">Zet vast</button></div>`;
    h += '<p class="hint">Was een groep niet volledig bij de buzzer? Neem ze een zone af:</p>' + Object.keys(T).filter(t => t !== b.winner).map(t => {
      if (b.taken?.[t]) return `<small>✓ ${esc(zoneById(b.taken[t])?.name)} afgenomen van ${esc(T[t].name)}</small>`;
      const own = zones().filter(z => zst(z.id).owner === t && !zst(z.id).locked);
      return `<div class="sub-card"><div><span class="tag" style="--c:${T[t].color}">${esc(T[t].name)}</span></div>${own.length
        ? `<div class="row give"><select data-chg="takePick" data-t="${t}"><option value="">🎲 Willekeurige zone</option>${own.map(z => `<option value="${z.id}" ${S.take?.[t] === z.id ? 'selected' : ''}>${esc(z.name)}</option>`).join('')}</select><button class="btn small" data-act="takeAway" data-t="${t}">Neem af</button></div>`
        : '<small>Heeft geen zone die afgenomen kan worden.</small>'}</div>`;
    }).join('');
  } else if (b) h += '<p class="hint">Vorige ronde: geen winnaar.</p>';
  return h + `<p class="hint">De ronde start op de plek waar jij nu staat, bij de echte buzzer. Alle groepen krijgen een melding. Wie als eerste volledig is en drukt, duid je daarna hier aan; die groep mag één van haar zones voorgoed vastzetten.</p>
    <label>Hoe lang hebben ze?<select data-chg="bzPick" data-k="min">${[3, 5, 10, 15].map(n => `<option value="${n}" ${String(bz.min || 5) === String(n) ? 'selected' : ''}>${n} min</option>`).join('')}</select></label>
    <button class="btn big" data-act="buzzStart" ${S.pos ? '' : 'disabled'}>🚨 Start een buzzer-ronde hier</button>
    ${S.pos ? `<p class="hint">📍 ${zoneById(S.zoneId) ? 'Je staat in ' + esc(zoneById(S.zoneId).name) : 'Je staat buiten de zones'}.</p>` : `<p class="note">${esc(S.gpsErr || 'Wachten op je gps-locatie…')}</p>`}`;
}

// Pakketjes: de leiding kiest een code, steekt ze in het pakketje en neemt er een close-up foto van.
// De code wordt nagekeken via een hash; de code zelf wordt ook bewaard zodat de leiding ze later nog kan opzoeken
// (de app toont ze enkel aan de leiding). De eerste groep die de code invult, heeft SHIELD_MS beschermde zones.
function loadPhoto(key) {
  if (S.photos[key] || S.loadingPh?.[key]) return;
  (S.loadingPh = S.loadingPh || {})[key] = true;
  db.get(`photos/${S.code}/${key}`).then(v => { S.photos[key] = v || ''; renderSheet(); });
}
function packList() {
  const T = S.room.teams || {}, P = Object.entries(S.room.packs || {}).sort((a, b) => b[1].at - a[1].at);
  P.forEach(([id]) => loadPhoto('pack-' + id));
  return P.map(([id, p]) => `<div class="sub-card ${p.usedBy ? 'closed' : ''}">${Me()?.sup ? `<div class="pkc">🔑 Code: <b>${p.code ? esc(p.code) : 'niet bewaard'}</b></div>` : ''}<small>📦 ${new Date(p.at).toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit' })} · ${p.usedBy ? 'gevonden door <b>' + esc(T[p.usedBy]?.name) + '</b>' : '<b>nog niet gevonden</b>'}</small>
    ${S.photos['pack-' + id] ? `<img src="${S.photos['pack-' + id]}" alt="pakketje">` : S.photos['pack-' + id] === '' ? '' : '<div class="busy"><div class="spin"></div>Foto laden…</div>'}</div>`).join('') || '<p class="note">Nog geen pakketjes verstopt.</p>';
}
function shPacks() {
  const T = myTeam();
  return `<h2>📦 Pakketjes</h2><p class="hint">De leiding verstopt pakketjes in de stad. Vind er een en vul de code in: dan zijn al jullie zones ${SHIELD_MS / 60000} minuten beschermd tegen duels.</p>
    ${T ? `${shielded(Me().team) ? `<p class="note">🛡️ Jullie zones zijn nog ${cd(T.shieldUntil)} beschermd.</p>` : ''}<div class="row give"><input id="pkin" maxlength="12" placeholder="Code uit het pakketje" autocomplete="off" autocapitalize="characters"><button class="btn small" data-act="packCode">Openen</button></div>` : ''}
    ${packList()}`;
}
A.packCode = async () => {
  const code = $('#pkin').value; if (!code.trim()) return;
  const h = await packHash(code), tid = Me().team, hit = Object.entries(S.room.packs || {}).find(([, p]) => p.hash === h);
  if (!hit) return toast('Die code klopt niet');
  const r = await db.tx(`${R()}/packs/${hit[0]}/usedBy`, u => (u ? undefined : tid));
  if (!r.committed) return toast('Dit pakketje is al gevonden door een andere groep');
  await db.tx(`${R()}/teams/${tid}/shieldUntil`, v => Math.max(v || 0, db.now()) + SHIELD_MS);
  log(`📦 ${myTeam().name} vond een pakketje: hun zones zijn ${SHIELD_MS / 60000} minuten beschermd!`, tid);
  $('#pkin').value = '';
};
function packPanel() {
  S.packCode = S.packCode ?? randCode();
  return `<p class="hint">Kies een code, steek ze in het pakketje en neem een close-up foto. Alle groepen krijgen de foto te zien. De eerste groep die de code invult, heeft ${SHIELD_MS / 60000} minuten beschermde zones.</p>
    <p class="hint">${S.pos ? '📍 De plek waar je nu staat wordt bewaard: enkel de leiding ziet het pakketje op de kaart, tot het gevonden is.' : '⚠ Je locatie is niet bekend: dit pakketje komt niet op de kaart.'}</p>
    <label>Code in het pakketje<input id="pkcode" maxlength="12" autocomplete="off" autocapitalize="characters" value="${esc(S.packCode)}"></label>
    <p class="q">Foto van het pakketje (geeft het meteen vrij)</p>
    <div class="pickrow"><label class="btn big filebtn">📷 Camera<input type="file" accept="image/*" capture="environment" data-packfile="1" hidden></label>
    <label class="btn big alt filebtn">🖼️ Galerij<input type="file" accept="image/*" data-packfile="1" hidden></label></div>
    <h3 class="gap">Verstopte pakketjes</h3>${packList()}`;
}
async function onPackFile(file) {
  const code = (S.packCode || '').trim().toUpperCase();
  if (code.length < 3) return toast('Kies eerst een code van minstens 3 tekens');
  try {
    const media = await prepareMedia(file), id = 'p' + rid();
    if (media.thumb) await db.set(`photos/${S.code}/pack-${id}`, media.thumb);
    await db.set(`${R()}/packs/${id}`, { at: db.now(), hash: await packHash(code), code, ...(S.pos ? { lat: S.pos.lat, lng: S.pos.lng } : {}) });
    log('📦 De leiding heeft een pakketje verstopt! Bekijk de foto bij Pakketjes.');
    ping('pack', id);
    S.packCode = randCode(); renderSheet();
    ask({ title: '📦 Pakketje vrijgegeven', text: `Steek de code ${code} in het pakketje. De groepen zien nu de foto.`, ok: 'Begrepen', cancel: 'Sluiten' });
  } catch (e) { console.error(e); toast('Er ging iets mis: ' + e.message); }
}

/* ---------- chat en mededelingen ---------- */
// Kanaal 'all' leest iedereen. Elke groep heeft een eigen kanaal (zelfde naam als de groep, bv. 't0') met enkel de leiding.
// Mededelingen van de leiding zijn berichten in 'all' met news: true; die verschijnen bij iedereen als venster met melding.
function chatChannels() {
  const me = Me(), T = S.room?.teams || {};
  if (me?.sup) return [['all', '📣 Iedereen'], ...Object.entries(T).map(([id, t]) => [id, '🔒 ' + t.name])];
  return [['all', '📣 Iedereen'], ...(me?.team && T[me.team] ? [[me.team, '🔒 Leiding']] : [])];
}
const chatMsgsOf = ch => Object.entries(S.room?.chat?.[ch] || {}).map(([id, c]) => ({ id, ...c })).sort((a, b) => a.ts - b.ts);
const readAt = ch => +(ls(`read-${S.code}-${ch}`) || 0);
function markRead(ch) { const l = chatMsgsOf(ch).pop(); if (l && l.ts > readAt(ch)) ls(`read-${S.code}-${ch}`, l.ts); }
const unread = ch => chatMsgsOf(ch).filter(c => c.ts > readAt(ch) && c.pid !== S.pid).length;
const unreadAll = () => chatChannels().reduce((a, [ch]) => a + unread(ch), 0);
function chatTabs(cur) {
  return chatChannels().map(([k, l]) => { const n = k === cur ? 0 : unread(k); return `<button class="${k === cur ? 'on' : ''}" data-act="tab" data-tab="${k}">${esc(l)}${n ? ` <i class="cnt">${n}</i>` : ''}</button>`; }).join('');
}
function chatMsgs(ch) {
  const T = S.room.teams || {}, time = ts => new Date(ts).toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit' });
  return chatMsgsOf(ch).slice(-100).map(c => `<div class="msg ${c.pid === S.pid ? 'me' : ''} ${c.news ? 'news' : ''}">
      <small>${c.news ? '📢 Mededeling · ' : ''}<b style="color:${c.sup ? '#5a3d22' : T[c.team]?.color || '#5a3d22'}">${esc(c.by)}</b>${c.sup ? ' 👑' : T[c.team] ? ' · ' + esc(T[c.team].name) : ''} · ${time(c.ts)}</small>
      <div>${esc(c.text)}</div></div>`).join('')
    || `<p class="hint center">${ch === 'all' ? 'Nog geen berichten. Iedereen in het spel leest mee.' : 'Nog geen berichten. Enkel deze groep en de leiding lezen dit.'}</p>`;
}
function shChat() {
  const ch = chatChannels().some(([k]) => k === S.sheet.tab) ? S.sheet.tab : 'all';
  S.sheet.tab = ch; markRead(ch);
  const to = ch === 'all' ? 'Bericht aan iedereen…' : Me().sup ? `Bericht aan ${S.room.teams[ch]?.name}…` : 'Bericht aan de leiding…';
  return `<h2>💬 Chat</h2><div class="tabs" id="chattabs">${chatTabs(ch)}</div><div class="chatmsgs" id="chatmsgs">${chatMsgs(ch)}</div>
    <form class="chatform" id="chatform"><input id="chatin" maxlength="300" autocomplete="off" placeholder="${esc(to)}"><button class="btn small">Stuur</button></form>`;
}
async function sendChat(text, ch, news) {
  const me = Me(); text = String(text || '').trim().slice(0, 300); if (!text || !me) return;
  const key = await db.push(`${R()}/chat/${ch}`, { by: me.name, pid: S.pid, team: me.team || '', sup: !!me.sup, text, ts: db.now(), ...(news ? { news: true } : {}) });
  ping(news ? 'news' : 'chat', key, ch);
}
A.sendNews = async () => {
  const text = ($('#newsin')?.value || '').trim();
  if (!text) return toast('Typ eerst een mededeling');
  await sendChat(text, 'all', true);
  S.newsDraft = ''; $('#newsin').value = '';
  toast('Mededeling verstuurd');
};

/* ---------- opruimen ---------- */
// Verwijdert spellen die al een tijd voorbij zijn, samen met hun foto's en posities, zodat de database niet volloopt.
// De eindstand blijft bewaard in het archief (history). Loopt hoogstens één keer per dag per toestel.
const KEEP_ENDED = 7 * 864e5, KEEP_IDLE = 30 * 864e5;
async function cleanup() {
  const now = db.now();
  if (now - +(ls('cleaned') || 0) < 864e5) return;
  ls('cleaned', now);
  const [rooms, photos, pos] = await Promise.all(['rooms', 'photos', 'pos'].map(p => db.keys(p)));
  const keep = new Set();
  for (const code of rooms) {
    const m = await db.get(`rooms/${code}/meta`);
    const over = m && (m.phase === 'ended' || (m.phase === 'playing' && now > m.endsAt));
    const old = !m || (over ? now - Math.min(now, m.endsAt || m.createdAt) > KEEP_ENDED : now - m.createdAt > KEEP_IDLE);
    if (old && code !== S.code) await db.set('rooms/' + code, null); else keep.add(code);
  }
  for (const code of new Set([...photos, ...pos])) if (!keep.has(code)) { await db.set('photos/' + code, null); await db.set('pos/' + code, null); }
}

/* ---------- boot ---------- */
navigator.serviceWorker?.register('sw.js').catch(e => console.warn(e));
(async () => {
  const saved = ls('code'), link = (params.get('code') || '').toUpperCase();
  if (saved && (!link || link === saved) && await db.get(`rooms/${saved}/players/${S.pid}`).catch(() => null)) return enterRoom(saved);
  go(link ? 'join' : 'home');
})();
setTimeout(() => cleanup().catch(e => console.warn('Opruimen lukt niet', e)), 4000);
