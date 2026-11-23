// Corsa del giorno con l'AI (Gemini, livello gratuito di Google AI Studio).
// Come AIRunPlanner.swift dell'app iPhone: scrivi come stai e con chi corri, l'AI costruisce la corsa a tempo
// partendo dalla seduta del piano (o del programma base) e dai dati di stanotte. Se Gemini non è collegato
// o non risponde, il coach costruisce la corsa dalle frasi tipiche (RunNotePlanner).
import * as C from './coach.js';

// se un modello è occupato (503) o al limite (429) si passa al successivo, tutti del livello gratuito
const MODELS = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-flash-lite-latest'];
const urlFor = m => `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;
export const SUGGESTIONS = ['Corro con mia moglie 45 minuti, alterniamo corsa e camminata', 'Ho mezz\'ora, gambe un po\' pesanti', 'Mi sento bene, ho un\'ora', 'Corsa facile 40 minuti da solo'];

const INSTRUCTIONS = `Sei il coach di corsa dentro l'app Coach Garmin. Programmi la corsa di oggi per un amatore che alterna corsa e rulli \
e che a volte corre con la moglie, più lenta di lui: in quel caso la seduta va costruita sul ritmo di lei \
(sforzo molto facile o facile, eventuali tratti di cammino) e, se lui ha margine, puoi proporre brevi allunghi o un tratto da solo prima o dopo. \
La corsa è misurata SOLO A TEMPO: niente distanze, niente ritmi al km, niente frequenza cardiaca. Per ogni tratto indica lo sforzo da 1 a 5 \
(1 = cammino o corsa lentissima, 2 = corsa facile da conversazione, 3 = ritmo medio, 4 = sostenuto, 5 = forte) e una nota breve a parole. \
Rispetta il tempo disponibile che indica. Sii prudente: con recupero basso, sintomi, gambe pesanti o dolore al ginocchio riduci intensità e durata; \
con dolore che peggiora proponi cammino o riposo. Rispondi in italiano, spiegazione breve (2–3 frasi) e concreta. \
La somma dei minuti dei tratti deve rispettare il tempo indicato; usa da 2 a 10 tratti. \
La richiesta scritta dall'utente ha la precedenza sul piano: se dice quanto tempo ha, con chi corre o come si sente, costruisci la corsa su quello. \
Esempio: "corro con mia moglie 40 minuti, lei va piano" → 5' cammino veloce (sforzo 1), 30' corsa lenta insieme (sforzo 2), 5' cammino (sforzo 1).`;

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING', description: "Titolo breve in italiano, per esempio 'Corsa facile con mia moglie 40''" },
    intensity: { type: 'STRING', enum: ['recovery', 'endurance', 'tempo', 'threshold', 'vo2'] },
    explanation: { type: 'STRING', description: 'Perché questa corsa oggi, in 2–3 frasi in italiano' },
    steps: {
      type: 'ARRAY', description: 'Tratti in ordine, dal riscaldamento al defaticamento (da 2 a 10)',
      items: {
        type: 'OBJECT',
        properties: {
          minutes: { type: 'INTEGER', description: 'Durata del tratto in minuti (1–90)' },
          zone: { type: 'INTEGER', description: 'Sforzo da 1 (cammino) a 5 (forte)' },
          kind: { type: 'STRING', enum: ['warmup', 'run', 'recovery', 'walk', 'cooldown'] },
          note: { type: 'STRING', description: 'Indicazione breve in italiano' },
        },
        required: ['minutes', 'zone', 'kind', 'note'],
      },
    },
  },
  required: ['title', 'intensity', 'explanation', 'steps'],
};

/** Contesto del giorno: seduta del piano (o del programma base), recupero, sonno, check-in, sforzi recenti. */
export function context(data, user, dec) {
  const k = C.today(), t = data.days.find(d => d.key === k), c = [];
  const planned = dec.session ? C.planWorkout(dec.session) : dec.baseWorkout;
  if (planned) c.push(`Seduta prevista ${user.goal ? 'dal piano' : 'dal programma base'} oggi: ${C.title(planned)}, ${planned.minutes} minuti, ${planned.sport === 'run' ? 'corsa' : 'rulli'} (${C.INT_LABEL[planned.intensity]}).`);
  else c.push('Oggi il piano prevede riposo: la corsa è fuori programma, tienila facile.');
  if (user.goal) c.push(`Obiettivo: ${C.GOAL_KIND[user.goal.kind].label}, fase ${C.phase(user.goal, C.currentWeek(user.goal))}.`);
  c.push(`Semaforo recupero: ${dec.light} – ${dec.lightReason}`);
  if (dec.recovery?.recovery != null) {
    const p = dec.recovery.parts || {};
    c.push(`Prontezza del coach: ${dec.recovery.recovery}/100 (notte ${p.notte ?? '-'}, tendenza HRV 7 giorni ${p.tendenza ?? '-'}, Training Readiness Garmin del mattino ${p.garmin ?? '-'}).`);
    for (const f of dec.recovery.flags || []) c.push('Attenzione: ' + f);
  }
  if (t) {
    if (t.sleepHours != null) c.push(`Sonno: ${C.hm(t.sleepHours)}${t.sleepScore != null ? `, punteggio ${t.sleepScore}` : ''}.`);
    if (t.readiness != null) c.push(`Training readiness Garmin: ${t.readiness}.`);
    if (t.hrvStatus) c.push(`Stato HRV: ${t.hrvStatus}.`);
    if (t.bodyBatteryNow != null) c.push(`Body Battery ora: ${t.bodyBatteryNow}.`);
  }
  const load = C.recentLoad(data.activities, k);
  if (load.summary) c.push(`Sforzi recenti: ${load.summary}.`);
  const ci = user.checkIns[k];
  if (ci) c.push(`Check-in: sensazioni ${ci.feeling}/10, gambe pesanti ${ci.heavyLegs ? 'sì' : 'no'}, ginocchio: ${{ none: 'nessun dolore', light: 'leggero', worse: 'peggiorato' }[ci.knee]}, sintomi ${ci.symptoms ? 'sì' : 'no'}.`);
  if (user.goal) c.push(`Tempo massimo abituale: ${Math.round(user.goal.hoursPerDay * 60)} minuti.`);
  return c.join('\n');
}
export const maxMinutes = user => Math.max(20, Math.round((user.goal?.hoursPerDay || 1.5) * 60));

/** Controlli sulla risposta: sforzi 1–5, durate sensate, totale entro il massimo. */
export function sanitize(r, max) {
  const kinds = ['warmup', 'run', 'recovery', 'walk', 'cooldown'];
  r.steps = (r.steps || []).filter(s => s.minutes >= 0.5).map(s => ({
    minutes: Math.min(90, Math.round(s.minutes)), zone: Math.min(5, Math.max(1, Math.round(s.zone || 2))),
    kind: kinds.includes(s.kind) ? s.kind : 'run', note: String(s.note || '').slice(0, 120),
  }));
  const tot = r.steps.reduce((a, s) => a + s.minutes, 0);
  if (tot > max && tot > 0) r.steps = r.steps.map(s => ({ ...s, minutes: Math.max(1, Math.round(s.minutes * max / tot)) }));
  if (!['recovery', 'endurance', 'tempo', 'threshold', 'vo2'].includes(r.intensity)) r.intensity = 'endurance';
  r.title = String(r.title || 'Corsa di oggi').slice(0, 60);
  return r;
}

export async function gemini(key, note, ctx, max) {
  const prompt = `RICHIESTA DI OGGI (la cosa più importante, rispettala): ${note}\n\nDurata massima: ${max} minuti.\nDati di contesto:\n${ctx}`;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: INSTRUCTIONS }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA, temperature: 0.4 },
  });
  let last = '';
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let r;
      try { r = await fetch(urlFor(model), { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body, signal: AbortSignal.timeout(45e3) }); }
      catch (e) { last = e.message; continue; }
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        const txt = j?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
        try { const out = sanitize(JSON.parse(txt), max); if (out.steps.length) { out.modelName = model; return out; } } catch { }
        last = 'risposta non valida'; continue;
      }
      const msg = j?.error?.message || `HTTP ${r.status}`;
      if (r.status === 400 && /api key/i.test(msg)) throw new Error('La chiave Gemini non è valida: ricontrollala in Account.');
      last = msg;
      if (r.status === 503 || r.status === 500) { await new Promise(x => setTimeout(x, 1500)); continue; }   // occupato: riprova, poi modello dopo
      break;   // 429 o altro: passa al modello successivo
    }
  }
  throw new Error('Gemini è molto occupato in questo momento (' + last.slice(0, 80) + ').');
}

// ---------- il coach sulle tue parole (senza AI) ----------
export function parse(note) {
  const t = note.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/’/g, "'");
  const has = ws => ws.some(w => t.includes(w));
  const p = { minutes: null };
  if (has(["mezz'ora", 'mezzora', 'mezza ora'])) p.minutes = 30;
  if (has(["un'ora", 'un ora', '1 ora'])) p.minutes = 60;
  if (has(['ora e mezza', 'ora e mezzo'])) p.minutes = 90;
  const m = t.match(/(\d+(?:[.,]\d+)?)\s*(minuti|minuto|min|ore|ora|h|')/);
  if (m) { const v = parseFloat(m[1].replace(',', '.')); p.minutes = Math.round(m[2].startsWith('or') || m[2] === 'h' ? v * 60 : v); }
  p.wife = has(['moglie', 'con lei', 'compagna', 'fidanzata', 'insieme']);
  p.walk = has(['cammin', 'passeggi', 'alterna', 'alternando', 'run walk', 'corsa e cammino']);
  p.tired = has(['stanc', 'pesant', 'dolor', 'male ', 'ginocch', 'affaticat', 'poco dormito', 'dormito male']);
  p.good = has(['bene', 'in forma', 'spingere', 'veloce', 'ripetute', 'carico', 'fresco']);
  p.recognized = p.minutes != null || p.wife || p.walk || p.tired || p.good;
  return p;
}
export function rulePlan(note, max, light) {
  const p = parse(note);
  if (!p.recognized) return null;
  const total = Math.min(Math.max(15, p.minutes ?? (p.wife ? 45 : 40)), Math.max(15, max));
  const steps = [], add = (minutes, kind, zone, n) => { if (minutes > 0) steps.push({ minutes, kind, zone, note: n }); };
  const tired = p.tired || light === 'rosso';
  let title, why, intensity = 'endurance';
  if (p.walk || (p.wife && tired)) {
    const [run, walk] = tired ? [2, 2] : p.good && !p.wife ? [4, 1] : [3, 2];
    const middle = total - 10, reps = Math.max(1, Math.trunc(middle / (run + walk))), extra = middle - reps * (run + walk);
    add(5, 'walk', 1, 'Cammino veloce per scaldarsi');
    for (let i = 0; i < reps; i++) { add(run, 'run', 2, p.wife ? 'Corsa lenta insieme' : 'Corsa lenta'); add(walk, 'walk', 1, 'Cammino'); }
    add(5 + extra, 'walk', 1, 'Cammino per finire');
    title = (p.wife ? 'Corsa e cammino con mia moglie ' : 'Corsa e cammino ') + `${total}'`;
    why = `${reps} volte ${run}' di corsa e ${walk}' di cammino, più 5' di cammino all'inizio e alla fine. Tutto a tempo.`;
    intensity = 'recovery';
  } else if (p.wife) {
    add(5, 'walk', 1, 'Cammino veloce insieme'); add(total - 10, 'run', 2, 'Corsa lenta al ritmo di lei'); add(5, 'walk', 1, 'Cammino per finire');
    title = `Corsa con mia moglie ${total}'`;
    why = 'Corsa continua al ritmo di tua moglie, con 5\' di cammino prima e dopo. Se lei ha bisogno di camminare, fermatevi pure.';
  } else if (tired) {
    add(5, 'walk', 1, 'Cammino'); add(total - 10, 'run', 1, 'Corsa lentissima, respiro tranquillo'); add(5, 'walk', 1, 'Cammino');
    title = `Corsa rigenerante ${total}'`; why = 'Oggi sei stanco o il recupero è basso: corsa lentissima e corta, solo per sciogliere le gambe.'; intensity = 'recovery';
  } else if (p.good && total >= 30) {
    const reps = Math.max(3, Math.min(6, Math.trunc((total - 15) / 6)));
    add(10, 'warmup', 2, 'Corsa facile');
    for (let i = 0; i < reps; i++) { add(4, 'run', 3, 'Ritmo sostenuto'); add(2, 'recovery', 1, 'Corsa lenta'); }
    add(Math.max(3, total - 10 - reps * 6), 'cooldown', 1, 'Corsa lenta per finire');
    title = `Corsa con variazioni ${total}'`; why = `Ti senti bene: ${reps} tratti da 4' a ritmo sostenuto con 2' lenti, dopo 10' facili.`; intensity = 'tempo';
  } else {
    add(5, 'warmup', 1, 'Corsa lenta'); add(total - 10, 'run', 2, 'Corsa facile'); add(5, 'walk', 1, 'Cammino');
    title = `Corsa facile ${total}'`; why = 'Corsa facile e continua, con inizio e fine tranquilli.';
  }
  if (light === 'rosso' && !p.tired) why += " Il recupero di oggi è basso: l'ho tenuta leggera.";
  return { title, intensity, explanation: why, steps };
}

/** La corsa AI nel formato degli allenamenti del coach. */
export function toWorkout(r) {
  const P = [0.5, 0.66, 0.78, 0.92, 1.1];
  const steps = r.steps.map(s => ({ seconds: Math.max(30, Math.round(s.minutes * 60)), power: s.kind === 'walk' ? 0.45 : P[s.zone - 1], cadence: s.kind === 'run' ? 1 : null, note: s.note, kind: s.kind }));
  const I = { recovery: 0, endurance: 1, tempo: 2, threshold: 4, vo2: 5 };
  return {
    code: 'CORSA', name: /^corsa/i.test(r.title) ? r.title : 'Corsa ' + r.title.toLowerCase(), minutes: Math.trunc(steps.reduce((a, s) => a + s.seconds, 0) / 60),
    range: 'a tempo', intensity: I[r.intensity] ?? 1, goal: r.explanation, why: r.explanation, howTo: [], steps, sport: 'run', ai: true,
  };
}
