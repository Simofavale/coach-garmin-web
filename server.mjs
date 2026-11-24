// Coach Garmin Web: server locale e generazione del sito statico (Node 18+, senza dipendenze).
//   node server.mjs              → http://localhost:5174 (anche da iPhone sulla stessa rete Wi-Fi), Garmin ogni 15 minuti
//   node server.mjs --demo       → come sopra ma con dati di prova (senza account Garmin)
//   node server.mjs --build _site → scarica da Garmin e genera il sito per GitHub Pages (dati cifrati con DATA_KEY)
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { ROOT, sync, publicData, loadCache, encrypt, localKeys, addDays, today, loadEsito, renewMyWhoosh, importMyWhoosh, saveCache, myWhooshFtp, activityDetails } from './garmin.mjs';

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
  // notti di prova per il grafico del sonno: fasi a cicli di ~90 minuti
  for (const d of days.slice(-7)) {
    const start = Date.parse(addDays(d.key, -1) + 'T23:10:00'), end = start + d.sleepHours * 3600e3, levels = [];
    let t = start, i = 0; const pat = [1, 0, 1, 2, 1, 3, 1, 0, 1, 2];
    while (t < end) { const len = (8 + ((i * 7) % 23)) * 60e3; levels.push([t, Math.min(end, t + len), pat[i % pat.length]]); t += len; i++; }
    const ser = (base, amp) => Array.from({ length: 80 }, (_, j) => [start + (end - start) * j / 79, Math.round(base + amp * Math.sin(j / 9))]);
    d.night = { start, end, levels, hr: ser(54, 6), hrv: ser(45, 10), bb: ser(30, 25).map(([x, v], j) => [x, 20 + j]), stress: ser(18, 8) };
  }
  activities.sort((a, b) => b.startTime - a.startTime);
  return { updated: Date.now() - 4 * 60e3, error: null, profile: { name: 'Prova' }, demo: true, mywhoosh: null, mwFtp: 147, cirqa: { deviceId: '1', name: 'CIRQA', mountingSide: 'RIGHT_UPPER_ARM', alarms: [{ alarmId: 1, alarmTime: 330, alarmDays: ['M', 'Tu', 'W', 'Th', 'F'], alarmMode: 'ON', alarmSound: 'VIBRATION', backlight: 'ON' }] }, runWorkouts: {}, days, activities, devices: [{ id: '1', name: 'CIRQA' }, { id: '2', name: 'Forerunner 255' }], ftp: 215 };
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
  let c = await sync({ days: 3 });
  await renewMyWhoosh();
  // uscite MyWhoosh su Garmin; se ne ha caricate, riprende subito le attività da Garmin
  await myWhooshFtp(c);
  if (await importMyWhoosh(c)) { saveCache(c); await new Promise(r => setTimeout(r, 15e3)); c = await sync({ days: 1 }); }
  else saveCache(c);
  // anche senza dati (Garmin non ancora collegato) il sito si pubblica: l'app mostra cosa fare
  if (!c.lastSync) console.warn('Nessun dato Garmin: pubblico il sito con il messaggio di errore.');
  const dataKey = process.env.DATA_KEY || localKeys().dataKey;
  if (!dataKey) { console.error('Manca DATA_KEY: i dati non verrebbero cifrati. Build annullata.'); process.exit(1); }
  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync(PUB, out, { recursive: true });
  // numero di versione su codice e stile: GitHub Pages tiene i file in copia 10 minuti, così ogni pubblicazione si vede subito
  const v = Date.now().toString(36);
  for (const f of fs.readdirSync(out).filter(f => /\.(js|html)$/.test(f) && f !== 'sw.js')) {
    const file = path.join(out, f);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/((?:src|href)="|from '|import\(')(\.\/)?([\w-]+\.(?:js|css))(?=['"])/g, (m, a, dot, name) => `${a}${dot || ''}${name}?v=${v}`));
  }
  fs.mkdirSync(path.join(out, 'api'), { recursive: true });
  // dettagli delle attività (file già cifrati) in api/act/
  if (c.lastSync) { const dir = await activityDetails(c, dataKey); saveCache(c); fs.cpSync(dir, path.join(out, 'api', 'act'), { recursive: true }); }
  fs.writeFileSync(path.join(out, 'api/garmin.json'), encrypt(JSON.stringify(publicData(c)), dataKey));
  fs.writeFileSync(path.join(out, 'api/version.json'), JSON.stringify({ updated: c.lastSync || 0, esito: loadEsito()?.id || null }));
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
      // dati di prova: dettaglio finto di un'attività
      if (arg('--demo') && u.pathname.startsWith('/api/act/')) {
        const pts = n => Array.from({ length: 120 }, (_, i) => [i * 0.5, n(i)]);
        return res.writeHead(200, { 'Content-Type': MIME['.json'] }).end(JSON.stringify({ summary: { duration: 3600, movingDuration: 3500, distance: 28500, averageSpeed: 7.9, maxSpeed: 14.2, elevationGain: 320, averageHR: 132, maxHR: 168, calories: 640, averagePower: 168, normalizedPower: 181, trainingStressScore: 62, intensityFactor: 0.78, trainingEffect: 3.1, activityTrainingLoad: 88, moderateIntensityMinutes: 20, vigorousIntensityMinutes: 25 },
          hrZones: [1, 2, 3, 4, 5].map(z => ({ zoneNumber: z, secsInZone: [300, 1500, 1200, 500, 100][z - 1] })), powerZones: [], laps: [{ duration: 1800, distance: 14000, averageSpeed: 7.8, averageHR: 128, averagePower: 160 }, { duration: 1800, distance: 14500, averageSpeed: 8.0, averageHR: 136, averagePower: 176 }],
          weather: { temp: 59, humidity: 70, wind: 6, desc: 'Poco nuvoloso' }, series: { directHeartRate: pts(i => 120 + 20 * Math.sin(i / 10)), directSpeed: pts(i => 28 + 4 * Math.cos(i / 7)), directElevation: pts(i => 250 + 60 * Math.sin(i / 25)) },
          route: Array.from({ length: 60 }, (_, i) => [44.7 + 0.02 * Math.sin(i / 10), 7.85 + i * 0.002]) }));
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
