// Coach Garmin Web: server locale e generazione del sito statico (Node 18+, senza dipendenze).
//   node server.mjs              → http://localhost:5174 (anche da iPhone sulla stessa rete Wi-Fi), Garmin ogni 15 minuti
//   node server.mjs --demo       → come sopra ma con dati di prova (senza account Garmin)
//   node server.mjs --build _site → scarica da Garmin e genera il sito per GitHub Pages (dati cifrati con DATA_KEY)
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { ROOT, sync, publicData, loadCache, encrypt, localKeys, addDays, today } from './garmin.mjs';

const PORT = Number(process.env.PORT) || 5174;
const PUB = path.join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const arg = n => process.argv.includes(n);

// ---------- dati di prova (per vedere l'app senza account) ----------
function demoData() {
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const days = [], activities = [];
  for (let i = 89; i >= 0; i--) {
    const k = addDays(today(), -i);
    const bad = i === 0 ? 0 : rnd() < 0.15;
    const sleep = Math.round((bad ? 5.4 + rnd() : 6.8 + rnd() * 1.4) * 100) / 100;
    days.push({
      key: k, sleepHours: sleep, sleepScore: Math.round(bad ? 55 + rnd() * 10 : 72 + rnd() * 18),
      deepMin: Math.round(60 + rnd() * 40), remMin: Math.round(80 + rnd() * 40), lightMin: Math.round(220 + rnd() * 40), awakeMin: Math.round(10 + rnd() * 25),
      hrv: Math.round(bad ? 38 + rnd() * 6 : 46 + rnd() * 12), hrvWeekly: 49, hrvStatus: 'BALANCED', hrvLow: 42, hrvHigh: 58,
      restingHR: Math.round(bad ? 56 + rnd() * 3 : 50 + rnd() * 4), respiration: Math.round((13.5 + rnd()) * 10) / 10,
      bbCharged: Math.round(40 + rnd() * 40), bbDrained: Math.round(40 + rnd() * 40), bbHigh: Math.round(70 + rnd() * 25), bbLow: Math.round(10 + rnd() * 20),
      readiness: Math.round(bad ? 35 + rnd() * 15 : 60 + rnd() * 30), readinessMorning: Math.round(bad ? 32 + rnd() * 15 : 58 + rnd() * 30), steps: Math.round(5000 + rnd() * 8000), stepsDistance: Math.round(4000 + rnd() * 6000),
      stressAvg: Math.round(20 + rnd() * 20), nightStress: Math.round(12 + rnd() * 10), sleepEfficiency: Math.round(88 + rnd() * 8),
      ...(i === 0 ? { bodyBatteryNow: 68, bbTime: Date.now() - 25 * 60e3, napCount: 1, napMin: 22, naps: [{ start: Date.now() - 5 * 3600e3, end: Date.now() - 5 * 3600e3 + 22 * 60e3 }] } : {}),
    });
    const wd = new Date(k + 'T12:00').getDay();
    if ([1, 3, 5].includes(wd) && rnd() < 0.85) activities.push({ id: 'r' + i, key: k, type: 'Rulli', minutes: 45 + Math.round(rnd() * 15), avgHR: 120 + Math.round(rnd() * 20), avgPower: 150 + Math.round(rnd() * 40), trainingEffect: 2.4 + rnd(), trainingLoad: 50 + rnd() * 30, startTime: Date.parse(k + 'T18:30'), garminName: 'MyWhoosh W02' });
    if ([0, 6].includes(wd) && rnd() < 0.6) activities.push({ id: 'g' + i, key: k, type: 'Gravel', minutes: 100 + Math.round(rnd() * 80), km: Math.round(40 + rnd() * 40), avgHR: 125 + Math.round(rnd() * 10), trainingEffect: 3 + rnd(), trainingLoad: 120 + rnd() * 80, elevationGain: 400 + rnd() * 600, startTime: Date.parse(k + 'T09:00'), garminName: 'Gravel Langhe' });
    if (wd === 2 && rnd() < 0.5) activities.push({ id: 'c' + i, key: k, type: 'Corsa', minutes: 35 + Math.round(rnd() * 15), km: Math.round((5 + rnd() * 3) * 10) / 10, avgHR: 140 + Math.round(rnd() * 10), trainingEffect: 2.8, trainingLoad: 60, startTime: Date.parse(k + 'T07:00'), garminName: 'Corsa' });
  }
  activities.sort((a, b) => b.startTime - a.startTime);
  return { updated: Date.now() - 4 * 60e3, error: null, profile: { name: 'Prova' }, demo: true, mywhoosh: null, days, activities, devices: [{ id: '1', name: 'CIRQA' }, { id: '2', name: 'Forerunner 255' }], ftp: 215 };
}

// ---------- server locale ----------
const state = { json: null, loading: null };
async function refresh() {
  if (state.loading) return state.loading;
  state.loading = (async () => {
    const data = arg('--demo') ? demoData() : publicData(await sync({ days: 3 }));
    state.json = JSON.stringify(data);
  })().finally(() => { state.loading = null; });
  return state.loading;
}

if (arg('--build')) {
  const out = path.resolve(process.argv[process.argv.indexOf('--build') + 1] || '_site');
  const c = await sync({ days: 3 });
  // anche senza dati (Garmin non ancora collegato) il sito si pubblica: l'app mostra cosa fare
  if (!c.lastSync) console.warn('Nessun dato Garmin: pubblico il sito con il messaggio di errore.');
  const dataKey = process.env.DATA_KEY || localKeys().dataKey;
  if (!dataKey) { console.error('Manca DATA_KEY: i dati non verrebbero cifrati. Build annullata.'); process.exit(1); }
  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync(PUB, out, { recursive: true });
  fs.mkdirSync(path.join(out, 'api'), { recursive: true });
  fs.writeFileSync(path.join(out, 'api/garmin.json'), encrypt(JSON.stringify(publicData(c)), dataKey));
  fs.writeFileSync(path.join(out, 'api/version.json'), JSON.stringify({ updated: c.lastSync || 0 }));
  fs.writeFileSync(path.join(out, '.nojekyll'), '');
  fs.writeFileSync(path.join(out, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
  console.log(`Sito generato in ${out} (dati cifrati: si aprono solo con il link privato)`);
} else {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    try {
      if (u.pathname === '/api/garmin.json') {
        if (!state.json) await refresh();
        res.writeHead(200, { 'Content-Type': MIME['.json'], 'Content-Encoding': 'gzip', 'Cache-Control': 'no-store' });
        return res.end(zlib.gzipSync(state.json));
      }
      if (u.pathname === '/api/version.json') {
        return res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' }).end(JSON.stringify({ updated: state.json ? JSON.parse(state.json).updated : 0 }));
      }
      if (u.pathname === '/api/refresh' && req.method === 'POST') {
        await refresh();
        return res.writeHead(200, { 'Content-Type': MIME['.json'] }).end('{"ok":true}');
      }
      let p = path.normalize(decodeURIComponent(u.pathname)).replace(/^(\.\.[/\\])+/, '');
      if (p === '/' || !path.extname(p)) p = '/index.html';
      const file = path.join(PUB, p);
      if (!file.startsWith(PUB)) return res.writeHead(403).end();
      fs.readFile(file, (err, data) => {
        if (err) return res.writeHead(404).end('Non trovato');
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }).end(data);
      });
    } catch (e) { console.error(e); res.writeHead(500).end(String(e.message)); }
  });
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Coach Garmin → http://localhost:${PORT}${arg('--demo') ? '  (dati di prova)' : ''}`);
    for (const n of Object.values(os.networkInterfaces()).flat()) if (n && n.family === 'IPv4' && !n.internal) console.log(`  da iPhone (stessa rete Wi-Fi): http://${n.address}:${PORT}`);
  });
  refresh().catch(e => console.error(e.message));
  if (!arg('--demo')) setInterval(() => refresh().catch(e => console.error(e.message)), 15 * 60e3);
}
