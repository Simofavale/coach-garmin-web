// Collegamenti chiesti dalla web app (Account → Collega Garmin / Collega MyWhoosh), eseguiti da GitHub Actions.
// Garmin e MyWhoosh non accettano richieste da una pagina web, quindi la pagina manda la richiesta qui,
// CIFRATA con la chiave del link privato (DATA_KEY). Ticket Garmin, email e password MyWhoosh si usano
// una volta e non vengono salvati né scritti nel registro: resta solo il token, cifrato con TOKEN_KEY.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, decrypt, exchangeTicket, loginGarmin, loginMyWhoosh } from './garmin.mjs';

const out = esito => {
  fs.writeFileSync(path.join(ROOT, 'data', 'esito.json'), JSON.stringify({ ...esito, at: Date.now() }));
  console.log(`Collegamento ${esito.tipo || '?'}: ${esito.ok ? 'riuscito' : 'non riuscito'}`);
};

let req;
try { req = JSON.parse(decrypt(process.env.RICHIESTA, process.env.DATA_KEY)); }
catch { out({ id: null, ok: false, msg: 'Richiesta non leggibile: riapri la web app dal link privato e riprova.' }); process.exit(0); }

// richieste vecchie (oltre 15 minuti) non valgono più: il ticket Garmin scade in pochi minuti
if (!req.at || Date.now() - req.at > 15 * 60e3) { out({ id: req.id, tipo: req.tipo, ok: false, msg: 'Richiesta scaduta: riprova.' }); process.exit(0); }

try {
  if (req.tipo === 'garmin') {
    if (req.email) await loginGarmin(String(req.email).trim(), String(req.password || ''));
    else {
      const ticket = String(req.ticket || '').match(/ST-[\w.-]+/)?.[0];
      if (!ticket) throw new Error('Nel testo incollato non trovo il codice "ticket=ST-…".');
      await exchangeTicket(ticket, /sso\/embed/.test(String(req.ticket)) || req.service === 'embed' ? 'embed' : 'mobile');
    }
    out({ id: req.id, tipo: 'garmin', ok: true, msg: 'Garmin collegato: i tuoi dati arrivano adesso.' });
  } else if (req.tipo === 'mywhoosh') {
    const { exp } = await loginMyWhoosh(String(req.email || '').trim(), String(req.password || ''));
    out({ id: req.id, tipo: 'mywhoosh', ok: true, msg: 'MyWhoosh collegato' + (exp ? `, valido fino al ${new Date(exp).toLocaleDateString('it-IT')}` : '') + '.' });
  } else throw new Error('Richiesta sconosciuta.');
} catch (e) {
  out({ id: req.id, tipo: req.tipo, ok: false, msg: e.message + (req.tipo === 'garmin' && !req.email ? ' Il codice vale pochi minuti e una volta sola: rifai l\'accesso a Garmin.' : '') });
}
