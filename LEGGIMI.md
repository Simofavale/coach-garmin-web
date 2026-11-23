# Coach Garmin Web

La versione web dell'app iPhone **Coach Garmin**: si apre da Safari (o dalla schermata Home dell'iPhone) senza installare nulla e senza il limite degli App ID.
Stessa impostazione di **Rassegna**: sito su GitHub Pages, dati cifrati che si aprono solo con il **link privato**, aggiornamento automatico con GitHub Actions circa ogni 15 minuti, anche con il Mac spento.

## Cosa c'è
- **Corsa con l'AI (Gemini, gratis)**: in Oggi tocchi "Oggi corro: programma con l'AI", scrivi come stai e con chi corri ("corro con mia moglie 45 minuti, alterniamo corsa e camminata"). Gemini parte dalla seduta del piano (o del programma base W01–W10) e dai dati di stanotte e prepara la corsa **a tempo**. Senza chiave Gemini la prepara il coach dalle frasi tipiche.
- **MyWhoosh**: nei giorni di rulli ti dice quale W01–W09 usare o carica su MyWhoosh l'allenamento su misura di oggi ("CG gg/mm …"); da Account installi gli W01–W09 mancanti.
- **Oggi**: Body Battery, sonno, HRV, Training Readiness, FC a riposo, stato di salute, sonnellini, recupero con semaforo e allenamento del giorno (watt calcolati sulla FTP), check-in delle sensazioni.
- **Piano**: obiettivo (gara, forma fisica, potenza), giorni, ore, solo rulli / corsa e rulli / solo corsa, calendario della settimana, allenamento in più, chat per modificarlo ("oggi non posso", "più facile"…).
- **Dieta**: le stesse regole della scheda Dieta (14 pasti, pasto libero, colazione, frutta, dosi ridotte).
- **Attività**: km in bici e a piedi (settimana, mese, anno) ed elenco delle attività Garmin.
- **Account**: stato di Garmin, FTP, link privato, copia di sicurezza di piano/check-in/dieta.

Piano, check-in e dieta restano **nel browser del dispositivo** (non si mischiano con l'app iPhone).

## Cosa fare (Simone)
Tutto dalla web app, aprendola dal **link privato** (sul Mac è in `data/link-privato.txt`):
1. **Account → Collegamenti → Garmin Connect**: apri la pagina di Garmin, accedi (la password la vede solo Garmin), copia l'indirizzo della pagina che compare dopo ("ticket=ST-…") e incollalo. Fallo dal browser del Mac se sull'iPhone si apre l'app Garmin Connect.
2. **Account → Collegamenti → MyWhoosh**: email e password, che partono cifrate e non vengono salvate.
3. La prima volta ti chiede l'**autorizzazione GitHub** (codice `github_pat_…`, permesso solo "Actions"): serve anche al pulsante ↻ per aggiornare subito.
4. **Gemini**: crea gratis una chiave su aistudio.google.com/apikey e incollala in Account → Chiave Gemini.
5. **Sull'iPhone**: apri il link privato in Safari → Condividi → **Aggiungi alla schermata Home** (su iOS 26 è sotto "Visualizza altro").

Garmin e MyWhoosh non accettano richieste da una pagina web: il collegamento lo esegue GitHub Actions (`collega-web.mjs`), con la richiesta cifrata con la chiave del link. Se un giorno compare "Sessione Garmin scaduta", ricollega da Account.

## Per provarla sul Mac
- `Avvia sul Mac.command` (doppio clic): apre http://localhost:5174 con i tuoi dati Garmin.
- Da Terminale `node server.mjs --demo`: stessi schermi con **dati di prova**, senza account.

## Com'è fatta
- `garmin.mjs`: accesso a Garmin (stesso flusso dell'app iPhone) e download di sonno, HRV, Body Battery, readiness, sonnellini, attività, FTP.
- `server.mjs`: server locale e `--build _site` (genera il sito con i dati cifrati per GitHub Pages).
- `collega-web.mjs`: collegamenti chiesti dalla web app, eseguiti da GitHub Actions.
- `public/ai.js` = corsa con l'AI (Gemini + coach sulle frasi), `public/mywhoosh.js` = allenamenti MyWhoosh.
- `public/`: la web app (HTML, CSS e JavaScript senza librerie). `coach.js` = regole del coach, `dieta.js` = regole della dieta.
- `.github/workflows/aggiorna.yml`: aggiornamento automatico.
- Chiavi: `data/chiavi.json` (solo sul Mac, mai su GitHub). `DATA_KEY` apre i dati ed è nel link privato; `TOKEN_KEY` protegge il token Garmin e resta segreta.
