export const TEAMS = [
  { name: 'Rood', color: '#d64545' },
  { name: 'Blauw', color: '#3b7dd8' },
  { name: 'Groen', color: '#3f9d5a' },
  { name: 'Geel', color: '#e0b422' },
  { name: 'Paars', color: '#8e5bd0' },
  { name: 'Oranje', color: '#e8792b' },
  { name: 'Roze', color: '#e26aa5' },
  { name: 'Turkoois', color: '#2bb3b1' },
];

export const UNITS = [
  { id: 'a', fig: 'squire', name: 'Schildknaap', power: 1, price: 15, desc: 'Goedkoop en trouw.' },
  { id: 'd', fig: 'archer', name: 'Boogschutter', power: 2, price: 28, desc: 'Raakt van ver.' },
  { id: 'b', fig: 'knight', name: 'Ridder', power: 3, price: 40, desc: 'Telt voor drie.' },
  { id: 'e', fig: 'rider', name: 'Ruiter', power: 5, price: 62, desc: 'Stormt een zone binnen.' },
  { id: 'c', fig: 'cannon', name: 'Kanon', power: 7, price: 85, desc: 'Blaast een zone open.' },
  { id: 'f', fig: 'tower', name: 'Belegeringstoren', power: 12, price: 140, desc: 'Het zwaarste geschut.' },
];

export const DURATIONS = [30, 45, 60, 90, 120, 150, 180, 240];

// Beloning in goud per moeilijkheidsgraad (modus Leger). In modus Verover telt de graad zelf als sterkte.
export const REWARD = { 1: 20, 2: 40, 3: 70 };

export const START_POWER = 3;

const t = (title, desc, check, diff) => ({ title, desc, check, diff });
export const DEFAULT_TASKS = [
  t('Handtekeningenjacht', 'Verzamel 10 handtekeningen van voorbijgangers op één blad.', 'Een blad papier met minstens 10 duidelijk verschillende handtekeningen. Tel ze.', 2),
  t('Menselijke piramide', 'Bouw een menselijke piramide met minstens 6 personen.', 'Minstens 6 personen in een piramide van minstens twee lagen.', 2),
  t('Hondenvriend', 'Maak een groepsfoto met een hond van een voorbijganger.', 'Meerdere jongeren samen met een echte hond.', 1),
  t('Levend standbeeld', 'Doe met de groep de pose van een standbeeld na, mét het standbeeld op de foto.', 'Een standbeeld en minstens één persoon in dezelfde pose.', 1),
  t('Hoedje af', 'Neem een selfie met een voorbijganger die een hoed of pet draagt.', 'Een selfie met iemand die een hoofddeksel draagt.', 1),
  t('Regenboog', 'Leg vijf voorwerpen naast elkaar: rood, oranje, geel, groen en blauw.', 'Vijf voorwerpen naast elkaar in de kleuren rood, oranje, geel, groen en blauw.', 2),
  t('K-S-A', 'Vorm met jullie lichamen de letters K, S en A.', 'Personen die liggend of staand herkenbaar de letters K, S en A vormen.', 2),
  t('Polonaise', 'Film een polonaise met minstens 3 voorbijgangers erbij.', 'Een rij mensen in polonaise met handen op elkaars schouders, waaronder volwassenen.', 3),
  t('Serenade', 'Zing als groep een liedje voor een voorbijganger en film het.', 'Een groep die zingt voor een toeschouwer.', 2),
  t('High five-ketting', 'Film hoe jullie 10 high fives krijgen van voorbijgangers.', 'Een video met minstens 10 high fives met verschillende mensen. Tel ze.', 3),
  t('Spring!', 'Maak een foto waarop heel de groep tegelijk in de lucht hangt.', 'Meerdere personen die tegelijk los van de grond zijn.', 1),
  t('Toren in de hand', 'Maak een perspectieffoto waarop iemand een toren of hoog gebouw "vasthoudt".', 'Een persoon die door perspectief een toren of gebouw lijkt vast te houden.', 2),
  t('Duim van de winkelier', 'Ga op de foto met een winkelier achter de toonbank, duim omhoog.', 'Binnen in een winkel, iemand achter een toonbank met duim omhoog.', 2),
  t('Fietsenstad', 'Zet minstens 8 fietsen in één beeld.', 'Minstens 8 fietsen zichtbaar. Tel ze.', 1),
  t('Straatnaam', 'Zoek een straatnaambord dat met een K, S of A begint en ga er mee op de foto.', 'Een straatnaambord waarvan de naam begint met K, S of A, met minstens één persoon erbij.', 1),
  t('Rode brievenbus', 'Groepsfoto rond een rode brievenbus.', 'Een rode brievenbus met meerdere personen errond.', 1),
  t('Waterkant', 'Groepsfoto bij water: een fontein, rivier of vijver.', 'Meerdere personen bij een fontein, rivier, kanaal of vijver.', 1),
  t('Portret', 'Laat een voorbijganger iemand van de groep tekenen. Toon tekening en model samen.', 'Een getekend portret op papier naast de persoon die getekend werd.', 3),
  t('Op handen gedragen', 'Til één groepslid met z\'n allen horizontaal boven de grond.', 'Eén persoon die horizontaal gedragen wordt door minstens drie anderen.', 2),
  t('Bladerdek', 'Verzamel bladeren van 3 verschillende boomsoorten.', 'Drie duidelijk verschillende soorten boombladeren naast elkaar.', 1),
  t('Kruiwagenrace', 'Film een kruiwagenrace tussen twee duo\'s.', 'Twee duo\'s die een kruiwagenrace doen (één loopt op de handen, de ander houdt de benen vast).', 2),
  t('Huisnummer 100', 'Zoek een huisnummer van 100 of hoger.', 'Een huisnummer van 100 of hoger duidelijk leesbaar op een gevel of brievenbus.', 1),
  t('Oud steen', 'Zoek een gevel met een jaartal van vóór 1950.', 'Een gebouw of gevelsteen met een leesbaar jaartal vóór 1950.', 2),
  t('Mop van de dag', 'Vertel een voorbijganger een mop en film de reactie.', 'Iemand die een mop vertelt aan een voorbijganger die lacht of reageert.', 3),
  t('Schoenentoren', 'Stapel alle schoenen van de groep tot één toren.', 'Een stapel van minstens 6 schoenen op elkaar.', 1),
  t('Spiegelbeeld', 'Maak een foto van jezelf of de groep via een spiegel of etalageruit.', 'Een weerspiegeling van één of meer personen in een spiegel of ruit.', 1),
];
