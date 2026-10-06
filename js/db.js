import { firebaseConfig } from './config.js';

// Eén kleine API bovenop Firebase Realtime Database, met een lokale variant
// (localStorage + BroadcastChannel) voor demo en testen zonder Firebase.

const FB = 'https://www.gstatic.com/firebasejs/10.12.2/';

function loadScript(src) {
  return new Promise((ok, err) => {
    const s = document.createElement('script');
    s.src = src; s.onload = ok; s.onerror = () => err(new Error('Kon ' + src + ' niet laden'));
    document.head.appendChild(s);
  });
}

async function firebaseDb(cfg) {
  await loadScript(FB + 'firebase-app-compat.js');
  await loadScript(FB + 'firebase-database-compat.js');
  window.firebase.initializeApp(cfg);
  const d = window.firebase.database();
  let off = 0;
  d.ref('.info/serverTimeOffset').on('value', s => { off = s.val() || 0; });
  return {
    on(p, cb) { const r = d.ref(p), f = s => cb(s.val()); r.on('value', f); return () => r.off('value', f); },
    get: p => d.ref(p).get().then(s => s.val()),
    set: (p, v) => d.ref(p).set(v),
    update: (p, o) => d.ref(p).update(o),
    push(p, v) { const r = d.ref(p).push(); return r.set(v).then(() => r.key); },
    tx: (p, fn) => d.ref(p).transaction(fn).then(r => ({ committed: r.committed, value: r.snapshot.val() })),
    now: () => Date.now() + off,
  };
}

function localDb() {
  const KEY = 'stadsspel-db';
  const bc = new BroadcastChannel(KEY);
  const subs = new Set();
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
  let tree = load();
  const keys = p => p.split('/').filter(Boolean);
  const getP = p => keys(p).reduce((o, k) => (o == null ? undefined : o[k]), tree);
  const setP = (p, v) => {
    const ks = keys(p); let o = tree;
    for (let i = 0; i < ks.length - 1; i++) {
      if (typeof o[ks[i]] !== 'object' || o[ks[i]] === null) o[ks[i]] = {};
      o = o[ks[i]];
    }
    const k = ks[ks.length - 1];
    if (v === null || v === undefined) delete o[k]; else o[k] = v;
  };
  const clone = v => (v == null ? null : JSON.parse(JSON.stringify(v)));
  const fire = () => subs.forEach(s => {
    const j = JSON.stringify(getP(s.path) ?? null);
    if (j !== s.last) { s.last = j; s.cb(JSON.parse(j)); }
  });
  const commit = () => {
    try { localStorage.setItem(KEY, JSON.stringify(tree)); } catch (e) { console.warn('Opslag vol', e); }
    bc.postMessage(1); fire();
  };
  bc.onmessage = () => { tree = load(); fire(); };
  let n = 0;
  return {
    on(path, cb) {
      const s = { path, cb, last: undefined }; subs.add(s);
      queueMicrotask(() => { if (subs.has(s) && s.last === undefined) { s.last = JSON.stringify(getP(path) ?? null); cb(JSON.parse(s.last)); } });
      return () => subs.delete(s);
    },
    get: async p => clone(getP(p)),
    async set(p, v) { tree = load(); setP(p, clone(v)); commit(); },
    async update(p, o) { tree = load(); for (const k in o) setP(p + '/' + k, clone(o[k])); commit(); },
    async push(p, v) { const k = Date.now().toString(36) + (n++).toString(36) + Math.random().toString(36).slice(2, 6); await this.set(p + '/' + k, v); return k; },
    async tx(p, fn) {
      tree = load();
      const r = fn(clone(getP(p)));
      if (r === undefined) return { committed: false, value: clone(getP(p)) };
      setP(p, clone(r)); commit();
      return { committed: true, value: clone(r) };
    },
    now: () => Date.now(),
  };
}

export const isLocal = !firebaseConfig;
export const db = isLocal ? localDb() : await firebaseDb(firebaseConfig);
