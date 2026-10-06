// Bewijs (foto of video) klaarmaken en laten beoordelen door Gemini.

const MODELS = ['gemini-flash-latest', 'gemini-2.5-flash'];
const MAX_VIDEO = 14e6; // inline limiet van Gemini is 20 MB na base64

function toJpeg(src, w, h, max, q) {
  const k = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * k); c.height = Math.round(h * k);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', q);
}

function imageToJpeg(file) {
  return new Promise((ok, err) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => { ok(toJpeg(img, img.naturalWidth, img.naturalHeight, 1024, 0.72)); URL.revokeObjectURL(url); };
    img.onerror = () => err(new Error('Kon de foto niet lezen'));
    img.src = url;
  });
}

function videoThumb(file) {
  return new Promise((ok, err) => {
    const url = URL.createObjectURL(file), v = document.createElement('video');
    const to = setTimeout(() => err(new Error('timeout')), 6000);
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.onloadeddata = () => { v.currentTime = Math.min(1, (v.duration || 2) / 2); };
    v.onseeked = () => { clearTimeout(to); ok(toJpeg(v, v.videoWidth, v.videoHeight, 800, 0.7)); URL.revokeObjectURL(url); };
    v.onerror = () => { clearTimeout(to); err(new Error('Kon de video niet lezen')); };
    v.src = url;
  });
}

const b64 = file => new Promise((ok, err) => {
  const r = new FileReader();
  r.onload = () => ok(r.result.split(',')[1]); r.onerror = () => err(r.error);
  r.readAsDataURL(file);
});

export async function prepareMedia(file) {
  if (file.type.startsWith('video/')) {
    const thumb = await videoThumb(file).catch(() => null);
    let ai = null;
    if (file.size < MAX_VIDEO) ai = { mime: file.type === 'video/quicktime' ? 'video/mov' : file.type.split(';')[0], data: await b64(file) };
    return { thumb, ai, video: true };
  }
  const thumb = await imageToJpeg(file);
  return { thumb, ai: { mime: 'image/jpeg', data: thumb.split(',')[1] }, video: false };
}

export async function verify(key, task, media) {
  const prompt = `Je bent scheidsrechter bij een stadsspel van een jeugdbeweging.
Opdracht: "${task.title}"
Omschrijving: ${task.desc || '-'}
Wat er te zien moet zijn: ${task.check || task.desc || task.title}

Bekijk het bewijs en oordeel of de opdracht overtuigend is uitgevoerd. Tel waar een aantal gevraagd wordt. Keur af als het bewijs ontbreekt, onduidelijk is of duidelijk van een scherm is gefotografeerd, maar wees niet kleinzielig over details.
Antwoord enkel met JSON: {"ok": true of false, "reden": "korte uitleg in het Nederlands, hoogstens 20 woorden"}`;
  const body = JSON.stringify({
    contents: [{ parts: [{ inline_data: { mime_type: media.mime, data: media.data } }, { text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0 },
  });
  let last;
  for (const model of MODELS) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body,
    });
    if (r.status === 404) { last = new Error('Model niet gevonden'); continue; }
    if (!r.ok) throw new Error('Gemini ' + r.status);
    const j = await r.json();
    const out = JSON.parse(j.candidates[0].content.parts.map(p => p.text || '').join(''));
    return { ok: out.ok === true, reden: String(out.reden || '').slice(0, 200) };
  }
  throw last;
}
