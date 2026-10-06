// Firebase-project "stadsspel". Voor de Realtime Database volstaan deze twee waarden;
// ze zijn niet geheim. Zet dit op null om in demo-modus (alles op één toestel) te draaien.
export const firebaseConfig = {
  projectId: 'stadsspel-836d6',
  databaseURL: 'https://stadsspel-836d6-default-rtdb.europe-west1.firebasedatabase.app',
};

// Adres van het tussenstation (Google Apps Script, zie proxy/Code.gs) dat foto's laat nakijken.
// De Gemini-sleutel staat daar, niet op deze site. Leeg = de leiding keurt alles zelf goed.
export const aiProxyUrl = '';
