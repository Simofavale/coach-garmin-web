// Accesso a Garmin Connect e download dei dati (Node 18+, senza dipendenze).
// Stesso flusso dell'app iPhone Coach Garmin (Shared/Garmin/GarminAuth.swift e GarminSync.swift):
// ticket di accesso → token OAuth2 (diauth.garmin.com) → rinnovo con il refresh token.
// La password la vede solo la pagina di Garmin: qui si conserva solo il token, cifrato.
// API non ufficiale: se Garmin cambia il flusso, va aggiornata.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

if (!process.env.TZ) process.env.TZ = 'Europe/Rome';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONNECT = 'https://connectapi.garmin.com';
const TOKEN_URL = 'https://diauth.garmin.com/di-oauth2-service/oauth/token';
const GRANT_TICKET = 'https://connectapi.garmin.com/di-oauth2-service/oauth/grant/service_ticket';
export const SERVICE_URL = 'https://mobile.integration.garmin.com/gcm/ios';
export const SIGN_IN_URL = 'https://sso.garmin.com/mobile/sso/en_US/sign-in?clientId=GCM_IOS_DARK&service=' + encodeURIComponent(SERVICE_URL);
const CLIENT_IDS = ['GARMIN_CONNECT_MOBILE_IOS_DI', 'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2', 'GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4', 'GARMIN_CONNECT_MOBILE_ANDROID_DI'];
const NATIVE = {
  'User-Agent': 'GCM-Android-5.23',
  'X-Garmin-User-Agent': 'com.garmin.android.apps.connectmobile/5.23; ; Google/sdk_gphone64_arm64/google; Android/33; Dalvik/2.1.0',
  'X-Garmin-Paired-App-Version': '10861', 'X-Garmin-Client-Platform': 'Android', 'X-App-Ver': '10861',
  'X-Lang': 'it', 'X-GCExperience': 'GC5', 'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
};

// ---------- date (fuso orario italiano) ----------
const pad = n => String(n).padStart(2, '0');
export const key = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const today = () => key(new Date());
export const addDays = (k, n) => { const [y, m, d] = k.split('-').map(Number); return key(new Date(y, m - 1, d + n, 12)); };
const gmt = t => (t ? Date.parse(String(t).slice(0, 19) + 'Z') || null : null);

// ---------- cifratura (AES-256-GCM, come Rassegna) ----------
export function keyBuf(b64) {
  const k = Buffer.from(String(b64 || ''), 'base64url');
  if (k.length !== 32) throw new Error('chiave non valida (servono 32 byte in base64url)');
  return k;
}
export const newKey = () => crypto.randomBytes(32).toString('base64url');
export function encrypt(text, b64, gzip = true) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyBuf(b64), iv);
  const data = Buffer.concat([c.update(gzip ? zlib.gzipSync(text) : Buffer.from(text)), c.final(), c.getAuthTag()]);
  return JSON.stringify({ enc: 1, gz: gzip ? 1 : 0, iv: iv.toString('base64'), data: data.toString('base64') });
}
export function decrypt(json, b64) {
  const o = typeof json === 'string' ? JSON.parse(json) : json;
  if (!o || !o.enc) return typeof json === 'string' ? json : JSON.stringify(json);
  const raw = Buffer.from(o.data, 'base64'), iv = Buffer.from(o.iv, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', keyBuf(b64), iv);
  d.setAuthTag(raw.subarray(raw.length - 16));
  const out = Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]);
  return (o.gz === 0 ? out : zlib.gunzipSync(out)).toString('utf8');
}

// ---------- archivio: token e dati ----------
// TOKEN_KEY cifra token e storico (solo su GitHub e sul Mac). Senza chiave (uso locale) restano in chiaro in data/.
const TOKEN_FILE = path.join(ROOT, 'data', 'token.enc.json');
const CACHE_FILE = path.join(ROOT, 'data', 'garmin-cache.enc.json');
const tokenKey = () => process.env.TOKEN_KEY || localKeys().tokenKey;
export function localKeys() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'chiavi.json'), 'utf8')); } catch { return {}; }
}
function readEnc(file) {
  try { return JSON.parse(decrypt(fs.readFileSync(file, 'utf8'), tokenKey())); } catch (e) { if (e.code !== 'ENOENT') console.warn(`  ${path.basename(file)} non leggibile: ${e.message}`); return null; }
}
function writeEnc(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encrypt(JSON.stringify(obj), tokenKey()));
}
export const loadTokens = () => readEnc(TOKEN_FILE);
export const saveTokens = t => writeEnc(TOKEN_FILE, t);
export const loadCache = () => readEnc(CACHE_FILE) || { days: {}, activities: [], devices: [] };
export const saveCache = c => writeEnc(CACHE_FILE, c);

// ---------- token ----------
async function tokenPost(clientId, body) {
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { ...NATIVE, Authorization: 'Basic ' + Buffer.from(clientId + ':').toString('base64'), Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: new URLSearchParams(body).toString(), signal: AbortSignal.timeout(30e3),
  });
  let j = null; try { j = await r.json(); } catch { }
  return { code: r.status, j };
}
function jwtClaim(jwt, claim) {
  try { return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString())[claim]; } catch { return undefined; }
}
function parseToken(j, clientId, fallbackRefresh) {
  if (!j || !j.access_token) return null;
  return {
    accessToken: j.access_token, refreshToken: j.refresh_token || fallbackRefresh || null,
    clientId: jwtClaim(j.access_token, 'client_id') || clientId,
    expiresAt: Date.now() + (Number(j.expires_in) || 3600) * 1000,
  };
}

/** Ticket di accesso (ST-…) → token. */
export async function exchangeTicket(ticket) {
  let last = 'nessuna risposta';
  for (const clientId of CLIENT_IDS) {
    const { code, j } = await tokenPost(clientId, { client_id: clientId, service_ticket: ticket, grant_type: GRANT_TICKET, service_url: SERVICE_URL });
    if (code === 429) throw new Error('Troppe richieste a Garmin: riprova tra qualche minuto.');
    const t = code === 200 && parseToken(j, clientId);
    if (t) { saveTokens(t); return t; }
    last = `HTTP ${code} (${clientId})`;
  }
  throw new Error('Accesso Garmin non completato: ' + last);
}

let TOK = null;
async function refresh() {
  const t = TOK || loadTokens();
  if (!t?.refreshToken) throw new Error('Garmin non collegato: fai doppio clic su "Collega Garmin.command".');
  const { code, j } = await tokenPost(t.clientId, { grant_type: 'refresh_token', client_id: t.clientId, refresh_token: t.refreshToken });
  const n = code === 200 && parseToken(j, t.clientId, t.refreshToken);
  if (!n) throw new Error(`Sessione Garmin scaduta (HTTP ${code}): ricollega l'account con "Collega Garmin.command".`);
  n.displayName = t.displayName; n.fullName = t.fullName;
  TOK = n; saveTokens(n);
  return n;
}
async function tokens() {
  TOK = TOK || loadTokens();
  if (!TOK) throw new Error('Garmin non collegato: fai doppio clic su "Collega Garmin.command".');
  if (TOK.expiresAt - Date.now() < 300e3) return refresh();
  return TOK;
}

// ---------- API ----------
let calls = 0;
export async function api(method, p, query = {}, body) {
  const u = new URL(CONNECT + p);
  for (const [k, v] of Object.entries(query).sort()) u.searchParams.set(k, v);
  let t = await tokens();
  for (let attempt = 0; attempt < 2; attempt++) {
    calls++;
    const r = await fetch(u, {
      method, signal: AbortSignal.timeout(30e3),
      headers: { ...NATIVE, Authorization: 'Bearer ' + t.accessToken, Accept: 'application/json', 'Cache-Control': 'no-cache', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401 && attempt === 0) { t = await refresh(); continue; }
    if (r.status === 204) return null;
    if (r.status === 429) throw new Error('Troppe richieste a Garmin: riprovo più tardi.');
    if (r.status >= 200 && r.status < 300) { const s = await r.text(); try { return JSON.parse(s); } catch { return null; } }
    throw new Error(`Garmin ha risposto ${r.status} su ${p.split('/').slice(0, 3).join('/')}`);
  }
}
const get = (p, q) => api('GET', p, q);
const opt = async (p, q) => { try { return await get(p, q); } catch (e) { if (/429|collegato|scaduta/.test(e.message)) throw e; return null; } };

// ---------- lettura dei dati (come GarminSync.swift) ----------
const num = v => (typeof v === 'number' && isFinite(v) ? v : typeof v === 'string' && v !== '' && isFinite(+v) ? +v : null);
const int = v => { const n = num(v); return n == null ? null : Math.round(n); };
const clean = o => { for (const k of Object.keys(o)) if (o[k] == null) delete o[k]; return o; };

function readNaps(sl, d) {
  const naps = sl?.dailyNapDTOS || [];
  const time = v => (typeof v === 'number' ? v : gmt(v));
  d.naps = naps.map(n => ({ start: time(n.napStartTimestampGMT), end: time(n.napEndTimestampGMT) })).filter(n => n.start && n.end).sort((a, b) => a.start - b.start);
  d.napCount = naps.length;
  const secs = naps.reduce((s, n) => s + (int(n.napTimeSec) || 0), 0);
  d.napMin = Math.floor((secs > 0 ? secs : int(sl?.dailySleepDTO?.napTimeSeconds) || 0) / 60);
  if (!d.napCount && d.napMin > 0) d.napCount = 1;
}

async function latestBodyBattery(d) {
  const j = await opt(`/wellness-service/wellness/dailyStress/${d.key}`);
  const arr = (j?.bodyBatteryValuesArray || []).filter(x => int(x?.[2]) != null);
  const last = arr[arr.length - 1];
  if (last) { d.bodyBatteryNow = int(last[2]); if (num(last[0])) d.bbTime = num(last[0]); }
}

async function fetchDay(k, name) {
  const d = { key: k };
  const s = await opt(`/usersummary-service/usersummary/daily/${name}`, { calendarDate: k });
  if (s) {
    Object.assign(d, {
      restingHR: int(s.restingHeartRate), steps: int(s.totalSteps), bodyBatteryNow: int(s.bodyBatteryMostRecentValue),
      bbTime: gmt(s.lastSyncTimestampGMT), bbHigh: int(s.bodyBatteryHighestValue), bbLow: int(s.bodyBatteryLowestValue),
      bbCharged: int(s.bodyBatteryChargedValue), bbDrained: int(s.bodyBatteryDrainedValue),
      stressAvg: int(s.averageStressLevel) >= 0 ? int(s.averageStressLevel) : null,
      activeKcal: int(s.activeKilocalories), stepsDistance: num(s.totalDistanceMeters), respiration: num(s.avgWakingRespirationValue),
    });
    if (k === today()) await latestBodyBattery(d);
  }
  const sl = await opt(`/wellness-service/wellness/dailySleepData/${name}`, { date: k, nonSleepBufferMinutes: '60' });
  if (sl) {
    const dto = sl.dailySleepDTO || {};
    const secs = num(dto.sleepTimeSeconds);
    if (secs > 0) {
      Object.assign(d, {
        sleepHours: Math.round(secs / 36) / 100,
        deepMin: dto.deepSleepSeconds != null ? Math.floor(dto.deepSleepSeconds / 60) : null,
        lightMin: dto.lightSleepSeconds != null ? Math.floor(dto.lightSleepSeconds / 60) : null,
        remMin: dto.remSleepSeconds != null ? Math.floor(dto.remSleepSeconds / 60) : null,
        awakeMin: dto.awakeSleepSeconds != null ? Math.floor(dto.awakeSleepSeconds / 60) : null,
        sleepScore: int(dto.sleepScores?.overall?.value), respiration: num(dto.averageRespirationValue) ?? d.respiration,
        sleepStart: num(dto.sleepStartTimestampGMT), sleepEnd: num(dto.sleepEndTimestampGMT), nightStress: int(dto.avgSleepStress),
      });
    }
    d.hrv = int(sl.avgOvernightHrv) ?? d.hrv;
    d.restingHR = d.restingHR ?? int(sl.restingHeartRate);
    readNaps(sl, d);
  }
  const h = await opt(`/hrv-service/hrv/${k}`);
  if (h?.hrvSummary) {
    const s2 = h.hrvSummary;
    Object.assign(d, { hrv: int(s2.lastNightAvg) ?? d.hrv, hrvWeekly: int(s2.weeklyAvg), hrvStatus: s2.status || null, hrvLow: int(s2.baseline?.balancedLow), hrvHigh: int(s2.baseline?.balancedUpper) });
  }
  const r = await opt(`/metrics-service/metrics/trainingreadiness/${k}`);
  if (r) {
    // la prima è la più recente (quella che mostra Garmin Connect); quella del mattino è il calcolo dopo il risveglio
    const list = Array.isArray(r) ? r : [r], f = list[0] || {};
    const morning = list.find(x => /WAKEUP/i.test(x.inputContext || x.context || '')) || list[list.length - 1] || {};
    Object.assign(d, { readiness: int(f.score), readinessLevel: f.level || null, readinessFeedback: f.feedbackShort || null, readinessMorning: int(morning.score) });
  }
  if (d.sleepStart && d.sleepEnd && d.sleepHours) {
    const inBed = (d.sleepEnd - d.sleepStart) / 3600e3;
    if (inBed > 0) d.sleepEfficiency = Math.min(100, Math.round(d.sleepHours / inBed * 100));
  }
  return clean(d);
}

function typeName(k, name) {
  return ({ gravel_cycling: 'Gravel', indoor_cycling: 'Rulli', virtual_ride: 'Rulli', road_biking: 'Bici', cycling: 'Bici', mountain_biking: 'MTB', walking: 'Camminata', casual_walking: 'Camminata', hiking: 'Escursione', running: 'Corsa', trail_running: 'Corsa', strength_training: 'Forza', yoga: 'Yoga' })[k]
    || name || k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
function parseActivity(a) {
  if (a?.activityId == null) return null;
  const start = a.startTimeLocal || '';
  return clean({
    id: String(a.activityId), key: start.slice(0, 10), type: typeName(a.activityType?.typeKey || 'other', a.activityName),
    minutes: Math.round((num(a.duration) || 0) / 60), km: a.distance != null ? Math.round(a.distance / 100) / 10 : null,
    avgHR: int(a.averageHR), trainingEffect: num(a.aerobicTrainingEffect), trainingLoad: num(a.activityTrainingLoad),
    avgPower: int(a.avgPower), startTime: start ? Date.parse(start.replace(' ', 'T')) : null, garminName: a.activityName || null,
    elevationGain: num(a.elevationGain), maxSpeed: num(a.maxSpeed),
  });
}

/** Storico di 28 giorni con le richieste a intervallo (poche chiamate). */
async function backfill(c, name, from, to) {
  const ch = {};
  const upd = (k, f) => { if (!k) return; k = String(k).slice(0, 10); ch[k] = ch[k] || { key: k }; f(ch[k]); };
  const sl = await opt(`/sleep-service/stats/sleep/daily/${from}/${to}`);
  for (const r of sl?.individualStats || []) {
    const v = r.values || r;
    upd(r.calendarDate, d => {
      const s = num(v.totalSleepTimeInSeconds) ?? num(v.sleepTimeSeconds);
      if (s > 0) d.sleepHours = Math.round(s / 36) / 100;
      d.sleepScore = int(v.sleepScore) ?? int(v.overallSleepScore);
      const m = x => (num(x) != null ? Math.floor(x / 60) : null);
      d.deepMin = m(v.deepTime ?? v.deepSleepSeconds); d.remMin = m(v.remTime ?? v.remSleepSeconds);
      d.lightMin = m(v.lightTime ?? v.lightSleepSeconds); d.awakeMin = m(v.awakeTime ?? v.awakeSleepSeconds);
      d.respiration = num(v.respiration) ?? num(v.averageRespirationValue);
      d.restingHR = int(v.restingHeartRate); d.hrv = int(v.avgOvernightHrv); d.bbCharged = int(v.bodyBatteryChange);
    });
  }
  const h = await opt(`/hrv-service/hrv/daily/${from}/${to}`);
  for (const r of h?.hrvSummaries || []) upd(r.calendarDate, d => Object.assign(d, { hrv: int(r.lastNightAvg) ?? d.hrv, hrvWeekly: int(r.weeklyAvg), hrvStatus: r.status, hrvLow: int(r.baseline?.balancedLow), hrvHigh: int(r.baseline?.balancedUpper) }));
  const tr = await opt(`/metrics-service/metrics/trainingreadiness/${from}/${to}`);
  for (const r of (Array.isArray(tr) ? tr : []).slice().reverse()) upd(r.calendarDate, d => {
    Object.assign(d, { readiness: int(r.score), readinessLevel: r.level, readinessFeedback: r.feedbackShort });
    if (/WAKEUP/i.test(r.inputContext || '') || d.readinessMorning == null) d.readinessMorning = int(r.score);
  });
  const st = await opt(`/usersummary-service/stats/steps/daily/${from}/${to}`);
  for (const r of Array.isArray(st) ? st : []) upd(r.calendarDate, d => Object.assign(d, { steps: int(r.totalSteps), stepsDistance: num(r.totalDistance) }));
  const rhr = await opt(`/userstats-service/wellness/daily/${name}`, { fromDate: from, untilDate: to, metricId: '60' });
  for (const r of rhr?.allMetrics?.metricsMap?.WELLNESS_RESTING_HEART_RATE || []) upd(r.calendarDate, d => { d.restingHR = d.restingHR ?? int(r.value); });
  let n = 0;
  for (const d of Object.values(ch)) {
    clean(d);
    if (d.sleepHours == null && d.hrv == null && d.restingHR == null && !(d.steps > 0)) continue;
    c.days[d.key] = { ...d, ...(c.days[d.key] || {}) }; n++; // non sovrascrive i dati giornalieri più dettagliati
  }
  return n;
}

/**
 * Aggiorna l'archivio: gli ultimi `days` giorni, le attività recenti, dispositivi e FTP.
 * Al primo giro scarica anche 3 mesi di storico (serve come termine di confronto per il recupero).
 */
export async function sync({ days = 3 } = {}) {
  const c = loadCache();
  const t0 = Date.now(); calls = 0;
  try {
    await tokens();
    if (!TOK.displayName) {
      const p = await get('/userprofile-service/socialProfile');
      TOK.displayName = p?.displayName; TOK.fullName = p?.fullName; saveTokens(TOK);
    }
    const name = TOK.displayName;
    c.profile = { name: TOK.fullName || name };
    const first = Object.keys(c.days).length < 14;
    const n = first ? 30 : days;
    const keys = Array.from({ length: n }, (_, i) => addDays(today(), -(n - 1 - i)));
    for (let i = 0; i < keys.length; i += 3) {
      const got = await Promise.all(keys.slice(i, i + 3).map(k => fetchDay(k, name)));
      for (const d of got) c.days[d.key] = { ...(c.days[d.key] || {}), ...d };
    }
    // storico: blocchi di 28 giorni all'indietro, fino a circa un anno
    if (!c.historyDone) {
      let oldest = c.historyOldest || keys[0];
      for (let b = 0; b < (first ? 3 : 1); b++) {
        const to = addDays(oldest, -1), from = addDays(to, -27);
        const got = await backfill(c, name, from, to);
        oldest = from; c.historyOldest = from;
        c.historyEmpty = got ? 0 : (c.historyEmpty || 0) + 1;
        if (c.historyEmpty >= 3 || from < addDays(today(), -365)) { c.historyDone = true; break; }
      }
    }
    // attività: al primo giro le ultime 100, poi quelle dei giorni aggiornati
    const acts = first || !c.activities.length
      ? await get('/activitylist-service/activities/search/activities', { start: '0', limit: '100' })
      : await get('/activitylist-service/activities/search/activities', { startDate: keys[0], endDate: today(), start: '0', limit: '100' });
    const map = new Map(c.activities.map(a => [a.id, a]));
    for (const a of (Array.isArray(acts) ? acts : []).map(parseActivity).filter(Boolean)) map.set(a.id, a);
    c.activities = [...map.values()].sort((a, b) => (b.startTime || 0) - (a.startTime || 0)).slice(0, 300);
    // FTP e dispositivi: una volta ogni 6 ore
    if (!c.devicesAt || Date.now() - c.devicesAt > 6 * 3600e3) {
      const f = await opt('/biometric-service/biometric/latestFunctionalThresholdPower/CYCLING');
      c.ftp = int(f?.functionalThresholdPower ?? (Array.isArray(f) ? f[0]?.functionalThresholdPower : null)) ?? c.ftp;
      const devs = await opt('/device-service/deviceregistration/devices');
      if (Array.isArray(devs)) c.devices = devs.map(d => ({ id: String(d.deviceId ?? d.unitId ?? ''), name: d.displayName || d.productDisplayName || 'Dispositivo' }));
      c.devicesAt = Date.now();
    }
    // tiene al massimo ~14 mesi di giorni
    const min = addDays(today(), -430);
    for (const k of Object.keys(c.days)) if (k < min) delete c.days[k];
    c.lastSync = Date.now(); c.lastSyncError = null;
    console.log(`  Garmin: ${n} giorni aggiornati, ${Object.keys(c.days).length} in archivio, ${c.activities.length} attività, ${calls} richieste in ${Math.round((Date.now() - t0) / 1000)} s`);
  } catch (e) {
    c.lastSyncError = e.message;
    console.error('  Garmin: ' + e.message);
  }
  saveCache(c);
  return c;
}

/** Token MyWhoosh (cifrato da collega-mywhoosh.mjs): va alla web app dentro i dati cifrati. */
export const loadMyWhoosh = () => readEnc(path.join(ROOT, 'data', 'mywhoosh.enc.json'));

/** Dati per la web app (senza il token Garmin né campi interni). */
export function publicData(c) {
  return {
    mywhoosh: loadMyWhoosh(),
    updated: c.lastSync || null, error: c.lastSyncError || null, profile: c.profile || null,
    days: Object.values(c.days).sort((a, b) => (a.key < b.key ? -1 : 1)),
    activities: c.activities, devices: c.devices || [], ftp: c.ftp || null,
  };
}
