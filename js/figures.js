// Speelstukken als kleine getekende beeldjes (bordspelstijl) in de kleur van de groep.
// Elk onderdeel wordt twee keer getekend: één keer in kleur en één keer met een licht-donkerverloop erover, voor de ronding.

const METAL = '#cfd5dc', IRON = '#59606a', GOLD = '#d9a93a', WOOD = '#8a5a30', LINE = '#2a1c0e';

document.body.insertAdjacentHTML('beforeend', `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
  <linearGradient id="fg-sh" x1="0" x2="1" y1="0" y2="0.25">
    <stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset=".38" stop-color="#fff" stop-opacity="0"/>
    <stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".42"/>
  </linearGradient>
  <radialGradient id="fg-fl" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#000" stop-opacity=".4"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>
</defs></svg>`);

// Een gevulde vorm met schaduwverloop en donkere omlijning. fill 'c' = groepskleur.
const sh = (tag, attrs, fill = 'c') => {
  const f = fill === 'c' ? 'var(--c, #a3322a)' : fill;
  return `<${tag} ${attrs} fill="${f}"/><${tag} ${attrs} fill="url(#fg-sh)" stroke="${LINE}" stroke-width="1.4" stroke-linejoin="round"/>`;
};
const P = (d, fill) => sh('path', `d="${d}"`, fill);
const BASE = `<ellipse cx="32" cy="67" rx="23" ry="5" fill="url(#fg-fl)"/>` + P('M11 60 q0 -5 21 -5 q21 0 21 5 v3 q0 5 -21 5 q-21 0 -21 -5z') + `<ellipse cx="32" cy="60" rx="21" ry="5" fill="#fff" opacity=".18"/>`;
const BODY = P('M21 60 C21 46 26 42 27 32 h10 C38 42 43 46 43 60 q-11 4 -22 0z');
const COLLAR = sh('ellipse', 'cx="32" cy="32" rx="8.5" ry="3"');
const head = fill => sh('circle', 'cx="32" cy="22" r="9"', fill);

const ART = {
  squire: BODY + COLLAR + head() +
    P('M35 38 h15 v8 q0 9 -7.5 12 q-7.5 -3 -7.5 -12z', METAL) + `<path d="M42.5 40 v14 M37.5 46 h10" stroke="${GOLD}" stroke-width="2.4" stroke-linecap="round"/>`,
  archer: BODY + COLLAR + head() +
    P('M21 25 q2 -17 11 -19 q9 2 11 19 q-11 -6 -22 0z') +
    `<path d="M49 18 q13 20 0 40" fill="none" stroke="${LINE}" stroke-width="4.6" stroke-linecap="round"/><path d="M49 18 q13 20 0 40" fill="none" stroke="${WOOD}" stroke-width="2.6" stroke-linecap="round"/>
     <path d="M49 18 v40" stroke="#fff" stroke-width="1" opacity=".8"/><path d="M40 38 h17 l-3 -2.5 m3 2.5 l-3 2.5" fill="none" stroke="${LINE}" stroke-width="1.6" stroke-linecap="round"/>`,
  knight: BODY + COLLAR + head(METAL) +
    `<path d="M25 21 h14" stroke="${LINE}" stroke-width="2.2" stroke-linecap="round"/><path d="M32 21 v7" stroke="${LINE}" stroke-width="1.4"/>` +
    P('M31 13 q5 -13 15 -5 q-8 0 -10 7z') +
    P('M48 14 l2.2 -4 l2.2 4 v30 h-4.4z', METAL) + P('M43.5 44 h13 v3.4 h-13z', GOLD) + P('M48.6 47.4 h3.2 v7 h-3.2z', WOOD),
  rider: P('M19 60 C19 48 26 44 26 36 C22 37 17 39 14 34 C16 24 27 12 40 12 L38 6 L45 11 C52 18 52 34 45 45 C45 51 46 54 46 60 q-13 4 -27 0z') +
    `<circle cx="33" cy="23" r="1.9" fill="${LINE}"/><path d="M17 33 q3 1 5 -1" fill="none" stroke="${LINE}" stroke-width="1.4" stroke-linecap="round"/>
     <path d="M43 14 q6 10 2 24" fill="none" stroke="${LINE}" stroke-width="1.6" stroke-linecap="round" opacity=".55"/>` +
    P('M26 44 q10 5 19 1 l1 5 q-10 4 -21 -1z', GOLD),
  cannon: P('M16 37 L47 19 q6 -2 8 4 q2 6 -3 9 L24 50 q-6 2 -9 -4 q-2 -6 1 -9z', IRON) +
    P('M44 20.5 l5 9.5 l4 -2.2 l-5 -9.6z', GOLD) +
    sh('circle', 'cx="24" cy="50" r="11"', WOOD) + `<path d="M24 39 v22 M13 50 h22 M16.2 42.2 l15.6 15.6 M31.8 42.2 l-15.6 15.6" stroke="${LINE}" stroke-width="1.5"/>` + sh('circle', 'cx="24" cy="50" r="3.2"', GOLD),
  tower: P('M19 60 L23 30 h-5 v-15 h6 v5 h5 v-5 h6 v5 h5 v-5 h6 v15 h-5 L45 60 q-13 4 -26 0z') +
    `<path d="M22.6 34 h18.8" stroke="${LINE}" stroke-width="1.4" opacity=".6"/><path d="M28 60.5 v-10 q4 -6 8 0 v10z" fill="${LINE}" opacity=".8"/><rect x="30" y="38" width="4" height="6" rx="2" fill="${LINE}" opacity=".8"/>` +
    `<path d="M32 15 v-11" stroke="${LINE}" stroke-width="1.6"/>` + P('M32.6 4 l9 3 l-9 3z', GOLD),
};

export function figure(kind, color) {
  return `<svg class="fig" viewBox="0 0 64 74" style="--c:${color || '#a3322a'}" aria-hidden="true">${BASE}${ART[kind] || ART.squire}</svg>`;
}
