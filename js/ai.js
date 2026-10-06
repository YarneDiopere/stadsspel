// Bewijs (foto of video) klaarmaken en laten nakijken via het tussenstation (proxy/Code.gs).

const MAX_VIDEO = 8e6; // grotere filmpjes gaan rechtstreeks naar de leiding

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

async function ask(proxyUrl, body) {
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 25000);
  try {
    // text/plain houdt het een "eenvoudig" verzoek, zodat de browser geen preflight stuurt die Apps Script niet beantwoordt.
    const r = await fetch(proxyUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, signal: ctl.signal, body });
    if (!r.ok) throw new Error('tussenstation gaf fout ' + r.status);
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    return { ok: j.ok === true, reden: j.reden || '' };
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'het duurde te lang' : e.message);
  } finally { clearTimeout(to); }
}

export async function verify(proxyUrl, code, task, media) {
  const body = JSON.stringify({ code, title: task.title, desc: task.desc, check: task.check, mime: media.mime, data: media.data });
  try { return await ask(proxyUrl, body); }
  catch (e) { if (e.message === 'geen lopend spel') throw e; return ask(proxyUrl, body); } // één keer opnieuw proberen
}
