// Firebase-project "stadsspel". Voor de Realtime Database volstaan deze twee waarden;
// ze zijn niet geheim. Zet dit op null om in demo-modus (alles op één toestel) te draaien.
export const firebaseConfig = {
  projectId: 'stadsspel-836d6',
  databaseURL: 'https://stadsspel-836d6-default-rtdb.europe-west1.firebasedatabase.app',
};

// Adres van het tussenstation (Google Apps Script, zie proxy/Code.gs) dat foto's laat nakijken.
// De Gemini-sleutel staat daar, niet op deze site. Leeg = de leiding keurt alles zelf goed.
export const aiProxyUrl = 'https://script.google.com/macros/s/AKfycbyX4p1OuRu0bEoQ23Pp4s-TBhkwuMdFKaInHA7cboeKmxAXEWjJE2-oxRyYqM64ojwn/exec';

// Pushmeldingen voor de leiding (ook met de gsm op slot). Vul hier de publieke "Web Push"-sleutel in
// (Firebase-console > Projectinstellingen > Cloud Messaging > Web Push-certificaten); die is niet geheim.
// Daarnaast heeft firebaseConfig dan ook apiKey, appId en messagingSenderId nodig. Leeg = geen pushmeldingen.
export const vapidKey = '';
