// Valutazione delle attività e consigli del giorno: come ActivityAssessment.swift e Insights.swift dell'app iPhone.
import * as C from './coach.js';

// ---------- valutazione di un'attività nella sua settimana ----------
export const BENEFIT = [['Nessuno stimolo', '#8e8e93'], ['Recupero', '#30b0c7'], ['Mantiene', '#2ecc71'], ['Migliora', '#007aff'], ['Migliora molto', '#ff9500'], ['Sovraccarico', '#ff3b30']];
export const VERDICT = { tooMuch: ['Troppo', '#ff3b30'], right: ['Giusto', '#2ecc71'], tooLittle: ['Troppo poco', '#ff9500'] };
const hrZone = hr => (hr < 109 ? 1 : hr < 128 ? 2 : hr < 147 ? 3 : hr < 164 ? 4 : 5);
const ZONE = ['', 'Z1 recupero', 'Z2 fondo', 'Z3 tempo', 'Z4 soglia', 'Z5 massimale'];
export function intensity(a, ftp) {
  if (a.avgPower && ftp > 0) { const f = a.avgPower / ftp; return f < 0.56 ? 0 : f < 0.76 ? 1 : f < 0.88 ? 2 : f < 0.95 ? 3 : f < 1.06 ? 4 : f < 1.2 ? 5 : 6; }
  if (!a.avgHR) return 1;
  return [0, 0, 1, 2, 3, 6][hrZone(a.avgHR)];
}
export function trainingEffect(a) {
  if (a.trainingEffect != null) return [a.trainingEffect, false];
  const z = a.avgHR ? hrZone(a.avgHR) : 2;
  return [Math.min(5, a.minutes / 60 * (0.6 + 0.45 * z)), true];
}
export function assess(a, { activities, days, ftp, blockStart }) {
  const [te, estimated] = trainingEffect(a);
  const benefit = te < 1 ? 0 : te < 2 ? 1 : te < 3 ? 2 : te < 4 ? 3 : te < 5 ? 4 : 5;
  const weekKeys = C.weekKeys(a.key), today = C.today(), finished = weekKeys[6] < today;
  const weekActs = activities.filter(x => weekKeys.includes(x.key));
  const rides = weekActs.filter(C.isRide), hard = rides.filter(x => intensity(x, ftp) >= 2);
  const rideMin = rides.reduce((s, x) => s + x.minutes, 0), footMin = weekActs.filter(x => !C.isRide(x)).reduce((s, x) => s + x.minutes, 0);
  const rideKm = rides.reduce((s, x) => s + (x.km || 0), 0);
  const slots = weekKeys.map(k => C.baseSlot(k, blockStart));
  const planned = slots.filter(s => s.kind === 'session').map(s => C.lib(s.code)).filter(Boolean);
  const plannedHard = planned.filter(w => w.intensity >= 2).length, plannedMin = planned.reduce((s, w) => s + w.minutes, 0) + 120;
  const soFar = slots.filter((s, i) => weekKeys[i] <= today && s.kind === 'session').length;
  const hm = m => `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
  const points = [
    `Uscite in bici: ${rides.length} su ${planned.length} sedute previste + gravel nel weekend${finished ? '' : ` (finora previste ${soFar})`}.`,
    `Tempo in bici: ${hm(rideMin)} su circa ${hm(plannedMin)} del programma · ${Math.round(rideKm)} km.`,
    `Sedute intense (tempo o più): ${hard.length}, previste ${plannedHard}.`,
  ];
  if (footMin > 0) points.push(`Camminate e altro: ${footMin} min, utili come recupero attivo.`);
  const hardKeys = new Set(hard.map(x => x.key));
  const b2b = [...hardKeys].some(k => hardKeys.has(C.addDays(k, 1)));
  if (b2b) points.push('Due giorni intensi consecutivi: il programma li evita per dare tempo al recupero.');
  let score = 0;
  if (rideMin > plannedMin * 1.3) score++;
  if (hard.length > plannedHard + 1 || b2b) score++;
  const expected = finished ? planned.length : soFar;
  if (rides.length < Math.max(1, expected - 1) && rideMin < plannedMin * (finished ? 0.6 : 0.3)) score--;
  const verdict = score > 0 ? 'tooMuch' : score < 0 ? 'tooLittle' : 'right';
  const summary = {
    right: finished ? 'Settimana andata bene: volume e intensità in linea con il programma.' : 'Finora la settimana procede bene rispetto al programma.',
    tooMuch: finished ? 'Settimana sopra il programma: più carico di quanto previsto per questa fase.' : 'Finora stai facendo più del previsto: nei prossimi giorni tieni le sedute facili.',
    tooLittle: finished ? 'Settimana sotto il programma: meno sedute o minuti di quelli previsti.' : 'Finora sei sotto il programma: recupera con le sedute previste, senza raddoppiare.',
  }[verdict];
  const after = [], before = days.find(d => d.key === a.key);
  for (const off of [1, 2]) {
    const k = C.addDays(a.key, off); if (k > today) break;
    const label = off === 1 ? 'Il giorno dopo' : 'Due giorni dopo', m = days.find(d => d.key === k);
    if (m) {
      const p = [];
      if (m.hrv != null) p.push(before?.hrv != null ? `HRV ${m.hrv} ms (${m.hrv - before.hrv >= 0 ? '+' : ''}${m.hrv - before.hrv})` : `HRV ${m.hrv} ms`);
      if (m.readiness != null) p.push(`readiness ${m.readiness}`);
      if (m.bbCharged != null) p.push(`Body Battery +${m.bbCharged} nella notte`);
      if (m.sleepScore != null) p.push(`sonno ${m.sleepScore}`);
      if (p.length) { const good = (m.readiness ?? 60) >= 50 && String(m.hrvStatus || 'BALANCED').toUpperCase() !== 'LOW'; after.push(`${label}: ${p.join(', ')} → ${good ? 'recuperato bene' : "ancora un po' di fatica"}.`); }
    }
    for (const n of activities.filter(x => x.key === k)) {
      const i = intensity(n, ftp);
      after.push(`${label} hai fatto ${n.type.toLowerCase()} ${n.minutes} min (${C.INT_LABEL[i].toLowerCase()})${te >= 3 && i >= 2 && off === 1 ? ': troppo ravvicinato a questa seduta.' : '.'}`);
    }
  }
  if (!after.length) after.push(a.key === today ? 'Il commento si aggiorna domattina con il sonno e il recupero della notte.' : 'Nessun dato Garmin per i giorni successivi.');
  let c = `${a.type} di ${a.minutes} minuti${a.km ? ` (${C.f1(a.km)} km)` : ''}${a.avgHR ? ` con FC media ${a.avgHR} bpm, soprattutto in ${ZONE[hrZone(a.avgHR)]}` : ''}. `;
  c += ['Stimolo leggero: conta come movimento e aiuta il recupero.', 'Ha favorito il recupero: circolazione e mobilità senza aggiungere fatica.', 'Ha mantenuto la base aerobica: utile per la costanza.',
    'Ha migliorato la forma aerobica: è il tipo di seduta che fa crescere la resistenza per il gravel.', 'Stimolo forte: ha spinto parecchio la forma, ma lascia fatica.', "Sforzo eccessivo per la fase attuale: rischia di togliere più di quanto dà."][benefit];
  if (a.avgPower && ftp) c += ` Potenza media ${a.avgPower} W (${Math.round(a.avgPower / ftp * 100)}% della FTP).`;
  if (C.isRide(a) && rides.length > 1) { const idx = [...rides].sort((x, y) => (x.startTime || 0) - (y.startTime || 0)).findIndex(x => x.id === a.id); if (idx >= 0) c += ` È stata l'uscita n. ${idx + 1} della settimana.`; }
  const recovery = te >= 4 ? "Recupero consigliato: 48 h prima di un'altra seduta intensa." : te >= 3 ? 'Recupero consigliato: 24 h, il giorno dopo solo fondo facile.' : 'Recupero rapido: puoi seguire il programma già dal giorno dopo.';
  const title = `Settimana ${C.pretty(weekKeys[0], 'dm')} – ${C.pretty(weekKeys[6], 'dm')}${finished ? '' : ' (in corso)'}`;
  return { benefit, te, estimated, verdict, title, summary, points, after, comment: c, recovery };
}

// ---------- consigli del giorno ----------
const dur = h => { const m = Math.round(h * 60); if (m < 60) return `${m} minuti`; const H = Math.floor(m / 60), r = m % 60; return `${H === 1 ? '1 ora' : `${H} ore`}${r ? ` e ${r} minuti` : ''}`; };
export function teMeaning(te) { return te < 1 ? 'nessun beneficio rilevante' : te < 2 ? 'beneficio minimo, utile per il recupero' : te < 3 ? 'mantiene la forma aerobica' : te < 4 ? 'migliora la forma aerobica' : te < 5 ? 'migliora molto la forma aerobica' : 'sovraccarico: serve recupero'; }
function feedbackIT(s) {
  const k = String(s).toUpperCase();
  if (/GOOD_SLEEP|WELL_RECOVERED/.test(k)) return 'ben recuperato'; if (/POOR_SLEEP|LOW_SLEEP/.test(k)) return 'sonno scarso';
  if (/HIGH_LOAD|RECOVERY/.test(k)) return 'recupero in corso'; if (/HRV/.test(k)) return 'HRV sotto la norma'; if (/STRESS/.test(k)) return 'stress elevato';
  if (/NAP/.test(k)) return 'sonnellino rigenerante';
  return String(s).replace(/_/g, ' ').toLowerCase();
}
export function insights(d, history, activities) {
  if (!d) return [];
  const prev = history.filter(x => x.key < d.key).slice(-7);
  const avg = f => { const xs = prev.map(f).filter(v => v != null); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };
  const out = [], I = (title, icon, color, value, tone, headline, detail, tip = null) => out.push({ title, icon, color, value, tone, headline, detail, tip });
  if (d.sleepHours != null) {
    const h = d.sleepHours, a = avg(x => x.sleepHours), need = d.sleepNeed || 8, diff = a != null ? h - a : null;
    let head = `Hai dormito ${C.hm(h)}`;
    if (diff != null && Math.abs(diff) >= 0.25) head += diff > 0 ? `, ${dur(diff)} più della tua media` : `, ${dur(-diff)} meno della tua media`;
    head += h >= need ? ': hai coperto il fabbisogno.' : `: ti mancano circa ${dur(need - h)} sul fabbisogno di ${need} ore.`;
    I('Sonno', 'bed', '#5856d6', C.hm(h) + (d.sleepScore != null ? ` · ${d.sleepScore}/100` : ''), h >= 7.5 ? 'good' : h >= 6.5 ? 'neutral' : 'watch', head,
      h >= 7.5 ? 'Una notte piena dà al corpo il tempo di completare tutti i cicli di sonno: è durante questi cicli che si consolidano gli adattamenti degli allenamenti.' : 'Con meno di 7 h di solito si accorciano soprattutto le ultime fasi REM del mattino: aumenta la fatica percepita e cala la lucidità.',
      h < 6.5 ? 'Oggi meglio fondo facile o recupero; stasera prova ad andare a letto 30–45 minuti prima.' : null);
  }
  if (d.deepMin != null && d.sleepHours > 0) {
    const pct = d.deepMin / (d.sleepHours * 60) * 100, a = avg(x => x.deepMin);
    I('Sonno profondo', 'moon', '#5856d6', `${d.deepMin} min`, pct >= 15 ? 'good' : pct >= 10 ? 'neutral' : 'watch',
      `${dur(d.deepMin / 60)} di sonno profondo (${Math.round(pct)}% della notte)${pct >= 15 ? ' hanno favorito la riparazione dei muscoli e la ricarica delle energie.' : ' sono pochi: il recupero fisico della notte è stato parziale.'}`,
      'Nel sonno profondo il corpo rilascia la maggior parte dell\'ormone della crescita: ripara le fibre muscolari, ricostituisce il glicogeno e sostiene il sistema immunitario. Di solito è il 13–23% della notte.' + (a != null ? ` La tua media recente è ${Math.round(a)} minuti.` : ''),
      pct < 12 ? "Gambe probabilmente meno fresche: evita l'intensità oggi. Il profondo si concentra a inizio notte, quindi conta l'ora in cui vai a letto." : null);
  }
  if (d.remMin != null && d.sleepHours > 0) {
    const pct = d.remMin / (d.sleepHours * 60) * 100;
    I('Sonno REM', 'sparkles', '#30b0c7', `${d.remMin} min`, pct >= 18 ? 'good' : pct >= 12 ? 'neutral' : 'watch',
      `${d.remMin} minuti di sonno REM (${Math.round(pct)}%)${pct >= 18 ? ' hanno aiutato memoria, coordinazione e umore.' : ' sono sotto il normale: puoi sentirti meno concentrato e più stanco di testa.'}`,
      "Il REM consolida l'apprendimento motorio, regola le emozioni e la percezione della fatica. Normalmente è il 20–25% della notte e si concentra nelle ultime ore: svegliarsi presto lo taglia.",
      pct < 12 ? 'Con poco REM lo stesso sforzo sembra più duro: valuta le sensazioni e non inseguire i watt.' : null);
  }
  if (d.awakeMin >= 30) I('Risvegli', 'time', '#ff9500', `${d.awakeMin} min`, 'watch', `Sei rimasto sveglio ${d.awakeMin} minuti durante la notte: il sonno è stato frammentato.`,
    'Ogni risveglio interrompe i cicli e riduce la qualità del recupero anche se le ore totali sembrano buone. Cause comuni: cena tardi o pesante, alcol, caldo in camera, stress.', 'Camera fresca (18–19 °C), niente alcol la sera, ultimo pasto 2–3 h prima di dormire.');
  if (d.hrv != null) {
    let tone = 'neutral', head = `HRV notturna ${d.hrv} ms`;
    const base = d.hrvWeekly ?? (avg(x => x.hrv) != null ? Math.round(avg(x => x.hrv)) : null);
    if (d.hrvLow != null && d.hrvHigh != null) {
      if (d.hrv < d.hrvLow) { tone = 'watch'; head += `, sotto la tua fascia normale (${d.hrvLow}–${d.hrvHigh}): il sistema nervoso è ancora sotto stress.`; }
      else if (d.hrv > d.hrvHigh) head += `, sopra la tua fascia (${d.hrvLow}–${d.hrvHigh}): spesso succede dopo un grosso sforzo o una notte di recupero profondo.`;
      else { tone = 'good'; head += `, dentro la tua fascia (${d.hrvLow}–${d.hrvHigh}): il sistema nervoso è in equilibrio.`; }
    } else if (base != null) { const df = d.hrv - base; tone = df >= -2 ? 'good' : df >= -5 ? 'neutral' : 'watch'; head += df >= -2 ? `, in linea con la tua media (${base} ms).` : `, ${-df} ms sotto la tua media (${base} ms): il corpo sta ancora smaltendo fatica o stress.`; }
    I('HRV', 'pulse', '#ff2d55', `${d.hrv} ms`, tone, head, "L'HRV misura quanto varia il tempo fra un battito e l'altro: più è alta rispetto alla TUA norma, più il sistema del recupero è attivo. Conta il trend di più giorni, non il singolo valore.",
      tone === 'watch' ? "Una sola notte bassa non annulla l'allenamento, ma tieni l'intensità sotto controllo e osserva domani." : null);
  }
  if (d.restingHR != null) {
    const a = avg(x => x.restingHR); let tone = 'neutral', head = `FC a riposo ${d.restingHR} bpm`;
    if (a != null) { const df = d.restingHR - a; if (df >= 4) { tone = 'watch'; head += `, ${Math.round(df)} battiti sopra la tua media: segnale di fatica, poco sonno, alcol o un malanno in arrivo.`; } else if (df <= -2) { tone = 'good'; head += ', sotto la tua media: buon segno di recupero.'; } else { tone = 'good'; head += ', nella tua media: nessun segnale di affaticamento.'; } }
    I('FC a riposo', 'heart', '#ff3b30', `${d.restingHR} bpm`, tone, head, "Con l'allenamento aerobico costante la FC a riposo tende a scendere nei mesi. Un rialzo di 5+ bpm per 2–3 giorni è il segnale più affidabile di fatica accumulata.", tone === 'watch' ? 'Se è alta anche domani, fai solo recupero.' : null);
  }
  const ch = d.bbCharged ?? d.bbHigh;
  if (ch != null) I('Body Battery', 'battery-half', '#007aff', d.bodyBatteryNow != null ? `${d.bodyBatteryNow}` : `+${ch}`, ch >= 50 ? 'good' : ch >= 30 ? 'neutral' : 'watch',
    `${d.bbCharged != null ? `Stanotte la Body Battery si è ricaricata di ${ch} punti` : `Body Battery massima ${ch}`}${ch >= 50 ? ': un buon recupero di energia.' : ': ricarica bassa, sei partito con il serbatoio mezzo vuoto.'}${d.bodyBatteryNow != null ? ` Ora è a ${d.bodyBatteryNow}.` : ''}`,
    'È la stima Garmin della tua energia: si ricarica con sonno e rilassamento e si consuma con attività, stress e digestione. Se la ricarica notturna resta sotto 40 per più giorni, il recupero non tiene il passo.',
    (d.bodyBatteryNow ?? 100) < 30 ? 'Riserva bassa: oggi niente intensità, va bene una seduta breve e facile.' : null);
  if (d.readiness != null) { const r = d.readiness; I('Training Readiness', 'fitness', '#ff9500', `${r}/100`, r >= 60 ? 'good' : r >= 40 ? 'neutral' : 'watch',
    `Garmin ti dà ${r}/100${d.readinessFeedback ? ` (${feedbackIT(d.readinessFeedback)})` : ''}: ${r >= 75 ? 'sei pronto a una seduta impegnativa.' : r >= 50 ? 'puoi allenarti normalmente.' : r >= 25 ? 'meglio una seduta facile.' : 'giornata da recupero.'}`,
    'Combina sonno, recupero dall\'ultimo allenamento, HRV, carico acuto e stress. È una stima Garmin: usala insieme alle tue sensazioni.'); }
  if (d.stressAvg != null) { const s = d.stressAvg; I('Stress', 'pulse', '#30b0c7', `${s}`, s <= 50 ? 'good' : 'watch',
    `Stress medio ${s} (${s <= 25 ? 'riposo' : s <= 50 ? 'basso' : s <= 75 ? 'medio' : 'alto'}): ${s <= 50 ? 'il sistema nervoso non è sotto pressione.' : 'il corpo ha speso energia per stress fisico o mentale.'}`,
    'Garmin stima lo stress dall\'HRV durante il giorno (0–100). Lo stress quotidiano pesa sul recupero quanto l\'allenamento.', s > 50 ? '5 minuti di respirazione lenta (4 s inspiro, 6 s espiro) prima della seduta aiutano.' : null); }
  const ra = avg(x => x.respiration);
  if (d.respiration != null && ra != null && d.respiration - ra >= 1) I('Respirazione', 'pulse', '#34c759', C.f1(d.respiration), 'watch',
    `Frequenza respiratoria ${C.f1(d.respiration)} atti/min, più alta della tua media (${C.f1(ra)}).`, 'Di notte è molto stabile: un aumento di 1+ atto al minuto spesso precede un raffreddore o segnala fatica e caldo.', 'Se hai anche FC a riposo alta o sintomi, oggi riposo.');
  const last = activities[0];
  if (last?.trainingEffect != null) I('Ultima attività', C.isRide(last) ? 'bicycle' : 'walk', '#34c759', `TE ${C.f1(last.trainingEffect)}`, last.trainingEffect >= 4 ? 'watch' : 'good',
    `${last.type} del ${C.pretty(last.key)}: effetto aerobico ${C.f1(last.trainingEffect)}, ${teMeaning(last.trainingEffect)}.`, 'Il Training Effect (0–5) stima quanto la seduta ha stimolato la tua forma aerobica. 2–2,9 mantiene, 3–3,9 migliora, 4+ migliora molto ma richiede 48 h di recupero.',
    last.trainingEffect >= 4 ? 'Seduta molto allenante: oggi niente intensità.' : null);
  return out;
}
export function insightSummary(list) {
  if (!list.length) return null;
  const good = list.filter(x => x.tone === 'good').map(x => x.title), watch = list.filter(x => x.tone === 'watch').map(x => x.title);
  if (!watch.length) return `Tutti i segnali sono positivi: ${good.slice(0, 3).join(', ')} nella norma o meglio.`;
  if (!good.length) return `Diversi segnali chiedono prudenza: ${watch.join(', ')}.`;
  return `Bene ${good.slice(0, 3).join(', ')}; da tenere d'occhio ${watch.join(', ')}.`;
}
