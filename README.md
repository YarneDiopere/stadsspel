# Stadsspel

Een Risk-achtig stadsspel voor de KSA: verover zones in het stadscentrum door opdrachten uit te voeren.

Live: https://yarnediopere.github.io/stadsspel/

## Firebase

De app gebruikt de Realtime Database van het Firebase-project `stadsspel-836d6` (regio europe-west1).
De koppeling staat in `js/config.js`. De databaseregels laten iedereen lezen en schrijven op
`rooms`, `photos`, `pos` en `archive`. Zet `firebaseConfig` op `null` voor demo-modus op één toestel.

## Lokaal draaien

    python -m http.server 8765

Voeg `?p=2` toe aan de url om in een tweede tabblad een tweede speler te simuleren.
