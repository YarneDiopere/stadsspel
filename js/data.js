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
  t('Piramide', 'Maak een menselijke piramide van 5 verdiepingen.', 'Een menselijke piramide met 5 lagen personen boven elkaar.', 3),
  t('High five', 'Krijg een high five van een vreemde.', 'Een groepslid dat een high five geeft aan een voorbijganger.', 1),
  t('Olifantenpas', 'Doe met je groep de olifantenpas en film het.', 'Een groep die samen de olifantenpas doet.', 1),
  t('Iets gratis', 'Vraag iets gratis in een winkel en toon wat je kreeg.', 'Een groepslid in of bij een winkel met iets dat ze gekregen hebben.', 2),
  t('Kaart doorzuigen', 'Geef met heel het groepje een kaart door van mond tot mond door te zuigen, zonder handen.', 'Een speelkaart die zonder handen van mond tot mond wordt doorgegeven.', 2),
  t('Hapje voor een vreemde', 'Laat een vreemde iets van eten opeten.', 'Een voorbijganger die iets eet dat de groep aanbiedt.', 2),
  t('Flip de cup', 'Speel flip de cup en film een geslaagde flip.', 'Een beker die met een tik op de rand omgedraaid op de tafel landt.', 1),
  t('Selfie met standbeeld', 'Neem een groepsselfie met een standbeeld.', 'Een standbeeld en de groep samen op één foto.', 1),
  t('Polonaise', 'Doe de polonaise met minstens één vreemde erbij.', 'Een rij mensen in polonaise, met minstens één volwassen voorbijganger erbij.', 2),
  t('Insect', 'Vind een insect.', 'Een insect duidelijk zichtbaar op de foto.', 1),
  t('Opruimen', 'Ruim minstens 3 stukken afval op straat op.', 'Minstens 3 stukken afval in de hand of bij een vuilbak.', 1),
  t('Happy birthday', 'Bel ergens aan en zing Happy Birthday voor wie opendoet.', 'Een groep die zingt aan een voordeur.', 3),
  t('KSA-logo', 'Teken het KSA-logo met krijt op straat.', 'Een krijttekening van het KSA-logo op de grond.', 2),
  t('K-S-A-bordjes', 'Neem een foto van 3 straatnaambordjes: samen moeten ze de letters K, S en A tonen.', 'Straatnaambordjes waarop de letters K, S en A te vinden zijn.', 2),
  t('20 koprollen', 'Doe in totaal met je groepje 20 koprollen en film het.', 'Groepsleden die koprollen maken.', 2),
  t('Huisdier aaien', 'Aai een huisdier (vraag het eerst aan het baasje).', 'Iemand die een hond, kat of ander huisdier aait.', 1),
  t('Begrafenis', 'Organiseer een begrafenis voor een gevallen blad.', 'Een groep rond een blad op de grond, als bij een begrafenis.', 2),
  t('Kabouterdans', 'Doe met je groep de kabouterdans en film het.', 'Een groep die samen de kabouterdans doet.', 1),
  t('Filmscène', 'Speel een scène na uit je favoriete film en film het.', 'Groepsleden die samen een scène naspelen.', 2),
  t('Reclame voor oudernamiddag', 'Maak een reclamefilmpje voor de oudernamiddag.', 'Groepsleden die reclame maken voor de oudernamiddag van de KSA.', 2),
  t('Dierenketting', 'Maak een woordenketting van 15 dieren: elk dier begint met de laatste letter van het vorige (dieR → RooS → Slang …). Schrijf ze op en neem er een foto van.', 'Een geschreven lijst van 15 dieren waarbij elk woord begint met de laatste letter van het vorige.', 2),
  t('Binnenstebuiten', 'Draag je jas of trui binnenstebuiten voor de rest van de activiteit.', 'Groepsleden met hun jas of trui binnenstebuiten aan.', 1),
  t('Gepersonaliseerde nummerplaat', 'Vind een gepersonaliseerde nummerplaat.', 'Een nummerplaat met een eigen tekst of naam in plaats van een gewone combinatie.', 2),
  t('Interview', 'Interview een voorbijganger en film het.', 'Een groepslid dat een voorbijganger interviewt.', 2),
  t('Na-aper', 'Aap een voorbijganger een minuut lang na en film het.', 'Een groepslid dat achter of naast een voorbijganger diens bewegingen nadoet.', 2),
  t('Boomknuffel', 'Knuffel een boom voor 2 minuten en film het.', 'Iemand die een boom knuffelt.', 1),
  t('Huisnummer 67', 'Vind huisnummer 67 en doe de 67-move erbij.', 'Huisnummer 67 op een gevel of brievenbus, met iemand die de 67-move doet.', 1),
  t('Limbo', 'Doe de limbo met een voorbijganger en film het.', 'Een voorbijganger die samen met de groep de limbo doet.', 2),
  t('Influencer', 'Doe alsof je een influencer bent en maak een vlog van 30 seconden.', 'Een groepslid dat als influencer in de camera praat.', 1),
  t('Vuistjes', 'Krijg een vuistje van drie verschillende mensen.', 'Groepsleden die een vuistje geven aan voorbijgangers.', 1),
  t('Jumping jacks', 'Vraag iemand om een cijfer tussen 1 en 10 en doe evenveel jumping jacks. Film het.', 'Een voorbijganger die een cijfer zegt en groepsleden die jumping jacks doen.', 1),
  t('Macarena', 'Doe met heel je groepje de macarena op een openbare plek en film het.', 'Een groep die samen de macarena danst op straat of een plein.', 1),
  t('Film uitbeelden', 'Beeld de titel van een film uit zonder woorden. Film het: de leiding moet raden welke film het is.', 'Groepsleden die zonder woorden een filmtitel uitbeelden. Enkel de leiding kan dit beoordelen.', 2),
];

// Spelletjes voor een duel om een zone (modus Duel). Er wordt er telkens één willekeurig gekozen.
export const DUELS = [
  { name: 'Blad-steen-schaar', desc: 'Eén speler per groep. Best van drie.' },
  { name: 'Hanengevecht', desc: 'Eén speler per groep, op één been. Wie eerst met twee voeten op de grond staat, verliest.' },
  { name: 'Krokodillengevecht', desc: 'Eén speler per groep, volgens de uitleg van de leiding.' },
];
