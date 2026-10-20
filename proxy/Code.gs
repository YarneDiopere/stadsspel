// Tussenstation voor de fotocontrole van het stadsspel (Google Apps Script, web-app).
// De Gemini-sleutel staat in Projectinstellingen > Scripteigenschappen als GEMINI_KEY
// en verlaat dit script nooit. De site stuurt enkel de foto en de opdracht door.

const DB = 'https://stadsspel-836d6-default-rtdb.europe-west1.firebasedatabase.app';
// Snelle modellen eerst: een groep die staat te wachten heeft meer aan tempo dan aan finesse.
// Gemeten: de twee lite-modellen antwoorden in minder dan een seconde; de zwaardere zijn vaak overbelast.
const MODELS = ['gemini-flash-lite-latest', 'gemini-3.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-3.1-flash-lite', 'gemini-3.8-flash'];

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    const q = JSON.parse(e.postData.contents);
    // Enkel voor een spel dat nu bezig is, zodat niemand dit adres voor iets anders gebruikt.
    if (!/^[A-Z]{4}$/.test(q.code || '')) return out({ error: 'ongeldige code' });
    const phase = UrlFetchApp.fetch(DB + '/rooms/' + q.code + '/meta/phase.json', { muteHttpExceptions: true }).getContentText();
    if (phase !== '"playing"') return out({ error: 'geen lopend spel' });

    if (q.action === 'notify') return out(notify(q));

    const key = PropertiesService.getScriptProperties().getProperty('GEMINI_KEY');
    if (!key) return out({ error: 'geen sleutel ingesteld' });

    const prompt = 'Je bent een milde scheidsrechter bij een stadsspel van een jeugdbeweging.\n' +
      'Opdracht: "' + String(q.title).slice(0, 100) + '"\n' +
      'Omschrijving: ' + String(q.desc || '-').slice(0, 300) + '\n' +
      'Wat er te zien moet zijn: ' + String(q.check || q.desc || q.title).slice(0, 300) + '\n\n' +
      'Keur goed als de kern van de opdracht herkenbaar op het beeld staat. Wees soepel over details, ' +
      'beeldkwaliteit en het exacte aantal personen. Tel enkel na wanneer de opdracht uitdrukkelijk een aantal voorwerpen vraagt, ' +
      'en reken dan een kleine marge. Keur enkel af als het beeld duidelijk iets anders toont of de kern ontbreekt. Bij twijfel: goedkeuren.\n' +
      'Antwoord enkel met JSON: {"ok": true of false, "reden": "korte uitleg in het Nederlands, hoogstens 15 woorden"}';
    const payload = JSON.stringify({
      contents: [{ parts: [{ inline_data: { mime_type: q.mime, data: q.data } }, { text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    });

    const fails = [];
    for (const model of MODELS) {
      const r = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
        method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': key }, payload, muteHttpExceptions: true,
      });
      const status = r.getResponseCode();
      if (status !== 200) { fails.push(model.replace('gemini-', '') + ' ' + status); continue; }
      const parts = JSON.parse(r.getContentText()).candidates[0].content.parts;
      const res = JSON.parse(parts.filter(p => !p.thought).map(p => p.text || '').join(''));
      return out({ ok: res.ok === true, reden: String(res.reden || '').slice(0, 200) });
    }
    return out({ error: 'de AI antwoordt niet (' + fails.join(', ') + ')' });
  } catch (err) {
    return out({ error: String(err).slice(0, 150) });
  }
}

// Pushmeldingen (ook met de gsm op slot). Wat er gemeld wordt, leest dit script zelf uit het spel in de database;
// de site zegt enkel welk soort melding en over welke inzending, groep of opdracht het gaat:
//   sub  = bewijs wacht op de leiding            -> naar de leiding
//   skip = een groep vraagt een andere opdracht   -> naar de leiding
//   task = een groep kreeg een nieuwe opdracht    -> naar de leden van die groep
//   new  = de leiding voegde een opdracht toe     -> naar iedereen in een groep
//   duel = een groep daagt een zone uit           -> naar de leden van de verdedigende groep
//   buzz = de leiding start een buzzer-ronde      -> naar iedereen in een groep
//   pack = de leiding verstopte een pakketje      -> naar iedereen in een groep
//   chat = een chatbericht (kanaal q.ch)          -> 'all': iedereen, groepskanaal: die groep en de leiding (niet naar wie het stuurde)
//   news = een mededeling van de leiding          -> naar iedereen behalve wie ze stuurde
//   gps  = iemand geeft geen locatie meer door    -> naar de leiding
// Het sleutelbestand van het Firebase-serviceaccount staat als FCM_SA in de Scripteigenschappen (de volledige JSON).
function notify(q) {
  const kind = q.kind || 'sub', id = String(q.id || q.sid || '');
  if (!/^[-\w]{1,40}$/.test(id)) return { error: 'ongeldige melding' };
  const sa = PropertiesService.getScriptProperties().getProperty('FCM_SA');
  if (!sa) return { error: 'geen FCM-sleutel ingesteld' };
  const cache = CacheService.getScriptCache(), room = DB + '/rooms/' + q.code;
  const get = p => JSON.parse(UrlFetchApp.fetch(room + p + '.json', { muteHttpExceptions: true }).getContentText());

  let title, body, tag, to;
  if (kind === 'sub') {
    const sub = get('/subs/' + id);
    if (!sub || sub.status !== 'pending') return { error: 'geen wachtend bewijs' };
    title = 'Nieuw bewijs om na te kijken'; tag = 'sub-' + id; to = p => p.sup;
    body = (get('/teams/' + sub.team + '/name') || 'Een groep') + ' · ' + (get('/tasks/' + sub.task + '/title') || 'opdracht');
  } else if (kind === 'skip') {
    const t = get('/teams/' + id);
    if (!t || !t.skipReq) return { error: 'geen vraag' };
    title = 'Vraag van een groep'; tag = 'skip-' + id + ':' + t.skipReq; to = p => p.sup;
    body = t.name + ' wil een andere opdracht';
  } else if (kind === 'task') {
    const t = get('/teams/' + id);
    if (!t || !t.cur) return { error: 'geen opdracht' };
    title = 'Nieuwe opdracht voor jullie groep'; tag = 'task-' + t.cur; to = p => p.team === id;
    body = get('/tasks/' + t.cur + '/title') || '';
  } else if (kind === 'new') {
    body = get('/tasks/' + id + '/title');
    if (!body) return { error: 'geen opdracht' };
    title = 'Nieuwe opdracht'; tag = 'task-' + id; to = p => !!p.team;
  } else if (kind === 'duel') {
    const x = get('/duels/' + id);
    if (!x || x.status !== 'wait') return { error: 'geen duel' };
    const z = JSON.parse(get('/zonesJson') || '[]').filter(z => z.id === id)[0];
    title = '⚔️ Jullie zone wordt aangevallen!'; tag = 'duel-' + id + ':' + x.at; to = p => p.team === x.def;
    body = (get('/teams/' + x.att + '/name') || 'Een groep') + ' daagt jullie uit in ' + (z ? z.name : 'een zone') + '. Ren terug: jullie hebben 3 minuten!';
  } else if (kind === 'buzz') {
    const b = get('/buzz');
    if (!b || b.id !== id) return { error: 'geen buzzer-ronde' };
    title = '🚨 Buzzer!'; tag = 'buzz-' + id; to = p => !!p.team;
    body = 'Ren met je hele groep naar ' + b.label + '!';
  } else if (kind === 'pack') {
    if (!get('/packs/' + id)) return { error: 'geen pakketje' };
    title = '📦 Nieuw pakketje verstopt!'; tag = 'pack-' + id; to = p => !!p.team;
    body = 'Bekijk de foto bij Pakketjes en ga zoeken.';
  } else if (kind === 'chat' || kind === 'news') {
    const ch = String(q.ch || '');
    if (!/^(all|t\d)$/.test(ch)) return { error: 'ongeldig kanaal' };
    const msg = get('/chat/' + ch + '/' + id);
    if (!msg) return { error: 'geen bericht' };
    if (kind === 'news' && !(msg.news && msg.sup)) return { error: 'geen mededeling' };
    title = kind === 'news' ? '📢 Mededeling van de leiding' : '💬 ' + msg.by + (ch === 'all' ? '' : ' (privé)');
    body = String(msg.text || '').slice(0, 150); tag = kind === 'news' ? 'news-' + id : 'chat-' + ch;
    to = (p, pid) => pid !== msg.pid && (ch === 'all' || p.sup || p.team === ch);
  } else if (kind === 'gps') {
    const pl = get('/players/' + id);
    if (!pl || !pl.gpsOff) return { error: 'locatie is niet uit' };
    title = '📍 Locatie uit'; tag = 'gps-' + id + ':' + pl.gpsOff.ts; to = p => p.sup;
    body = pl.name + ' geeft geen locatie meer door. Kijk even waar die is.';
  } else return { error: 'onbekende melding' };

  const once = 'n-' + q.code + '-' + kind + '-' + id + '-' + tag;
  if (cache.get(once)) return { ok: true, sent: 0 }; // hiervoor is net al gemeld
  cache.put(once, '1', 120);

  const tokens = get('/push') || {}, players = get('/players') || {};
  const key = JSON.parse(sa), bearer = accessToken(key, cache);
  let sent = 0;
  Object.keys(tokens).forEach(pid => {
    if (!players[pid] || !to(players[pid], pid)) return;
    const r = UrlFetchApp.fetch('https://fcm.googleapis.com/v1/projects/' + key.project_id + '/messages:send', {
      method: 'post', contentType: 'application/json', headers: { Authorization: 'Bearer ' + bearer }, muteHttpExceptions: true,
      payload: JSON.stringify({ message: {
        token: tokens[pid],
        data: { title: title, body: body, tag: tag, ack: room + '/pushAck/' + pid + '.json' },
        webpush: { headers: { Urgency: 'high', TTL: '900' } },
      } }),
    });
    if (r.getResponseCode() === 200) sent++;
    else if (r.getResponseCode() === 404) UrlFetchApp.fetch(room + '/push/' + pid + '.json', { method: 'delete', muteHttpExceptions: true }); // toestel bestaat niet meer
  });
  return { ok: true, sent: sent };
}

// Tijdelijk toegangsbewijs voor Firebase Cloud Messaging, ondertekend met het serviceaccount. Blijft 50 minuten in de cache van dit script.
function accessToken(key, cache) {
  const hit = cache.get('fcm-token');
  if (hit) return hit;
  const b64 = s => Utilities.base64EncodeWebSafe(s).replace(/=+$/, '');
  const now = Math.floor(Date.now() / 1000);
  const head = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + b64(JSON.stringify({
    iss: key.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }));
  const jwt = head + '.' + b64(Utilities.computeRsaSha256Signature(head, key.private_key));
  const r = JSON.parse(UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post', payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt },
  }).getContentText());
  cache.put('fcm-token', r.access_token, 3000);
  return r.access_token;
}

function doGet() { return out({ ok: true, info: 'stadsspel fotocontrole' }); }
