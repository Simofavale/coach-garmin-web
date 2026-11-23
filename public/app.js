// Coach Garmin Web — interfaccia. Dati Garmin da api/garmin.json (cifrati sul sito pubblicato),
// sensazioni, piano e dieta salvati su questo dispositivo (localStorage).
import * as C from './coach.js';
import * as D from './dieta.js';
import { ic } from './icons.js';
import * as AI from './ai.js';
import * as MW from './mywhoosh.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { } },
};

// ---------- accesso riservato (link privato con la chiave, ?k=…), come Rassegna ----------
const KKEY = 'coachgarmin:key', KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const getKey = () => { const q = new URLSearchParams(location.search).get('k'); if (q && KEY_RE.test(q)) return q; try { return localStorage.getItem(KKEY) || ''; } catch { return ''; } };
const privateLink = () => location.origin + location.pathname + '?k=' + getKey();
(() => {
  const k = getKey(); if (!k) return;
  try { localStorage.setItem(KKEY, k); } catch { }
  const q = new URLSearchParams(location.search);
  if (q.get('k') !== k) { q.set('k', k); history.replaceState(null, '', location.pathname + '?' + q + location.hash); }
})();
class Locked extends Error { }
const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  if (!j || !j.enc) return j;
  const k = getKey(); if (!k) throw new Locked();
  try {
    const key = await crypto.subtle.importKey('raw', b64(k.replace(/-/g, '+').replace(/_/g, '/') + '='), 'AES-GCM', false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(j.iv) }, key, b64(j.data));
    const txt = j.gz === 0 ? new TextDecoder().decode(plain) : await new Response(new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    return JSON.parse(txt);
  } catch { throw new Locked(); }
}
function showLocked() {
  $('#tabbar').style.display = 'none'; $('#topbar').style.display = 'none';
  $('#view').innerHTML = `<div class="empty"><img class="logo" src="icona-192.png" alt="">
    <h3>Accesso riservato</h3><p>Questi sono i tuoi dati Garmin. Incolla qui il link privato: basta farlo una volta sola su questo dispositivo.</p>
    <form id="unlock" style="width:100%;display:flex;flex-direction:column;align-items:center;gap:10px">
      <input id="unlockIn" placeholder="Incolla il link privato" autocomplete="off" autocapitalize="off" spellcheck="false">
      <button class="btn" style="max-width:420px">Entra</button></form><p id="unlockMsg" class="tiny"></p></div>`;
  $('#unlock').addEventListener('submit', e => {
    e.preventDefault();
    const v = $('#unlockIn').value.trim();
    const k = (v.match(/[?#&]k=([A-Za-z0-9_-]{43})/) || v.match(/^([A-Za-z0-9_-]{43})$/) || [])[1];
    if (!k) { $('#unlockMsg').textContent = 'Link non valido: copia il link privato completo.'; return; }
    try { localStorage.setItem(KKEY, k); } catch { }
    location.href = location.pathname + '?k=' + k + '#/oggi';
  });
}

// ---------- stato ----------
const UKEY = 'coachgarmin:utente';
const U = Object.assign({ checkIns: {}, goal: null, chat: [], blockStart: C.startOfWeek(C.today()), ftpManual: null, aiRuns: {} }, store.get(UKEY, {}));
U.aiRuns = U.aiRuns || {};
const GKEY = 'coachgarmin:gemini';
const geminiKey = () => store.get(GKEY, '');
let MWLIST = null, MWSTATE = '';   // allenamenti salvati su MyWhoosh (letti all'apertura)
const saveU = () => store.set(UKEY, U);
let DATA = null, DIET = D.load(), weekOffset = 0, dietCat = 'carbo', loading = false;
const ftp = () => U.ftpManual || DATA?.ftp || 0;

function toast(t, ms = 3200) {
  const el = $('#toast'); el.textContent = t; el.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { el.hidden = true; }, ms);
}
const ago = ms => {
  const m = Math.round((Date.now() - ms) / 60e3);
  if (m < 1) return 'adesso'; if (m < 60) return `${m} min fa`;
  const h = Math.round(m / 60); if (h < 24) return h === 1 ? "un'ora fa" : `${h} ore fa`;
  return `${Math.round(h / 24)} giorni fa`;
};
const hhmm = ms => new Date(ms).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
const durata = m => (m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${m} min`);

// ---------- dati ----------
async function loadData({ quiet = false } = {}) {
  if (loading) return; loading = true; setSpin(true);
  try {
    const d = await getJSON('api/garmin.json?t=' + Date.now());   // evita la copia di 10 minuti di GitHub Pages
    const changed = !DATA || d.updated !== DATA.updated;
    DATA = d;
    if (U.goal) {
      const msg = C.updateProgression(U.goal, DATA.days, DATA.activities, U.checkIns);
      if (msg) { saveU(); toast(msg, 5000); }
    }
    if (changed || !quiet) route();
    if (MW.account(DATA) && !MWLIST) loadMyWhoosh();
  } catch (e) {
    if (e instanceof Locked) return showLocked();
    if (!DATA) $('#view').innerHTML = `<div class="empty">${ic('warning')}<h3>Dati non raggiungibili</h3><p>${esc(e.message)}. Controlla la connessione e riprova.</p><button class="btn" style="max-width:300px" data-act="reload">Riprova</button></div>`;
    else if (!quiet) toast('Non riesco ad aggiornare: uso gli ultimi dati scaricati.');
  } finally { loading = false; setSpin(false); }
}
function setSpin(on) { const b = $('#refreshBtn'); if (b) b.classList.toggle('spin', on); }
// ---------- aggiorna subito (come il ↻ di Rassegna) ----------
// Online il pulsante fa partire subito il workflow su GitHub con un'autorizzazione salvata su questo dispositivo
// (permesso solo "Actions" sul repository), poi aspetta i dati nuovi e ricarica da solo.
const GH_KEY = 'coachgarmin:gh';
const ghToken = () => store.get(GH_KEY, '');
const repoInfo = () => { const m = location.hostname.match(/^([^.]+)\.github\.io$/); const r = location.pathname.split('/').filter(Boolean)[0]; return m && r ? { owner: m[1], repo: r } : null; };
const ghTokenUrl = () => { const r = repoInfo(); return r ? `https://github.com/settings/personal-access-tokens/new?name=${encodeURIComponent('Coach Garmin')}&description=${encodeURIComponent('Pulsante aggiorna della web app Coach Garmin')}&target_name=${encodeURIComponent(r.owner)}&expires_in=none&actions=write` : '#'; };
let refreshing = null;
async function refreshNow() {
  const r = repoInfo();
  if (!r) {   // sul Mac (server locale): chiede subito i dati nuovi a Garmin
    setSpin(true);
    try { await fetch('api/refresh', { method: 'POST' }); } catch { }
    await loadData();
    if (DATA?.updated) toast('Dati Garmin di ' + ago(DATA.updated));
    return;
  }
  if (refreshing) return toast('Sto già aggiornando…');
  if (!ghToken()) return openGhSetup(() => refreshNow());
  const before = DATA?.updated || 0;
  try {
    const res = await fetch(`https://api.github.com/repos/${r.owner}/${r.repo}/actions/workflows/aggiorna.yml/dispatches`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + ghToken(), Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' }, body: JSON.stringify({ ref: 'main' }),
    });
    if (res.status === 401 || res.status === 403 || res.status === 404) { store.set(GH_KEY, ''); toast('Autorizzazione GitHub non valida: ricollegala', 5000); return openGhSetup(() => refreshNow()); }
    if (!res.ok) throw new Error('GitHub ha risposto ' + res.status);
  } catch (e) { return toast('Non riesco ad avviare l\'aggiornamento: ' + e.message, 5000); }
  // aspetta i dati nuovi (di solito 1–2 minuti) mostrando il tempo che passa
  const t0 = Date.now();
  refreshing = setInterval(async () => {
    const sec = Math.round((Date.now() - t0) / 1000);
    toast(`Aggiorno da Garmin… ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`, 12e3);
    setSpin(true);
    let v = null;
    try { v = await (await fetch('api/version.json?t=' + Date.now(), { cache: 'no-store' })).json(); } catch { }
    if (v && v.updated > before) {
      clearInterval(refreshing); refreshing = null;
      await loadData();
      toast('Dati Garmin aggiornati adesso');
    } else if (sec > 300) {
      clearInterval(refreshing); refreshing = null; setSpin(false);
      toast('Ci sta mettendo più del solito: i dati arriveranno da soli fra poco.', 5000);
    }
  }, 6000);
}
function openGhSetup(onDone) {
  const r = repoInfo();
  sheet('Aggiorna subito', `<section class="card"><div class="sub" style="display:flex;flex-direction:column;gap:8px">
    <p style="margin:0">Per aggiornare i dati Garmin sul momento la web app deve poter avviare l'aggiornamento su GitHub. Si fa <b>una volta sola</b> per dispositivo:</p>
    <p style="margin:0">1. Tocca il pulsante: si apre GitHub con il modulo già compilato.<br>2. In "Repository access" scegli <b>Only select repositories</b> → <b>${esc(r?.repo || '')}</b>; controlla che "Actions" sia <b>Read and write</b>, poi <b>Generate token</b>.<br>3. Copia il codice che inizia con <code>github_pat_</code> e incollalo qui.</p></div>
    <a class="btn soft" href="${ghTokenUrl()}" target="_blank" rel="noopener">Crea l'autorizzazione su GitHub</a>
    <input type="text" id="ghTok" placeholder="Incolla qui il codice github_pat_…" autocapitalize="off" autocorrect="off" spellcheck="false" style="border:1.5px solid var(--line);border-radius:12px;padding:12px;background:var(--bg)">
    <p id="ghMsg" class="tiny" style="margin:0"></p>
    <div class="tiny">Il codice resta solo su questo dispositivo e può soltanto avviare l'aggiornamento: non vede i tuoi dati. Senza, i dati si aggiornano comunque da soli ogni 15 minuti circa.</div></section>`,
  { right: 'Salva', left: 'Annulla' });
  sheet.ok = () => {
    const t = $('#ghTok').value.trim();
    if (!/^(github_pat_|ghp_)/.test(t)) { $('#ghMsg').textContent = 'Il codice deve iniziare con github_pat_'; return; }
    store.set(GH_KEY, t); closeSheet(); onDone && onDone();
  };
}
// controlla le novità quando riapri l'app e ogni 3 minuti mentre è aperta
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { DIET = D.load(); checkVersion(); } });
setInterval(() => { if (document.visibilityState === 'visible') checkVersion(); }, 180e3);
async function checkVersion() {
  try { const v = await (await fetch('api/version.json?t=' + Date.now(), { cache: 'no-store' })).json(); if (!DATA || v.updated > DATA.updated) loadData({ quiet: true }); } catch { }
}

/** Decisione del giorno: se hai programmato la corsa con l'AI vale lei, come nell'app iPhone. */
function dayDecision(k = C.today()) {
  const d = C.decision(DATA, U, k), ai = U.aiRuns[k];
  if (ai && !d.stopWarning) {
    const w = AI.toWorkout(ai);
    d.planned = d.workout;
    Object.assign(d, { workout: w, headline: `Oggi fai ${w.name}: ${w.minutes} minuti di corsa.`, change: `Corsa programmata ${ai.model === 'Gemini' ? 'da Gemini' : 'dal coach'} su quello che hai scritto: "${ai.note}".`, practical: C.runPractical(), provisional: false });
    d.reasons = [ai.explanation, ...d.reasons.filter(r => !/check-in/.test(r))];
  }
  return d;
}

// ---------- navigazione ----------
const TABS = [['oggi', 'Oggi', 'sunny'], ['piano', 'Piano', 'calendar'], ['dieta', 'Dieta', 'restaurant'], ['attivita', 'Attività', 'bicycle'], ['account', 'Account', 'person-circle']];
$('#tabbar').innerHTML = TABS.map(([id, label, icon]) => `<a href="#/${id}" data-tab="${id}">${ic(icon + '-outline', 'ti-off')}${ic(icon, 'ti-on')}<span>${label}</span></a>`).join('');
window.addEventListener('hashchange', route);
function route() {
  if (!DATA) return;
  const tab = (location.hash.match(/^#\/(\w+)/) || [])[1] || 'oggi';
  document.querySelectorAll('#tabbar a').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
  if (tab !== route.last) { route.last = tab; window.scrollTo(0, 0); }
  const views = { oggi: viewToday, piano: viewPlan, dieta: viewDiet, attivita: viewActivities, account: viewAccount };
  (views[tab] || viewToday)();
}
function setHead(title, actions = '') {
  $('#title').textContent = title;
  $('#topActions').innerHTML = actions;
}
const refreshBtn = `<button id="refreshBtn" class="icon-btn" data-act="refresh" aria-label="Aggiorna dati Garmin">${ic('refresh')}</button>`;

// ---------- componenti ----------
const card = (title, icon, body, extra = '') => `<section class="card" ${extra}>${title ? `<div class="card-title">${ic(icon)}${esc(title)}</div>` : ''}${body}</section>`;
const bullet = (t, icon = 'checkmark-circle', color = 'var(--accent)') => `<div class="bullet"><span style="color:${color}">${ic(icon)}</span><span>${esc(t)}</span></div>`;
const tile = (title, icon, color, val, unit, det, info) => `<div class="tile${info ? ' link' : ''}"${info ? ` data-act="info" data-id="${info}" role="button"` : ''}><div class="t-head"><span style="color:${color}">${ic(icon)}</span>${esc(title)}</div><div class="t-val">${val ?? '–'}${val != null && unit ? `<small>${unit}</small>` : ''}</div>${det ? `<div class="t-det">${esc(det)}</div>` : ''}</div>`;
function ring(value, color, size = 100, w = 11) {
  const r = (size - w) / 2, c = 2 * Math.PI * r, v = Math.max(0, Math.min(1, value || 0));
  return `<svg viewBox="0 0 ${size} ${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--fill)" stroke-width="${w}"/><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-dasharray="${c * v} ${c}"/></svg>`;
}
const zoneColor = p => (p < 0.56 ? '#30b0c7' : p < 0.76 ? '#34c759' : p < 0.88 ? '#ff9500' : p < 1.0 ? '#ff3b30' : p < 1.15 ? '#ff2d55' : '#5856d6');
function profile(steps) {
  const tot = steps.reduce((a, s) => a + s.seconds, 0) || 1, max = Math.max(1.2, ...steps.map(s => s.power));
  let x = 0;
  const bars = steps.map(s => { const w = s.seconds / tot * 300, h = s.power / max * 44; const r = `<rect x="${x.toFixed(2)}" y="${(46 - h).toFixed(2)}" width="${Math.max(0.6, w - 0.6).toFixed(2)}" height="${h.toFixed(2)}" rx="1.5" fill="${zoneColor(s.power)}"/>`; x += w; return r; }).join('');
  return `<svg class="profile" viewBox="0 0 300 46" preserveAspectRatio="none">${bars}</svg>`;
}
function stepsTable(w, steps) {
  const run = w.sport === 'run', f = ftp();
  // unisce i passi uguali consecutivi (es. riscaldamento a gradini resta, le ripetute si leggono una per una)
  let t = 0;
  return `<div class="steps">${steps.map(s => {
    const from = t; t += s.seconds;
    const mm = s.seconds % 60 ? `${Math.floor(s.seconds / 60)}'${String(s.seconds % 60).padStart(2, '0')}` : `${s.seconds / 60}'`;
    // corse misurate solo a tempo (scelta di Simone): niente zone cardio, solo come deve sembrare
    const p = s.power;
    const what = run && s.note ? `${esc(s.note)}${s.kind === 'walk' && !/cammin/i.test(s.note) ? ' · cammino' : ''}` : run ? (p < 0.56 ? 'molto facile, anche camminando' : p < 0.72 ? 'corsa facile, da conversazione' : p < 0.84 ? 'ritmo medio' : p < 0.98 ? 'ritmo sostenuto' : 'forte') :`${Math.round(s.power * 100)}% FTP${f ? ` · <b>${Math.round(s.power * f)} W</b>` : ''}${s.cadence && s.cadence > 1 ? ` · ${s.cadence} rpm` : ''}`;
    return `<div class="step"><span class="mono strong">${mm}</span><span><i class="dot" style="background:${zoneColor(s.power)}"></i>${what}</span><span class="tiny mono">${Math.floor(from / 60)}'</span></div>`;
  }).join('')}</div>`;
}

// ---------- OGGI ----------
function viewToday() {
  const k = C.today();
  setHead(C.pretty(k, 'long'), refreshBtn);
  if (!DATA.days.length) {
    $('#view').innerHTML = `<div class="empty">${ic('warning')}<h3>Garmin non ancora collegato</h3><p>${esc(DATA.error || 'Nessun dato Garmin.')}</p><p class="tiny">Sul Mac: doppio clic su "Collega Garmin.command" nella cartella Coach Garmin Web. Dopo 2–3 minuti qui compaiono i tuoi dati.</p></div>`;
    return;
  }
  const days = DATA.days, t = days.find(d => d.key === k) || days[days.length - 1];
  const dec = dayDecision(k), rec = dec.recovery, L = C.LIGHT[dec.light];
  const h = C.health(t, days), ci = U.checkIns[k];
  const adj = C.adjustToday(dec, t, ci);
  const out = [];
  out.push(DATA.error ? `<div class="syncbar warn">${ic('warning')}${esc(DATA.error)}</div>`
    : `<div class="syncbar">${ic('checkmark-circle')}Garmin aggiornato ${DATA.updated ? ago(DATA.updated) : '–'}${DATA.demo ? ' · <b>dati di prova</b>' : ''}</div>`);
  // essenziali Garmin
  const bbDet = t?.bbTime ? `dato CIRQA delle ${hhmm(t.bbTime)}` : t?.bbCharged != null ? `+${t.bbCharged} stanotte` : '';
  out.push(`<div class="grid2">
    ${tile('Body Battery', 'battery-half', '#30b0c7', t?.key === k ? t?.bodyBatteryNow : null, '', bbDet, 'bb')}
    ${tile('Sonno', 'moon', '#5856d6', t?.sleepScore, '/100', t?.sleepHours != null ? C.hm(t.sleepHours) : '', 'sonno')}
    ${tile('HRV notturna', 'pulse', '#ff2d55', t?.hrv, 'ms', t?.hrvLow != null ? `fascia ${t.hrvLow}–${t.hrvHigh}${t.hrvStatus ? ' · ' + hrvStatus(t.hrvStatus) : ''}` : '', 'hrv')}
    ${tile('Sonno ristoratore', 'bed', '#5856d6', t?.deepMin != null && t?.remMin != null ? C.hm((t.deepMin + t.remMin) / 60) : null, '', t?.deepMin != null ? `profondo ${t.deepMin}' · REM ${t.remMin}'` : '', 'ristoratore')}
    ${tile('FC a riposo', 'heart', '#ff3b30', t?.restingHR, 'bpm', t?.stressAvg != null ? `stress medio ${t.stressAvg}` : '', 'fc')}
    ${tile('Stato di salute', 'medkit', C.LIGHT[h.light].color, `<span style="font-size:18px">${esc(h.label)}</span>`, '', h.items.filter(i => !i.normal).map(i => i.name).join(', ') || h.items.map(i => i.name).join(' · '), 'salute')}
  </div>`);
  // sonnellini
  const naps = (t?.key === k ? t?.naps : null) || [];
  out.push(`<section class="card"><div class="row link" data-act="naps"><span style="color:var(--indigo)">${ic('bed')}</span><div class="grow"><div class="strong">${naps.length ? (naps.length === 1 ? '1 sonnellino oggi' : `${naps.length} sonnellini oggi`) : 'Nessun sonnellino oggi'}</div>
    <div class="sub mono">${naps.length ? naps.map(n => `${hhmm(n.start)}–${hhmm(n.end)} · ${durata(Math.round((n.end - n.start) / 60e3))}`).join('<br>') : 'Registrati dalla CIRQA: tocca per vedere gli ultimi giorni'}</div></div>${ic('chevron-forward', 'chev')}</div></section>`);
  // decisione
  const w = dec.workout;
  let hero = `<div class="hero-top"><div class="ring">${ring((rec.recovery || 0) / 100, L.color)}<div class="rv"><b>${rec.recovery ?? '–'}</b><span>${rec.source === 'coach' ? 'prontezza' : 'stima'}</span></div></div>
    <div style="flex:1;min-width:0"><span class="badge" style="background:${L.color}">${L.label}</span>${partsBars(rec)}</div></div>
    <div class="hr"></div><div class="headline">${esc(dec.headline)}</div>`;
  hero += `<button class="btn plain" style="min-height:28px;justify-content:flex-start;padding:0" data-act="prontezza">${ic('information-circle')}Come la calcolo</button>`;
  if (dec.provisional) hero += `<div class="prov">${ic('time')}Provvisorio: fai il check-in</div>`;
  if (w) hero += profile(adj ? adj.steps : w.steps);
  if (dec.change) hero += `<div class="strong" style="font-size:15px">${esc(dec.change)}</div>`;
  hero += dec.reasons.map(r => bullet(r, 'chevron-forward', L.color)).join('');
  if (dec.stopWarning) hero += `<div class="bullet stop">${ic('medkit')}<span>${esc(dec.stopWarning)}</span></div>`;
  if (!dec.stopWarning) {
    const isRun = w?.sport === 'run';
    hero += `<button class="btn ${isRun || U.aiRuns[k] ? '' : 'soft'}" data-act="runai">${ic('sparkles')}${U.aiRuns[k] ? 'Modifica la corsa con l\'AI' : isRun ? 'Adatta la corsa con l\'AI' : 'Oggi corro: programma con l\'AI'}</button>`;
    if (U.aiRuns[k]) hero += `<button class="btn plain" data-act="runai-del">Torna all'allenamento del ${U.goal ? 'piano' : 'programma base'}</button>`;
  }
  if (U.goal && !dec.stopWarning) {
    if (U.goal.extras?.[k] && !U.goal.extras[k].recorded) hero += `<div class="tiny strong" style="color:var(--accent-ink)">Allenamento in più: i prossimi giorni sono già ribilanciati</div><button class="btn danger" data-act="unextra">Annulla l'allenamento in più</button>`;
    else if (!w) hero += `<button class="btn soft" data-act="extra">${ic('add')}Voglio allenarmi lo stesso</button><div class="tiny">Creo una seduta su misura per come stai oggi e alleggerisco i prossimi giorni.</div>`;
  }
  out.push(`<section class="hero" style="--lc:${L.color}">${hero}</section>`);
  // allenamento nel dettaglio
  if (w) {
    const steps = adj ? adj.steps : w.steps, mins = adj ? adj.minutes : w.minutes;
    let body = `<div class="chips"><span class="chip" style="color:${C.INT_COLOR[w.intensity]}">${C.INT_LABEL[w.intensity]}</span><span class="chip">${mins} min</span>${w.sport === 'run' ? '<span class="chip">corsa a tempo</span>' : `<span class="chip">${esc(w.range)}</span><span class="chip">TSS ${C.tss(steps)}</span>${ftp() ? `<span class="chip">FTP ${ftp()} W</span>` : ''}`}</div>`;
    if (adj) body += `<div class="banner info"><b>Su misura per oggi:</b> ${esc(adj.why.join(' '))}</div>`;
    body += stepsTable(w, steps);
    if (w.why) body += `<div class="sub">${esc(w.why)}</div>`;
    out.push(card(w.sport === 'run' ? w.name : C.title(w), w.sport === 'run' ? 'walk' : 'bicycle', body));
    if (w.sport !== 'run') out.push(myWhooshCard(w, steps, adj));
  }
  out.push(`<button class="btn ${ci ? '' : 'orange'}" data-act="checkin">${ic('heart')}${ci ? `Sensazioni ${ci.feeling}/10 · modifica` : 'Check-in sensazioni'}</button>`);
  if (adj && w && w.code !== 'PIANO') dec.practical[0] = `Su MyWhoosh segui i blocchi qui sopra: è ${w.code} su misura per oggi, più leggero del file salvato "${w.code} ${w.name}".`;
  out.push(card('Oggi nel pratico', 'checkmark-circle', dec.practical.map((p, i) => `<div class="bullet"><span class="chip" style="min-width:22px;text-align:center;align-self:flex-start">${i + 1}</span><span>${esc(p)}</span></div>`).join('')));
  if (dec.dataWarnings.length) out.push(card('Controllo dati', 'warning', dec.dataWarnings.map(x => bullet(x, 'information-circle', 'var(--orange)')).join('')));
  $('#view').innerHTML = out.join('');
}
/** Le tre parti della Prontezza: notte (stile WHOOP), tendenza HRV 7 giorni, readiness Garmin del mattino. */
function partsBars(rec) {
  const p = rec.parts || {};
  const row = (label, v, extra = '') => v == null ? '' : `<div class="part"><span>${label}</span><i><b style="width:${v}%;background:${C.LIGHT[C.lightFrom(v)].color}"></b></i><em class="mono">${v}</em>${extra}</div>`;
  const out = row('Notte', p.notte) + row('Tendenza', p.tendenza) + row('Garmin', p.garmin, p.garminOra != null && p.garminOra !== p.garmin ? `<small>ora ${p.garminOra}</small>` : '');
  return out ? `<div class="parts">${out}</div>` : `<p class="sub" style="margin:8px 0 0">${esc(rec.recovery != null ? 'Stima dai dati di stanotte' : 'Dati insufficienti')}</p>`;
}
const hrvStatus = s => ({ BALANCED: 'bilanciata', LOW: 'bassa', UNBALANCED: 'sbilanciata', POOR: 'scarsa' })[String(s).toUpperCase()] || String(s).toLowerCase();
const feedback = s => String(s).replace(/_/g, ' ').toLowerCase().replace(/^\w/, c => c.toUpperCase());

function sheet(title, body, { right = '', left = 'Chiudi', onOpen } = {}) {
  const m = $('#modal');
  m.onclick = null;
  m.innerHTML = `<div class="sheet" role="dialog" aria-label="${esc(title)}"><div class="sheet-head"><button class="l" data-act="close">${esc(left)}</button><h3>${esc(title)}</h3>${right ? `<button class="r" data-act="sheet-ok">${esc(right)}</button>` : '<span></span>'}</div>${body}</div>`;
  m.hidden = false; document.body.style.overflow = 'hidden';
  onOpen && onOpen(m);
}
function closeSheet() { $('#modal').hidden = true; $('#modal').innerHTML = ''; document.body.style.overflow = ''; sheet.ok = null; }

const sw = (id, on) => `<label class="switch"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><i></i></label>`;
function openCheckIn() {
  const k = C.today(), c = U.checkIns[k] || { feeling: 7, heavyLegs: false, knee: 'none', symptoms: false, lowTime: false, noWill: false };
  sheet('Check-in', `<div class="form">
    <div class="field"><span>Come ti senti?</span><b id="feelV" class="mono">${c.feeling}/10</b></div>
    <div class="field"><input type="range" id="feel" min="1" max="10" step="1" value="${c.feeling}"></div>
    <div class="field"><span>Gambe pesanti</span>${sw('legs', c.heavyLegs)}</div>
    <div class="field"><span>Ginocchio</span><select id="knee"><option value="none">Nessun dolore</option><option value="light">Leggero, gestibile</option><option value="worse">Peggiorato</option></select></div></div>
    <div class="form"><div class="field"><span>Sintomi o malessere</span>${sw('sym', c.symptoms)}</div>
    <div class="field"><span>Ho poco tempo oggi</span>${sw('low', c.lowTime)}</div>
    <div class="field"><span>Oggi non ho voglia</span>${sw('nowill', c.noWill)}</div></div>
    <p class="tiny" style="margin:0 4px">Il check-in resta su questo dispositivo e serve al coach per confermare o cambiare l'allenamento di oggi.</p>`,
  { right: 'Conferma', left: 'Annulla', onOpen: m => { m.querySelector('#knee').value = c.knee; m.querySelector('#feel').oninput = e => { m.querySelector('#feelV').textContent = e.target.value + '/10'; }; } });
  sheet.ok = () => {
    U.checkIns[k] = { key: k, feeling: +$('#feel').value, heavyLegs: $('#legs').checked, knee: $('#knee').value, symptoms: $('#sym').checked, lowTime: $('#low').checked, noWill: $('#nowill').checked };
    // tiene solo gli ultimi 60 giorni
    for (const x of Object.keys(U.checkIns)) if (x < C.addDays(k, -60)) delete U.checkIns[x];
    saveU(); closeSheet(); route(); toast('Check-in salvato');
  };
}
function openNaps() {
  const list = DATA.days.slice(-7).reverse().map(d => {
    const naps = d.naps || [];
    return `<div class="li"><div class="grow"><div class="ttl">${C.pretty(d.key)}</div><div class="sub mono">${naps.length ? naps.map(n => `${hhmm(n.start)}–${hhmm(n.end)} · ${durata(Math.round((n.end - n.start) / 60e3))}`).join('<br>') : d.napMin ? `${d.napMin} min in tutto` : 'nessuno'}</div></div></div>`;
  }).join('');
  sheet('Sonnellini', `<div class="list">${list}</div><p class="tiny" style="margin:0 4px">Per aggiungere, modificare o eliminare un sonnellino usa l'app Coach Garmin sull'iPhone o Garmin Connect: la web app per ora li legge soltanto.</p>`);
}

// ---------- PIANO ----------
function viewPlan() {
  setHead('Piano');
  const g = U.goal, k = C.today(), out = [];
  if (!g) {
    out.push(card('Nessun piano attivo', 'calendar', `<p class="sub" style="margin:0">Scegli un obiettivo: creo un programma su misura e ogni giorno ti dico cosa fare in base a sonno e recupero, alzando la difficoltà quando rispondi bene.</p>
      <button class="btn" data-act="setup">${ic('add')}Crea il piano</button>`));
    out.push(card('Senza piano', 'information-circle', `<p class="sub" style="margin:0">Intanto il coach usa il programma base sui rulli (W01–W10 su MyWhoosh: lunedì, mercoledì e venerdì, giovedì facoltativo, weekend gravel all'aperto) e lo adatta a come stai.</p>`));
    $('#view').innerHTML = out.join(''); return;
  }
  const week = C.currentWeek(g, k), n = C.goalWeeks(g), daysLeft = Math.max(0, C.daysBetween(k, g.targetDate));
  out.push(`<div class="form-h">Obiettivo</div><div class="goal-tiles">${Object.entries(C.GOAL_KIND).map(([id, x]) => `<button class="goal-tile ${g.kind === id ? 'on' : ''}" data-kind="${id}">${ic(x.icon)}${x.short}</button>`).join('')}</div>`);
  out.push(card(C.GOAL_KIND[g.kind].label, C.GOAL_KIND[g.kind].icon, `
    <div class="stats3"><div><div class="k">Settimana</div><div class="v">${Math.min(week + 1, n)} di ${n}</div></div><div><div class="k">Fase</div><div class="v">${esc(C.phase(g, week))}</div></div><div><div class="k">Mancano</div><div class="v">${daysLeft} gg</div></div></div>
    <div class="stats3"><div><div class="k">Giorni</div><div class="v">${[...g.weekdays].sort((a, b) => ((a + 5) % 7) - ((b + 5) % 7)).map(C.dayName).join(' ')}</div></div><div><div class="k">Ore/giorno</div><div class="v">${C.f1(g.hoursPerDay)}</div></div><div><div class="k">Difficoltà</div><div class="v">${C.level(g)}</div></div></div>
    <div class="seg">${Object.entries(C.MIX).map(([id, x]) => `<button class="${(g.mix || 'bike') === id ? 'on' : ''}" data-mix="${id}">${x.label}</button>`).join('')}</div>
    <div class="tiny">${esc(C.GOAL_KIND[g.kind].explanation)}</div>`));
  const ses = C.session(g, k);
  if (!ses) out.push(`<button class="btn soft" data-act="extra">${ic('add')}Oggi è riposo, ma voglio allenarmi</button>`);
  // settimana
  const ref = C.addDays(k, weekOffset * 7), dates = C.weekKeys(ref);
  const rows = dates.map(d => {
    const s0 = C.session(g, d), ai = U.aiRuns[d];
    const s = ai ? { title: AI.toWorkout(ai).name, phase: 'Corsa con l\'AI', purpose: 'Programmata sulle tue parole', intensity: AI.toWorkout(ai).intensity, sport: 'run', ai: true } : s0;
    const done = DATA.activities.filter(a => a.key === d && (C.isRide(a) || C.isRun(a)));
    let info;
    if (s) {
      const tag = s.ai ? '<span class="tag">AI</span>' : s.phase === C.EXTRA_PHASE ? '<span class="tag">IN PIÙ</span>' : (g.softened || []).includes(d) ? '<span class="tag o">ALLEGGERITA</span>' : '';
      info = `<div class="strong" style="font-size:15px">${esc(s.title)}${tag}</div><div class="sub">${esc(s.ai || s.phase === C.EXTRA_PHASE ? s.purpose : C.sessionDetail(s))}</div>`;
    } else info = `<div class="sub" style="font-size:15px">${(g.skipped || []).includes(d) ? 'Saltata' : 'Riposo'}</div>`;
    info += done.map(a => `<div class="done-line">${ic('checkmark-circle')}${esc(a.garminName || a.type)} · ${a.minutes}'</div>`).join('');
    return `<div class="day"><div class="dd ${d === k ? 'today' : ''}"><span>${C.pretty(d, 'wd')}</span><b>${C.toDate(d).getDate()}</b></div><div class="di">${info}</div>${s ? `<span style="color:${C.INT_COLOR[s.intensity]}">${ic(s.sport === 'run' ? 'walk' : 'bicycle')}</span>` : ''}</div>`;
  }).join('');
  out.push(`<section class="card"><div class="week-head"><button data-week="-1" aria-label="Settimana prima">${ic('chevron-back')}</button><span>${C.pretty(dates[0], 'dm')} – ${C.pretty(dates[6], 'dm')}</span><button data-week="1" aria-label="Settimana dopo">${ic('chevron-forward')}</button></div>${rows}</section>`);
  out.push(`<button class="btn" data-act="chat">${ic('chatbubbles')}Modifica il piano con la chat</button>`);
  out.push(`<button class="btn plain" data-act="setup">Crea un nuovo piano</button><button class="btn danger" data-act="delgoal">Elimina il piano</button>`);
  $('#view').innerHTML = out.join('');
}
function openSetup() {
  const g = U.goal;
  const st = { kind: g?.kind || 'fitness', date: g?.targetDate || C.addDays(C.today(), 70), days: new Set(g?.weekdays || [2, 4, 6, 7]), hours: g?.hoursPerDay || 1, mix: g?.mix || 'bike' };
  const draw = () => {
    $('#setupBody').innerHTML = `<div class="form-h">1. Che obiettivo vuoi raggiungere?</div>
      <div class="goal-tiles">${Object.entries(C.GOAL_KIND).map(([id, x]) => `<button class="goal-tile ${st.kind === id ? 'on' : ''}" data-skind="${id}">${ic(x.icon)}${x.short}</button>`).join('')}</div>
      <p class="sub" style="margin:0 4px">${esc(C.GOAL_KIND[st.kind].explanation)}</p>
      <div class="form-h">2. ${st.kind === 'race' ? 'Quando è la gara?' : 'Entro quando?'}</div>
      <div class="form"><div class="field"><span>Data</span><input type="date" id="sdate" min="${C.addDays(C.today(), 14)}" value="${st.date}"></div></div>
      <div class="form-h">3. Che giorni puoi allenarti?</div>
      <div class="form"><div class="daypick">${C.DAY_WORDS.map(([w, n]) => `<button class="${st.days.has(n) ? 'on' : ''}" data-sday="${n}">${w.slice(0, 2).toUpperCase()}</button>`).join('')}</div></div>
      <div class="form-h">4. Quante ore al giorno hai?</div>
      <div class="form"><div class="field"><button class="icon-btn" data-shours="-0.25">−</button><b class="mono">${C.f1(st.hours, 2).replace(/0$/, '')} ore</b><button class="icon-btn" data-shours="0.25">+</button></div></div>
      <div class="form-h">5. Corsa, rulli o entrambi?</div>
      <div class="seg">${Object.entries(C.MIX).map(([id, x]) => `<button class="${st.mix === id ? 'on' : ''}" data-smix="${id}">${x.label}</button>`).join('')}</div>
      <p class="tiny" style="margin:0 4px">${esc(C.MIX[st.mix].explanation)}</p>`;
  };
  sheet('Nuovo piano', '<div id="setupBody" style="display:flex;flex-direction:column;gap:10px"></div>', { right: 'Crea', left: 'Annulla', onOpen: draw });
  $('#modal').onclick = e => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.skind) { st.kind = t.dataset.skind; st.date = $('#sdate').value || st.date; draw(); }
    if (t.dataset.sday) { const n = +t.dataset.sday; st.days.has(n) ? st.days.delete(n) : st.days.add(n); st.date = $('#sdate').value || st.date; draw(); }
    if (t.dataset.shours) { st.hours = Math.min(5, Math.max(0.5, st.hours + +t.dataset.shours)); st.date = $('#sdate').value || st.date; draw(); }
    if (t.dataset.smix) { st.mix = t.dataset.smix; st.date = $('#sdate').value || st.date; draw(); }
  };
  sheet.ok = () => {
    const date = $('#sdate').value;
    if (st.days.size < 2) return toast('Scegli almeno 2 giorni');
    if (!date || date < C.addDays(C.today(), 14)) return toast('Scegli una data fra almeno 2 settimane');
    U.goal = { kind: st.kind, targetDate: date, weekdays: [...st.days].sort(), hoursPerDay: st.hours, startDate: C.today(), progression: 0, skipped: [], moved: {}, deloadWeeks: [], extras: {}, softened: [], mix: st.mix, lastProgressionCheck: C.today() };
    U.chat = [];
    saveU(); closeSheet(); location.hash = '#/piano'; route(); toast('Piano creato');
  };
}
function chatCtx() {
  const k = C.today(), dec = dayDecision(k);
  return { load: C.recentLoad(DATA.activities, k), light: dec.light, feeling: U.checkIns[k]?.feeling };
}
function openChat() {
  const draw = () => {
    const msgs = U.chat.length ? U.chat : [{ me: false, text: 'Ciao! Dimmi cosa cambiare nel piano: per esempio "oggi non posso", "sposta a domani", "più facile" o "ho solo 1 ora al giorno".' }];
    $('#msgs').innerHTML = msgs.map(m => `<div class="msg ${m.me ? 'me' : 'coach'}">${esc(m.text)}</div>`).join('');
    $('#msgs').lastElementChild?.scrollIntoView({ block: 'end' });
  };
  sheet('Chat del piano', `<div class="msgs" id="msgs"></div><div class="sugg">${C.CHAT_SUGGESTIONS.map(s => `<button data-say="${esc(s)}">${esc(s)}</button>`).join('')}</div>
    <form class="chat-form" id="chatForm"><input id="chatIn" placeholder="Scrivi al coach" autocomplete="off"><button aria-label="Invia">${ic('chevron-forward')}</button></form>`, { onOpen: draw });
  const say = text => {
    if (!text.trim() || !U.goal) return;
    const reply = C.chat(text, U.goal, chatCtx());
    U.chat.push({ me: true, text }, { me: false, text: reply });
    U.chat = U.chat.slice(-60); saveU(); draw();
  };
  $('#chatForm').onsubmit = e => { e.preventDefault(); say($('#chatIn').value); $('#chatIn').value = ''; };
  $('#modal').onclick = e => { const b = e.target.closest('[data-say]'); if (b) say(b.dataset.say); };
}

// ---------- DIETA ----------
function viewDiet() {
  setHead('La mia dieta', `<button class="icon-btn" data-act="dietmenu" aria-label="Altre azioni">${ic('ellipsis-horizontal')}</button>`);
  const s = DIET, sc = D.score(s), out = [];
  const GIORNI = ['lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato', 'domenica'];
  const ws = C.startOfWeek(C.today());
  const tiles = Object.entries(D.CATS).map(([id, c]) => {
    const p = D.progress(s, id), now = D.expectedNow(id);
    const ok = p.done >= now.number, near = p.done === now.number - 1;
    return `<button class="cat-tile ${dietCat === id ? 'on' : ''}" style="--cc:${c.color}" data-cat="${id}"><div class="ch"><span>${ic(c.icon)}${c.short}</span><b class="mono">${p.done}/${p.total}</b></div>
      <div class="bar"><i style="width:${Math.min(100, p.done / p.total * 100)}%;background:${c.color}"></i></div>
      <div class="tiny" style="color:${ok ? '#34c759' : near ? 'var(--muted)' : 'var(--orange)'}">${ok ? 'In linea' : near ? 'Manca ' + now.label : 'Indietro'} · ${now.label} = ${now.number}</div></button>`;
  }).join('');
  out.push(`<section class="card"><div class="diet-top"><div class="ring" style="width:124px;height:124px">${ring(sc.percent / 100, D.scoreColor(sc.percent), 124, 13)}<div class="rv"><b style="font-size:30px">${sc.percent}%</b><span>riuscita</span></div></div>
    <div style="min-width:0"><div class="strong">Settimana dal ${C.pretty(ws, 'dm')}</div><div class="sub">Da lunedì a ${GIORNI[sc.day - 1]}: ${sc.day} ${sc.day === 1 ? 'giorno' : 'giorni'}</div>
    <div style="font-size:14px;font-weight:500;margin-top:4px">Pasti ${sc.mealsPercent}% · Colazione ${sc.breakfastPercent}% · Frutta ${sc.fruitPercent}%</div>
    <div class="tiny">Attesi finora: ${sc.mealsExpected} carbo, ${sc.mealsExpected} proteine, ${sc.mealsExpected} verdure</div>
    ${s.lastWeekPercent != null ? `<div class="tiny">Settimana scorsa: ${s.lastWeekPercent}%</div>` : ''}</div></div>
    <div class="grid2">${tiles}</div></section>`);
  const free = D.freeMeals(s);
  out.push(`<div class="list"><div class="li"><div class="ico-c" style="background:#af52de">${ic('restaurant')}</div><div class="grow"><div class="ttl">Pasto libero</div><div class="sub">${free ? `${free} questa settimana` : 'Nessuno questa settimana'}</div></div>
    ${free ? `<button class="undo" data-undo="${D.FREE_ID}" aria-label="Togli un pasto libero">${ic('arrow-undo')}</button>` : ''}<button class="btn small" style="width:auto" data-eat="${D.FREE_ID}">Segna</button></div></div>
    <div class="list-foot">${sc.extraFree > 0 ? `Pasti liberi in più: ${sc.extraFree}. Dal secondo pasto libero le dosi passano a quelle ridotte (indicate in arancione) e la riuscita scende: ogni pasto libero in più occupa un pasto del programma.` : 'Hai 1 pasto libero a settimana: vale come un pasto di carboidrati, proteine e verdura e non abbassa la riuscita.'}</div>`);
  out.push(`<div class="seg">${Object.entries(D.CATS).map(([id, c]) => `<button class="${dietCat === id ? 'on' : ''}" data-cat="${id}">${c.short}</button>`).join('')}</div>`);
  const c = D.CATS[dietCat], all = D.inCat(s, dietCat);
  const just = s.lastEatenAt && Date.now() - s.lastEatenAt < 120e3 ? s.lastEaten : null;
  const sections = dietCat === 'colazione' ? [['Colazione · 1 al giorno', all.filter(i => i.group)], ['Frutta · 1 al giorno', all.filter(i => !i.group)]] : [['Da mangiare', all]];
  const todoAll = all.filter(i => D.remaining(s, i) > 0);
  if (!todoAll.length) out.push(`<div class="list"><div class="li" style="color:${c.color}">${ic('checkmark-circle')}<span class="strong">Hai completato ${c.title.toLowerCase()} per questa settimana</span></div></div>`);
  for (const [ttl, list] of sections) {
    const rows = list.filter(i => D.remaining(s, i) > 0);
    if (!rows.length) continue;
    out.push(`<div class="list-h">${esc(ttl)}</div><div class="list">${rows.map(i => {
      const p = D.portion(s, i), left = D.remaining(s, i);
      return `<div class="li food ${i.healthy ? '' : 'unhealthy'} ${just === i.id ? 'just' : ''}" style="--cc:${c.color}" data-eat="${i.id}"><span class="check">${ic('add')}</span><div class="grow"><div class="ttl">${esc(i.name)}</div>${p.text ? `<div class="sub" style="${p.reduced ? 'color:var(--orange);font-weight:600' : ''}">${esc(p.text)}${p.reduced ? ' (ridotta)' : ''}</div>` : ''}</div><div class="right"><div class="count">${D.eaten(s, i)}/${i.weeklyTarget}</div><div class="tiny">${left === 1 ? 'ne manca 1' : `ne mancano ${left}`}</div></div></div>`;
    }).join('')}</div>`);
  }
  if (dietCat === 'colazione') out.push('<div class="list-foot">Una colazione al giorno: il latte sempre abbinato a biscotti o cereali, oppure lo yogurt. Con 7 colazioni sane la colazione è al 100%. Latte e biscotti non sani e il bar si possono segnare ma non contano. In più un frutto al giorno.</div>');
  const done = all.filter(i => D.eaten(s, i) > 0);
  if (done.length) out.push(`<div class="list-h">Già mangiato</div><div class="list">${done.map(i => `<div class="li ${just === i.id ? 'food just' : ''}" style="--cc:${c.color}"><span style="color:${c.color}">${ic('checkmark-circle')}</span><div class="grow"><div class="ttl">${esc(i.name)}</div></div><b class="count">${D.eaten(s, i)}</b><button class="undo" data-undo="${i.id}" aria-label="Togli una spunta">${ic('arrow-undo')}</button></div>`).join('')}</div><div class="list-foot">Tocca la freccia per togliere una spunta messa per sbaglio.</div>`);
  $('#view').innerHTML = out.join('');
}
function openDietMenu() {
  sheet('Dieta', `<div class="list"><button class="li" style="width:100%;text-align:left" data-act="doses">${ic('restaurant')}<span class="grow">Personalizza dosi</span>${ic('chevron-forward', 'chev')}</button>
    <button class="li" style="width:100%;text-align:left;color:var(--red)" data-act="dietreset">${ic('trash')}<span class="grow">Azzera settimana</span></button></div>
    <p class="tiny" style="margin:0 4px">Le spunte restano su questo dispositivo e ripartono da zero ogni lunedì. Quelle dell'app iPhone non si vedono qui.</p>`);
}
function openDoses() {
  const its = D.items(DIET).filter(i => i.portion && i.portion !== 'da evitare');
  sheet('Personalizza dosi', `<div class="form">${its.map(i => `<div class="field" style="flex-wrap:wrap"><span class="strong" style="width:100%">${esc(i.name)}</span>
    <label class="tiny">Dose <input type="text" data-dose="${i.id}" value="${esc(i.portion)}" style="width:96px"></label>
    ${i.reducedPortion ? `<label class="tiny">Ridotta <input type="text" data-red="${i.id}" value="${esc(i.reducedPortion)}" style="width:96px"></label>` : ''}</div>`).join('')}</div>
    <button class="btn plain" data-act="dosereset">Ripristina le dosi del programma</button>`, { right: 'Salva', left: 'Annulla' });
  sheet.ok = () => {
    const doses = {};
    document.querySelectorAll('[data-dose]').forEach(el => { const def = D.DEFAULT_ITEMS.find(x => x.id === el.dataset.dose); if (el.value.trim() && el.value.trim() !== def.portion) (doses[def.id] = doses[def.id] || {}).portion = el.value.trim(); });
    document.querySelectorAll('[data-red]').forEach(el => { const def = D.DEFAULT_ITEMS.find(x => x.id === el.dataset.red); if (el.value.trim() && el.value.trim() !== def.reducedPortion) (doses[def.id] = doses[def.id] || {}).reducedPortion = el.value.trim(); });
    DIET.doses = doses; D.save(DIET); closeSheet(); route(); toast('Dosi salvate');
  };
}

// ---------- ATTIVITÀ ----------
function viewActivities() {
  setHead('Attività', refreshBtn);
  const acts = DATA.activities, k = C.today(), out = [];
  const sum = (f, from) => acts.filter(a => a.key >= from && f(a)).reduce((s, a) => s + (a.km || 0), 0);
  const ws = C.startOfWeek(k), ms = k.slice(0, 8) + '01', ys = k.slice(0, 5) + '01-01';
  const feet = a => C.isWalk(a) || C.isRun(a);
  const row = (label, f, color, icon) => `<div class="li"><div class="ico-c" style="background:${color}">${ic(icon)}</div><div class="grow"><div class="ttl">${label}</div></div>
    <div class="stats3" style="gap:14px;text-align:right">${[['Settimana', ws], ['Mese', ms], ['Anno', ys]].map(([n, from]) => `<div><div class="k">${n}</div><div class="v mono">${Math.round(sum(f, from))} km</div></div>`).join('')}</div></div>`;
  out.push(`<div class="list-h">Chilometri</div><div class="list">${row('In bici', C.isRide, '#34c759', 'bicycle')}${row('A piedi', feet, '#ff9500', 'walk')}</div>
    <div class="list-foot">Somme delle attività registrate su Garmin (${acts.length} scaricate).</div>`);
  let month = '';
  const items = [];
  for (const a of acts.slice(0, 150)) {
    const m = a.key.slice(0, 7);
    if (m !== month) { if (items.length) items.push('</div>'); month = m; const d = C.toDate(a.key); items.push(`<div class="list-h">${d.toLocaleDateString('it-IT', { month: 'long', year: 'numeric' })}</div><div class="list">`); }
    const color = C.isRide(a) ? '#34c759' : C.isRun(a) ? '#ff9500' : C.isWalk(a) ? '#ffcc00' : '#8e8e93';
    const met = [a.avgHR && `FC ${a.avgHR}`, a.avgPower && `${a.avgPower} W`, a.trainingEffect && `TE ${C.f1(a.trainingEffect)}`].filter(Boolean).join(' · ');
    items.push(`<div class="li"><div class="ico-c" style="background:${color}">${ic(C.isRide(a) ? 'bicycle' : C.isRun(a) || C.isWalk(a) ? 'walk' : 'fitness')}</div><div class="grow"><div class="ttl">${esc(a.garminName || a.type)}</div><div class="sub">${C.pretty(a.key)} · ${esc(a.type)}</div></div>
      <div class="right"><div class="mono strong" style="font-size:14.5px">${a.minutes} min${a.km ? ` · ${C.f1(a.km)} km` : ''}</div><div class="tiny">${met}</div></div></div>`);
  }
  if (items.length) items.push('</div>');
  out.push(items.length ? items.join('') : '<div class="list"><div class="li sub">Nessuna attività scaricata</div></div>');
  $('#view').innerHTML = out.join('');
}

// ---------- ACCOUNT ----------
function viewAccount() {
  setHead('Account', refreshBtn);
  const out = [], days = DATA.days;
  out.push(`<div class="list-h">Garmin Connect</div><div class="list">
    <div class="li"><div class="grow">Account</div><b>${esc(DATA.profile?.name || 'collegato')}</b></div>
    <div class="li"><div class="grow">Ultimo aggiornamento</div><b>${DATA.updated ? `${ago(DATA.updated)} (${hhmm(DATA.updated)})` : '–'}</b></div>
    <div class="li"><div class="grow">Giorni in archivio</div><b>${days.length}${days.length ? ` · dal ${C.pretty(days[0].key, 'dm')}` : ''}</b></div>
    <div class="li"><div class="grow">Attività</div><b>${DATA.activities.length}</b></div>
    <div class="li"><div class="grow">Dispositivi</div><b style="text-align:right">${esc((DATA.devices || []).map(d => d.name).join(', ') || '–')}</b></div>
    ${DATA.error ? `<div class="li" style="color:var(--orange)">${ic('warning')}<div class="grow">${esc(DATA.error)}</div></div>` : ''}</div>
    <div class="list-foot">${location.hostname.endsWith('github.io') ? 'I dati Garmin si aggiornano da soli circa ogni 15 minuti, anche con il Mac spento.' : 'Con il server sul Mac i dati si aggiornano ogni 15 minuti; ↻ li aggiorna subito.'}</div>`);
  out.push(`<div class="list-h">Allenamento</div><div class="list">
    <div class="li"><div class="grow">FTP da Garmin</div><b>${DATA.ftp ? DATA.ftp + ' W' : '–'}</b></div>
    <div class="li"><div class="grow">FTP inserita a mano</div><input type="number" id="ftpIn" min="80" max="600" placeholder="watt" value="${U.ftpManual || ''}" style="width:96px;background:var(--fill);border:0;border-radius:8px;padding:6px 10px"></div></div>
    <div class="list-foot">Se la inserisci a mano (per esempio quella di MyWhoosh), vale questa per i watt degli allenamenti. Lascia vuoto per usare quella di Garmin.</div>`);
  const acc = MW.account(DATA);
  out.push(`<div class="list-h">MyWhoosh</div><div class="list">
    <div class="li"><div class="grow">Allenamenti MyWhoosh</div><b>${acc ? (acc.expired ? 'accesso scaduto' : 'collegati') : 'non collegati'}</b></div>
    ${acc && !acc.expired ? `<div class="li"><div class="grow">Salvati su MyWhoosh</div><b>${MWLIST ? MWLIST.length : '…'}</b></div>
    <button class="li" style="width:100%;text-align:left" data-act="mwlib">${ic('bicycle')}<span class="grow">${MWLIST && MW.LIBRARY.every(w => MWLIST.some(x => x.name === w.code + ' ' + w.name)) ? 'W01–W09 sono già tutti su MyWhoosh' : 'Carica su MyWhoosh gli W01–W09 mancanti'}</span></button>` : ''}</div>
    <div class="list-foot">${acc ? (acc.exp ? `Accesso valido fino al ${new Date(acc.exp).toLocaleDateString('it-IT')}. ` : '') + 'Nei giorni di rulli la web app ti dice quale allenamento usare e, se serve, ne carica uno su misura (in MyWhoosh: Allenamenti › I miei allenamenti).' : 'Per collegarli: sul Mac doppio clic su "Collega MyWhoosh.command" (una volta sola).'}${MWSTATE ? ' ' + esc(MWSTATE) : ''}</div>`);
  out.push(`<div class="list-h">Corsa con l'AI (Gemini)</div><div class="list">
    <div class="li"><div class="grow">Chiave Gemini</div><input type="password" id="gemIn" placeholder="incolla la chiave" value="${esc(geminiKey())}" autocomplete="off" style="width:160px;background:var(--fill);border:0;border-radius:8px;padding:6px 10px"></div></div>
    <div class="list-foot">Gratis: crea la chiave su <b>aistudio.google.com/apikey</b> (account Google, "Create API key") e incollala qui. Resta solo su questo dispositivo. Senza chiave la corsa la prepara il coach dalle frasi tipiche.</div>`);
  if (repoInfo()) out.push(`<div class="list-h">Pulsante aggiorna</div><div class="list">
    <div class="li"><div class="grow">Aggiornamento immediato</div><b>${ghToken() ? 'attivo' : 'non attivo'}</b></div>
    <button class="li" style="width:100%;text-align:left${ghToken() ? ';color:var(--red)' : ''}" data-act="${ghToken() ? 'ghoff' : 'ghon'}">${ic(ghToken() ? 'trash' : 'refresh')}<span class="grow">${ghToken() ? 'Scollega GitHub da questo dispositivo' : 'Attiva l\'aggiornamento immediato'}</span></button></div>
    <div class="list-foot">${ghToken() ? 'Il pulsante ↻ in alto scarica subito i dati da Garmin (1–2 minuti).' : 'Senza, il pulsante ↻ carica l\'ultimo aggiornamento automatico (ogni 15 minuti circa).'}</div>`);
  if (getKey()) out.push(`<div class="list-h">Su iPhone</div><div class="list">
    <button class="li" style="width:100%;text-align:left" data-act="copylink">${ic('person-circle')}<span class="grow">Copia il link privato</span>${ic('chevron-forward', 'chev')}</button>
    <div class="li"><div class="grow sub">Per averla come un'app: in Safari tocca Condividi → <b>Aggiungi alla schermata Home</b> (su iOS 26 è sotto "Visualizza altro"). Si apre a schermo intero, già con l'accesso.</div></div></div>`);
  out.push(`<div class="list-h">Dati su questo dispositivo</div><div class="list">
    <button class="li" style="width:100%;text-align:left" data-act="export">${ic('arrow-undo')}<span class="grow">Salva una copia di piano, check-in e dieta</span></button>
    <label class="li" style="cursor:pointer">${ic('add')}<span class="grow">Ripristina da una copia</span><input type="file" id="importIn" accept="application/json" hidden></label>
    <button class="li" style="width:100%;text-align:left;color:var(--red)" data-act="wipe">${ic('trash')}<span class="grow">Cancella piano, check-in e dieta da questo dispositivo</span></button></div>
    <div class="list-foot">Piano, check-in e dieta della web app restano in questo browser e non si mischiano con l'app iPhone. Coach Garmin Web · stima dell'app, non un parere medico.</div>`);
  $('#view').innerHTML = out.join('');
  $('#gemIn').onchange = e => { store.set(GKEY, e.target.value.trim()); toast(e.target.value.trim() ? 'Chiave Gemini salvata' : 'Chiave Gemini tolta'); };
  $('#ftpIn').onchange = e => { const v = parseInt(e.target.value, 10); U.ftpManual = v >= 80 && v <= 600 ? v : null; saveU(); toast(U.ftpManual ? `FTP ${U.ftpManual} W` : 'Uso la FTP di Garmin'); };
  $('#importIn').onchange = async e => {
    try {
      const j = JSON.parse(await e.target.files[0].text());
      if (!j.utente || !j.dieta) throw 0;
      Object.assign(U, j.utente); saveU(); D.save(j.dieta); DIET = D.load(); toast('Copia ripristinata'); route();
    } catch { toast('File non valido'); }
  };
}

// ---------- spiegazione dei dati ----------
/** La tua fascia normale: media ± 1 deviazione standard delle 4 settimane prima di oggi. */
function myRange(get, k) {
  const xs = DATA.days.filter(d => d.key < k).slice(-28).map(get).filter(v => v != null && isFinite(v));
  if (xs.length < 7) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length, sd = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
  return { mean: m, lo: m - sd, hi: m + sd, n: xs.length };
}
function openInfo(id) {
  const k = C.today(), t = DATA.days.find(d => d.key === k) || DATA.days[DATA.days.length - 1] || {};
  const f = (v, d = 0) => (v == null ? '–' : C.f1(v, d));
  // verdetto di oggi rispetto alla tua fascia; better = 'alto' se più alto è meglio
  const verdict = (v, r, better, fmt = x => f(x)) => {
    if (v == null || !r) return '';
    const inRange = v >= r.lo && v <= r.hi, good = better === 'alto' ? v > r.hi : v < r.lo;
    const [txt, col] = inRange ? ['nella tua norma', 'var(--accent)'] : good ? ['meglio del solito', 'var(--accent)'] : ['peggio del solito', 'var(--orange)'];
    return `<div class="banner ${col === 'var(--accent)' ? 'info' : ''}"><b>Oggi ${fmt(v)}: ${txt}.</b> La tua fascia normale (ultime ${r.n} notti) va da ${fmt(r.lo)} a ${fmt(r.hi)}, media ${fmt(r.mean)}.</div>`;
  };
  const S = (title, ...p) => `<section class="card"><div class="card-title">${title}</div><div class="sub" style="display:flex;flex-direction:column;gap:8px">${p.map(x => `<p style="margin:0">${x}</p>`).join('')}</div></section>`;
  let title, body;
  if (id === 'bb') {
    const r = myRange(d => d.bbHigh, k);
    title = 'Body Battery';
    body = (t.bodyBatteryNow != null ? `<div class="banner info"><b>Adesso ${t.bodyBatteryNow}</b>${t.bbTime ? ` (dato CIRQA delle ${hhmm(t.bbTime)})` : ''}${t.bbCharged != null ? ` · stanotte +${t.bbCharged}` : ''}${t.bbHigh != null ? ` · massimo di oggi ${t.bbHigh}` : ''}.</div>` : '')
      + (r ? `<div class="banner info">Il tuo massimo del mattino di solito sta fra ${f(r.lo)} e ${f(r.hi)} (media ${f(r.mean)}).</div>` : '')
      + S('Cosa misura', "L'energia di riserva del corpo da 0 a 100: si ricarica con sonno e riposo e si scarica con attività, stress e giornate lunghe. Garmin la calcola da HRV, stress e attività.")
      + S('Valori di riferimento', '<b>Al risveglio:</b> 75–100 ottimo, 50–74 discreto, sotto 50 la notte non ti ha ricaricato.', '<b>Ricarica notturna:</b> +50 o più è buona; sotto +30 hai dormito poco o male.', '<b>Durante il giorno:</b> sotto 25 sei in riserva: niente allenamenti intensi, meglio un sonnellino o andare a letto presto.')
      + S('Come la usa il coach', 'Non entra nel punteggio di Prontezza (cambia troppo durante il giorno), ma Gemini la riceve quando programma la corsa.');
  } else if (id === 'sonno') {
    const rs = myRange(d => d.sleepScore, k), rh = myRange(d => d.sleepHours, k);
    title = 'Sonno';
    body = verdict(t.sleepScore, rs, 'alto') + verdict(t.sleepHours, rh, 'alto', v => C.hm(v))
      + S('Cosa misura', 'Il punteggio Garmin (0–100) unisce durata, fasi del sonno (profondo, leggero, REM), risvegli e stress notturno.')
      + S('Valori di riferimento', '<b>Punteggio:</b> 90–100 eccellente, 80–89 buono, 60–79 discreto, sotto 60 scarso.', '<b>Durata:</b> per un adulto che si allena 7–9 ore. Sotto le 6 ore per 2 notti su 3 il coach blocca l\'intensità.', `<b>Efficienza</b> (tempo dormito / tempo a letto): sopra 85% è buona${t.sleepEfficiency ? `; stanotte ${t.sleepEfficiency}%` : ''}.`)
      + S('Come la usa il coach', 'Durata ed efficienza entrano nella parte "Notte" della Prontezza; le ultime 3 notti nel debito di sonno della "Tendenza".');
  } else if (id === 'hrv') {
    const r = myRange(d => d.hrv, k);
    title = 'HRV notturna';
    body = verdict(t.hrv, r, 'alto', v => f(v) + ' ms')
      + (t.hrvLow != null ? `<div class="banner info">Fascia "bilanciata" calcolata da Garmin: ${t.hrvLow}–${t.hrvHigh} ms${t.hrvWeekly ? ` · media 7 giorni ${t.hrvWeekly} ms` : ''}${t.hrvStatus ? ` · stato ${hrvStatus(t.hrvStatus)}` : ''}.</div>` : '')
      + S('Cosa misura', 'La variabilità del battito durante la notte (in millisecondi): quanto il sistema nervoso è "rilassato". Più alta rispetto al tuo solito = recupero migliore.')
      + S('Il valore corretto', '<b>Non esiste un numero giusto per tutti:</b> dipende da età, genetica e dispositivo (fra adulti va da 20 a oltre 100 ms). Conta solo il confronto con <b>la tua</b> media.', '<b>Segnali da guardare:</b> un singolo giorno basso conta poco; la media di 7 giorni sotto la tua norma per più giorni indica fatica accumulata, stress o un malanno in arrivo. HRV bassa insieme a FC a riposo alta è il segnale più affidabile che non hai recuperato.')
      + S('Come la usa il coach', 'È il dato più importante: pesa quasi metà della "Notte" e tutta la "Tendenza" della Prontezza.');
  } else if (id === 'ristoratore') {
    const tot = t.sleepHours ? t.sleepHours * 60 : null, rd = myRange(d => d.deepMin != null && d.remMin != null ? (d.deepMin + d.remMin) / 60 : null, k);
    title = 'Sonno ristoratore';
    body = verdict(t.deepMin != null && t.remMin != null ? (t.deepMin + t.remMin) / 60 : null, rd, 'alto', v => C.hm(v))
      + (tot && t.deepMin != null ? `<div class="banner info">Stanotte: profondo ${t.deepMin}' (${Math.round(t.deepMin / tot * 100)}%) · REM ${t.remMin}' (${Math.round(t.remMin / tot * 100)}%).</div>` : '')
      + S('Cosa misura', '<b>Sonno profondo:</b> recupero fisico di muscoli e tendini, ormone della crescita. <b>REM:</b> recupero mentale, memoria, umore.')
      + S('Valori di riferimento', '<b>Profondo:</b> 13–23% del sonno (circa 1–1,5 h su 7–8 h). <b>REM:</b> 20–25% (circa 1,5–2 h). Insieme di solito 2–3 ore a notte.', 'Il sonno profondo è soprattutto a inizio notte, il REM verso il mattino: andare a letto tardi taglia il profondo, svegliarsi presto taglia il REM.', 'I valori di braccialetti e orologi sono stime: guarda la tendenza, non la singola notte.');
  } else if (id === 'fc') {
    const r = myRange(d => d.restingHR, k);
    title = 'FC a riposo';
    body = verdict(t.restingHR, r, 'basso', v => f(v) + ' bpm')
      + S('Cosa misura', 'Il battito più basso della giornata, di solito durante il sonno.')
      + S('Valori di riferimento', '<b>Adulti:</b> 60–80 bpm normale; <b>sportivi allenati:</b> 45–60 bpm. Scende man mano che migliori la forma.', '<b>Rispetto alla tua media:</b> +3–5 bpm per uno o due giorni = fatica, poco sonno, alcol o caldo; +5 bpm o più per diversi giorni, soprattutto con HRV bassa = possibile malanno: riposo.')
      + S('Come la usa il coach', 'Pesa un quarto della "Notte" della Prontezza ed è uno dei campanelli d\'allarme insieme a HRV e respirazione.');
  } else {
    const h = C.health(t, DATA.days);
    title = 'Stato di salute';
    body = `<div class="list">${h.items.map(i => `<div class="li"><span style="color:${i.normal ? 'var(--accent)' : 'var(--orange)'}">${ic(i.normal ? 'checkmark-circle' : 'warning')}</span><div class="grow">${esc(i.name)}</div><b>${esc(i.value)}</b></div>`).join('') || '<div class="li sub">Servono almeno 7 giorni di dati</div>'}</div>`
      + S('Cosa misura', 'Una stima dell\'app (Garmin non la espone): controlla se HRV, FC a riposo, respirazione e stress notturno di stanotte sono dentro la tua fascia normale delle ultime 4 settimane.')
      + S('Valori di riferimento', '<b>Nella norma:</b> tutto a posto. <b>1 fuori norma:</b> capita, guarda come ti senti. <b>2 o più fuori norma</b> (soprattutto FC alta + HRV bassa + respirazione alta): il corpo sta combattendo qualcosa, oggi riposo.');
  }
  sheet(title, body + '<p class="tiny" style="margin:0 4px">Valori indicativi per adulti sportivi amatori, non un parere medico.</p>');
}

// ---------- MyWhoosh ----------
async function loadMyWhoosh() {
  const acc = MW.account(DATA);
  if (!acc || acc.expired) return;
  try { MWLIST = await MW.saved(acc); MWSTATE = ''; } catch (e) { MWSTATE = e.message; }
  route();
}
function myWhooshCard(w, steps, adj) {
  const acc = MW.account(DATA);
  if (!acc) return card('Su MyWhoosh oggi', 'bicycle', `<div class="sub">${w.code === 'PIANO' || adj ? 'Crea su MyWhoosh un allenamento con i blocchi qui sopra' : `Su MyWhoosh avvia "${esc(w.code + ' ' + w.name)}"`}. Per farlo caricare in automatico collega MyWhoosh: sul Mac doppio clic su "Collega MyWhoosh.command".</div>`);
  if (acc.expired) return card('Su MyWhoosh oggi', 'bicycle', '<div class="banner">Accesso MyWhoosh scaduto: rifai "Collega MyWhoosh.command" sul Mac.</div>');
  if (!MWLIST) return card('Su MyWhoosh oggi', 'bicycle', `<div class="sub">${MWSTATE ? esc(MWSTATE) : 'Leggo i tuoi allenamenti MyWhoosh…'}</div>`);
  const sug = MW.suggestion(w, steps, MWLIST);
  if (sug.kind === 'saved') return card('Su MyWhoosh oggi', 'bicycle', `<div class="strong" style="color:var(--accent-ink)">${ic('checkmark-circle')} Usa un allenamento già salvato</div><div class="headline">${esc(sug.name)}</div><div class="tiny">${sug.minutes} min · fino al ${Math.round(sug.peak * 100)}% FTP · in MyWhoosh: Allenamenti › I miei allenamenti</div>`);
  const up = MWLIST.some(x => x.name === sug.name);
  return card('Su MyWhoosh oggi', 'bicycle', `<div class="strong" style="color:#af52de">${ic('sparkles')} Allenamento creato su misura per oggi</div><div class="headline">${esc(sug.name)}</div>
    <div class="tiny">${sug.minutes} min · fino al ${Math.round(sug.peak * 100)}% FTP · TSS ≈ ${C.tss(sug.steps)}</div>
    ${up ? `<div class="strong" style="color:var(--accent-ink);font-size:14px">${ic('checkmark-circle')} Già su MyWhoosh: Allenamenti › I miei allenamenti</div>` : `<button class="btn" style="background:#af52de" data-act="mwupload">${ic('bicycle')}Carica ora su MyWhoosh</button>`}
    ${MWSTATE ? `<div class="banner">${esc(MWSTATE)}</div>` : ''}`);
}
async function mwUpload() {
  const k = C.today(), dec = dayDecision(k), t = DATA.days.find(d => d.key === k), adj = C.adjustToday(dec, t, U.checkIns[k]);
  const w = dec.workout; if (!w || w.sport === 'run') return;
  const steps = adj ? adj.steps : w.steps, sug = MW.suggestion(w, steps, MWLIST || []);
  toast('Carico su MyWhoosh…');
  try {
    await MW.uploadToday(MW.account(DATA), sug, [w.why, ...(adj?.why || [])].filter(Boolean).join(' '), w.intensity, ftp(), MWLIST || []);
    MWSTATE = ''; await new Promise(r => setTimeout(r, 1500)); await loadMyWhoosh(); toast('Caricato su MyWhoosh: Allenamenti › I miei allenamenti');
  } catch (e) { MWSTATE = e.message; route(); toast('Caricamento non riuscito'); }
}
async function mwLibrary() {
  const acc = MW.account(DATA);
  if (!MWLIST) await loadMyWhoosh();
  const r = await MW.installLibrary(acc, MWLIST || [], ftp(), t => toast(t, 1500));
  toast(r.ok || r.ko ? `Caricati ${r.ok}${r.ko ? `, ${r.ko} non riusciti` : ''}` : 'Erano già tutti su MyWhoosh');
  await new Promise(x => setTimeout(x, 1500)); loadMyWhoosh();
}

// ---------- corsa con l'AI ----------
function openRunAI() {
  const k = C.today(), prev = U.aiRuns[k];
  const dec = C.decision(DATA, U, k), planned = dec.session ? C.planWorkout(dec.session) : dec.baseWorkout;
  const base = planned ? `Oggi ${U.goal ? 'il piano' : 'il programma base'} prevede <b>${esc(C.title(planned))}</b> (${planned.minutes}'): l'AI parte da qui e da come hai dormito.` : `Oggi ${U.goal ? 'il piano' : 'il programma base'} prevede riposo: la corsa sarà tenuta facile.`;
  sheet("Oggi corro con l'AI", `<div class="card"><div class="sub">${base}</div>
    <textarea id="runNote" rows="3" placeholder="Come stai, quanto tempo hai, con chi corri…" style="width:100%;border:1px solid var(--line);border-radius:12px;padding:10px;background:var(--bg);resize:vertical">${esc(prev?.note || '')}</textarea>
    <div class="sugg">${AI.SUGGESTIONS.map(s => `<button data-runsay="${esc(s)}">${esc(s)}</button>`).join('')}</div>
    <button class="btn" id="runGo">${ic('sparkles')}Programma la corsa</button>
    <div class="tiny">${geminiKey() ? 'Risponde Gemini (gratis). La corsa è tutta a tempo.' : 'Gemini non è collegato (chiave in Account): la prepara il coach dalle frasi tipiche.'}</div></div>
    <div id="runOut"></div>`);
  $('#modal').onclick = e => { const b = e.target.closest('[data-runsay]'); if (b) $('#runNote').value = b.dataset.runsay; };
  $('#runGo').onclick = async () => {
    const note = $('#runNote').value.trim();
    if (!note) return toast('Scrivi come stai o tocca una frase');
    const btn = $('#runGo'); btn.disabled = true; btn.innerHTML = `<div class="spinner" style="width:20px;height:20px;border-width:2px"></div>Programmo…`;
    const max = AI.maxMinutes(U);
    let run = null, model = 'coach', warn = '';
    if (geminiKey()) {
      try { run = await AI.gemini(geminiKey(), note, AI.context(DATA, U, dec), max); model = 'Gemini'; }
      catch (e) { warn = e.message; }
    }
    if (!run) run = AI.rulePlan(note, max, dec.light);
    btn.disabled = false; btn.innerHTML = `${ic('sparkles')}Programma di nuovo`;
    if (!run) { $('#runOut').innerHTML = `<div class="banner">${esc(warn || 'Non ho capito: scrivi quanti minuti hai, come ti senti o con chi corri (per esempio "corro con mia moglie 45 minuti").')}</div>`; return; }
    const r = { ...run, key: k, note, model };
    const w = AI.toWorkout(r);
    $('#runOut').innerHTML = `${warn ? `<div class="banner">${esc(warn)} Ho usato il coach sulle tue parole.</div>` : ''}
      <section class="card"><div class="card-title">${ic('walk')}${esc(w.name)}</div><div class="chips"><span class="chip">${w.minutes} min</span><span class="chip">corsa a tempo</span><span class="chip">${model === 'Gemini' ? 'Gemini' : 'coach sulle tue parole'}</span></div>
      ${profile(w.steps)}${stepsTable(w, w.steps)}<div class="sub">${esc(r.explanation)}</div>
      <button class="btn" id="runSave">${ic('checkmark-circle')}Usa questa corsa oggi</button></section>`;
    $('#runSave').onclick = () => { U.aiRuns[k] = r; for (const x of Object.keys(U.aiRuns)) if (x < C.addDays(k, -7)) delete U.aiRuns[x]; saveU(); closeSheet(); route(); toast('Corsa di oggi impostata'); };
  };
}

// ---------- azioni ----------
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-act],[data-kind],[data-mix],[data-week],[data-cat],[data-eat],[data-undo]');
  if (!t) { if (e.target.id === 'modal') closeSheet(); return; }
  const a = t.dataset.act, k = C.today();
  if (a === 'close') return closeSheet();
  if (a === 'sheet-ok') return sheet.ok && sheet.ok();
  if (a === 'reload') return location.reload();
  if (a === 'refresh') return refreshNow();
  if (a === 'ghon') return openGhSetup(() => { route(); refreshNow(); });
  if (a === 'ghoff') { store.set(GH_KEY, ''); route(); return toast('GitHub scollegato da questo dispositivo'); }
  if (a === 'checkin') return openCheckIn();
  if (a === 'runai') return openRunAI();
  if (a === 'runai-del') { delete U.aiRuns[k]; saveU(); route(); return toast('Torna l\'allenamento previsto'); }
  if (a === 'mwupload') return mwUpload();
  if (a === 'mwlib') return mwLibrary();
  if (a === 'naps') return openNaps();
  if (a === 'info') return openInfo(t.dataset.id);
  if (a === 'prontezza') return sheet('Prontezza', `<section class="card"><div class="sub" style="display:flex;flex-direction:column;gap:10px">
    <p style="margin:0"><b>Notte (40%)</b> — come fa WHOOP: HRV, FC a riposo, sonno, respirazione e stress di stanotte confrontati con le tue ultime 4 settimane. Vede subito una notte storta, ma da sola è ballerina.</p>
    <p style="margin:0"><b>Tendenza (25%)</b> — media dell'HRV degli ultimi 7 giorni rispetto alle 4 settimane prima, meno il debito di sonno delle ultime 3 notti. È il metodo usato negli studi sull'allenamento guidato dall'HRV: conta la media, non il singolo giorno.</p>
    <p style="margin:0"><b>Garmin (35%)</b> — la Training Readiness <i>del mattino</i>, l'unica che considera carico e tempo di recupero. Quella che vedi in Garmin Connect cambia durante il giorno (sale dopo un sonnellino): qui conta quella dopo il risveglio.</p>
    <p style="margin:0"><b>Campanelli d'allarme</b> — se HRV crolla e FC a riposo sale insieme, il punteggio non supera 45 anche se Garmin è ottimista; con anche la respirazione alta (possibile malanno) non supera 30; con 2 notti su 3 sotto le 6 ore non supera 60.</p>
    <p style="margin:0"><b>Semaforo</b> — verde da 67, giallo da 34, rosso sotto. Verde: seduta come da programma. Giallo: fondo sì, intensità no. Rosso: solo recupero.</p></div></section>`);
  if (a === 'setup') return openSetup();
  if (a === 'chat') return openChat();
  if (a === 'dietmenu') return openDietMenu();
  if (a === 'doses') return openDoses();
  if (a === 'dosereset') { DIET.doses = {}; D.save(DIET); closeSheet(); route(); return toast('Dosi del programma ripristinate'); }
  if (a === 'dietreset') { if (confirm('Azzerare tutte le spunte di questa settimana?')) { D.resetWeek(DIET); closeSheet(); route(); } return; }
  if (a === 'delgoal') { if (confirm('Eliminare il piano di allenamento? Le attività e i dati Garmin restano.')) { U.goal = null; U.chat = []; saveU(); route(); } return; }
  if (a === 'extra' && U.goal) { const ctx = chatCtx(); const msg = C.addExtra(U.goal, k, ctx.load, ctx.light, ctx.feeling); saveU(); route(); return toast(msg, 6000); }
  if (a === 'extra' && !U.goal) return toast('Crea prima un piano nella scheda Piano');
  if (a === 'unextra' && U.goal) { const msg = C.removeExtra(U.goal, k); saveU(); route(); return toast(msg); }
  if (a === 'copylink') { try { await navigator.clipboard.writeText(privateLink()); toast('Link privato copiato'); } catch { prompt('Copia il link privato:', privateLink()); } return; }
  if (a === 'export') {
    const blob = new Blob([JSON.stringify({ app: 'Coach Garmin Web', salvato: new Date().toISOString(), utente: U, dieta: DIET }, null, 1)], { type: 'application/json' });
    const l = document.createElement('a'); l.href = URL.createObjectURL(blob); l.download = `coach-garmin-copia-${k}.json`; l.click(); return;
  }
  if (a === 'wipe') { if (confirm('Cancellare piano, check-in e dieta da questo dispositivo?')) { localStorage.removeItem(UKEY); localStorage.removeItem('coachgarmin:dieta'); location.reload(); } return; }
  if (t.dataset.kind && U.goal) { U.goal.kind = t.dataset.kind; saveU(); return route(); }
  if (t.dataset.mix && U.goal) { U.goal.mix = t.dataset.mix; saveU(); return route(); }
  if (t.dataset.week) { weekOffset += +t.dataset.week; return route(); }
  if (t.dataset.cat) { dietCat = t.dataset.cat; return route(); }
  if (t.dataset.eat) { D.eat(DIET, t.dataset.eat); const it = D.item(DIET, t.dataset.eat); toast(`Segnato: ${it ? it.name : 'pasto libero'}`); return route(); }
  if (t.dataset.undo) { D.undo(DIET, t.dataset.undo); return route(); }
});

// ---------- avvio ----------
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { });
if (!location.hash) history.replaceState(null, '', location.pathname + location.search + '#/oggi');
loadData();
