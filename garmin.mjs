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
  const r = await fetchRetry(TOKEN_URL, {
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
// ---------- accesso "classico" (sso/embed) come la libreria garth ----------
// ticket del servizio https://sso.garmin.com/sso/embed → token OAuth1 (dura ~1 anno) → token OAuth2 rinnovabile.
const EMBED = 'https://sso.garmin.com/sso/embed';
let CONSUMER = null;
async function consumer() {
  if (CONSUMER) return CONSUMER;
  const r = await fetch('https://thegarth.s3.amazonaws.com/oauth_consumer.json', { signal: AbortSignal.timeout(20e3) });
  CONSUMER = await r.json();
  return CONSUMER;
}
const pct = v => encodeURIComponent(v).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
/** Garmin a volte risponde 429 (troppe richieste) ai server cloud: riprova dopo 5, 15 e 30 secondi. */
async function fetchRetry(u, opts) {
  let r;
  for (const wait of [0, 5e3, 15e3, 30e3]) {
    if (wait) { console.log(`  Garmin: troppe richieste, riprovo fra ${wait / 1000} s`); await new Promise(x => setTimeout(x, wait)); }
    r = await fetch(u, { ...opts, signal: AbortSignal.timeout(30e3) });
    if (r.status !== 429) return r;
  }
  return r;
}
async function oauth1(method, url, token, secret) {
  const c = await consumer(), u = new URL(url);
  const o = { oauth_consumer_key: c.consumer_key, oauth_nonce: crypto.randomBytes(16).toString('hex'), oauth_signature_method: 'HMAC-SHA1', oauth_timestamp: String(Math.floor(Date.now() / 1000)), oauth_version: '1.0', ...(token ? { oauth_token: token } : {}) };
  const params = [...u.searchParams.entries(), ...Object.entries(o)].map(([k, v]) => [pct(k), pct(v)]).sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  const base = [method, pct(u.origin + u.pathname), pct(params.map(p => p.join('=')).join('&'))].join('&');
  o.oauth_signature = crypto.createHmac('sha1', `${pct(c.consumer_secret)}&${pct(secret || '')}`).update(base).digest('base64');
  const r = await fetchRetry(u, { method, signal: AbortSignal.timeout(30e3), headers: { 'User-Agent': 'com.garmin.android.apps.connectmobile', Authorization: 'OAuth ' + Object.entries(o).map(([k, v]) => `${pct(k)}="${pct(v)}"`).join(', '), ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) } });
  return { code: r.status, text: await r.text() };
}
async function exchangeOAuth1(t) {
  const { code, text } = await oauth1('POST', 'https://connectapi.garmin.com/oauth-service/oauth/exchange/user/2.0', t.oauth1Token, t.oauth1Secret);
  let j = null; try { j = JSON.parse(text); } catch { }
  if (code !== 200 || !j?.access_token) throw new Error(`Sessione Garmin scaduta (HTTP ${code}): ricollegalo dalla web app (Account → Collegamenti).`);
  return { ...t, kind: 'oauth1', accessToken: j.access_token, expiresAt: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
}
async function exchangeEmbedTicket(ticket) {
  const { code, text } = await oauth1('GET', `https://connectapi.garmin.com/oauth-service/oauth/preauthorized?ticket=${ticket}&login-url=${EMBED}&accepts-mfa-tokens=true`);
  const q = new URLSearchParams(text);
  if (code === 429) throw new Error('Garmin ha accettato email e password ma sta limitando le richieste: riprova fra 15–30 minuti.');
  if (code !== 200 || !q.get('oauth_token')) throw new Error(`Accesso Garmin non completato (HTTP ${code}).`);
  const t = await exchangeOAuth1({ oauth1Token: q.get('oauth_token'), oauth1Secret: q.get('oauth_token_secret') });
  saveTokens(t); return t;
}

/**
 * Accesso completo con email e password (come la libreria garth): pagina di accesso classica → ticket → token.
 * Tutto in pochi secondi, quindi il ticket non fa in tempo a scadere. La password non viene salvata.
 */
export async function loginGarmin(email, password) {
  // accesso "mobile" come la pagina dell'app Garmin Connect: restituisce subito il ticket, poi token con i client dell'app
  const jar = new Map(), UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
  const req = async (url, opts = {}) => {
    const r = await fetchRetry(url, { redirect: 'manual', ...opts, headers: { 'User-Agent': UA, Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(opts.headers || {}) } });
    for (const c of r.headers.getSetCookie?.() || []) { const kv = c.split(';')[0]; const i = kv.indexOf('='); jar.set(kv.slice(0, i).trim(), kv.slice(i + 1)); }
    return r;
  };
  await req(SIGN_IN_URL);
  const r = await req(`https://sso.garmin.com/mobile/api/login?clientId=GCM_IOS_DARK&locale=en-US&service=${encodeURIComponent(SERVICE_URL)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', Origin: 'https://sso.garmin.com', Referer: SIGN_IN_URL },
    body: JSON.stringify({ username: email, password, rememberMe: false, captchaToken: '' }),
  });
  if (r.status === 429) throw new Error('Garmin sta limitando gli accessi: riprova fra 15–30 minuti.');
  const j = await r.json().catch(() => ({}));
  const type = j?.responseStatus?.type || '';
  if (j?.serviceTicketId) return exchangeTicket(j.serviceTicketId, 'mobile');
  if (type === 'INVALID_USERNAME_PASSWORD') throw new Error('Email o password Garmin non corrette.');
  if (/LOCKED/.test(type)) throw new Error('Account Garmin bloccato temporaneamente per troppi tentativi: riprova più tardi.');
  if (j?.customerMfaInfo || /MFA/.test(type)) throw new Error('Il tuo account Garmin ha la verifica in due passaggi: per ora la web app non la gestisce. Dimmelo e la aggiungo.');
  if (/CAPTCHA/i.test(type) || j?.captchaAlreadyPassed === false && /CAPTCHA/i.test(JSON.stringify(j))) throw new Error('Garmin chiede di confermare che non sei un robot: riprova fra qualche minuto.');
  throw new Error(`Accesso Garmin non riuscito (${type || 'HTTP ' + r.status}).`);
}

export async function exchangeTicket(ticket, service = 'mobile') {
  if (service === 'embed') return exchangeEmbedTicket(ticket);
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
  if (t?.kind === 'oauth1') { const n = await exchangeOAuth1(t); TOK = n; saveTokens(n); return n; }
  if (!t?.refreshToken) throw new Error('Garmin non collegato: collegalo dalla web app (Account → Collegamenti).');
  const { code, j } = await tokenPost(t.clientId, { grant_type: 'refresh_token', client_id: t.clientId, refresh_token: t.refreshToken });
  const n = code === 200 && parseToken(j, t.clientId, t.refreshToken);
  if (!n) throw new Error(`Sessione Garmin scaduta (HTTP ${code}): ricollegalo dalla web app (Account → Collegamenti).`);
  n.displayName = t.displayName; n.fullName = t.fullName;
  TOK = n; saveTokens(n);
  return n;
}
async function tokens() {
  TOK = TOK || loadTokens();
  if (!TOK) throw new Error('Garmin non collegato: collegalo dalla web app (Account → Collegamenti).');
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
    elevationGain: num(a.elevationGain), elevationLoss: num(a.elevationLoss), maxElevation: num(a.maxElevation), maxSpeed: num(a.maxSpeed), avgSpeed: num(a.averageSpeed),
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
    // storico completo delle attività: 100 più vecchie a ogni giro, finché ce ne sono
    // tutte le attività salvate su Garmin: pagine da 100 fino in fondo (al primo giro), poi solo le nuove
    for (let p = 0; !c.activitiesDone && p < 60; p++) {
      c.activitiesOffset = c.activitiesOffset || 0;
      const older = await opt('/activitylist-service/activities/search/activities', { start: String(c.activitiesOffset), limit: '100' });
      const arr = Array.isArray(older) ? older : [];
      for (const a of arr.map(parseActivity).filter(Boolean)) map.set(a.id, a);
      c.activitiesOffset += arr.length;
      if (arr.length < 100) c.activitiesDone = true;
    }
    c.activities = [...map.values()].sort((a, b) => (b.startTime || 0) - (a.startTime || 0)).slice(0, 10000);
    // FTP e dispositivi: una volta ogni 6 ore
    if (!c.devicesAt || Date.now() - c.devicesAt > 6 * 3600e3) {
      const f = await opt('/biometric-service/biometric/latestFunctionalThresholdPower/CYCLING');
      c.ftp = int(f?.functionalThresholdPower ?? (Array.isArray(f) ? f[0]?.functionalThresholdPower : null)) ?? c.ftp;
      const devs = await opt('/device-service/deviceregistration/devices');
      if (Array.isArray(devs)) c.devices = devs.map(d => ({ id: String(d.deviceId ?? d.unitId ?? ''), name: d.displayName || d.productDisplayName || 'Dispositivo' }));
      c.devicesAt = Date.now();
    }
    // impostazioni della CIRQA: sveglie e posizione di indosso (una richiesta a giro)
    const cirqa = (c.devices || []).find(d => /cirqa/i.test(d.name)) || (c.devices || [])[0];
    if (cirqa?.id) {
      const st = await opt(`/device-service/deviceservice/device-info/settings/${cirqa.id}`);
      if (st) c.cirqa = { deviceId: cirqa.id, name: cirqa.name, alarms: Array.isArray(st.alarms) ? st.alarms : [], mountingSide: st.mountingSide || null, at: Date.now() };
    }
    if (!c.profilePk) { const p = await opt('/userprofile-service/socialProfile'); c.profilePk = p?.profileId ?? p?.id ?? null; }
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

/** Token MyWhoosh (cifrato): va alla web app dentro i dati cifrati. */
export const loadMyWhoosh = () => readEnc(path.join(ROOT, 'data', 'mywhoosh.enc.json'));

/**
 * Accesso a MyWhoosh con email e password (non salvate): si conserva solo il token, cifrato.
 * Usa l'accesso dell'app MyWhoosh (services.mywhoosh.com), che non ha il controllo reCAPTCHA del sito;
 * poi verifica che il codice valga anche per la libreria degli allenamenti (coaching.mywhoosh.com).
 */
const MW_LOGIN = () => path.join(ROOT, 'data', 'mywhoosh-login.enc.json');
export async function loginMyWhoosh(email, password, { save = true } = {}) {
  const r = await fetch('https://services.mywhoosh.com/http-service/api/login', {
    method: 'POST', signal: AbortSignal.timeout(30e3), headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Username: email, Password: password, Platform: 'Android', Action: 1001, CorrelationId: crypto.randomUUID(), DeviceId: crypto.randomUUID(), Authorization: '' }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j?.Success || !j?.AccessToken) throw new Error(/incorrect|invalid/i.test(j?.Message || '') ? 'Email o password MyWhoosh non corrette.' : `MyWhoosh non ha accettato l'accesso (${j?.Message || 'HTTP ' + r.status}).`);
  const token = j.AccessToken;
  const claim = k => { try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())[k]; } catch { return undefined; } };
  const exp = claim('exp') ? claim('exp') * 1000 : null;
  const userId = j.WhooshId ?? claim('userId') ?? claim('whoosh_user_id');
  // il codice vale per la libreria allenamenti?
  const t = await fetch('https://coaching.mywhoosh.com/api/v2/workout-builder/my-workouts', { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }, signal: AbortSignal.timeout(30e3) });
  const lib = await t.json().catch(() => ({}));
  const n = Array.isArray(lib?.data) ? lib.data.length : null;
  console.log(`  MyWhoosh: accesso app riuscito, libreria allenamenti HTTP ${t.status}`);
  if (!t.ok) throw new Error(`Accesso a MyWhoosh riuscito, ma la libreria degli allenamenti non accetta questo codice (HTTP ${t.status}): serve un'altra strada, avvisa Claude.`);
  writeEnc(path.join(ROOT, 'data', 'mywhoosh.enc.json'), { token, refreshToken: j.RefreshToken || null, userId: userId != null ? String(userId) : null, exp });
  // scelta di Simone: email e password conservate cifrate (TOKEN_KEY, solo su GitHub e sul Mac) per rinnovare l'accesso da solo
  if (save) writeEnc(MW_LOGIN(), { email, password });
  return { exp, n };
}

/** Rinnova da solo l'accesso MyWhoosh quando mancano meno di 3 giorni alla scadenza. */
export async function renewMyWhoosh() {
  const cur = loadMyWhoosh(), cred = readEnc(MW_LOGIN());
  if (!cred?.email || (cur?.exp && cur.exp - Date.now() > 3 * 864e5)) return;
  try { const r = await loginMyWhoosh(cred.email, cred.password, { save: false }); console.log(`  MyWhoosh: accesso rinnovato fino al ${r.exp ? new Date(r.exp).toLocaleDateString('it-IT') : '?'}`); }
  catch (e) { console.error('  MyWhoosh: rinnovo non riuscito: ' + e.message); }
}
export const myWhooshAuto = () => fs.existsSync(MW_LOGIN());

/**
 * Uscite MyWhoosh su Garmin Connect (come l'import dell'app iPhone): legge le ultime uscite con il token dell'app
 * MyWhoosh, scarica i file FIT di quelle nuove e li carica su Garmin, saltando quelle già presenti
 * (attività in bici con partenza entro 15 minuti) e quelle più vecchie di 30 giorni.
 */
export async function importMyWhoosh(c) {
  const m = loadMyWhoosh();
  if (!m?.token || !loadTokens()) return 0;
  const H = { Authorization: 'Bearer ' + m.token, 'Content-Type': 'application/json', Accept: 'application/json' };
  let list = [];
  try {
    const r = await fetch('https://service14.mywhoosh.com/v2/rider/profile/activities', { method: 'POST', headers: H, body: JSON.stringify({ page: 1, limit: 20, sortDate: 'DESC' }), signal: AbortSignal.timeout(30e3) });
    if (!r.ok) { console.log(`  MyWhoosh uscite: HTTP ${r.status}`); return 0; }
    const j = await r.json();
    list = Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : j?.data?.results || j?.results || [];
  } catch (e) { console.log('  MyWhoosh uscite: ' + e.message); return 0; }
  const done = new Set(c.mwImported || []);
  const isRide = a => /gravel|bici|cicl|rulli|bike/i.test(a.type);
  let up = 0, skip = 0, ko = 0;
  for (const ride of list) {
    const fid = ride.activityFileId;
    if (!fid || done.has(fid)) continue;
    const start = Date.parse(ride.startDatetime || ride.startTime || ride.date || '');
    if (!start || Date.now() - start > 30 * 864e5) { done.add(fid); continue; }
    if (c.activities.some(a => isRide(a) && a.startTime && Math.abs(a.startTime - start) < 15 * 60e3)) { done.add(fid); skip++; continue; }
    try {
      const d = await fetch('https://service14.mywhoosh.com/v2/rider/profile/download-activity-file', { method: 'POST', headers: H, body: JSON.stringify({ key: m.userId, fileId: fid }), signal: AbortSignal.timeout(30e3) });
      const url = (await d.json().catch(() => ({})))?.data;
      if (typeof url !== 'string' || !url.startsWith('http')) throw new Error('indirizzo del file non ricevuto');
      const fit = Buffer.from(await (await fetch(url, { signal: AbortSignal.timeout(60e3) })).arrayBuffer());
      if (fit.subarray(8, 12).toString() !== '.FIT') throw new Error('il file non è un FIT');
      const t = await tokens();
      const form = new FormData();
      form.append('file', new Blob([fit]), `MyWhoosh-${fid}.fit`);
      const u = await fetchRetry(CONNECT + '/upload-service/upload', { method: 'POST', headers: { ...NATIVE, Authorization: 'Bearer ' + t.accessToken }, body: form });
      if (u.status === 409 || u.ok) { done.add(fid); u.status === 409 ? skip++ : up++; }
      else throw new Error('Garmin HTTP ' + u.status);
    } catch (e) { ko++; console.log(`  MyWhoosh → Garmin: uscita non caricata (${e.message})`); }
  }
  c.mwImported = [...done].slice(-500);
  c.mwLast = { at: Date.now(), up, skip, ko };
  console.log(`  MyWhoosh → Garmin: ${up} caricate, ${skip} già presenti${ko ? `, ${ko} non riuscite` : ''}`);
  return up;
}

/** FTP del profilo MyWhoosh (una volta ogni 6 ore). */
export async function myWhooshFtp(c) {
  const m = loadMyWhoosh();
  if (!m?.token || (c.mwFtpAt && Date.now() - c.mwFtpAt < 6 * 3600e3)) return;
  try {
    const r = await fetch('https://services.mywhoosh.com/http-service/v1/player/player-data', { method: 'POST', headers: { Authorization: 'Bearer ' + m.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ WhooshId: m.userId }), signal: AbortSignal.timeout(30e3) });
    const t = await r.text(); const f = t.match(/"FtpPlayer"\s*:\s*([0-9.]+)/);
    if (r.ok && f && +f[1] > 0) { c.mwFtp = Math.round(+f[1]); c.mwFtpAt = Date.now(); }
  } catch { }
}

// ---------- modifiche su Garmin chieste dalla web app ----------
const RUNNING = { sportTypeId: 1, sportTypeKey: 'running' };
function runPayload(w, name) {
  const steps = w.steps, n = steps.length;
  return {
    workoutName: name, description: 'Coach Garmin · ' + (w.goal || ''), sportType: RUNNING,
    estimatedDurationInSecs: steps.reduce((a, s) => a + s.seconds, 0),
    workoutSegments: [{ segmentOrder: 1, sportType: RUNNING, workoutSteps: steps.map((s, i) => {
      const main = s.cadence != null, walk = s.power < 0.47;
      const type = walk && i > 0 && i < n - 1 ? [4, 'recovery'] : main ? [3, 'interval'] : i === 0 ? [1, 'warmup'] : i === n - 1 ? [2, 'cooldown'] : [4, 'recovery'];
      return { type: 'ExecutableStepDTO', stepOrder: i + 1, stepType: { stepTypeId: type[0], stepTypeKey: type[1] },
        endCondition: { conditionTypeId: 2, conditionTypeKey: 'time' }, endConditionValue: s.seconds,
        targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: 'no.target' },
        description: s.note || (walk ? 'Cammino' : main ? 'Corsa' : type[1] === 'warmup' ? 'Corsa lenta per scaldarsi' : type[1] === 'cooldown' ? 'Corsa lenta per finire' : 'Corsa lenta') };
    }) }],
  };
}
const gmtString = ms => new Date(ms).toISOString().replace('Z', '').slice(0, 23);
/**
 * Esegue una modifica su Garmin. Ritorna il messaggio per l'utente.
 * azioni: rinomina, sonnellino-add, sonnellino-del, sveglie, posizione, corse.
 */
export async function doAction(req) {
  const c = loadCache();
  const dev = c.cirqa?.deviceId;
  switch (req.azione) {
    case 'rinomina':
      await api('PUT', `/activity-service/activity/${req.activityId}`, {}, { activityId: Number(req.activityId), activityName: String(req.name).slice(0, 100) });
      return 'Nome aggiornato su Garmin Connect.';
    case 'sonnellino-add': {
      let pk = c.profilePk;
      if (!pk) { const p = await get('/userprofile-service/socialProfile'); pk = p?.profileId; }
      await api('POST', '/sleep-service/sleep/nap', {}, { calendarDate: req.day, napStartTimestampGMT: gmtString(req.start), napEndTimestampGMT: gmtString(req.end), userProfilePK: pk });
      return 'Sonnellino salvato su Garmin.';
    }
    case 'sonnellino-del':
      await api('DELETE', `/sleep-service/sleep/nap/${req.day}/${Math.round(req.start)}`);
      return 'Sonnellino eliminato da Garmin.';
    case 'sveglie':
      if (!dev) throw new Error('Non trovo la CIRQA tra i dispositivi Garmin.');
      await api('PUT', `/device-service/deviceservice/device-info/settings/${dev}`, {}, { deviceId: Number(dev) || dev, alarms: req.alarms });
      return 'Sveglie inviate alla CIRQA: arrivano alla prossima sincronizzazione della band.';
    case 'posizione':
      if (!dev) throw new Error('Non trovo la CIRQA tra i dispositivi Garmin.');
      await api('PUT', `/device-service/deviceservice/device-info/settings/${dev}`, {}, { deviceId: Number(dev) || dev, mountingSide: req.value });
      return 'Posizione aggiornata: arriva alla CIRQA alla prossima sincronizzazione.';
    case 'corse': {
      // allinea gli allenamenti di corsa dei prossimi giorni (I miei allenamenti + calendario + invio al Forerunner)
      const map = c.runWorkouts || {}, wanted = req.runs || {}, today = req.today;
      const watch = (c.devices || []).find(d => /forerunner/i.test(d.name)) || (c.devices || []).find(d => /fenix|fēnix|venu|vivoactive|instinct|epix|enduro/i.test(d.name));
      let added = 0, removed = 0, sent = 0;
      for (const [k, e] of Object.entries(map)) {
        const w = wanted[k];
        if (k >= addDays(today, -1) && w && w.sig === e.sig) continue;
        try { await api('DELETE', `/workout-service/workout/${e.id}`); } catch (er) { if (!/404/.test(er.message)) continue; }
        delete map[k]; if (!w && k >= today) removed++;
      }
      for (const [k, w] of Object.entries(wanted).sort()) {
        if (map[k] || k < today) continue;
        const created = await api('POST', '/workout-service/workout', {}, runPayload(w, w.name));
        const id = created?.workoutId; if (!id) continue;
        await api('POST', `/workout-service/schedule/${id}`, {}, { date: k });
        map[k] = { id, sig: w.sig, name: w.name }; added++;
        if (watch) { try { await api('POST', '/device-service/devicemessage/messages', {}, [{ deviceId: Number(watch.id) || watch.id, messageUrl: `workout-service/workout/FIT/${id}`, messageType: 'workouts', messageName: w.name, groupName: null, priority: 1, fileType: 'FIT', metaDataId: id }]); sent++; } catch { } }
      }
      c.runWorkouts = map; saveCache(c);
      if (!added && !removed) return 'Corse su Garmin già aggiornate.';
      return `Garmin Connect: ${added} ${added === 1 ? 'corsa caricata' : 'corse caricate'}${sent && watch ? ` e inviate al ${watch.name}` : ''}${removed ? `, ${removed} tolte` : ''}.`;
    }
    default: throw new Error('Azione sconosciuta.');
  }
}

/** Esito dell'ultimo collegamento chiesto dalla web app (stesso giro di GitHub Actions). */
export function loadEsito() { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'esito.json'), 'utf8')); } catch { return null; } }

/** Dati per la web app (senza il token Garmin né campi interni). */
export function publicData(c) {
  return {
    mwImport: c.mwLast || null, mwFtp: c.mwFtp || null, cirqa: c.cirqa || null, runWorkouts: c.runWorkouts || {}, mywhoosh: loadMyWhoosh(), mywhooshAuto: myWhooshAuto(), esito: loadEsito(), garminLinked: !!loadTokens(),
    updated: c.lastSync || null, error: c.lastSyncError || null, profile: c.profile || null,
    days: Object.values(c.days).sort((a, b) => (a.key < b.key ? -1 : 1)),
    activities: c.activities, devices: c.devices || [], ftp: c.ftp || null,
  };
}
