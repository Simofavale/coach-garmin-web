// Collega MyWhoosh alla web app (doppio clic su "Collega MyWhoosh.command").
// Il sito di MyWhoosh accetta l'accesso solo da sé stesso, quindi lo si fa da qui, una volta:
// email e password le scrivi nel Terminale, vanno solo a MyWhoosh e NON vengono salvate.
// Si conserva solo il token, cifrato in data/mywhoosh.enc.json (arriva alla web app insieme ai dati Garmin).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { ROOT, encrypt, localKeys } from './garmin.mjs';

const keys = localKeys();
if (!keys.tokenKey) { console.log('Prima collega Garmin con "Collega Garmin.command" (crea le chiavi segrete).'); process.exit(1); }
const FILE = path.join(ROOT, 'data', 'mywhoosh.enc.json');
const claim = (jwt, k) => { try { return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString())[k]; } catch { return undefined; } };

function ask(q, hidden = false) {
  return new Promise(res => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = s => { if (s.includes(q)) rl.output.write(q); };
    rl.question(q, a => { rl.close(); if (hidden) process.stdout.write('\n'); res(a.trim()); });
  });
}

console.log('\nCollego gli allenamenti MyWhoosh alla web app.');
console.log('Usa la stessa email e password con cui entri in MyWhoosh (la password non si vede mentre la scrivi e non viene salvata).\n');
let token = process.argv.find(a => a.split('.').length === 3 && a.length > 80), userId;
if (!token) {
  const email = await ask('Email MyWhoosh: ');
  const password = await ask('Password MyWhoosh: ', true);
  const r = await fetch('https://event.mywhoosh.com/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Origin: 'https://workout.mywhoosh.com', Referer: 'https://workout.mywhoosh.com/' },
    body: JSON.stringify({ email, password, token: '' }),
  }).catch(e => ({ ok: false, status: 0, json: async () => ({ message: e.message }) }));
  const j = await r.json().catch(() => ({}));
  token = j?.token || j?.data?.token;
  userId = j?.user?.whoosh_user_id || j?.data?.user?.whoosh_user_id;
  if (!r.ok || !token) {
    console.error(`\n✗ MyWhoosh non ha accettato l'accesso (${j?.message || 'HTTP ' + r.status}).`);
    console.error('Ricontrolla email e password. Se continua a non andare, chiedi a Claude di collegarlo con il browser.');
    process.exit(1);
  }
}
userId = userId || claim(token, 'userId');
const exp = claim(token, 'exp') ? claim(token, 'exp') * 1000 : null;
fs.writeFileSync(FILE, encrypt(JSON.stringify({ token, userId: userId != null ? String(userId) : null, exp }), keys.tokenKey));
console.log(`\n✓ MyWhoosh collegato${exp ? `, valido fino al ${new Date(exp).toLocaleDateString('it-IT')}` : ''}.`);

// pubblica il token cifrato, così il sito lo riceve al prossimo aggiornamento (2–3 minuti)
try {
  execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, stdio: 'ignore' });
  const git = (...a) => execFileSync('git', a, { cwd: ROOT, stdio: 'pipe' });
  try { git('pull', '--rebase', '--autostash', 'origin', 'main'); } catch { }
  git('add', 'data/mywhoosh.enc.json');
  try { git('commit', '-m', 'MyWhoosh collegato (token cifrato)'); } catch { }
  git('push', 'origin', 'HEAD:main');
  console.log('✓ Pubblicato: tra 2–3 minuti la web app vede i tuoi allenamenti MyWhoosh.');
} catch { console.log('Progetto non ancora su GitHub: per ora vale con "Avvia sul Mac.command".'); }
