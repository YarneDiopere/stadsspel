# Stadsspel

Een Risk-achtig stadsspel voor de KSA: verover zones in het stadscentrum door opdrachten uit te voeren.

Live: https://yarnediopere.github.io/stadsspel/

## Firebase koppelen

Zonder Firebase draait de app in demo-modus (alles blijft op één toestel).

1. Maak een gratis project op https://console.firebase.google.com (Spark-plan, geen kaart nodig).
2. Build > Realtime Database > Create database (regio europe-west1).
3. Zet bij Rules: `{ "rules": { ".read": true, ".write": true } }`
4. Project settings > Your apps > Web app (`</>`) en kopieer de `firebaseConfig`.
5. Plak die in `js/config.js` en push.

## Lokaal draaien

    python -m http.server 8765

Voeg `?p=2` toe aan de url om in een tweede tabblad een tweede speler te simuleren.
