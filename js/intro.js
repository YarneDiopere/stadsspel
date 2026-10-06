// Geanimeerde speluitleg die elke groep te zien krijgt op het startpunt.

const SCENE_MS = 6500;

const tiles = () => {
  const cols = ['#d64545', '#3b7dd8', '#3f9d5a', '#e0b422'];
  return '<div class="in-grid">' + Array.from({ length: 16 }, (_, i) => `<i style="--c:${cols[(i * 7 + (i >> 2)) % 4]};--d:${(i * 0.17).toFixed(2)}s"></i>`).join('') + '</div>';
};

function scenes(mode) {
  const leger = mode === 'leger';
  return [
    { art: '<div class="in-scroll">🗺️</div><h2 class="in-title">De stad ligt voor het grijpen</h2>', text: 'Vandaag is deze stad jullie speelbord. Er kan maar één groep heersen.' },
    { art: tiles(), text: 'De stad is verdeeld in zones. Wie de meeste zones bezit wanneer de tijd om is, wint.' },
    leger
      ? { art: '<div class="in-row"><span class="in-pop">📸</span><span class="in-arrow">➜</span><span class="in-pop d1">✅</span><span class="in-arrow d1">➜</span><span class="in-pop d2">💰</span></div>', text: 'Voer opdrachten uit en bewijs ze met een foto of filmpje. Goedgekeurd? Dan verdien je goud.' }
      : { art: '<div class="in-row"><span class="in-pop">📍</span><span class="in-arrow">➜</span><span class="in-pop d1">📸</span><span class="in-arrow d1">➜</span><span class="in-pop d2">🏰</span></div>', text: 'Ga in een zone staan, voer een opdracht uit en bewijs ze met een foto of filmpje. Goedgekeurd? Dan is de zone van jou.' },
    leger
      ? { art: '<div class="in-row march"><span>🛡️</span><span>🛡️</span><span>⚔️</span><span>⚔️</span><span>💣</span></div>', text: 'Met goud koop je soldaten in de winkel. Schildknapen zijn goedkoop, ridders en kanonnen slaan harder.' }
      : { art: '<div class="in-row march"><span>⭐</span><span>⭐⭐</span><span>⭐⭐⭐</span></div>', text: 'Hoe moeilijker de opdracht, hoe meer sterkte ze oplevert voor de zone waar je staat.' },
    { art: '<div class="in-math"><b class="in-pop">10</b><span class="in-pop d1">−</span><b class="in-pop d1 def">8</b><span class="in-pop d2">=</span><b class="in-pop d2 win">2</b></div>', text: (leger ? 'Sta je in een zone? Zet er soldaten in.' : 'Staat er al een groep?') + ' Aanval min verdediging: 10 tegen 8 wint, en er blijven er 2 over om de zone te houden.' },
    { art: '<div class="in-scroll">🏰</div>', text: 'Versterk je eigen zones om ze te verdedigen. Blijf als groep samen en kijk uit in het verkeer. Veel succes!' },
  ];
}

export function playIntro(mode) {
  return new Promise(done => {
    const list = scenes(mode), el = document.getElementById('overlay');
    let i = -1, timer;
    const finish = () => { clearTimeout(timer); el.hidden = true; el.innerHTML = ''; el.className = ''; done(); };
    const show = n => {
      i = n; clearTimeout(timer);
      if (i >= list.length) return finish();
      const s = list[i];
      el.innerHTML = `<div class="intro">
        <div class="in-bar">${list.map((_, k) => `<i class="${k < i ? 'done' : k === i ? 'on' : ''}" style="--ms:${SCENE_MS}ms"></i>`).join('')}</div>
        <div class="in-art">${s.art}</div>
        <p class="in-text">${s.text}</p>
        <div class="in-btns"><button class="btn ghost" data-in="skip">Overslaan</button><button class="btn" data-in="next">${i === list.length - 1 ? 'Start!' : 'Verder'}</button></div>
      </div>`;
      timer = setTimeout(() => show(i + 1), SCENE_MS);
    };
    el.className = 'intro-wrap'; el.hidden = false;
    el.onclick = e => { const b = e.target.closest('[data-in]'); if (!b) return; b.dataset.in === 'skip' ? finish() : show(i + 1); };
    show(0);
  });
}
