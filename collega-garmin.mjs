// Collega l'account Garmin alla web app (si usa con doppio clic su "Collega Garmin.command").
// 1. apre la pagina ufficiale di Garmin: la password la scrivi solo lì;
// 2. incolli qui l'indirizzo della pagina che compare dopo l'accesso (contiene "ticket=ST-…");
// 3. il ticket diventa un token, salvato cifrato in data/token.enc.json; poi, se il progetto è su GitHub,
//    imposta le chiavi segrete e pubblica il token cifrato, così il sito si aggiorna da solo.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { execFileSync } from 'node:child_process';
import { ROOT, SIGN_IN_URL, newKey, exchangeTicket, sync } from './garmin.mjs';

const KEYS = path.join(ROOT, 'data', 'chiavi.json');
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim();
const tryOut = (cmd, args, opts) => { try { return sh(cmd, args, opts); } catch { return null; } };

// chiavi: DATA_KEY apre i dati (va nel link privato), TOKEN_KEY protegge il token Garmin (resta segreta)
let keys = {};
try { keys = JSON.parse(fs.readFileSync(KEYS, 'utf8')); } catch { }
if (!keys.dataKey || !keys.tokenKey) {
  keys = { dataKey: keys.dataKey || newKey(), tokenKey: keys.tokenKey || newKey() };
  fs.mkdirSync(path.dirname(KEYS), { recursive: true });
  fs.writeFileSync(KEYS, JSON.stringify(keys, null, 2), { mode: 0o600 });
  console.log('Create le chiavi segrete (data/chiavi.json, resta solo su questo Mac).');
}
process.env.TOKEN_KEY = keys.tokenKey;

let ticket = process.argv.find(a => /ST-[\w.-]+/.test(a))?.match(/ST-[\w.-]+/)?.[0];
if (!ticket) {
  console.log('\nApro la pagina di accesso di Garmin. Accedi con la tua email e password Garmin');
  console.log('(le vede solo Garmin, non questo programma).');
  console.log('\nDopo l\'accesso il browser va su una pagina "mobile.integration.garmin.com" (può risultare vuota o di errore: va bene).');
  console.log('Copia l\'indirizzo completo di quella pagina dalla barra in alto e incollalo qui sotto.\n');
  tryOut('open', [SIGN_IN_URL]);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  for (let i = 0; i < 3 && !ticket; i++) {
    const v = await rl.question('Indirizzo (o ticket ST-…): ');
    ticket = v.match(/ST-[\w.-]+/)?.[0];
    if (!ticket) console.log('Non trovo "ticket=ST-…" in quello che hai incollato. Riprova.');
  }
  rl.close();
  if (!ticket) { console.log('Nessun ticket: collegamento annullato.'); process.exit(1); }
}

try {
  await exchangeTicket(ticket);
  console.log('\n✓ Account Garmin collegato. Scarico i dati per controllare che funzioni…');
} catch (e) { console.error('\n✗ ' + e.message + '\nIl ticket vale pochi minuti e una volta sola: rifai l\'accesso.'); process.exit(1); }

const c = await sync({ days: 3 });
if (c.lastSyncError) { console.error('✗ ' + c.lastSyncError); process.exit(1); }
console.log(`✓ Dati Garmin letti: ${Object.keys(c.days).length} giorni e ${c.activities.length} attività.`);

// pubblicazione su GitHub (solo se il progetto è già collegato a un repository)
const remote = tryOut('git', ['remote', 'get-url', 'origin']);
if (!remote || !tryOut('gh', ['auth', 'status'])) {
  console.log('\nProgetto non ancora su GitHub: per ora i dati si vedono con "node server.mjs" su questo Mac.');
  process.exit(0);
}
const repo = remote.replace(/^.*github\.com[:/]/, '').replace(/\.git$/, '');
sh('gh', ['secret', 'set', 'DATA_KEY', '--repo', repo], { input: keys.dataKey });
sh('gh', ['secret', 'set', 'TOKEN_KEY', '--repo', repo], { input: keys.tokenKey });
tryOut('git', ['pull', '--rebase', '--autostash', 'origin', 'main']);
sh('git', ['add', 'data/token.enc.json']);
if (tryOut('git', ['diff', '--cached', '--quiet']) === null) sh('git', ['commit', '-m', 'Token Garmin aggiornato (cifrato)']);
sh('git', ['push', 'origin', 'HEAD:main']);
const [owner, name] = repo.split('/');
const link = `https://${owner.toLowerCase()}.github.io/${name}/?k=${keys.dataKey}`;
console.log('\n✓ Pubblicato. Tra 2–3 minuti il sito ha i tuoi dati. Il tuo link privato è:\n\n  ' + link + '\n');
fs.writeFileSync(path.join(ROOT, 'data', 'link-privato.txt'), link + '\n', { mode: 0o600 });
console.log('(Salvato anche in data/link-privato.txt. Non condividerlo: chi ha il link vede i tuoi dati.)');
