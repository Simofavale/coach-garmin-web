// Motore del coach: stesse regole dell'app iPhone Coach Garmin (cartella Shared/Coach),
// riscritte in JavaScript. Le date sono chiavi "aaaa-mm-gg" nel fuso del telefono.

// ---------- date ----------
const pad = n => String(n).padStart(2, '0');
export const key = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const today = () => key(new Date());
export const toDate = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d, 12); };
export const addDays = (k, n) => { const d = toDate(k); d.setDate(d.getDate() + n); return key(d); };
export const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / 864e5);
/** 1 = domenica … 7 = sabato (come Calendar.weekday). */
export const weekday = k => toDate(k).getDay() + 1;
export const startOfWeek = k => addDays(k, -((toDate(k).getDay() + 6) % 7));
export const weekKeys = k => { const s = startOfWeek(k); return Array.from({ length: 7 }, (_, i) => addDays(s, i)); };
const MESI = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
const MESI_L = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
const GG = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
const GG_L = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
export const pretty = (k, style = 'short') => {
  const d = toDate(k);
  if (style === 'long') return cap(`${GG_L[d.getDay()]} ${d.getDate()} ${MESI_L[d.getMonth()]}`);
  if (style === 'day') return cap(`${GG_L[d.getDay()]} ${d.getDate()}`);
  if (style === 'dm') return `${d.getDate()} ${MESI[d.getMonth()]}`;
  if (style === 'ddmm') return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
  if (style === 'wd') return cap(GG[d.getDay()]);
  if (style === 'year') return `${d.getDate()} ${MESI_L[d.getMonth()]} ${d.getFullYear()}`;
  return cap(`${GG[d.getDay()]} ${d.getDate()} ${MESI[d.getMonth()]}`);
};
export const hm = h => { let H = Math.floor(h), m = Math.round((h - H) * 60); if (m === 60) { H++; m = 0; } return `${H}h ${pad(m)}`; };
const minHm = m => (m >= 60 ? `${Math.floor(m / 60)}h${pad(m % 60)}'` : `${m}'`);
export const f1 = (x, d = 1) => x.toLocaleString('it-IT', { minimumFractionDigits: d, maximumFractionDigits: d });
const compact = a => a.filter(x => x != null);
const avg = xs => xs.reduce((a, b) => a + b, 0) / xs.length;

// ---------- semaforo ----------
export const LIGHT = {
  verde: { label: 'VERDE', color: '#2ecc71' }, giallo: { label: 'GIALLO', color: '#fac22e' },
  rosso: { label: 'ROSSO', color: '#ef4d45' }, nd: { label: 'N/D', color: '#8e8e93' },
};
export const lightFrom = r => (r == null ? 'nd' : r >= 67 ? 'verde' : r >= 34 ? 'giallo' : 'rosso');

// ---------- intensità ----------
export const I = { recovery: 0, endurance: 1, tempo: 2, sweetSpot: 3, threshold: 4, vo2: 5, test: 6 };
export const INT_LABEL = ['Recupero', 'Fondo', 'Tempo', 'Sweet spot', 'Soglia', 'VO2max', 'Test'];
export const INT_COLOR = ['#30b0c7', '#34c759', '#ff9500', '#ff3b30', '#ff2d55', '#5856d6', '#af52de'];

// ---------- attività ----------
export const isRide = a => /gravel|bici|cicl|rulli|bike/i.test(a.type);
export const isRun = a => !isRide(a) && /corsa|run/i.test(a.type);
export const isWalk = a => /cammin|walk|escurs|hik/i.test(a.type);

// ---------- recupero (stile WHOOP, stima dell'app) ----------
export function sleepPerformance(d) {
  if (d.sleepHours == null) return null;
  const need = d.sleepNeed || 8;
  const hoursPart = Math.min(1, d.sleepHours / need) * 100;
  const eff = d.sleepEfficiency ?? estimatedEfficiency(d) ?? 95;
  const cons = d.sleepConsistency ?? 60;
  return Math.round(0.5 * hoursPart + 0.25 * eff + 0.25 * cons);
}
function estimatedEfficiency(d) {
  if (d.sleepHours == null || d.awakeMin == null) return null;
  const asleep = d.sleepHours * 60;
  return Math.round(asleep / (asleep + d.awakeMin) * 100);
}
function stats(xs) {
  if (xs.length < 4) return null;
  const m = avg(xs);
  const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return [m, Math.max(Math.sqrt(v), 1e-6)];
}
/** Livello Garmin della Training Readiness → semaforo (alta/ottimale verde, moderata gialla, bassa rossa). */
export const READINESS_LEVEL = { PRIME: 'ottimale', HIGH: 'alta', MODERATE: 'moderata', LOW: 'bassa', POOR: 'scarsa' };
export function lightFromReadiness(score, level) {
  const l = String(level || '').toUpperCase();
  if (l === 'PRIME' || l === 'HIGH') return 'verde';
  if (l === 'MODERATE') return 'giallo';
  if (l === 'LOW' || l === 'POOR') return 'rosso';
  return score >= 75 ? 'verde' : score >= 50 ? 'giallo' : 'rosso';
}
/**
 * PRONTEZZA COACH (1–99): il recupero del giorno, unendo il meglio di WHOOP e di Garmin.
 * - Notte (stile WHOOP, 40%): HRV, FC a riposo, sonno, respirazione e stress notturno di stanotte
 *   confrontati con le tue ultime 4 settimane. Vede subito una notte storta, ma da sola è "rumorosa".
 * - Tendenza (25%): media HRV degli ultimi 7 giorni rispetto alle 4 settimane prima, meno il debito di sonno
 *   delle ultime 3 notti (il metodo degli studi sull'allenamento guidato dall'HRV: conta la media, non il giorno singolo).
 * - Garmin (35%): Training Readiness del mattino (dopo il risveglio): l'unica che tiene conto di carico e tempo di recupero.
 * Campanelli d'allarme: se più segnali peggiorano insieme il punteggio viene limitato, anche se Garmin è ottimista.
 */
export function recovery(day, history) {
  const before = history.filter(d => d.key < day.key).slice(-28);
  const night = estimate(day, history);
  const parts = [], flags = [];
  if (night.recovery != null) parts.push(['notte', night.recovery, 0.40]);
  // tendenza HRV: media dei 7 giorni (oggi compreso) contro le 4 settimane prima
  const last7 = compact(history.filter(d => d.key <= day.key).slice(-7).map(d => d.hrv)).map(Math.log);
  const base = stats(compact(history.filter(d => d.key <= day.key).slice(-35, -7).map(d => d.hrv)).map(Math.log));
  let trend = null;
  if (last7.length >= 4 && base) {
    const z = (avg(last7) - base[0]) / base[1];
    trend = 50 + 50 * Math.tanh(z / 1.5);
    const nights = compact(history.filter(d => d.key <= day.key).slice(-3).map(d => d.sleepHours));
    if (nights.length) trend -= Math.max(0, 7.5 - avg(nights)) * 6;   // debito di sonno: −6 per ogni ora sotto le 7,5 h
    trend = Math.max(1, Math.min(99, Math.round(trend)));
    parts.push(['tendenza', trend, 0.25]);
  }
  const garminMorning = day.readinessMorning ?? day.readiness;
  if (garminMorning != null) parts.push(['garmin', garminMorning, 0.35]);
  if (!parts.length) return { ...night, source: 'stima', parts: {}, flags };
  const w = parts.reduce((a, p) => a + p[2], 0);
  let score = Math.round(parts.reduce((a, p) => a + p[1] * p[2], 0) / w);

  // campanelli d'allarme (z della notte: positivo = meglio)
  const z = Object.fromEntries(night.components);
  const hrvZ = z['HRV'], rhrZ = z['FC riposo'] != null ? -z['FC riposo'] : null;
  const respZ = z['Respirazione'] != null ? -z['Respirazione'] : null, stressZ = z['Stress notturno'] != null ? -z['Stress notturno'] : null;
  const cap = (max, why) => { if (score > max) score = max; flags.push(why); };
  if (rhrZ >= 1.5 && hrvZ <= -1 && respZ >= 1.5)
    cap(30, 'FC a riposo alta, HRV bassa e respirazione alta insieme: può essere l\'inizio di un malanno o forte stress. Oggi riposo o solo cammino.');
  else if (hrvZ <= -1.5 && rhrZ >= 1)
    cap(45, `HRV stanotte molto sotto la tua media e FC a riposo alta${stressZ >= 1.5 ? ', con stress notturno alto' : ''}: il corpo non ha recuperato, anche se ${garminMorning != null ? 'Garmin è più ottimista' : 'il resto sembra a posto'}.`);
  const short = history.filter(d => d.key <= day.key).slice(-3).filter(d => d.sleepHours != null && d.sleepHours < 6).length;
  if (short >= 2) cap(60, '2 delle ultime 3 notti sotto le 6 ore: niente intensità finché non recuperi sonno.');
  if (night.recovery != null && garminMorning != null && Math.abs(night.recovery - garminMorning) >= 30 && !flags.length)
    flags.push(`Notte (${night.recovery}) e Garmin (${garminMorning}) non sono d'accordo: il punteggio sta nel mezzo, per l'intensità scelgo la via prudente.`);
  score = Math.max(1, Math.min(99, score));
  return {
    recovery: score, light: lightFrom(score), source: 'coach', level: day.readinessLevel || null, flags,
    parts: { notte: night.recovery, tendenza: trend, garmin: garminMorning, garminOra: day.readiness ?? null },
    sleepPerformance: night.sleepPerformance, components: night.components, missing: night.missing,
  };
}
function estimate(day, history) {
  const before = history.filter(d => d.key < day.key).slice(-28);
  const comps = [], missing = [];
  let s;
  if (day.hrv != null && (s = stats(compact(before.map(d => d.hrv)).map(Math.log)))) comps.push(['HRV', (Math.log(day.hrv) - s[0]) / s[1], 0.45]); else missing.push('HRV');
  if (day.restingHR != null && (s = stats(compact(before.map(d => d.restingHR))))) comps.push(['FC riposo', -(day.restingHR - s[0]) / s[1], 0.25]); else missing.push('FC a riposo');
  const sp = sleepPerformance(day);
  if (sp != null && (s = stats(compact(before.map(sleepPerformance))))) comps.push(['Sonno', (sp - s[0]) / s[1], 0.15]); else missing.push('Sonno');
  if (day.respiration != null && (s = stats(compact(before.map(d => d.respiration))))) comps.push(['Respirazione', -(day.respiration - s[0]) / s[1], 0.05]);
  if (day.nightStress != null && (s = stats(compact(before.map(d => d.nightStress))))) comps.push(['Stress notturno', -(day.nightStress - s[0]) / s[1], 0.10]);
  let rec = null;
  if (comps.some(c => c[0] === 'HRV')) {
    const w = comps.reduce((a, c) => a + c[2], 0);
    const z = comps.reduce((a, c) => a + c[1] * c[2], 0) / w;
    rec = Math.max(1, Math.min(99, Math.round(50 + 50 * Math.tanh(z / 1.3))));
  }
  return { recovery: rec, light: lightFrom(rec), source: 'stima', sleepPerformance: sp, components: comps.map(c => [c[0], c[1]]), missing };
}
export function hrvBaseline(days, upTo, window = 7) {
  const xs = compact(days.filter(d => d.key <= upTo).slice(-window).map(d => d.hrv));
  return xs.length ? Math.round(avg(xs)) : null;
}

/** "Stato di salute": quanti indicatori notturni sono nella tua norma (stima dell'app). */
export function health(day, history) {
  if (!day) return { items: [], label: '–', light: 'nd' };
  const base = history.filter(d => d.key < day.key).slice(-28);
  const range = xs => {
    if (xs.length < 7) return null;
    const m = avg(xs), sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
    return [m - Math.max(1.5 * sd, 0.5), m + Math.max(1.5 * sd, 0.5)];
  };
  const items = [];
  let r;
  if (day.hrv != null) {
    let normal = true;
    if (day.hrvLow != null && day.hrvHigh != null) normal = day.hrv >= day.hrvLow && day.hrv <= day.hrvHigh + 10;
    else if ((r = range(compact(base.map(d => d.hrv))))) normal = day.hrv >= r[0];
    items.push({ name: 'HRV', value: `${day.hrv} ms`, normal });
  }
  if (day.restingHR != null && (r = range(compact(base.map(d => d.restingHR))))) items.push({ name: 'FC a riposo', value: `${day.restingHR} bpm`, normal: day.restingHR <= r[1] });
  if (day.respiration != null && (r = range(compact(base.map(d => d.respiration))))) items.push({ name: 'Respirazione', value: f1(day.respiration), normal: day.respiration <= r[1] && day.respiration >= r[0] });
  if (day.nightStress != null && (r = range(compact(base.map(d => d.nightStress))))) items.push({ name: 'Stress notturno', value: `${day.nightStress}`, normal: day.nightStress <= r[1] });
  const out = items.filter(i => !i.normal).length;
  return {
    items, label: !items.length ? '–' : !out ? 'Nella norma' : out === 1 ? '1 fuori norma' : `${out} fuori norma`,
    light: !items.length ? 'nd' : !out ? 'verde' : out === 1 ? 'giallo' : 'rosso',
  };
}

// ---------- carico recente ----------
export const loadOf = a => a.trainingLoad ?? a.minutes * (isRide(a) ? 1.3 : 0.6);
export function recentLoad(acts, date = today()) {
  const y = acts.filter(a => a.key === addDays(date, -1)), y2 = acts.filter(a => a.key === addDays(date, -2));
  const ly = y.reduce((s, a) => s + loadOf(a), 0), l2 = y2.reduce((s, a) => s + loadOf(a), 0);
  const win = new Set(Array.from({ length: 28 }, (_, i) => addDays(date, -(i + 3))));
  const base = acts.filter(a => win.has(a.key)).reduce((s, a) => s + loadOf(a), 0) / 28;
  const km = y.filter(isRide).reduce((s, a) => s + (a.km || 0), 0);
  const min = y.reduce((s, a) => s + a.minutes, 0);
  const gain = y.reduce((s, a) => s + (a.elevationGain || 0), 0);
  let level = 0;
  if (ly >= Math.max(200, base * 3) || km >= 80 || min >= 180 || ly + l2 >= Math.max(320, base * 5)) level = 2;
  else if (ly >= Math.max(110, base * 1.8) || km >= 45 || min > 120 || ly + l2 >= Math.max(200, base * 3.5)) level = 1;
  let text = '';
  if (y.length) {
    const parts = [];
    if (km >= 1) parts.push(`${Math.round(km)} km in bici`);
    parts.push(`in ${minHm(Math.max(min, 1))}`);
    text = 'Ieri ' + parts.join(' ');
    if (gain >= 300) text += ` (+${Math.round(gain)} m)`;
    if (base > 5) text += `, carico ${Math.round(ly)} contro una media di ${Math.round(base)} al giorno`;
  } else if (y2.length && level > 0) text = `L'altro ieri ${minHm(y2.reduce((s, a) => s + a.minutes, 0))} di attività`;
  return { level, summary: text, yesterday: ly, baseline: base };
}

// ---------- libreria W01–W10 (MyWhoosh) ----------
const B = (min, p, cad = null) => ({ seconds: Math.round(min * 60), power: p, cadence: cad });
const warm10 = [B(4, 0.5), B(3, 0.58), B(3, 0.65)], cool8 = [B(5, 0.58), B(3, 0.5)];
const W = (code, name, minutes, range, rpe, intensity, goal, lighter, howTo, why, steps) =>
  ({ code, name, minutes, range, rpe, intensity, goal, lighter, howTo, why, steps, sport: 'bike' });
export const LIBRARY = [
  W('W01', 'Recupero attivo', 30, '45–52%', '1–2', 0, 'Recupero, sciogliere le gambe', null,
    ['Rapporto agile, 85–95 rpm, nessuna fatica.', 'Devi poter parlare in frasi complete per tutto il tempo.', 'Se dopo 10 minuti le gambe restano pesanti, chiudi a 20 minuti: va bene così.', 'Bevi 300–500 ml; nessun integratore necessario.'],
    "Fa circolare il sangue senza aggiungere fatica: accelera il recupero e mantiene l'abitudine delle tre sedute.", [B(5, 0.45), B(20, 0.52), B(5, 0.45)]),
  W('W02', 'Fondo aerobico 45', 45, '50–65%', '3', 1, 'Base aerobica', 'W01',
    ['Riscaldamento progressivo di 8 minuti.', 'Blocco centrale di 32\' al 65%: respiro regolare, naso-bocca, puoi parlare.', 'Cadenza 85–95 rpm: protegge il ginocchio (meno forza per pedalata).', 'FC indicativa in zona 2 (circa 109–128 bpm): se sale oltre, abbassa i watt.'],
    'È il mattone principale della resistenza per il gravel: aumenta mitocondri e capillari e insegna al corpo a usare i grassi.', [B(3, 0.5), B(3, 0.55), B(2, 0.6), B(32, 0.65), B(3, 0.55), B(2, 0.5)]),
  W('W03', 'Fondo aerobico 60', 60, '50–70%', '3–4', 1, 'Resistenza aerobica', 'W02',
    ["10' di riscaldamento, poi 20' al 66% e 20' al 70%.", "La seconda parte deve sembrare 'sostenuta ma comoda': RPE 4.", 'Bevi 500–750 ml; se hai mangiato poco, 20–30 g di carboidrati a metà.', 'Ventilatore acceso: il caldo alza la FC e falsa la fatica.'],
    'Allunga la durata a ritmo aerobico: ti prepara alle uscite gravel di 2–3 ore senza crolli finali.', [B(4, 0.5), B(3, 0.55), B(3, 0.6), B(20, 0.66), B(20, 0.7), B(5, 0.55), B(5, 0.5)]),
  W('W04', 'Agilita e cadenza', 50, '50–62% (100 rpm)', '3', 1, 'Efficienza di pedalata a bassa coppia', 'W02',
    ["6 ripetute: 4' a 100 rpm al 62% + 2' a 85 rpm al 55%.", 'A 100 rpm il bacino resta fermo sulla sella: se rimbalzi, scendi a 95.', "Pensa a 'spingere avanti' in alto e 'raschiare' in basso.", 'Molla subito se il ginocchio dà fastidio e passa a W02.'],
    'Pedalare agile riduce la forza su ogni pedalata (meglio per il ginocchio) e rende più economica la salita in gravel.',
    [B(4, 0.5), B(3, 0.55), B(3, 0.58), ...Array.from({ length: 6 }, () => [B(4, 0.62, 100), B(2, 0.55, 85)]).flat(), B(4, 0.5)]),
  W('W05', 'Tempo breve 2x10', 45, 'fino al 76%', '5–6', 2, 'Primo contatto con il tempo', 'W02',
    ["2 × 10' al 76% a 90 rpm, recupero 5' al 55%.", 'Respiro più profondo, parli a frasi brevi: è normale.', "Il secondo blocco deve essere uguale al primo: se non ci riesci, l'FTP è troppo alta.", '20–30 g di carboidrati prima se arrivi a digiuno.'],
    'Alza il ritmo che sai tenere a lungo: è la velocità di crociera sugli sterrati veloci.', [...warm10, B(10, 0.76, 90), B(5, 0.55), B(10, 0.76, 90), B(5, 0.58), B(5, 0.5)]),
  W('W06', 'Tempo 3x10', 58, 'fino al 78%', '5–6', 2, 'Resistenza a ritmo sostenuto', 'W05',
    ["3 × 10' al 78% a 90 rpm, recupero 5' al 55%.", 'Resta seduto e rilassa le spalle; le mani appoggiate, non strette.', 'Bevi a ogni recupero.', 'Se la FC continua a salire nel terzo blocco senza stabilizzarsi, chiudi con il defaticamento.'],
    "Più minuti a ritmo tempo = più resistenza alla fatica nelle ultime ore di un'uscita lunga.", [...warm10, B(10, 0.78, 90), B(5, 0.55), B(10, 0.78, 90), B(5, 0.55), B(10, 0.78, 90), ...cool8]),
  W('W07', 'Sweet spot 3x8', 50, "fino all'85%", '6–7', 3, 'Introduzione al sweet spot', 'W05',
    ["3 × 8' all'85% a 90 rpm, recupero 4' al 55%.", "Impegnativo ma controllato: l'ultimo minuto è duro, non massimale.", "Mangia 30 g di carboidrati 30' prima.", 'Mai a bassa cadenza: è il modo più rapido per irritare il ginocchio.'],
    "Il miglior rapporto stimolo/fatica per alzare l'FTP: più watt in salita e sui tratti spinti.", [...warm10, B(8, 0.85, 90), B(4, 0.55), B(8, 0.85, 90), B(4, 0.55), B(8, 0.85, 90), ...cool8]),
  W('W08', 'Sweet spot 2x15', 55, "fino all'88%", '6–7', 3, 'Sweet spot prolungato (blocco successivo)', 'W07',
    ["2 × 15' all'88% a 90 rpm, recupero 5'.", 'Parti un filo sotto e assestati nei primi 2 minuti.', 'Carboidrati prima e durante (30–40 g).'],
    'Estende la durata ad alta intensità sostenibile: per salite gravel lunghe.', [B(4, 0.5), B(3, 0.58), B(3, 0.65), B(2, 0.72), B(15, 0.88, 90), B(5, 0.55), B(15, 0.88, 90), ...cool8]),
  W('W09', 'Fondo breve 35', 35, '50–65%', '3', 1, 'Alternativa corta e leggera', 'W01',
    ["25' al 65% dopo 5' di riscaldamento.", 'Come W02, solo più corto: zona 2, respiro facile.'],
    'Mantiene la continuità quando il tempo è poco: la costanza conta più della singola seduta.', [B(2, 0.5), B(3, 0.58), B(25, 0.65), B(3, 0.55), B(2, 0.5)]),
  W('W10', 'Verifica FTP a gradini', 33, '45–152%', '9–10 a fine test', 6, 'Stimare la FTP', 'W02',
    ["8' di riscaldamento, poi gradini da 1' (+6% FTP ogni minuto) fino al cedimento.", 'Cadenza libera ma sopra 85 rpm; quando non tieni più i watt, fermati.', "FTP = 75% della potenza media dell'ultimo minuto completato.", 'Aggiorna subito la FTP in MyWhoosh: tutti i file si adattano.'],
    'Senza FTP verificata le percentuali sono approssimative: il test rende precisi tutti gli altri allenamenti.',
    [B(4, 0.45), B(4, 0.5), ...Array.from({ length: 17 }, (_, i) => ({ seconds: 60, power: 0.56 + 0.06 * i, cadence: null })), B(8, 0.45)]),
];
export const lib = code => LIBRARY.find(w => w.code === code) || null;
export const title = w => (w.code === 'PIANO' || w.code === 'CORSA' ? w.name : `${w.code} — ${w.name}`);
export const tss = steps => Math.round(steps.reduce((s, x) => s + x.seconds / 3600 * x.power * x.power * 100, 0));

// ---------- programma base (senza piano attivo) ----------
const BLOCK1 = [['Ripresa', 'W02', 'W04', 'W03', 'W01'], ['Verifica', 'W10', 'W05', 'W03', 'W09'], ['Carico', 'W06', 'W02', 'W07', 'W01'], ['Alleggerimento', 'W05', 'W04', 'W02', 'W09']];
const BLOCK2 = [['Consolidamento', 'W02', 'W05', 'W03', 'W01'], ['Progressione', 'W06', 'W04', 'W07', 'W09'], ['Carico', 'W06', 'W02', 'W08', 'W01'], ['Alleggerimento', 'W05', 'W04', 'W02', 'W09']];
export function baseSlot(k, start) {
  const days = daysBetween(start, k);
  if (days < 0) return { kind: 'rest' };
  const absWeek = Math.floor(days / 7), block = Math.floor(absWeek / 4) + 1;
  const [name, mon, wed, fri, thu] = (block <= 1 ? BLOCK1 : BLOCK2)[absWeek % 4];
  const s = (kind, code) => ({ kind, code, weekName: name });
  switch (weekday(k)) {
    case 2: return s('session', mon);
    case 4: return s('session', wed);
    case 6: return s('session', fri);
    case 5: return s('optional', thu);
    case 7: case 1: return s('outdoor', null);
    default: return s('rest', null);
  }
}

// ---------- generatore del piano (obiettivo scelto da te) ----------
export const GOAL_KIND = {
  race: { label: 'Gara in programma', short: 'Gara', icon: 'flag', explanation: 'Costruisce la base, poi lavori specifici e scarico finale per arrivare al giorno della gara al massimo.' },
  fitness: { label: 'Recupero forma fisica', short: 'Forma fisica', icon: 'heart', explanation: 'Tanto fondo aerobico e poca intensità: torni in forma senza sovraccaricare.' },
  power: { label: 'Potenziamento', short: 'Potenza', icon: 'flash', explanation: 'Più sweet spot, soglia e VO2max per alzare FTP e potenza sugli sforzi brevi.' },
};
export const MIX = {
  bike: { label: 'Solo rulli', explanation: 'Tutte le sedute sui rulli (MyWhoosh), con i watt in % della FTP.' },
  alternate: { label: 'Corsa e rulli', explanation: 'Le sedute si alternano fra corsa e rulli: un giorno corri, quello dopo pedali.' },
  run: { label: 'Solo corsa', explanation: 'Tutte le sedute di corsa, a tempo, da fare con il Forerunner.' },
};
export const EXTRA_PHASE = 'Allenamento in più';
export const goalWeeks = g => Math.max(1, Math.ceil(daysBetween(g.startDate, g.targetDate) / 7));
const weekOf = (g, k) => Math.trunc(daysBetween(startOfWeek(g.startDate), k) / 7);
export const currentWeek = (g, k = today()) => Math.max(0, weekOf(g, k));

export function phase(g, week) {
  const n = goalWeeks(g);
  switch (g.kind) {
    case 'race': return week >= n - 1 ? 'Scarico pre-gara' : week < n * 0.45 ? 'Base' : week < n * 0.8 ? 'Costruzione' : 'Specifico';
    case 'fitness': return week < n * 0.6 ? 'Base' : 'Consolidamento';
    default: return week < n * 0.3 ? 'Base' : week < n * 0.75 ? 'Forza e soglia' : 'Potenza';
  }
}
const isDeload = (g, week) => (g.deloadWeeks || []).includes(week) || (week > 0 && (week + 1) % 4 === 0 && week < goalWeeks(g) - 1);
export const basePeak = i => [0.52, 0.66, 0.78, 0.88, 0.98, 1.12, 1.5][i];
export const bikeTitle = (i, m) => [`Recupero attivo ${m}'`, m >= 90 ? `Fondo lungo ${m}'` : `Fondo aerobico ${m}'`, `Tempo ${m}'`, `Sweet spot ${m}'`, `Soglia ${m}'`, `VO2max ${m}'`, 'Verifica FTP'][i];
const bikePurpose = i => ['Sciogliere le gambe e favorire il recupero.', 'Costruire resistenza aerobica: più capillari e mitocondri.', 'Ritmo sostenuto a lungo: alza la velocità di crociera.', "Il miglior rapporto stimolo/fatica per alzare l'FTP.", "Lavoro alla soglia: alza il limite che tieni per un'ora.", 'Sforzi brevi e intensi: potenza aerobica massima.', 'Misurare la FTP per aggiornare le zone.'][i];
export const runTitle = (i, m) => [`Corsa rigenerante ${m}'`, m >= 60 ? `Corsa lunga ${m}'` : `Corsa facile ${m}'`, `Corsa ritmo medio ${m}'`, `Corsa soglia ${m}'`, `Corsa soglia ${m}'`, `Ripetute di corsa ${m}'`, `Corsa soglia ${m}'`][i];
const runPurpose = i => ['Corsetta lentissima: sciogliere le gambe senza fatica.', 'Base aerobica di corsa: ritmo da conversazione, abitua tendini e articolazioni.', 'Blocchi a ritmo medio: alza la velocità che tieni a lungo.', "Ripetute vicino alla soglia: alzano il ritmo che tieni per un'ora.", "Ripetute vicino alla soglia: alzano il ritmo che tieni per un'ora.", 'Ripetute brevi e intense: potenza aerobica massima.', "Ripetute vicino alla soglia: alzano il ritmo che tieni per un'ora."][i];
export const hrZone = i => [1, 2, 3, 4, 4, 5, 4][i];
const sportFor = (g, week, idx) => (g.mix === 'run' ? 'run' : g.mix === 'alternate' ? ((idx + week) % 2 === 0 ? 'run' : 'bike') : 'bike');
function runMinutes(i, long, g, deload) {
  const maxMin = Math.min(g.hoursPerDay * 60, 240) | 0;
  let m = long && i === 1 ? (g.hoursPerDay >= 1.25 ? 75 : 60) : [25, 45, 45, 45, 45, 40, 45][i];
  if (deload) m = Math.trunc(m * 0.75);
  m += Math.round((g.progression || 0) * 100) * (i === 1 ? 1 : 0);
  return Math.max(20, Math.min(maxMin, m));
}

export function sessions(g, week) {
  const ws = addDays(startOfWeek(g.startDate), week * 7);
  const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i)).filter(k => g.weekdays.includes(weekday(k)) && k >= g.startDate && k <= g.targetDate);
  if (!days.length) return [];
  const ph = phase(g, week), deload = isDeload(g, week);
  const maxMin = Math.min(g.hoursPerDay * 60, 240) | 0, p = g.progression || 0;
  const { recovery: R, endurance: E, tempo: T, sweetSpot: S, threshold: H, vo2: V } = I;
  let pattern;
  if (g.kind === 'fitness') pattern = [E, T, E, R, E];
  else if (g.kind === 'race') pattern = ph === 'Base' ? [E, T, E, R, E] : ph === 'Costruzione' ? [S, E, H, R, E] : ph === 'Specifico' ? [H, E, V, R, E] : [T, R, E, R, R];
  else pattern = ph === 'Base' ? [T, E, S, R, E] : ph === 'Forza e soglia' ? [S, E, H, R, E] : [V, E, H, R, E];
  if (deload) pattern = pattern.map(x => (x >= T ? E : x));
  let longIdx = -1;
  days.forEach((k, i) => { if ([1, 7].includes(weekday(k))) longIdx = i; });
  if (longIdx < 0) longIdx = days.length - 1;
  return days.map((k, i) => {
    let intensity = pattern[Math.min(i, pattern.length - 1)];
    const sport = sportFor(g, week, i);
    const long = i === longIdx && days.length >= 3;
    let minutes;
    if (long && intensity !== R) { intensity = E; minutes = Math.min(maxMin, g.hoursPerDay >= 2 ? (g.hoursPerDay * 60) | 0 : 75); }
    else minutes = Math.min(maxMin, [30, 60, 55, 55, 55, 50, 35][intensity]);
    if (deload) minutes = Math.trunc(minutes * 0.7);
    minutes = Math.min(maxMin, Math.max(20, minutes + Math.trunc(p * 100) * (intensity === E ? 2 : 1)));
    const peak = basePeak(intensity) + (intensity >= T ? p : p / 2);
    if (sport === 'run') minutes = runMinutes(intensity, long, g, deload);
    return {
      key: k, intensity, minutes, peak: Math.round(Math.min(peak, basePeak(intensity) + 0.08) * 100) / 100,
      title: sport === 'run' ? runTitle(intensity, minutes) : bikeTitle(intensity, minutes),
      purpose: sport === 'run' ? runPurpose(intensity) : bikePurpose(intensity),
      week, phase: deload ? `${ph} · scarico` : ph, sport,
    };
  });
}
export const sessionDetail = s => (s.sport === 'run' ? `a tempo · ${s.phase}` : `fino al ${Math.round(s.peak * 100)}% · ${s.phase}`);

/** Seduta prevista per un giorno (tiene conto di sedute spostate, saltate e in più). */
export function session(g, k) {
  const week = weekOf(g, k);
  const x = (g.extras || {})[k];
  if (x) return { key: k, intensity: x.intensity, minutes: x.minutes, peak: x.peak, title: x.recorded ? `Uscita di tua iniziativa ${x.minutes}'` : bikeTitle(x.intensity, x.minutes), purpose: x.why, week, phase: EXTRA_PHASE, sport: 'bike', recorded: x.recorded };
  if ((g.skipped || []).includes(k)) return null;
  if (week < 0 || k > addDays(g.targetDate, 1)) return null;
  const from = Object.keys(g.moved || {}).find(f => g.moved[f] === k);
  if (from) {
    const s = session({ ...g, moved: {}, skipped: [] }, from);
    if (s) return { ...s, key: k, purpose: `${s.purpose} (spostata dal ${pretty(from)})` };
  }
  if ((g.moved || {})[k]) return null;
  if (k === g.targetDate && g.kind === 'race') return { key: k, intensity: I.threshold, minutes: 0, peak: 0, title: 'Giorno della gara', purpose: 'In bocca al lupo!', week, phase: 'Gara', sport: 'bike' };
  const s = sessions(g, week).find(x => x.key === k);
  if (!s || !(g.softened || []).includes(k)) return s || null;
  const i = s.intensity >= I.tempo ? I.endurance : s.intensity;
  const m = Math.max(s.sport === 'run' ? 25 : 30, Math.trunc(s.minutes * 0.8));
  return { ...s, intensity: i, minutes: m, peak: Math.min(s.peak, basePeak(i) + 0.04), title: s.sport === 'run' ? runTitle(i, m) : bikeTitle(i, m), purpose: (s.sport === 'run' ? runPurpose(i) : bikePurpose(i)) + " Alleggerita per l'allenamento in più." };
}
export const upcoming = (g, k) => Array.from({ length: 6 }, (_, i) => session(g, addDays(k, i + 1))).filter(s => s && s.phase !== EXTRA_PHASE && s.minutes > 0 && !(g.softened || []).includes(s.key));

// ---------- costruzione degli allenamenti ----------
const st = (min, p, cad = null) => ({ seconds: Math.round(min * 60), power: Math.round(p * 100) / 100, cadence: cad });
export function buildBike(t) {
  const total = t.minutes;
  switch (t.intensity) {
    case I.recovery: return [st(5, 0.45), st(total - 10, Math.min(t.peak, 0.55)), st(5, 0.45)];
    case I.endurance: { const main = Math.max(10, total - 13); return [st(3, 0.5), st(3, 0.55), st(2, 0.6), st(main / 2, t.peak - 0.02), st(main / 2, t.peak), st(3, 0.55), st(2, 0.5)]; }
    case I.vo2: {
      const reps = Math.max(3, Math.min(6, Math.trunc((total - 18) / 6)));
      const out = [st(4, 0.5), st(3, 0.6), st(3, 0.7), st(2, 0.55)];
      for (let i = 0; i < reps; i++) { out.push(st(3, t.peak, 95)); if (i < reps - 1) out.push(st(3, 0.5)); }
      const left = Math.max(5, total - (12 + reps * 6 - 3));
      return [...out, st(left * 0.6, 0.55), st(left * 0.4, 0.45)];
    }
    case I.test: return lib('W10').steps;
    default: {
      const avail = Math.max(14, total - 16), rest = t.intensity === I.sweetSpot ? 4 : 5;
      let reps = 2, len = Math.max(6, Math.floor((avail - rest) / 2));
      for (const r of [4, 3, 2]) { const l = Math.floor((avail - (r - 1) * rest) / r); if (l >= 8) { reps = r; len = Math.min(l, t.intensity === I.tempo ? 15 : 12); break; } }
      const out = [st(4, 0.5), st(3, 0.58), st(3, 0.65)];
      for (let i = 0; i < reps; i++) { out.push(st(len, t.peak, 90)); if (i < reps - 1) out.push(st(rest, 0.55)); }
      const cd = Math.max(5, total - (10 + reps * len + (reps - 1) * rest));
      return [...out, st(cd * 0.6, 0.58), st(cd * 0.4, 0.5)];
    }
  }
}
export function runSteps(i, minutes) {
  const s = (min, p, main = false) => ({ seconds: Math.round(min * 60), power: p, cadence: main ? 1 : null });
  const m = Math.max(20, minutes);
  if (i === I.recovery) return [s(5, 0.48), s(m - 5, 0.52, true)];
  if (i === I.endurance) return [s(10, 0.55), s(m - 15, 0.66, true), s(5, 0.5)];
  const [on, off, p] = i === I.tempo ? [8, 3, 0.78] : i === I.vo2 ? [3, 2, 1.1] : [6, 2, 0.92];
  const reps = Math.max(2, Math.min(6, Math.trunc((m - 20 + off) / (on + off))));
  const out = [s(12, 0.62)];
  for (let r = 0; r < reps; r++) { out.push(s(on, p, true)); if (r < reps - 1) out.push(s(off, 0.5)); }
  out.push(s(Math.max(5, m - (12 + reps * on + (reps - 1) * off)), 0.5));
  return out;
}
export function runWorkout(i, minutes, ttl, why) {
  const steps = runSteps(i, minutes);
  const total = Math.trunc(steps.reduce((a, s) => a + s.seconds, 0) / 60);
  return { code: 'CORSA', name: ttl || runTitle(i, total), minutes: total, range: 'a tempo', intensity: i, goal: why || runPurpose(i), why: why || runPurpose(i), howTo: ["Avvia l'allenamento dall'orologio oppure segui i tempi qui sotto.", 'È tutto a tempo: ritmo a sensazione.'], steps, sport: 'run' };
}
export function adHoc(i, minutes, peak, why) {
  return planWorkout({ key: today(), intensity: i, minutes, peak: peak ?? basePeak(i), title: bikeTitle(i, minutes), purpose: why || bikePurpose(i), phase: '', sport: 'bike' });
}
export function planWorkout(s) {
  if (s.sport === 'run') return runWorkout(s.intensity, s.minutes, s.title, s.purpose);
  return { code: 'PIANO', name: s.title, minutes: s.minutes, range: `fino al ${Math.round(s.peak * 100)}%`, intensity: s.intensity, goal: s.purpose, why: s.purpose, howTo: [], steps: buildBike({ intensity: s.intensity, minutes: Math.max(20, s.minutes), peak: s.peak }), sport: 'bike' };
}

// ---------- allenamento in più ----------
export function addExtra(g, k, load, light, feeling) {
  const s0 = session(g, k);
  if (s0 && s0.minutes > 0) return s0.phase === EXTRA_PHASE ? `L'allenamento in più di oggi è già pronto: ${s0.title}.` : `Oggi hai già in programma ${s0.title}: fai quella.`;
  const maxMin = Math.min(g.hoursPerDay * 60, 240) | 0, feel = feeling ?? 7;
  let i, m, why;
  if (load.level === 2 || light === 'rosso' || feel <= 4) { i = I.recovery; m = 35; why = load.level === 2 ? `${load.summary}: pedali sì, ma solo per sciogliere le gambe.` : 'Il recupero è basso: giro facile per muoverti senza affaticarti.'; }
  else if (load.level === 1 || light === 'giallo' || feel <= 5) { i = I.endurance; m = 45; why = 'Fondo facile e corto: ti alleni senza togliere energie alle prossime sedute.'; }
  else if (feel >= 7 && light === 'verde') { i = g.kind === 'fitness' ? I.tempo : I.sweetSpot; m = 50; why = 'Sei recuperato: seduta di qualità, poi alleggerisco i prossimi giorni.'; }
  else { i = I.endurance; m = 60; why = 'Fondo aerobico: allenamento utile che non pesa sul resto della settimana.'; }
  m = Math.min(maxMin, m);
  const p = g.progression || 0, peak = basePeak(i) + (i >= I.tempo ? p : p / 2);
  const soft = [], next = upcoming(g, k);
  const hard = next.find(s => s.intensity >= I.tempo);
  if (hard) soft.push(hard.key);
  if (i >= I.tempo && next[0] && next[0].key === addDays(k, 1) && !soft.includes(next[0].key)) soft.push(next[0].key);
  if (!soft.length && i > I.recovery && next[0]) soft.push(next[0].key);
  g.softened = [...(g.softened || []), ...soft];
  g.extras = { ...(g.extras || {}), [k]: { intensity: i, minutes: m, peak: Math.round(peak * 100) / 100, why, softened: soft } };
  let reply = `Allenamento in più per oggi: ${bikeTitle(i, m)}, fino al ${Math.round(peak * 100)}% FTP. ${why}`;
  if (soft.length) reply += ' Per compensare alleggerisco: ' + soft.map(x => pretty(x, 'day').toLowerCase()).join(' e ') + '.';
  return reply;
}
export function removeExtra(g, k) {
  const x = (g.extras || {})[k];
  if (!x) return "Oggi non c'è un allenamento in più da togliere.";
  delete g.extras[k];
  g.softened = (g.softened || []).filter(s => !(x.softened || []).includes(s));
  return 'Tolto l\'allenamento in più di oggi: il resto della settimana torna come prima.';
}

/**
 * Uscite fatte di tua iniziativa nei giorni di riposo (ultimi 3 giorni): le registra come allenamento in più
 * e, se sono state impegnative, alleggerisce la prossima seduta dura (come registerUnplanned dell'app).
 */
export function registerUnplanned(g, activities, k = today()) {
  const notes = [];
  for (let back = 1; back <= 3; back++) {
    const d = addDays(k, -back);
    if (d < g.startDate || (g.extras || {})[d] || session(g, d)) continue;
    const did = activities.filter(a => a.key === d && (isRide(a) || a.minutes >= 45));
    if (!did.length) continue;
    const minutes = did.reduce((s, a) => s + a.minutes, 0), load = did.reduce((s, a) => s + loadOf(a), 0);
    const tes = did.map(a => a.trainingEffect).filter(x => x != null), te = tes.length ? Math.max(...tes) : 2.5;
    const i = te >= 3.8 ? I.threshold : te >= 3 ? I.tempo : te >= 2 ? I.endurance : I.recovery;
    const soft = [];
    if (load >= 100 || i >= I.tempo) { const hard = upcoming(g, addDays(k, -1)).find(s => s.intensity >= I.tempo); if (hard) soft.push(hard.key); }
    g.softened = [...(g.softened || []), ...soft];
    g.extras = { ...(g.extras || {}), [d]: { intensity: i, minutes, peak: 0, why: 'Fatto di tua iniziativa: registrato come allenamento in più.', softened: soft, recorded: true } };
    let n = `Registrato come allenamento in più: ${did.map(a => a.type).join(', ')} di ${pretty(d, 'day').toLowerCase()} (${minutes}').`;
    if (soft[0]) n += ` Alleggerisco la seduta di ${pretty(soft[0], 'day').toLowerCase()}.`;
    notes.push(n);
  }
  return notes.length ? notes.join(' ') : null;
}

/** Progressione automatica: guarda ieri e alza o abbassa la difficoltà (una volta al giorno). */
export function updateProgression(g, days, activities, checkIns, k = today()) {
  if (g.lastProgressionCheck === k) return null;
  g.lastProgressionCheck = k;
  const yk = addDays(k, -1), planned = session(g, yk);
  if (!planned || planned.minutes <= 0 || planned.phase === EXTRA_PHASE) return null;
  const did = activities.filter(a => a.key === yk && (planned.sport === 'run' ? isRun(a) : isRide(a)));
  const t = days.find(d => d.key === k), feel = checkIns[k]?.feeling;
  const good = (t?.readiness ?? 60) >= 60 && String(t?.hrvStatus || 'BALANCED').toUpperCase() !== 'LOW' && (feel ?? 7) >= 6;
  const doneMin = did.reduce((s, a) => s + a.minutes, 0);
  g.progression = g.progression || 0;
  if (!did.length) { g.progression = Math.max(-0.06, g.progression - 0.01); return 'Ieri la seduta prevista non risulta fatta: abbasso di poco la difficoltà.'; }
  if (doneMin >= planned.minutes * 0.9 && good) { g.progression = Math.min(0.08, g.progression + 0.01); return `Ieri hai completato ${planned.title} e oggi sei recuperato: alzo la difficoltà (+1%).`; }
  if (!good) { g.progression = Math.max(-0.06, g.progression - 0.02); return 'La seduta di ieri ti ha affaticato più del previsto: riduco la difficoltà (−2%).'; }
  return null;
}

// ---------- decisione del giorno ----------
export function practical(w) {
  if (!w) return ["Cammina 20–30 minuti all'aperto se ti va: aiuta il recupero.", 'Punta a 8 ore a letto stanotte, orari regolari.', 'Idratazione e un pasto con proteine e carboidrati.'];
  const out = [w.code === 'PIANO' ? 'Su MyWhoosh avvia l\'allenamento su misura con questi blocchi (watt qui sotto).' : `Su MyWhoosh seleziona il file "${w.code} ${w.name}".`, ...(w.howTo || []).slice(0, 2)];
  out.push(w.intensity <= I.endurance ? 'Pre-seduta: basta un pasto normale nelle 2–3 h prima.' : "Pre-seduta: 30 g di carboidrati 30' prima (es. una banana).");
  out.push("Dopo: fai il check-in di domani mattina, così il coach adatta i prossimi giorni.");
  return out;
}
export const runPractical = () => [
  "Sull'orologio: Allenamento → I miei allenamenti, se la corsa è già stata caricata dall'app iPhone. Altrimenti segui i tempi qui sopra.",
  "È tutto a tempo: il ritmo lo decidi a sensazione.",
  'Superficie morbida (sterrato, parco) quando puoi: meno impatto su ginocchia e tendini.',
];

const nm = w => (w.code === 'PIANO' || w.code === 'CORSA' ? w.name : w.code);
function decide(inp) {
  const reasons = [], warnings = [];
  const k = inp.date, planned = inp.plannedOverride || lib(inp.slot.code);
  if (inp.today) { if (inp.today.key !== k) warnings.push(`Gli ultimi dati sono del ${pretty(inp.today.key)}: non sono quelli di stamattina.`); }
  else warnings.push('Nessun dato di oggi: sincronizza la CIRQA con Garmin Connect e aggiorna.');
  if (inp.recovery.missing.length) warnings.push('Mancano: ' + inp.recovery.missing.join(', ') + '. La stima del recupero è meno precisa.');

  let light = inp.recovery.light;
  const garmin = inp.recovery.source === 'coach';   // il punteggio combinato ha già sonno, HRV e campanelli d'allarme
  let lightReason = garmin ? `Prontezza ${inp.recovery.recovery}` : inp.recovery.recovery != null ? `Recupero stimato ${inp.recovery.recovery}%` : 'Recupero non calcolabile';
  if (garmin) reasons.push(...(inp.recovery.flags || []));
  const recent = inp.history.filter(d => d.key <= k).slice(-3);
  const shortNights = recent.filter(d => d.sleepHours != null && d.sleepHours < 6).length;
  const hrvT = inp.today?.hrv, hrv28 = hrvBaseline(inp.history, k, 28);
  const hrvDown = hrvT != null && hrv28 != null && hrvT < hrv28 * 0.88;
  if (!garmin && shortNights >= 2 && light === 'verde') { light = 'giallo'; lightReason += ', ma 2 delle ultime 3 notti sotto le 6 h'; }
  if (!garmin && hrvDown && light === 'verde') { light = 'giallo'; lightReason += ', ma HRV sotto la tua media di 4 settimane'; }
  if (!garmin && light === 'rosso' && !hrvDown && shortNights === 0) { light = 'giallo'; lightReason += ', ma HRV e sonno recenti nella norma: un solo indicatore non basta'; }

  const yest = addDays(k, -1);
  const longRideY = inp.activities.some(a => a.key === yest && isRide(a) && a.minutes > 120);
  const weekendLong = inp.activities.some(a => (a.key === yest || a.key === addDays(k, -2)) && isRide(a) && a.minutes >= 110);
  const c = inp.checkIn;

  const finish = (w, change, provisional = false, stop = null) => ({
    workout: w, headline: w ? `Oggi fai ${title(w)}, ${w.minutes} minuti.` : 'Oggi riposo: nessun workout da avviare.',
    light, lightReason, reasons, change, practical: practical(w), dataWarnings: warnings, provisional, stopWarning: stop,
  });

  if (c) {
    if (c.symptoms) { reasons.push('Hai segnalato malessere: con sintomi non si prescrivono allenamenti.'); light = 'rosso'; return finish(null, 'Piano sospeso per oggi.', false, 'Se i sintomi sono importanti o persistono, senti il medico.'); }
    if (c.knee === 'worse') { reasons.push('Ginocchio peggiorato: solo recupero attivo senza dolore oppure riposo.'); return finish(c.feeling >= 5 ? lib('W01') : null, 'Sostituito per il ginocchio.', false, 'Interrompi al primo fastidio e fai valutare il ginocchio da un professionista sanitario.'); }
    if (c.noWill) { reasons.push('Oggi non hai voglia: si salta senza recuperare con sedute doppie.'); return finish(null, 'Seduta saltata, il piano prosegue normalmente.'); }
  }
  if (!planned || !['session', 'optional'].includes(inp.slot.kind)) {
    if (inp.slot.kind === 'outdoor') {
      reasons.push("Weekend: se riesci, gravel all'aperto in zona 1–2 (FC sotto 128 bpm), 1,5–3 h.");
      if (light === 'rosso') reasons.push('Recupero basso: se esci, tienila corta e facile.');
    } else reasons.push("Da programma oggi non ci sono allenamenti: il recupero fa parte dell'allenamento.");
    return finish(null, 'Come da programma.');
  }
  let w = planned, change = null;
  const stepDown = why => {
    const l = lib(w.lighter || (w.intensity >= I.tempo ? 'W02' : w.intensity === I.endurance ? 'W01' : null));
    if (l) { change = `Sostituito ${nm(w)} con ${l.code}: ${why}.`; w = l; }
  };
  if (inp.slot.kind === 'optional') {
    if (light !== 'verde') { reasons.push('La 4ª seduta è facoltativa e oggi il recupero non la giustifica.'); return finish(null, 'Seduta facoltativa non fatta.'); }
    reasons.push('4ª seduta facoltativa: falla solo se ti va.');
  }
  if (w.code === 'W10') {
    const ok = light === 'verde' && (c?.knee || 'none') === 'none' && (c?.feeling ?? 0) >= 7 && !weekendLong;
    if (!ok) { reasons.push('Il test FTP va fatto solo da fresco, semaforo verde e ginocchio senza dolore.'); return finish(lib('W02'), 'Test W10 rimandato: oggi W02, riprova mercoledì o lunedì prossimo.', !c); }
  }
  const load = recentLoad(inp.activities, k);
  if (load.level === 2) {
    reasons.push(`${load.summary}: oggi serve recuperare, così assorbi il lavoro fatto.`);
    if (light !== 'verde' || (c?.feeling ?? 7) <= 5) return finish(null, "Riposo dopo lo sforzo di ieri: al massimo una passeggiata.");
    if (w.intensity > I.recovery) { change = "Sostituito con recupero attivo: dopo lo sforzo di ieri niente fondo né intensità."; w = adHoc(I.recovery, 35); }
  } else if (load.level === 1) {
    reasons.push(`${load.summary}: oggi più leggero e più corto.`);
    if (w.intensity >= I.tempo) stepDown('sforzo dei giorni scorsi');
    if (w.minutes > 50 && w.intensity <= I.endurance) {
      const m = Math.max(40, Math.trunc(w.minutes * 0.75));
      change = (change ? change + ' ' : '') + `Accorciato a ${m}' per lo sforzo di ieri.`;
      w = adHoc(w.intensity, m);
    }
  } else if (longRideY || (weekendLong && weekday(k) === 2)) { reasons.push('Uscita lunga nelle ultime 48 h: oggi più leggero.'); stepDown('dopo uscita lunga'); }
  if (light === 'rosso') { reasons.push('Semaforo rosso: solo recupero.'); if (w.intensity > I.recovery) { change = `Sostituito ${nm(w)} con W01: semaforo rosso.`; w = lib('W01'); } }
  else if (light === 'giallo') { if (w.intensity >= I.tempo) { reasons.push('Semaforo giallo: niente intensità oggi.'); stepDown('semaforo giallo'); } else reasons.push(w.sport === 'run' ? 'Semaforo giallo: va bene la corsa facile, senza forzare.' : 'Semaforo giallo: va bene il fondo, ma resta in zona 2.'); }
  else if (light === 'verde') reasons.push('Semaforo verde: seduta come da programma.');
  else { reasons.push('Dati insufficienti: scelta prudente.'); if (w.intensity >= I.tempo) stepDown('dati insufficienti'); }
  if (c) {
    if (c.heavyLegs && w.intensity > I.recovery) {
      reasons.push('Gambe pesanti: il recupero dei sensori non le vede, contano le sensazioni.');
      if (w.intensity >= I.tempo) stepDown('gambe pesanti');
      if (w.intensity >= I.endurance && c.feeling <= 5) { change = 'Sostituito con W01: gambe pesanti e poca energia.'; w = lib('W01'); }
    }
    if (c.feeling <= 4 && w.intensity > I.recovery) { reasons.push(`Sensazione ${c.feeling}/10: oggi solo recupero.`); change = 'Sostituito con W01: sensazioni basse.'; w = lib('W01'); }
    if (c.knee === 'light' && w.intensity >= I.tempo) { reasons.push('Ginocchio un po\' sensibile: niente coppia alta.'); stepDown('ginocchio sensibile'); }
    if (c.lowTime && w.minutes > 35) {
      const short = w.intensity <= I.recovery ? lib('W01') : lib('W09');
      reasons.push('Poco tempo: versione corta.'); change = `Sostituito ${nm(w)} con ${short.code}: poco tempo.`; w = short;
    }
  }
  if (!change) change = `Confermato il workout previsto (${nm(planned)}).`;
  if (!c) reasons.push('Scelta provvisoria: fai il check-in (sensazioni, gambe, ginocchio, tempo) per confermarla.');
  return finish(w, change, !c);
}

/** Decisione completa del giorno, con il piano attivo se c'è. */
export function decision(data, user, k = today()) {
  const days = data.days;
  const t = days.find(d => d.key === k) || days[days.length - 1] || null;
  const rec = t ? recovery(t, days) : { recovery: null, light: 'nd', sleepPerformance: null, components: [], missing: ['tutti i dati'] };
  let slot = baseSlot(k, user.blockStart || startOfWeek(today())), override = null, ses = null;
  if (user.goal) {
    ses = session(user.goal, k);
    if (ses && ses.minutes > 0) { override = planWorkout(ses); slot = { kind: 'session', code: 'PIANO', weekName: ses.phase }; }
    else slot = { kind: 'rest' };
  }
  const checkIn = user.checkIns[k] || null;
  const d = decide({ date: k, slot, today: t, history: days, activities: data.activities, checkIn, recovery: rec, plannedOverride: override });
  d.recovery = rec; d.session = ses;
  d.baseWorkout = !user.goal && ['session', 'optional'].includes(slot.kind) ? lib(slot.code) : null;
  if (override?.sport === 'run' && d.workout) adaptRun(d, override, d.workout, checkIn);
  return d;
}
function adaptRun(d, planned, w, c) {
  if (c?.knee === 'light') {
    const bike = adHoc(Math.min(w.intensity, I.endurance), Math.max(30, planned.minutes));
    Object.assign(d, { workout: bike, headline: `Oggi fai ${title(bike)}, ${bike.minutes} minuti sui rulli.`, change: "Corsa sostituita con i rulli: con il ginocchio sensibile l'impatto della corsa è da evitare.", practical: practical(bike) });
    return;
  }
  let run;
  if (w.code === 'CORSA') run = w;
  else {
    const i = Math.min(w.intensity, planned.intensity);
    const m = i < planned.intensity ? Math.min(planned.minutes, i === I.recovery ? 25 : 40) : planned.minutes;
    run = runWorkout(i, m);
    if (i < planned.intensity) d.change = `Corsa alleggerita: ${run.name} invece di ${planned.name}.`;
    else d.change = null;
  }
  Object.assign(d, { workout: run, headline: `Oggi fai ${run.name}: ${run.minutes} minuti di corsa.`, practical: runPractical() });
}

/** Adatta i watt e la durata ai dati di stanotte (come WorkoutPlanner.suggest dell'app). */
export function adjustToday(dec, t, checkIn) {
  const base = dec.workout;
  if (!base || base.sport === 'run') return null;
  const why = [];
  const tg = { intensity: base.intensity, minutes: base.minutes, peak: Math.max(...base.steps.map(s => s.power)) || 0.65 };
  const rec = dec.recovery?.recovery ?? 50, sleepH = t?.sleepHours ?? 7, ready = t?.readiness ?? 50, score = t?.sleepScore ?? 70;
  const hrvLow = String(t?.hrvStatus || '').toUpperCase() === 'LOW' || (t?.hrvLow != null && (t.hrv ?? t.hrvLow) < t.hrvLow);
  const capI = [0.55, 0.72, 0.82, 0.9, 1.02, 1.2, 1.6][tg.intensity];
  if (tg.intensity !== I.test && tg.intensity !== I.recovery) {
    if (rec >= 75 && ready >= 70 && sleepH >= 7 && score >= 75 && !hrvLow) {
      tg.peak = Math.min(tg.peak + 0.02, capI); tg.minutes = Math.min(60, tg.minutes + 5);
      why.push(`Recupero ${rec}%, readiness ${ready} e sonno ${hm(sleepH)}: oggi puoi spingere un filo di più (+2% e +5 minuti).`);
    } else if (rec < 50 || sleepH < 6.5 || score < 60 || hrvLow) {
      tg.peak = Math.max(tg.peak - 0.04, 0.55); tg.minutes = Math.max(30, Math.trunc(tg.minutes * 0.85));
      const r = [];
      if (rec < 50) r.push(`recupero ${rec}%`);
      if (sleepH < 6.5) r.push(`solo ${hm(sleepH)} di sonno`);
      if (score < 60) r.push(`punteggio sonno ${score}`);
      if (hrvLow) r.push('HRV sotto la tua fascia');
      why.push(`Con ${r.join(', ')} riduco intensità (−4%) e durata (−15%).`);
    } else return null;
  } else return null;
  if (checkIn?.lowTime) { tg.minutes = Math.min(tg.minutes, 35); why.push('Poco tempo: massimo 35 minuti.'); }
  if (checkIn?.knee === 'light') { tg.peak = Math.min(tg.peak, 0.85); why.push("Ginocchio sensibile: niente sopra l'85% e cadenza alta."); }
  tg.minutes = Math.min(60, tg.minutes);
  const steps = buildBike(tg);
  return { steps, minutes: Math.trunc(steps.reduce((a, s) => a + s.seconds, 0) / 60), peak: tg.peak, why };
}

// ---------- chat del piano ----------
export const CHAT_SUGGESTIONS = ['Voglio allenarmi lo stesso', 'Oggi non posso', 'Sposta a domani', 'Più facile', 'Più impegnativo', 'Ho solo 1 ora al giorno', 'Settimana di scarico', 'Cosa faccio oggi?', 'Alterna corsa e rulli', 'Solo corsa', 'Solo rulli', 'Gara il 15/03'];
export const DAY_WORDS = [['lun', 2], ['mar', 3], ['mer', 4], ['gio', 5], ['ven', 6], ['sab', 7], ['dom', 1]];
export const dayName = d => cap((DAY_WORDS.find(x => x[1] === d) || [''])[0]);
export const level = g => { const p = Math.round((g.progression || 0) * 100); return p === 0 ? 'standard' : p > 0 ? `+${p}%` : `${p}%`; };

export function chat(text, g, ctx, k = today()) {
  const t = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const ses = session(g, k);
  const mix = /altern/.test(t) || (t.includes('corsa') && t.includes('rulli')) ? 'alternate' : /solo (corsa|correre|di corsa)/.test(t) ? 'run' : /solo (rulli|bici)/.test(t) ? 'bike' : null;
  if (mix) { g.mix = mix; return `Fatto: ${MIX[mix].label.toLowerCase()}. ${MIX[mix].explanation}`; }
  if (t.includes('in piu') && /togli|annulla|cancella/.test(t)) return removeExtra(g, k);
  if (/allenarmi lo stesso|voglio allenarmi|in piu/.test(t)) return addExtra(g, k, ctx.load, ctx.light, ctx.feeling);
  if (t.includes('domani') && /sposta|rimanda/.test(t)) {
    if (!ses) return "Oggi non c'è una seduta da spostare.";
    g.moved = { ...(g.moved || {}), [k]: addDays(k, 1) };
    return `Fatto: la seduta di oggi passa a domani (${pretty(addDays(k, 1))}). Se domani ne avevi già una, faccio solo quella spostata.`;
  }
  if (/non posso|salta|niente oggi|riposo oggi/.test(t)) { g.skipped = [...new Set([...(g.skipped || []), k])]; return 'Ok, oggi riposo. Non recuperiamo raddoppiando: il piano riprende normalmente dalla prossima seduta.'; }
  if (/piu facile|piu leggero|troppo duro|stanco/.test(t)) { g.progression = Math.max(-0.06, (g.progression || 0) - 0.03); return `Ho ridotto la difficoltà del piano (−3% di intensità e un po' meno durata). Livello attuale: ${level(g)}.`; }
  if (/piu impegnativ|piu duro|piu difficile|troppo facile/.test(t)) { g.progression = Math.min(0.08, (g.progression || 0) + 0.03); return `Ho aumentato la difficoltà (+3% di intensità e qualche minuto in più). Livello attuale: ${level(g)}.`; }
  if (t.includes('scarico')) { const w = currentWeek(g, k); g.deloadWeeks = [...new Set([...(g.deloadWeeks || []), w])]; return 'Questa settimana diventa di scarico: niente intensità e durate ridotte del 30%.'; }
  let m = t.match(/(\d+(?:[.,]\d+)?)\s*(ore|ora|h|minuti|min)\b/);
  if (m) {
    const v = parseFloat(m[1].replace(',', '.')), h = m[2].startsWith('min') ? v / 60 : v;
    if (h >= 0.3 && h <= 6) { g.hoursPerDay = h; return `Aggiornato: ${f1(h)} ore al giorno. Le sedute ora durano al massimo ${Math.round(h * 60)} minuti.`; }
  }
  m = t.match(/(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?/);
  if (m) {
    let y = new Date().getFullYear(); if (m[3]) y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
    let d = key(new Date(y, +m[2] - 1, +m[1], 12));
    if (d < k) d = addDays(d, 365);
    g.targetDate = d; if (t.includes('gara')) g.kind = 'race';
    return `Nuova data obiettivo: ${pretty(d, 'year')}. Il piano ora è di ${goalWeeks(g)} settimane.`;
  }
  const words = t.split(/[^a-z]+/);
  const found = DAY_WORDS.filter(([w]) => words.some(x => x.startsWith(w) && x.length <= 9 && x !== 'marzo')).map(x => x[1]);
  if (found.length >= 2) { g.weekdays = found; return `Giorni di allenamento aggiornati: ${found.map(dayName).join(', ')}.`; }
  if (t.includes('gara')) { g.kind = 'race'; return 'Obiettivo cambiato in gara. Indica anche la data, per esempio: "gara il 15/03".'; }
  if (t.includes('potenz')) { g.kind = 'power'; return 'Obiettivo cambiato in potenziamento: più sweet spot, soglia e VO2max.'; }
  if (t.includes('forma')) { g.kind = 'fitness'; return 'Obiettivo cambiato in recupero della forma: soprattutto fondo aerobico.'; }
  if (/oggi|cosa faccio|perche/.test(t)) {
    if (!ses) return 'Oggi il piano prevede riposo.';
    return `Oggi: ${ses.title}${ses.sport === 'run' ? '' : `, fino al ${Math.round(ses.peak * 100)}% FTP`}. ${ses.purpose} Fase: ${ses.phase}. In Oggi trovi la versione adattata a come hai dormito.`;
  }
  return 'Posso aggiungere un allenamento in più ("voglio allenarmi lo stesso"), spostare o saltare una seduta, rendere il piano più facile o più impegnativo, cambiare ore al giorno ("ho 1,5 ore"), giorni ("lun mer ven sab"), data ("gara il 15/03") o aggiungere una settimana di scarico.';
}
