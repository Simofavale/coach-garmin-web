// Dieta: stesse regole della scheda Dieta dell'app iPhone (Shared/Dieta/DietPlan.swift e DietStore.swift).
// Le spunte restano su questo dispositivo; ogni lunedì ripartono da zero.
import { today, startOfWeek, daysBetween } from './coach.js';

export const CATS = {
  carbo: { title: 'Carboidrati', short: 'Carbo', color: '#f29e21', icon: 'fast-food' },
  proteine: { title: 'Proteine', short: 'Proteine', color: '#e64d59', icon: 'fish' },
  verdura: { title: 'Verdura', short: 'Verdura', color: '#40b366', icon: 'leaf' },
  colazione: { title: 'Colazione', short: 'Colazione', color: '#5980f2', icon: 'cafe' },
};
export const MEAL_CATS = ['carbo', 'proteine', 'verdura'];
export const MEALS_PER_WEEK = 14, FREE_ID = 'pasto_libero', FREE_ALLOWED = 1, BREAKFAST_TARGET = 7;
/** Sgarri: si segnano come il pasto libero e tolgono punti alla riuscita della settimana. */
export const SGARRI = [{ id: 'sgarro_piccolo', name: 'Sgarro piccolo', points: 2, hint: 'un dolce, uno snack, un aperitivo' }, { id: 'sgarro_grande', name: 'Sgarro grande', points: 5, hint: 'una pizza in più, un\'abbuffata' }];
export const SPECIAL = new Set([FREE_ID, ...SGARRI.map(x => x.id)]);
/** Porzioni segnate oltre il programma della settimana (non contano per la riuscita). */
export const oltre = (s, i) => Math.max(0, (s.eaten[i.id] || 0) - i.weeklyTarget);
export const raw = (s, i) => s.eaten[i.id] || 0;
const F = (id, name, portion, weeklyTarget, category, extra = {}) => ({ id, name, portion, weeklyTarget, category, healthy: true, ...extra });
export const DEFAULT_ITEMS = [
  F('pane', 'Pane', '80 g', 7, 'carbo', { reducedPortion: '60 g' }),
  F('pasta', 'Pasta', '100 g', 2, 'carbo', { reducedPortion: '70 g' }),
  F('riso', 'Riso', '100 g', 2, 'carbo', { reducedPortion: '60 g' }),
  F('patate', 'Patate', '250 g', 2, 'carbo', { reducedPortion: '200 g' }),
  F('carne_bianca', 'Carne bianca', '150 g', 3, 'proteine', { reducedPortion: '120 g' }),
  F('carne_rossa', 'Carne rossa', '150 g', 1, 'proteine', { reducedPortion: '120 g' }),
  F('uova', 'Uova', '2 uova', 2, 'proteine'),
  F('pesce_fresco', 'Pesce fresco/surgelato', '200 g', 2, 'proteine', { reducedPortion: '200 g' }),
  F('pesce_scatola', 'Pesce in scatola/affumicato', '100/80 g', 1, 'proteine', { reducedPortion: '80 g' }),
  F('affettato', 'Affettato', '100 g', 1, 'proteine', { reducedPortion: '80 g' }),
  F('formaggio_stagionato', 'Formaggio stagionato', '70 g', 1, 'proteine', { reducedPortion: '70 g' }),
  F('formaggio_fresco', 'Formaggio fresco', '125 g', 1, 'proteine'),
  F('legumi', 'Legumi', '1 porzione', 1, 'proteine'),
  F('verdura', 'Verdura', '200 g', 13, 'verdura'),
  F('latte_biscotti_sani', 'Latte + biscotti sani', '', 7, 'colazione', { group: 'colazioni' }),
  F('latte_cereali', 'Latte + cereali', '', 7, 'colazione', { group: 'colazioni' }),
  F('yogurt', 'Yogurt', '1 vasetto', 7, 'colazione', { group: 'colazioni' }),
  F('yogurt_cereali', 'Yogurt + cereali', '', 7, 'colazione', { group: 'colazioni' }),
  F('latte_biscotti_non_sani', 'Latte + biscotti non sani', 'da evitare', 7, 'colazione', { group: 'colazioni', healthy: false }),
  F('bar', 'Bar', 'da evitare', 7, 'colazione', { group: 'colazioni', healthy: false }),
  F('frutta', 'Frutta', '1 porzione', 7, 'colazione'),
];

const KEY = 'coachgarmin:dieta';
export function load() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(KEY)); } catch { }
  const week = startOfWeek(today());
  if (!s || !s.weekStart) s = { weekStart: week, eaten: {}, doses: {} };
  if (s.weekStart < week) {
    // nuova settimana: azzera e conserva il risultato della precedente (7 giorni pieni)
    s = { weekStart: week, eaten: {}, doses: s.doses || {}, lastWeekPercent: score(s, 7).percent };
    save(s);
  }
  s.doses = s.doses || {};
  return s;
}
export function save(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { } }

export function items(s) {
  return DEFAULT_ITEMS.map(i => {
    const c = s?.doses?.[i.id];
    return c ? { ...i, portion: c.portion?.trim() || i.portion, reducedPortion: c.reducedPortion?.trim() || i.reducedPortion } : i;
  });
}
export const inCat = (s, cat) => items(s).filter(i => i.category === cat);
const group = s => items(s).filter(i => i.group === 'colazioni');
export const item = (s, id) => items(s).find(i => i.id === id);
export const eaten = (s, i) => Math.min(s.eaten[i.id] || 0, i.weeklyTarget);
const eatenGroup = s => group(s).reduce((a, i) => a + eaten(s, i), 0);
const eatenGroupHealthy = s => group(s).filter(i => i.healthy).reduce((a, i) => a + eaten(s, i), 0);
export const freeMeals = s => s.eaten[FREE_ID] || 0;

export function progress(s, cat) {
  if (cat === 'colazione') return { done: eatenGroup(s), total: BREAKFAST_TARGET };
  return { done: inCat(s, cat).reduce((a, i) => a + eaten(s, i), 0) + freeMeals(s), total: MEALS_PER_WEEK };
}
export function remaining(s, i) {
  const own = i.weeklyTarget - eaten(s, i);
  if (i.group) return Math.min(own, BREAKFAST_TARGET - eatenGroup(s));
  if (MEAL_CATS.includes(i.category)) return Math.max(0, Math.min(own, MEALS_PER_WEEK - progress(s, i.category).done));
  return own;
}
/** Dal secondo pasto libero della settimana le dosi passano a quelle ridotte. */
export function portion(s, i) {
  if (freeMeals(s) > FREE_ALLOWED && i.reducedPortion && i.reducedPortion !== i.portion) return { text: i.reducedPortion, reduced: true };
  return { text: i.portion, reduced: false };
}
export function eat(s, id, { force = false } = {}) {
  if (!SPECIAL.has(id)) { const i = item(s, id); if (!i || (!force && remaining(s, i) <= 0)) return; }
  s.eaten[id] = (s.eaten[id] || 0) + 1;
  s.lastEaten = id; s.lastEatenAt = Date.now();
  save(s);
}
export function undo(s, id) {
  if (!(s.eaten[id] > 0)) return;
  s.eaten[id]--;
  if (s.lastEaten === id) { s.lastEaten = null; s.lastEatenAt = null; }
  save(s);
}
export function resetWeek(s) { s.eaten = {}; s.lastEaten = null; save(s); }

/** Giorno della settimana (1 = lunedì … 7 = domenica). */
export const dayOfWeek = () => Math.min(7, daysBetween(startOfWeek(today()), today()) + 1);
const pct = (d, t) => (t > 0 ? Math.round(d / t * 100) : 100);
export function score(s, day = dayOfWeek()) {
  const free = freeMeals(s);
  const expected = Math.min(2 * day - Math.min(free, FREE_ALLOWED), MEALS_PER_WEEK - FREE_ALLOWED);
  const achievable = Math.max(0, expected - Math.max(0, free - FREE_ALLOWED));
  const mealsDone = MEAL_CATS.reduce((a, c) => a + Math.min(progress(s, c).done - free, achievable), 0);
  const breakfastDone = Math.min(eatenGroupHealthy(s), day);
  const fruitDone = Math.min(eaten(s, item(s, 'frutta')), day);
  const mealsTot = expected * MEAL_CATS.length;
  const sgarri = SGARRI.map(x => ({ ...x, n: s.eaten[x.id] || 0 })), malus = sgarri.reduce((a, x) => a + x.n * x.points, 0);
  return {
    sgarri, malus,
    day, mealsExpected: expected, mealsDone, breakfastDone, fruitDone, freeMeals: free, extraFree: Math.max(0, free - FREE_ALLOWED),
    mealsPercent: pct(mealsDone, mealsTot), breakfastPercent: pct(breakfastDone, day), fruitPercent: pct(fruitDone, day),
    percent: Math.max(0, pct(mealsDone + breakfastDone + fruitDone, mealsTot + 2 * day) - malus),
  };
}
/** A che pasto dovresti essere adesso (dalle 16 conta la cena). */
const GIORNI = ['lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato', 'domenica'];
export function expectedNow(cat) {
  const day = dayOfWeek(), name = GIORNI[day - 1];
  if (cat === 'colazione') return { label: name, number: day };
  const dinner = new Date().getHours() >= 16;
  return { label: `${name} ${dinner ? 'cena' : 'pranzo'}`, number: 2 * (day - 1) + (dinner ? 2 : 1) };
}
export const scoreColor = p => (p >= 80 ? '#34c759' : p >= 60 ? '#ff9500' : '#ff3b30');
