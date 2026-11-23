// Allenamenti su MyWhoosh (coaching.mywhoosh.com), come Views/MyWhooshWorkouts.swift dell'app iPhone.
// Il token arriva cifrato con i dati Garmin (si collega da Account → Collegamenti).
import * as C from './coach.js';

const API = 'https://coaching.mywhoosh.com/api/v2';
export const PREFIX = 'CG ';
export const LIBRARY = C.LIBRARY.filter(w => w.code !== 'W10');
const fileName = w => `${w.code} ${w.name}`;

export function claim(jwt, k) {
  try { return JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))[k]; } catch { return undefined; }
}
/** Stato del collegamento: { token, userId, exp } oppure null. */
export function account(data) {
  const m = data?.mywhoosh;
  if (!m?.token) return null;
  const exp = m.exp || (claim(m.token, 'exp') ? claim(m.token, 'exp') * 1000 : null);
  return { token: m.token, userId: m.userId || claim(m.token, 'userId'), exp, expired: exp != null && exp - Date.now() < 3600e3 };
}

async function req(acc, method, path, body) {
  if (!acc || acc.expired) throw new Error('MyWhoosh non collegato o accesso scaduto: collegalo da Account → Collegamenti.');
  const r = await fetch(API + path, {
    method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + acc.token },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30e3),
  });
  if (r.status === 401) throw new Error('Accesso MyWhoosh scaduto: ricollegalo da Account → Collegamenti.');
  if (!r.ok) throw new Error(`MyWhoosh ha risposto ${r.status}`);
  return r.json().catch(() => ({}));
}

export async function saved(acc) {
  const j = await req(acc, 'GET', '/workout-builder/my-workouts');
  return (j.data || []).map(w => ({ id: w.WorkoutId, name: w.Name, minutes: Math.round((w.Time || 0) / 60) })).filter(w => w.id != null && w.name);
}

/** Stesso formato che il sito invia quando salvi un allenamento dal Workout Builder. */
function workoutJSON(name, why, intensity, steps, ftp) {
  const secs = steps.reduce((a, s) => a + s.seconds, 0) || 1;
  const np = Math.pow(steps.reduce((a, s) => a + s.seconds * s.power ** 4, 0) / secs, 0.25);
  const kj = steps.reduce((a, s) => a + s.seconds * s.power * (ftp || 200), 0) / 1000;
  return {
    Id: 1e6 + Math.floor(Math.random() * 8.99e6), Name: name, Description: 'Coach Garmin – ' + why,
    Mode: 'E_Ride', ERGMode: 'E_OFF', IsRecovery: intensity === C.I.recovery, IsIntervals: false,
    FTPMode: 'E_NoFTP', IsTT: false, IsTSS: false, IsIF: false, FTPMultiplier: 1, StressPoint: 0,
    Time: secs, CustomTagDescription: '2', CategoryId: 200000000, SubcategoryId: 1, Type: 'E_Normal',
    DisplayType: 'E_byWatts', StepCount: steps.length, IsFavorite: false, CompletedCount: 0,
    WorkoutSteps: [], AuthorName: 'Coach Garmin', WokoutAssociationId: 0,
    IF: Math.round(np * 100) / 100, TSS: C.tss(steps), KJ: Math.round(kj * 10) / 10,
    WorkoutStepsArray: steps.map((s, i) => ({
      IntervalId: 0, StepType: 'E_Normal', Id: i + 1, WorkoutMessage: [], Rpm: s.cadence || 0, Power: s.power, Pace: 0,
      StartPower: 0, EndPower: 0, Time: s.seconds, IsManualGrade: false, ManualGradeValue: 0, ShowAveragePower: true, FlatRoad: 0,
    })),
  };
}
async function upload(acc, name, why, intensity, steps, ftp) {
  await req(acc, 'POST', '/client/custom-workout-upload', { UserId: acc.userId, SportsModeType: 0, WorkoutsData: [workoutJSON(name, why, intensity, steps, ftp)] });
}
const del = (acc, id) => req(acc, 'DELETE', `/client/custom-workout-upload/0/${id}`);

/**
 * Cosa usare oggi su MyWhoosh: un W01–W09 già salvato se corrisponde, altrimenti uno su misura "CG gg/mm …".
 * (Come WorkoutPlanner.suggest: tolleranza 8 minuti e 3% di intensità.)
 */
export function suggestion(w, steps, list) {
  if (!w || w.sport === 'run') return null;
  const peak = Math.max(...steps.map(s => s.power)), mins = Math.trunc(steps.reduce((a, s) => a + s.seconds, 0) / 60);
  const match = LIBRARY.filter(x => x.intensity === w.intensity && list.some(s => s.name.startsWith(x.code)))
    .find(x => Math.abs(x.minutes - mins) <= 8 && Math.abs(Math.max(...x.steps.map(s => s.power)) - peak) <= 0.03);
  if (match) return { kind: 'saved', name: fileName(match), minutes: match.minutes, peak, steps: match.steps };
  const n = { 0: 'Recupero', 1: 'Fondo', 2: 'Tempo', 3: 'SweetSpot', 4: 'Soglia', 5: 'VO2', 6: 'Verifica FTP' }[w.intensity];
  const label = w.intensity <= 1 ? `${n} ${mins}' ${Math.round(peak * 100)}%` : `${n} ${mins}' ${Math.round(peak * 100)}%`;
  return { kind: 'custom', name: `${PREFIX}${C.pretty(C.today(), 'ddmm')} ${label}`, minutes: mins, peak, steps };
}

/** Carica l'allenamento su misura di oggi, togliendo i "CG" dei giorni prima. */
export async function uploadToday(acc, sug, why, intensity, ftp, list) {
  if (list.some(s => s.name === sug.name)) return 'già';
  for (const old of list.filter(s => s.name.startsWith(PREFIX))) await del(acc, old.id);
  await upload(acc, sug.name, why, intensity, sug.steps, ftp);
  return 'ok';
}

/** Carica su MyWhoosh gli W01–W09 mancanti. */
export async function installLibrary(acc, list, ftp, onStep) {
  let ok = 0, ko = 0;
  for (const w of LIBRARY) {
    if (list.some(s => s.name === fileName(w))) continue;
    onStep && onStep(`Carico ${w.code}…`);
    try { await upload(acc, fileName(w), w.goal + '.', w.intensity, w.steps, ftp); ok++; } catch { ko++; }
    await new Promise(r => setTimeout(r, 700));
  }
  return { ok, ko };
}
