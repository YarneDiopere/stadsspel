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

function doGet() { return out({ ok: true, info: 'stadsspel fotocontrole' }); }
