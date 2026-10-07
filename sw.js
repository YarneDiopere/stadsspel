// Minimale service worker: nodig om op Android meldingen te kunnen tonen.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then(cs => (cs[0] ? cs[0].focus() : self.clients.openWindow('./'))));
});
// Pushmelding van het tussenstation (via Firebase Cloud Messaging): toon ze, ook als de app dicht is.
self.addEventListener('push', e => {
  let d = {};
  try { const j = e.data.json(); d = { ...j.notification, ...j.data }; } catch { /* lege melding */ }
  const show = self.registration.showNotification(d.title || 'Stadsspel', { body: d.body || '', tag: d.tag || 'stadsspel', renotify: true, icon: 'icon-192.png', badge: 'icon-192.png' });
  // Ontvangstbewijs in het spel zelf, zodat na te gaan is of een melding het toestel bereikt heeft.
  const ack = /^https:\/\/stadsspel-836d6-default-rtdb\.[a-z0-9-]+\.firebasedatabase\.app\/rooms\/[A-Z]{4}\/pushAck\//.test(d.ack || '')
    ? fetch(d.ack, { method: 'PUT', body: JSON.stringify({ ts: Date.now(), tag: d.tag || '' }) }).catch(() => {}) : null;
  e.waitUntil(Promise.all([show, ack]));
});
