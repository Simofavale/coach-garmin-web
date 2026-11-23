# Coach Garmin Web
Versione web (PWA) dell'app iPhone Coach Garmin (`../Coach Garmin`). Impostazione presa da **Rassegna** (la web app "stile Column"): GitHub Pages, dati cifrati AES-256-GCM aperti dal link privato `?k=…`, GitHub Actions a catena ogni ~15 minuti, service worker, Ionicons.

## Com'è fatta
- Node 18+ senza dipendenze. `node server.mjs` (http://localhost:5174), `--demo` (dati di prova), `--build _site` (sito per Pages).
- `garmin.mjs`: token DI OAuth come `Shared/Garmin/GarminAuth.swift`; dati come `GarminSync.swift`. Token cifrato con `TOKEN_KEY` in `data/token.enc.json` (committato, rinnovato dal workflow con `[skip ci]`); storico cifrato in `data/garmin-cache.enc.json` (actions/cache).
- `public/coach.js` = porting di `Shared/Coach/*` (RecoveryEngine, CoachEngine, PlanGenerator, WorkoutPlanner, PlanChat). `public/dieta.js` = `Shared/Dieta/*`. Se cambi una regola nell'app iPhone, allinea anche qui.
- Stato dell'utente (piano, check-in, dieta) in localStorage, con copia di sicurezza esportabile da Account.

## Regole decise con Simone (valgono anche qui)
- Niente password nel codice: si conserva solo il token, cifrato.
- Recupero = **Prontezza Coach** (scelta di Simone, 23-11-2026): notte stile WHOOP 40% + tendenza HRV 7 giorni 25% + Training Readiness Garmin del mattino 35%, con campanelli d'allarme (tetti 45/30/60). Semaforo 67/34. Spiegazione nell'app ("Come la calcolo").
- Body Battery dall'ultimo punto della curva a 3 minuti. Corse misurate a **tempo** (niente zone cardio).
- AI della corsa: **Gemini** (scelta di Simone, livello gratuito), chiave in localStorage del dispositivo, chiamata diretta dal browser (CORS ok). Riserva senza AI: `rulePlan` (come RunNotePlanner.swift).
- MyWhoosh: API coaching.mywhoosh.com chiamata dal browser (CORS *); l'accesso del sito (event.mywhoosh.com) ha il reCAPTCHA: si usa quello dell'app (services.mywhoosh.com/http-service/api/login, come il progetto mywhoosh-to-garmin) e si verifica il codice sulla libreria allenamenti.
- Collegamenti **solo dalla web app** (richiesta di Simone): Account → Collegamenti cifra la richiesta (ticket Garmin / email+password MyWhoosh) con DATA_KEY e avvia il workflow con l'input `richiesta`; `collega-web.mjs` la esegue, scrive `data/esito.json` (finisce in garmin.json e version.json) e i token cifrati vengono committati. Garmin (diauth, connectapi) e MyWhoosh login bloccano il CORS: niente chiamate dirette dal browser. Il pulsante ↻ e i collegamenti usano un token GitHub `github_pat_` (solo Actions) salvato nel dispositivo.
- Da fare: invio corse al Forerunner, sonnellini e sveglie CIRQA, import uscite MyWhoosh su Garmin, rinomina attività (scritture su Garmin: via GitHub Actions o server sul Mac).

> Regole generali in `~/.studio-locale/AGENTS.md`, preferenze in `~/.studio-locale/progetti/MEMORIA.md`.

- Tutto gira su GitHub Actions (ubuntu), **senza Mac** (scelta di Simone 23-11-2026). Garmin a volte risponde 429 ai server cloud sul passaggio oauth-service: `fetchRetry` riprova dopo 5/15/30 s. Il runner sul Mac è stato provato e tolto.
- MyWhoosh: il codice dura ~15 giorni e non ha rinnovo. **Scelta di Simone (23-11-2026): email e password MyWhoosh salvate cifrate** con TOKEN_KEY in `data/mywhoosh-login.enc.json`; `renewMyWhoosh()` rifà l'accesso quando mancano meno di 3 giorni. (Per Garmin invece solo il token.)
