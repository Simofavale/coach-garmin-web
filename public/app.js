// Coach Garmin Web — interfaccia. Dati Garmin da api/garmin.json (cifrati sul sito pubblicato),
// sensazioni, piano e dieta salvati su questo dispositivo (localStorage).
import * as C from './coach.js';
import * as D from './dieta.js';
import { ic } from './icons.js';
import * as AI from './ai.js';
import * as MW from './mywhoosh.js';
import * as X from './extra.js';

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
const geminiKey = () => store.get(GKEY, '') || DATA?.geminiKey || '';
let MWLIST = null, MWSTATE = '';   // allenamenti salvati su MyWhoosh (letti all'apertura)
const saveU = () => store.set(UKEY, U);
let DATA = null, DIET = D.load(), weekOffset = 0, dietCat = 'carbo', loading = false;
/** FTP in uso: a mano, MyWhoosh, Garmin, oppure automatica (MyWhoosh se c'è, misurata sui rulli). */
const ftpSource = () => U.ftpSource || (U.ftpManual ? 'manual' : 'auto');
const ftp = () => { const src = ftpSource(), mw = DATA?.mwFtp || 0, g = DATA?.ftp || 0; return src === 'manual' ? (U.ftpManual || mw || g) : src === 'mywhoosh' ? (mw || g) : src === 'garmin' ? (g || mw) : (mw || g); };
const ftpConflict = () => ftpSource() === 'auto' && DATA?.mwFtp && DATA?.ftp && DATA.mwFtp !== DATA.ftp;
const title4 = a => U.names?.[a.id] || a.garminName || a.type;

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
      const extra = C.registerUnplanned(U.goal, DATA.activities);
      const msg = C.updateProgression(U.goal, DATA.days, DATA.activities, U.checkIns);
      if (extra || msg) { saveU(); toast([extra, msg].filter(Boolean).join(' '), 7000); }
    }
    // non ridisegna mentre stai scrivendo in un campo (altrimenti quello che incolli sparisce)
    const typing = document.activeElement?.matches?.('#view input, #view textarea');
    if ((changed || !quiet) && !typing) route();
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
  const before = DATA?.updated || 0;
  runOnGitHub(null, 'Aggiorno da Garmin', v => v.updated > before, async () => { await loadData(); toast('Dati Garmin aggiornati adesso'); }, () => refreshNow());
}
/** Avvia il workflow su GitHub (con una richiesta cifrata, se c'è) e aspetta che `done(version)` sia vero. */
async function runOnGitHub(richiesta, label, done, onDone, retry) {
  const r = repoInfo();
  if (!r) return toast('Funziona solo dal sito pubblicato (link privato).');
  if (!ghToken()) return openGhSetup(retry);
  try {
    const res = await fetch(`https://api.github.com/repos/${r.owner}/${r.repo}/actions/workflows/aggiorna.yml/dispatches`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + ghToken(), Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main', ...(richiesta ? { inputs: { richiesta } } : {}) }),
    });
    if (res.status === 401 || res.status === 403 || res.status === 404) { store.set(GH_KEY, ''); toast('Autorizzazione GitHub non valida: ricollegala', 5000); return openGhSetup(retry); }
    if (!res.ok) throw new Error('GitHub ha risposto ' + res.status);
  } catch (e) { return toast('Non riesco ad avviare: ' + e.message, 5000); }
  toast(richiesta ? 'Richiesta inviata a GitHub' : 'Aggiornamento avviato', 3000);
  // aspetta il risultato (di solito 1–2 minuti) mostrando il tempo che passa
  const t0 = Date.now();
  refreshing = setInterval(async () => {
    const sec = Math.round((Date.now() - t0) / 1000);
    toast(`${label}… ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`, 12e3);
    setSpin(true);
    let v = null;
    try { v = await (await fetch('api/version.json?t=' + Date.now(), { cache: 'no-store' })).json(); } catch { }
    if (v && done(v)) { clearInterval(refreshing); refreshing = null; await onDone(); }
    else if (sec > 300) { clearInterval(refreshing); refreshing = null; setSpin(false); toast('Ci sta mettendo più del solito: il risultato arriverà da solo fra poco.', 5000); }
  }, 4000);
}
/** Cifra la richiesta con la chiave del link privato: solo GitHub (che ha la stessa chiave segreta) la può leggere. */
async function encryptRequest(obj) {
  const k = getKey(); if (!k) throw new Error('Apri la web app dal link privato.');
  const key = await crypto.subtle.importKey('raw', b64(k.replace(/-/g, '+').replace(/_/g, '/') + '='), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj))));
  const enc64 = u => btoa(String.fromCharCode(...u));
  return JSON.stringify({ enc: 1, gz: 0, iv: enc64(iv), data: enc64(data) });
}
async function sendLink(obj, label) {
  if (refreshing) return toast('Aspetta: c\'è già un\'operazione in corso.');
  const id = Math.random().toString(36).slice(2, 10);
  let richiesta;
  try { richiesta = await encryptRequest({ ...obj, id, at: Date.now() }); } catch (e) { return toast(e.message, 5000); }
  closeSheet();
  runOnGitHub(richiesta, label, v => v.esito === id, async () => {
    await loadData();
    const e = DATA.esito;
    if (e?.ok) { toast(e.msg, 6000); if (obj.tipo === 'mywhoosh') { MWLIST = null; loadMyWhoosh(); } }
    else if (obj.tipo === 'azione') sheet('Modifica non riuscita', `<div class="banner">${esc(e?.msg || 'Errore sconosciuto.')}</div>`);
    else sheet('Collegamento non riuscito', `<div class="banner">${esc(e?.msg || 'Errore sconosciuto.')}</div><button class="btn" data-act="${obj.tipo === 'garmin' ? 'linkgarmin' : 'linkmw'}">Riprova</button>`);
  }, () => sendLink(obj, label));
}
function openLinkGarmin() {
  sheet('Collega Garmin', `<section class="card"><div class="sub">Scrivi email e password del tuo account <b>Garmin Connect</b>. Partono cifrate, servono una volta sola per entrare e <b>non vengono salvate</b>: si conserva solo il codice di accesso, cifrato.</div>
    <div class="form"><div class="field"><input type="email" id="gEmail" placeholder="Email Garmin" autocomplete="username" autocapitalize="off" spellcheck="false" style="max-width:none;width:100%;background:var(--fill);border:0;border-radius:8px;padding:6px 10px"></div>
    <div class="field"><input type="password" id="gPass" placeholder="Password Garmin" autocomplete="current-password" style="max-width:none;width:100%;background:var(--fill);border:0;border-radius:8px;padding:6px 10px"></div></div>
    <p id="gMsg" class="tiny" style="margin:0"></p>
    <div class="tiny">Garmin non accetta accessi da una pagina web: l'accesso lo fa GitHub per te (circa un minuto). Se il tuo account ha la verifica in due passaggi, per ora non funziona.</div></section>`,
  { right: 'Collega', left: 'Annulla' });
  sheet.ok = () => {
    const email = $('#gEmail').value.trim(), password = $('#gPass').value;
    if (!/@/.test(email) || !password) { $('#gMsg').textContent = 'Scrivi email e password.'; return; }
    sendLink({ tipo: 'garmin', email, password }, 'Collego Garmin');
  };
}
function openLinkMyWhoosh() {
  sheet('Collega MyWhoosh', `<section class="card"><div class="sub">Scrivi email e password con cui entri in MyWhoosh. Partono cifrate e vengono <b>conservate cifrate</b> (le può leggere solo GitHub) per rinnovare da solo l'accesso, che MyWhoosh fa scadere ogni 15 giorni.</div>
    <div class="form"><div class="field"><input type="text" class="wide" id="mwEmail" placeholder="Email MyWhoosh" autocomplete="username" autocapitalize="off" spellcheck="false" style="max-width:none;width:100%"></div>
    <div class="field"><input type="password" id="mwPass" placeholder="Password MyWhoosh" autocomplete="current-password" style="max-width:none;width:100%;background:var(--fill);border:0;border-radius:8px;padding:6px 10px"></div></div>
    <p id="mwMsg" class="tiny" style="margin:0"></p><div class="tiny">Il collegamento passa da GitHub e richiede 1–2 minuti.</div></section>`,
  { right: 'Collega', left: 'Annulla' });
  sheet.ok = () => {
    const email = $('#mwEmail').value.trim(), password = $('#mwPass').value;
    if (!/@/.test(email) || !password) { $('#mwMsg').textContent = 'Scrivi email e password.'; return; }
    sendLink({ tipo: 'mywhoosh', email, password }, 'Collego MyWhoosh');
  };
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
    $('#view').innerHTML = `<div class="empty">${ic('warning')}<h3>Garmin non ancora collegato</h3><p>Collega il tuo account Garmin: lo fai da qui in un minuto.</p><button class="btn" style="max-width:320px" data-act="linkgarmin">${ic('pulse')}Collega Garmin</button></div>`;
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
  // il sonno della notte, interattivo
  out.push(sleepCard());
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
  const ins = X.insights(t, days, DATA.activities);
  if (ins.length) out.push(`<section class="card"><div class="card-title">${ic('sparkles')}Cosa dicono i tuoi dati</div><div class="sub">${esc(X.insightSummary(ins))}</div>
    ${ins.map((x, i) => `<details class="ins"><summary><span style="color:${x.color}">${ic(x.icon)}</span><span class="grow strong">${esc(x.title)}</span><span class="mono" style="color:${x.tone === 'good' ? '#2ecc71' : x.tone === 'watch' ? 'var(--orange)' : 'var(--ink-2)'}">${esc(x.value)}</span></summary>
      <div class="sub" style="display:flex;flex-direction:column;gap:6px;padding:4px 0 6px 30px"><b style="color:var(--ink)">${esc(x.headline)}</b><span>${esc(x.detail)}</span>${x.tip ? `<span style="color:var(--accent-ink)"><b>Oggi:</b> ${esc(x.tip)}</span>` : ''}</div></details>`).join('')}
    <div class="tiny">Interpretazioni generali di fisiologia dello sport, non diagnosi.</div></section>`);
  out.push(card('Oggi nel pratico', 'checkmark-circle', dec.practical.map((p, i) => `<div class="bullet"><span class="chip" style="min-width:22px;text-align:center;align-self:flex-start">${i + 1}</span><span>${esc(p)}</span></div>`).join('')));
  if (dec.dataWarnings.length) out.push(card('Controllo dati', 'warning', dec.dataWarnings.map(x => bullet(x, 'information-circle', 'var(--orange)')).join('')));
  $('#view').innerHTML = out.join('');
  bindSleep();
}
/** Le tre parti della Prontezza: notte (stile WHOOP), tendenza HRV 7 giorni, readiness Garmin del mattino. */
function partsBars(rec) {
  const p = rec.parts || {};
  const row = (label, v, extra = '') => v == null ? '' : `<div class="part"><span>${label}</span><i><b style="width:${v}%;background:${C.LIGHT[C.lightFrom(v)].color}"></b></i><em class="mono">${v}</em>${extra}</div>`;
  const out = row('Notte', p.notte) + row('Tendenza', p.tendenza) + row('Garmin', p.garmin, p.garminOra != null && p.garminOra !== p.garmin ? `<small>ora ${p.garminOra}</small>` : '');
  return out ? `<div class="parts">${out}</div>` : `<p class="sub" style="margin:8px 0 0">${esc(rec.recovery != null ? 'Stima dai dati di stanotte' : 'Dati insufficienti')}</p>`;
}
// ---------- grafico del sonno (ipnogramma) ----------
const PHASES = [['Profondo', '#2b3fa8'], ['Leggero', '#4f8ff7'], ['REM', '#b061e8'], ['Sveglio', '#f2b92d']];
const SLEEP_LAYERS = [['hr', 'Battito', '#ff3b30', 'bpm'], ['bb', 'Batteria', '#30b0c7', ''], ['hrv', 'HRV', '#ff2d55', 'ms'], ['stress', 'Stress', '#ff9500', '']];
let sleepIdx = 0, sleepLayer = 'hr';
const nights = () => DATA.days.filter(d => d.night).slice().reverse();
function sleepCard() {
  const list = nights();
  if (!list.length) return '';
  sleepIdx = Math.min(sleepIdx, list.length - 1);
  const d = list[sleepIdx], n = d.night;
  const tot = [0, 0, 0, 0]; for (const [a, b, l] of n.levels) tot[l] += (b - a) / 60e3;
  const asleep = n.levels.find(l => l[2] !== 3)?.[0] ?? n.start, woke = [...n.levels].reverse().find(l => l[2] !== 3)?.[1] ?? n.end;
  const wakes = n.levels.filter((l, i) => l[2] === 3 && i > 0 && i < n.levels.length - 1).length;
  const all = (n.end - n.start) / 60e3;
  return `<section class="card" id="sleepCard">
    <div class="week-head"><button data-act="nightprev" aria-label="Notte prima" ${sleepIdx >= list.length - 1 ? 'disabled style="opacity:.3"' : ''}>${ic('chevron-back')}</button>
      <span style="display:flex;align-items:center;gap:6px;font-size:15px">${ic('moon')}Notte di ${C.pretty(C.addDays(d.key, -1), 'day').toLowerCase()}</span>
      <button data-act="nightnext" aria-label="Notte dopo" ${sleepIdx === 0 ? 'disabled style="opacity:.3"' : ''}>${ic('chevron-forward')}</button></div>
    <div class="sleep-top">
      <div><div class="k">Addormentato</div><div class="v mono">${hhmm(asleep)}</div></div>
      <div><div class="k">Sveglio</div><div class="v mono">${hhmm(woke)}</div></div>
      <div><div class="k">Dormito</div><div class="v mono">${d.sleepHours != null ? C.hm(d.sleepHours) : '–'}</div></div>
      <div><div class="k">Risvegli</div><div class="v mono">${wakes}</div></div>
    </div>
    <div class="hyp" id="hyp">${hypnogram(n)}<div class="hyp-cursor" hidden></div></div>
    <div class="hyp-info" id="hypInfo"><span class="tiny">Tocca o trascina il dito sul grafico per vedere ogni momento della notte.</span></div>
    <div class="seg">${SLEEP_LAYERS.filter(([k]) => n[k]?.length).map(([k, l]) => `<button class="${sleepLayer === k ? 'on' : ''}" data-layer="${k}">${l}</button>`).join('')}</div>
    <div class="phases">${PHASES.map(([l, c], i) => `<div><span class="dot" style="background:${c}"></span><span class="grow">${l}</span><b class="mono" style="white-space:nowrap">${hmin(Math.round(tot[i]))}</b><span class="tiny">${Math.round(tot[i] / all * 100)}%</span></div>`).join('')}</div>
  </section>`;
}
/** SVG: fasi a gradini (sveglio in alto, profondo in basso) + la curva scelta sotto. */
function hypnogram(n) {
  const W = 340, H = 150, top = 6, rowH = 22, rows = 4, t0 = n.start, t1 = n.end, X = t => ((t - t0) / (t1 - t0)) * W;
  const rowY = l => top + (3 - l) * rowH;
  let bars = '', path = '';
  n.levels.forEach(([a, b, l], i) => {
    const x = X(a), w = Math.max(0.8, X(b) - X(a)), y = rowY(l);
    bars += `<rect x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${rowH - 3}" rx="3" fill="${PHASES[l][1]}"/>`;
    path += `${i ? 'L' : 'M'}${x.toFixed(1)},${y + rowH / 2 - 1.5}L${(x + w).toFixed(1)},${y + rowH / 2 - 1.5}`;
  });
  const lay = SLEEP_LAYERS.find(([k]) => k === sleepLayer && n[k]?.length) || SLEEP_LAYERS.find(([k]) => n[k]?.length);
  let curve = '';
  if (lay) {
    const pts = n[lay[0]], ys = pts.map(p => p[1]), lo = Math.min(...ys), hi = Math.max(...ys), cy0 = top + rows * rowH + 8, ch = H - cy0 - 14;
    const Y = v => cy0 + ch - ((v - lo) / (hi - lo || 1)) * ch;
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');
    curve = `<path d="${line}" fill="none" stroke="${lay[2]}" stroke-width="1.6" stroke-linejoin="round"/><text x="2" y="${cy0 + 7}" class="hyp-lbl">${hi}</text><text x="2" y="${cy0 + ch}" class="hyp-lbl">${lo}</text>`;
  }
  let ticks = ''; const h0 = new Date(t0); h0.setMinutes(0, 0, 0);
  for (let t = +h0 + 3600e3; t < t1; t += 3600e3) { const x = X(t); ticks += `<line x1="${x}" x2="${x}" y1="${top}" y2="${H - 12}" class="hyp-grid"/><text x="${x}" y="${H - 1}" class="hyp-lbl" text-anchor="middle">${new Date(t).getHours()}</text>`; }
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="hyp-svg">${ticks}<path d="${path}" fill="none" stroke="var(--line)" stroke-width="1"/>${bars}${curve}</svg>
    <div class="hyp-rows">${PHASES.slice().reverse().map(([l]) => `<span>${l}</span>`).join('')}</div>`;
}
function redrawSleep() { const c = $('#sleepCard'); if (!c) return; c.outerHTML = sleepCard(); bindSleep(); }
function bindSleep() {
  const box = $('#hyp'); if (!box) return;
  const n = nights()[sleepIdx]?.night; if (!n) return;
  const cur = box.querySelector('.hyp-cursor'), info = $('#hypInfo'), svg = box.querySelector('svg');
  const near = (arr, t) => { if (!arr?.length) return null; let b = arr[0]; for (const p of arr) if (Math.abs(p[0] - t) < Math.abs(b[0] - t)) b = p; return Math.abs(b[0] - t) < 15 * 60e3 ? b[1] : null; };
  const show = ev => {
    const pt = ev.touches?.[0] || ev, r = svg.getBoundingClientRect(), x = Math.max(0, Math.min(r.width, pt.clientX - r.left));
    const t = n.start + (x / r.width) * (n.end - n.start);
    const seg = n.levels.find(([a, b]) => t >= a && t < b) || n.levels[n.levels.length - 1];
    const [l, c] = PHASES[seg[2]];
    cur.hidden = false; cur.style.left = `${x}px`;
    const extra = SLEEP_LAYERS.map(([k, lab, , u]) => { const v = near(n[k], t); return v != null ? `${lab} <b>${v}${u ? ' ' + u : ''}</b>` : null; }).filter(Boolean).join(' · ');
    info.innerHTML = `<span class="dot" style="background:${c}"></span><b class="mono">${hhmm(t)}</b> <b style="color:${c}">${l}</b> <span class="tiny">da ${hhmm(seg[0])} a ${hhmm(seg[1])} (${durata(Math.round((seg[1] - seg[0]) / 60e3))})</span><div class="tiny">${extra}</div>`;
    if (ev.cancelable && ev.type === 'touchmove') ev.preventDefault();
  };
  box.addEventListener('pointerdown', show);
  box.addEventListener('pointermove', e => { if (e.buttons || e.pointerType !== 'mouse') show(e); });
  box.addEventListener('touchmove', show, { passive: false });
}
const hrvStatus = s => ({ BALANCED: 'bilanciata', LOW: 'bassa', UNBALANCED: 'sbilanciata', POOR: 'scarsa' })[String(s).toUpperCase()] || String(s).toLowerCase();
const feedback = s => String(s).replace(/_/g, ' ').toLowerCase().replace(/^\w/, c => c.toUpperCase());

function sheet(title, body, { right = '', left = 'Chiudi', onOpen } = {}) {
  const m = $('#modal');
  m.onclick = null; m.onchange = null;
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
  const k = C.today();
  const list = DATA.days.slice(-7).reverse().map(d => {
    const naps = d.naps || [];
    const rows = naps.map(n => `<div class="row"><span class="grow mono">${hhmm(n.start)}–${hhmm(n.end)} · ${durata(Math.round((n.end - n.start) / 60e3))}</span>${d.key === k ? `<button class="chip" data-act="napedit" data-day="${d.key}" data-start="${n.start}" data-end="${n.end}">Modifica</button>` : ''}<button class="chip" style="color:var(--red)" data-act="napdel" data-day="${d.key}" data-start="${n.start}">Elimina</button></div>`).join('');
    return `<div class="li" style="flex-direction:column;align-items:stretch;gap:4px"><div class="ttl">${C.pretty(d.key)}</div>${rows || `<div class="sub">${d.napMin ? `${d.napMin} min in tutto` : 'nessuno'}</div>`}</div>`;
  }).join('');
  sheet('Sonnellini', `<button class="btn" data-act="napnew">${ic('add')}Aggiungi un sonnellino di oggi</button><div class="list">${list}</div>
    <p class="tiny" style="margin:0 4px">Garmin accetta nuovi sonnellini solo per oggi e già finiti. Le modifiche passano da GitHub e arrivano in 1–2 minuti.</p>`);
}
function openNapForm(day, start, end) {
  const now = new Date(), t = ms => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const s0 = start ? t(start) : t(now - 40 * 60e3), e0 = end ? t(end) : t(now - 10 * 60e3);
  sheet(start ? 'Modifica sonnellino' : 'Nuovo sonnellino', `<div class="form"><div class="field"><span>Inizio</span><input type="time" id="napS" value="${s0}"></div><div class="field"><span>Fine</span><input type="time" id="napE" value="${e0}"></div></div>
    <p id="napMsg" class="tiny" style="margin:0 4px">Solo sonnellini di oggi, già finiti.</p>`, { right: 'Salva', left: 'Annulla' });
  sheet.ok = () => {
    const k = C.today(), [sh, sm] = $('#napS').value.split(':').map(Number), [eh, em] = $('#napE').value.split(':').map(Number);
    const base = C.toDate(k); base.setHours(0, 0, 0, 0);
    const ns = +base + (sh * 60 + sm) * 60e3, ne = +base + (eh * 60 + em) * 60e3;
    if (!(ne > ns) || ne > Date.now()) { $('#napMsg').textContent = 'La fine deve essere dopo l\'inizio e non nel futuro.'; return; }
    if (start) sendAction({ azione: 'sonnellino-del', day, start, then: { azione: 'sonnellino-add', day: k, start: ns, end: ne } }, 'Modifico il sonnellino');
    else sendAction({ azione: 'sonnellino-add', day: k, start: ns, end: ne }, 'Salvo il sonnellino');
  };
}
/** Modifica su Garmin passando da GitHub (come i collegamenti). */
function sendAction(obj, label) { sendLink({ tipo: 'azione', ...obj }, label); }

// ---------- sveglie e posizione della CIRQA ----------
const WEAR = { LEFT_WRIST: 'Polso sinistro', RIGHT_WRIST: 'Polso destro', LEFT_UPPER_ARM: 'Braccio sinistro (in alto)', RIGHT_UPPER_ARM: 'Braccio destro (in alto)' };
const DAYS = [['M', 'Lu'], ['Tu', 'Ma'], ['W', 'Me'], ['Th', 'Gi'], ['F', 'Ve'], ['Sa', 'Sa'], ['Su', 'Do']];
const alarmTime = m => `${String(Math.floor((m || 0) / 60)).padStart(2, '0')}:${String((m || 0) % 60).padStart(2, '0')}`;
function alarmDays(d) {
  const ds = (d || []).filter(x => x !== 'ONCE');
  if (!ds.length) return 'una volta';
  if (ds.length === 7) return 'tutti i giorni';
  if (ds.length === 5 && ['M', 'Tu', 'W', 'Th', 'F'].every(x => ds.includes(x))) return 'lun–ven';
  return DAYS.filter(([k]) => ds.includes(k)).map(([, l]) => l).join(' ');
}
let ALARMS = null;
function openAlarms() {
  const cq = DATA.cirqa; if (!cq) return;
  ALARMS = ALARMS || (cq.alarms || []).map(a => ({ ...a, _orig: JSON.stringify(a) }));
  const draw = () => {
    $('#alBody').innerHTML = (ALARMS.filter(a => !a._del).map((a, i) => `<div class="li"><div class="grow link" data-act="alarmedit" data-i="${ALARMS.indexOf(a)}"><div class="ttl mono" style="font-size:22px">${alarmTime(a.alarmTime)}</div><div class="sub">${alarmDays(a.alarmDays)} · ${a.alarmSound === 'VIBRATION' ? 'vibrazione' : a.alarmSound === 'TONE' ? 'suono' : 'suono e vibrazione'}</div></div>
      <label class="switch"><input type="checkbox" data-alon="${ALARMS.indexOf(a)}" ${a.alarmMode === 'ON' ? 'checked' : ''}><i></i></label></div>`).join('') || '<div class="li sub">Nessuna sveglia</div>');
  };
  sheet(`Sveglie ${cq.name}`, `<div class="list" id="alBody"></div><button class="btn soft" data-act="alarmnew">${ic('add')}Nuova sveglia</button>
    <p class="tiny" style="margin:0 4px">Le sveglie arrivano alla band alla prossima sincronizzazione con Garmin Connect. La sveglia smart per la CIRQA Garmin non la espone.</p>`, { right: 'Invia', left: 'Annulla', onOpen: draw });
  $('#modal').onchange = e => { const i = e.target.dataset?.alon; if (i != null) ALARMS[+i].alarmMode = e.target.checked ? 'ON' : 'OFF'; };
  sheet.ok = () => {
    const list = ALARMS.map(a => {
      const { _orig, _del, _new, ...d } = a;
      if (_new) delete d.alarmId;
      if (!d.alarmDays?.length) d.alarmDays = ['ONCE'];
      return { ...d, changeState: _del ? 'DELETED' : _new ? 'NEW' : JSON.stringify(Object.fromEntries(Object.entries(a).filter(([k]) => !k.startsWith('_')))) === _orig ? 'UNCHANGED' : 'CHANGED' };
    }).filter(a => !(a.changeState === 'DELETED' && !a.alarmId));
    ALARMS = null;
    sendAction({ azione: 'sveglie', alarms: list }, 'Invio le sveglie');
  };
  openAlarms.redraw = draw;
}
function openAlarmEdit(i) {
  const a = i == null ? { alarmTime: 420, alarmDays: ['M', 'Tu', 'W', 'Th', 'F'], alarmMode: 'ON', alarmSound: 'VIBRATION', ...(ALARMS[0] ? { backlight: ALARMS[0].backlight } : {}), _new: true } : ALARMS[i];
  const days = new Set((a.alarmDays || []).filter(x => x !== 'ONCE'));
  const back = () => openAlarms();
  sheet(i == null ? 'Nuova sveglia' : 'Modifica sveglia', `<div class="form"><div class="field"><span>Ora</span><input type="time" id="alT" value="${alarmTime(a.alarmTime)}"></div>
    <div class="daypick">${DAYS.map(([k, l]) => `<button class="${days.has(k) ? 'on' : ''}" data-alday="${k}">${l}</button>`).join('')}</div>
    <div class="field"><span>Avviso</span><select id="alS"><option value="VIBRATION">Vibrazione</option><option value="TONE">Suono</option><option value="TONE_AND_VIBRATION">Suono e vibrazione</option></select></div></div>
    <div class="tiny" style="margin:0 4px">Nessun giorno = una volta sola.</div>${i != null ? '<button class="btn danger" data-act="alarmdel">Elimina la sveglia</button>' : ''}`,
  { right: 'Fatto', left: 'Indietro', onOpen: m => { m.querySelector('#alS').value = a.alarmSound || 'VIBRATION'; } });
  $('#modal').onclick = e => { const b = e.target.closest('[data-alday]'); if (b) { const k = b.dataset.alday; days.has(k) ? days.delete(k) : days.add(k); b.classList.toggle('on'); } if (e.target.closest('[data-act=alarmdel]')) { a._del = true; back(); } };
  sheet.ok = () => {
    const [h, m] = $('#alT').value.split(':').map(Number);
    Object.assign(a, { alarmTime: h * 60 + m, alarmDays: days.size ? DAYS.map(([k]) => k).filter(k => days.has(k)) : ['ONCE'], alarmSound: $('#alS').value });
    if (i == null) ALARMS.push(a);
    back();
  };
}
function openWear() {
  const cq = DATA.cirqa; if (!cq) return;
  sheet(`Posizione della ${cq.name}`, `<div class="list">${Object.entries(WEAR).map(([k, l]) => `<button class="li" style="width:100%;text-align:left" data-act="wearset" data-v="${k}"><span class="grow">${l}</span>${cq.mountingSide === k ? `<span style="color:var(--accent)">${ic('checkmark-circle')}</span>` : ''}</button>`).join('')}</div>
    <p class="tiny" style="margin:0 4px">Indica a Garmin dove porti la band: serve per misure di battito e sonno più precise.</p>`);
}

// ---------- corse sull'orologio ----------
function wantedRuns() {
  const out = {}, k = C.today();
  for (let i = 0; i < 7; i++) {
    const d = C.addDays(k, i);
    let w = null;
    if (i === 0) { const dec = dayDecision(d); if (dec.workout?.sport === 'run' && !dec.stopWarning) w = dec.workout; }
    else if (U.goal) { const s = C.session(U.goal, d); if (s && s.sport === 'run' && s.minutes > 0) w = C.planWorkout(s); }
    if (!w) continue;
    const name = `CG Corsa ${C.pretty(d, 'ddmm')} ` + w.name.replace(/^Corsa /, '').replace(/^\w/, c => c.toUpperCase());
    out[d] = { name, goal: w.goal || w.why || '', steps: w.steps.map(st => ({ seconds: st.seconds, power: st.power, cadence: st.cadence, note: st.note })), sig: name + '|' + w.steps.map(st => `${st.seconds}-${Math.round(st.power * 100)}`).join(',') };
  }
  return out;
}
function sendRuns() { sendAction({ azione: 'corse', runs: wantedRuns(), today: C.today() }, 'Invio le corse all\'orologio'); }
function runsCard() {
  const up = Object.entries(DATA.runWorkouts || {}).filter(([k]) => k >= C.today()).sort();
  const want = Object.keys(wantedRuns());
  return card("Corse sull'orologio", 'walk', `<div class="tiny">Le corse dei prossimi 7 giorni vanno in Garmin Connect → Allenamenti e nel calendario, e vengono inviate al Forerunner: sull'orologio le trovi in Allenamento → I miei allenamenti. I rulli restano su MyWhoosh.</div>
    ${up.map(([k, e]) => `<div class="row"><span style="color:var(--accent)">${ic('checkmark-circle')}</span><span class="grow">${esc(e.name)}</span></div>`).join('') || '<div class="sub">Nessuna corsa caricata per ora.</div>'}
    <button class="btn soft" data-act="sendruns" ${want.length || up.length ? '' : 'disabled'}>${ic('refresh')}${want.length ? `Aggiorna su Garmin (${want.length} ${want.length === 1 ? 'corsa' : 'corse'})` : 'Nessuna corsa prevista'}</button>`);
}

// ---------- FTP ----------
function openFtp() {
  const mw = DATA.mwFtp, g = DATA.ftp, src = ftpSource();
  const row = (id, t, d) => `<button class="li" style="width:100%;text-align:left" data-act="ftpset" data-v="${id}"><div class="grow"><div class="ttl">${t}</div><div class="sub">${d}</div></div>${src === id ? `<span style="color:var(--accent)">${ic('checkmark-circle')}</span>` : ''}</button>`;
  sheet('Fonte FTP', `<div class="sub" style="margin:0 4px">${mw && mw === g ? `La FTP di MyWhoosh (${mw} W) è già su Garmin Connect: le due fonti coincidono.` : 'La FTP serve a calcolare zone e watt degli allenamenti. Se MyWhoosh e Garmin hanno valori diversi, scegli tu quale usare.'}</div>
    <div class="list">${row('auto', 'Automatica', "MyWhoosh se c'è (misurata sui rulli), altrimenti Garmin.")}${row('mywhoosh', 'MyWhoosh', mw ? `${mw} W · misurata sui rulli` : 'non letta')}${row('garmin', 'Garmin Connect', g ? `${g} W · stimata da Garmin` : 'non disponibile')}${row('manual', 'Inserita a mano', U.ftpManual ? `${U.ftpManual} W` : 'per esempio dopo un test')}</div>
    ${src === 'manual' ? `<div class="form"><div class="field"><span>FTP a mano</span><input type="number" id="ftpMan" min="80" max="600" value="${U.ftpManual || ''}" placeholder="watt"></div></div>` : ''}`);
  const f = $('#ftpMan'); if (f) f.onchange = () => { const v = parseInt(f.value, 10); if (v >= 80 && v <= 600) { U.ftpManual = v; saveU(); toast(`FTP ${v} W`); route(); } };
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
  if ((g.mix || 'bike') !== 'bike') out.push(runsCard());
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
  const specialRow = (id, name, sub, color, icon, n) => `<div class="li"><div class="ico-c" style="background:${color}">${ic(icon)}</div><div class="grow"><div class="ttl">${name}</div><div class="sub">${sub}</div></div>
    ${n ? `<button class="undo" data-undo="${id}" aria-label="Togli uno">${ic('arrow-undo')}</button>` : ''}<button class="btn small" style="width:auto" data-eat="${id}">Segna</button></div>`;
  out.push(`<div class="list">${specialRow(D.FREE_ID, 'Pasto libero', free ? `${free} questa settimana` : 'Nessuno questa settimana', '#af52de', 'restaurant', free)}
    ${sc.sgarri.map((x, k) => specialRow(x.id, x.name, x.n ? `${x.n} questa settimana · −${x.n * x.points} punti` : `−${x.points} punti alla riuscita · ${x.hint}`, k ? '#ff3b30' : '#ff9500', k ? 'warning' : 'fast-food', x.n)).join('')}</div>
    <div class="list-foot">${sc.extraFree > 0 ? `Pasti liberi in più: ${sc.extraFree}. Dal secondo pasto libero le dosi passano a quelle ridotte (indicate in arancione) e la riuscita scende: ogni pasto libero in più occupa un pasto del programma.` : 'Hai 1 pasto libero a settimana: vale come un pasto di carboidrati, proteine e verdura e non abbassa la riuscita.'} Gli sgarri si aggiungono ai pasti e tolgono punti alla riuscita (piccolo −2, grande −5).</div>`);
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
  const done = all.filter(i => D.raw(s, i) > 0);
  if (done.length) out.push(`<div class="list-h">Già mangiato</div><div class="list">${done.map(i => { const ol = D.oltre(s, i); return `<div class="li ${just === i.id ? 'food just' : ''}" style="--cc:${c.color}"><span style="color:${c.color}">${ic('checkmark-circle')}</span><div class="grow"><div class="ttl">${esc(i.name)}</div>${ol ? `<div class="sub" style="color:var(--orange);font-weight:600">+${ol} oltre il programma</div>` : ''}</div><b class="count">${D.raw(s, i)}/${i.weeklyTarget}</b><button class="undo" data-undo="${i.id}" aria-label="Togli una spunta">${ic('arrow-undo')}</button><button class="undo" data-oltre="${i.id}" aria-label="Segna un'altra porzione" style="color:${c.color}">${ic('add')}</button></div>`; }).join('')}</div><div class="list-foot">La freccia toglie una spunta messa per sbaglio; il + segna un'altra porzione anche se quelle della settimana sono finite (resta "oltre il programma" e non alza la riuscita).</div>`);
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

/** Conferma della spunta, in basso sopra la barra delle schede (come nel widget): 2 minuti, con Annulla. */
function eatenBar(id, it) {
  $('#eatBar')?.remove();
  const sg = D.SGARRI.find(x => x.id === id), label = it ? it.name : sg ? sg.name : 'Pasto libero';
  const c = it ? D.CATS[it.category] : { color: sg ? (sg.points > 2 ? '#ff3b30' : '#ff9500') : '#af52de', title: label }, p = it ? D.portion(DIET, it) : null;
  const el = document.createElement('div'); el.id = 'eatBar'; el.style.setProperty('--cc', c.color);
  el.innerHTML = `<span class="check" style="background:${c.color};color:#fff">${ic('checkmark-circle')}</span><div class="grow"><div class="strong">Segnato: ${esc(label)}</div><div class="tiny">${it ? `${esc(p.text || c.title)} · ${D.raw(DIET, it)}/${it.weeklyTarget} questa settimana${D.oltre(DIET, it) ? ' · oltre il programma' : ''}` : sg ? `${DIET.eaten[id] || 0} questa settimana · −${sg.points} punti` : `${D.freeMeals(DIET)} questa settimana`}</div></div><button class="chip" data-act="eatundo" data-id="${esc(id)}">Annulla</button>`;
  document.body.appendChild(el);
  clearTimeout(eatenBar.t); eatenBar.t = setTimeout(() => el.remove(), 120e3);
}
window.addEventListener('hashchange', () => $('#eatBar')?.remove());

// ---------- ATTIVITÀ (come l'app iPhone: periodo, due pulsanti, dettaglio, record) ----------
const PERIODS = [['week', 'Sett.'], ['month', 'Mese'], ['year', 'Anno'], ['two', '2 anni'], ['all', 'Sempre'], ['custom', 'Date']];
const DEF_GROUPS = [
  { name: 'In bici', icon: 'bicycle', types: ['Gravel', 'Bici', 'Rulli', 'MTB', 'Ciclismo virtuale'], color: '#33c78c' },
  { name: 'A piedi', icon: 'walk', types: ['Camminata', 'Escursione', 'Corsa'], color: '#ff9500' },
];
const ST = Object.assign({ period: 'year', from: C.addDays(C.today(), -30), to: C.today() }, store.get('coachgarmin:stats', {}));
const saveST = () => store.set('coachgarmin:stats', ST);
const groups = () => (U.groups || DEF_GROUPS).map((g, i) => ({ ...DEF_GROUPS[i], ...g }));
const isFoot = a => /cammin|walk|escurs|hik|corsa|run/i.test(a.type);
const groupSteps = g => g.types.some(t => /cammin|escurs|corsa|walk|hik|run/i.test(t));
function interval() {
  const k = C.today();
  if (ST.period === 'custom') return [ST.from < ST.to ? ST.from : ST.to, ST.from < ST.to ? ST.to : ST.from];
  const start = ST.period === 'week' ? C.startOfWeek(k) : ST.period === 'month' ? k.slice(0, 8) + '01' : ST.period === 'year' ? k.slice(0, 5) + '01-01'
    : ST.period === 'two' ? C.addDays(k, -730) : (DATA.activities.map(a => a.key).sort()[0] || k);
  return [start, k];
}
/** Km a piedi fuori dalle attività: passi del giorno meno camminate/corse registrate (come DailyFootKm). */
function footDays(k0, k1) {
  const out = {};
  for (const d of DATA.days) if (d.key >= k0 && d.key <= k1) out[d.key] = { key: d.key, steps: (d.stepsDistance || 0) / 1000, act: 0 };
  for (const a of DATA.activities) if (isFoot(a) && a.key >= k0 && a.key <= k1) { out[a.key] = out[a.key] || { key: a.key, steps: 0, act: 0 }; out[a.key].act += a.km || 0; }
  return Object.values(out).map(d => ({ ...d, extra: Math.max(0, d.steps - d.act), total: d.act + Math.max(0, d.steps - d.act) })).filter(d => d.total > 0.05).sort((a, b) => (a.key < b.key ? 1 : -1));
}
function totals(acts, stepsKm = 0) {
  const sum = f => acts.reduce((s, a) => s + (f(a) || 0), 0), max = f => { const v = acts.map(f).filter(x => x != null); return v.length ? Math.max(...v) : null; };
  return { n: acts.length, km: sum(a => a.km) + stepsKm, stepsKm, min: sum(a => a.minutes), up: sum(a => a.elevationGain), down: sum(a => a.elevationLoss), vmax: max(a => a.maxSpeed != null ? a.maxSpeed * 3.6 : null), quota: max(a => a.maxElevation) };
}
const hmin = m => `${Math.floor(m / 60)}h${String(Math.round(m % 60)).padStart(2, '0')}`;
const kmf = v => C.f1(v, v >= 100 ? 0 : 1);
const actIcon = a => (C.isRide(a) ? 'bicycle' : C.isRun(a) || C.isWalk(a) ? 'walk' : 'fitness');
const actColor = a => (C.isRide(a) ? '#34c759' : C.isRun(a) ? '#ff9500' : C.isWalk(a) ? '#ffcc00' : '#8e8e93');
function periodPicker() {
  return `<div class="seg">${PERIODS.map(([id, l]) => `<button class="${ST.period === id ? 'on' : ''}" data-period="${id}">${l}</button>`).join('')}</div>
    ${ST.period === 'custom' ? `<div class="form"><div class="field"><input type="date" id="stFrom" value="${ST.from}" max="${C.today()}"><span class="tiny">→</span><input type="date" id="stTo" value="${ST.to}" max="${C.today()}"></div></div>` : ''}`;
}
function actRow(a) {
  const met = [a.avgHR && `FC ${a.avgHR}`, a.avgPower && `${a.avgPower} W`, a.trainingEffect && `TE ${C.f1(a.trainingEffect)}`].filter(Boolean).join(' · ');
  const as = X.assess(a, { activities: DATA.activities, days: DATA.days, ftp: ftp(), blockStart: U.blockStart }), [bl, bc] = X.BENEFIT[as.benefit], [vl, vc] = X.VERDICT[as.verdict];
  return `<div class="li link" data-act="actdetail" data-id="${esc(a.id)}"><div class="ico-c" style="background:${actColor(a)}">${ic(actIcon(a))}</div><div class="grow"><div class="ttl">${esc(title4(a))}</div><div class="sub">${C.pretty(a.key)} · ${esc(a.type)}</div>
    <div class="chips" style="margin-top:4px"><span class="chip" style="color:${bc};background:color-mix(in srgb, ${bc} 14%, transparent)">● ${bl}</span><span class="chip" style="color:${vc};background:color-mix(in srgb, ${vc} 14%, transparent)">Settimana: ${vl.toLowerCase()}</span></div></div>
    <div class="right"><div class="mono strong" style="font-size:14.5px">${a.km ? `${C.f1(a.km)} km` : `${a.minutes} min`}</div><div class="tiny">${a.km ? `${hmin(a.minutes)}${a.elevationGain ? ` · +${Math.round(a.elevationGain)} m` : ''}` : met}</div></div></div>`;
}
function viewActivities() {
  setHead('Attività', refreshBtn);
  const [k0, k1] = interval(), acts = DATA.activities.filter(a => a.key >= k0 && a.key <= k1), out = [];
  const gs = groups();
  const btn = (g, i) => {
    const extra = groupSteps(g) ? footDays(k0, k1).reduce((s, d) => s + d.extra, 0) : 0;
    const t = totals(acts.filter(a => g.types.includes(a.type)), extra);
    return `<div class="gbtn" style="--gc:${g.color}" data-act="group" data-i="${i}"><button class="gedit" data-act="groupedit" data-i="${i}" aria-label="Modifica il pulsante">${ic('ellipsis-horizontal')}</button>
      <div class="gname">${ic(g.icon)}${esc(g.name)}</div><div class="gkm"><b class="mono">${kmf(t.km)}</b> km</div><div class="tiny">${t.n} attività · ${hmin(t.min)}</div><div class="tiny">+${Math.round(t.up).toLocaleString('it-IT')}&nbsp;m di dislivello</div></div>`;
  };
  out.push(`<section class="card">${periodPicker()}<div class="row"><span class="tiny grow">${C.pretty(k0, 'year')} – ${C.pretty(k1, 'year')}</span><b class="tiny" style="color:var(--ink)">${acts.length} attività</b></div>
    <div class="grid2">${gs.map(btn).join('')}</div></section>`);
  if (DATA.mwImport) out.push(`<div class="list-foot">MyWhoosh → Garmin: ultimo controllo ${ago(DATA.mwImport.at)}${DATA.mwImport.up ? `, ${DATA.mwImport.up} uscite caricate` : ', nessuna uscita nuova'}.</div>`);
  let month = '';
  const items = [];
  for (const a of acts.slice(0, 300)) {
    const m = a.key.slice(0, 7);
    if (m !== month) { if (items.length) items.push('</div>'); month = m; items.push(`<div class="list-h">${C.toDate(a.key).toLocaleDateString('it-IT', { month: 'long', year: 'numeric' })}</div><div class="list">`); }
    items.push(actRow(a));
  }
  if (items.length) items.push('</div>');
  out.push(items.length ? items.join('') : '<div class="list"><div class="li sub">Nessuna attività nel periodo</div></div>');
  if (acts.length > 300) out.push('<div class="list-foot">Mostrate le ultime 300 attività del periodo.</div>');
  $('#view').innerHTML = out.join('');
  const f = $('#stFrom'), t = $('#stTo');
  if (f) f.onchange = () => { ST.from = f.value; saveST(); route(); };
  if (t) t.onchange = () => { ST.to = t.value; saveST(); route(); };
}
function records(acts) {
  const out = [], add = (title, icon, f, fmt) => { let best = null; for (const a of acts) { const v = f(a); if (v != null && (!best || v > best[1])) best = [a, v]; } if (best) out.push({ title, icon, a: best[0], v: fmt(best[1]) }); };
  add('Distanza più lunga', 'flag', a => (a.km > 0 ? a.km : null), v => `${C.f1(v)} km`);
  add('Durata più lunga', 'time', a => (a.minutes > 0 ? a.minutes : null), hmin);
  add('Più dislivello', 'trending-up', a => (a.elevationGain > 0 ? a.elevationGain : null), v => `+${Math.round(v)} m`);
  add('Velocità media più alta', 'speedometer', a => (a.km >= (C.isRide(a) ? 10 : 3) && a.minutes >= 15 ? a.km / (a.minutes / 60) : null), v => `${C.f1(v)} km/h`);
  add('Velocità massima', 'flash', a => (a.maxSpeed != null ? a.maxSpeed * 3.6 : null), v => `${C.f1(v)} km/h`);
  add('Potenza media più alta (≥20′)', 'flash', a => (a.minutes >= 20 ? a.avgPower : null), v => `${v} W`);
  add('Quota più alta', 'trending-up', a => a.maxElevation, v => `${Math.round(v)} m`);
  return out;
}
function openGroup(i) {
  const g = groups()[i], [k0, k1] = interval();
  const acts = DATA.activities.filter(a => a.key >= k0 && a.key <= k1 && g.types.includes(a.type));
  const days = groupSteps(g) ? footDays(k0, k1) : [];
  const t = totals(acts, days.reduce((s, d) => s + d.extra, 0));
  const counts = Object.entries(acts.reduce((m, a) => ((m[a.type] = (m[a.type] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]);
  const stat = (k, v) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`;
  const rec = records(DATA.activities.filter(a => g.types.includes(a.type)));
  sheet(g.name, `<div class="tiny" style="margin:0 4px">${C.pretty(k0, 'year')} – ${C.pretty(k1, 'year')} · <b>${acts.length} attività</b></div>
    ${counts.length ? `<div class="chips">${counts.map(([ty, n]) => `<span class="chip">${esc(ty)} ${n}</span>`).join('')}</div>` : ''}
    <section class="card"><div class="card-title">${ic('stats-chart')}Totali</div><div class="stats3" style="row-gap:12px">
      ${stat('Distanza', `${kmf(t.km)} km`)}${stat('Tempo', hmin(t.min))}${stat('Attività', t.n)}
      ${stat('Ascesa totale', `${Math.round(t.up)} m`)}${stat('Discesa totale', `${Math.round(t.down)} m`)}${stat('Quota max', t.quota != null ? `${Math.round(t.quota)} m` : '–')}
      ${stat('Velocità max', t.vmax != null ? `${C.f1(t.vmax)} km/h` : '–')}${days.length ? stat('Media al giorno', `${C.f1(t.km / Math.max(1, days.length))} km`) : stat('Media/attività', acts.length ? `${C.f1((t.km - t.stepsKm) / acts.length)} km` : '–')}</div>
      ${t.stepsKm > 0 ? `<div class="tiny">Di cui ${C.f1(t.stepsKm)} km di passi fuori dalle attività e ${C.f1(t.km - t.stepsKm)} km nelle attività registrate.</div>` : ''}</section>
    ${days.length ? `<section class="card"><div class="card-title">${ic('walk')}Km a piedi per giorno</div>${days.slice(0, 60).map(d => `<div class="row"><span class="grow">${C.pretty(d.key)}</span><span class="tiny">attività ${C.f1(d.act)}</span><b class="mono" style="min-width:64px;text-align:right">${C.f1(d.total)} km</b></div>`).join('')}${days.length > 60 ? '<div class="tiny">Mostrati gli ultimi 60 giorni del periodo.</div>' : ''}</section>` : ''}
    ${rec.length ? `<section class="card"><div class="card-title">${ic('trophy')}Record personali di sempre</div>${rec.map(r => `<div class="row link" data-act="actdetail" data-id="${esc(r.a.id)}"><span style="color:#ffcc00">${ic(r.icon)}</span><div class="grow"><div class="tiny">${r.title}</div><div class="tiny" style="color:var(--muted)">${esc(r.a.garminName || r.a.type)} · ${C.pretty(r.a.key, 'year')}</div></div><b class="mono">${r.v}</b></div>`).join('')}</section>` : ''}
    <div class="list-h">Attività (${acts.length})</div><div class="list">${acts.slice(0, 200).map(actRow).join('') || '<div class="li sub">Nessuna</div>'}</div>`);
}
function openGroupEdit(i) {
  const g = groups()[i], types = [...new Set(DATA.activities.map(a => a.type))].sort((a, b) => DATA.activities.filter(x => x.type === b).length - DATA.activities.filter(x => x.type === a).length);
  const icons = [['bicycle', 'Bici'], ['walk', 'A piedi'], ['fitness', 'Altro'], ['flag', 'Gare']];
  let icon = g.icon;
  sheet('Modifica pulsante', `<div class="form-h">Nome</div><div class="form"><div class="field"><input type="text" id="gName" value="${esc(g.name)}" style="max-width:none;width:100%"></div></div>
    <div class="form-h">Icona</div><div class="iconpick">${icons.map(([n, l]) => `<button class="${icon === n ? 'on' : ''}" data-gicon="${n}">${ic(n)}<span>${l}</span></button>`).join('')}</div>
    <div class="form-h">Attività da sommare</div><div class="list">${types.map(ty => { const n = DATA.activities.filter(a => a.type === ty).length; return `<label class="li" style="cursor:pointer"><span class="grow">${esc(ty)}</span><span class="tiny">${n}</span>${sw('gt-' + ty.replace(/\W/g, '_'), g.types.includes(ty))}</label>`; }).join('')}</div>
    <button class="btn plain" data-act="groupreset" data-i="${i}">Ripristina il pulsante predefinito</button>`, { right: 'Salva', left: 'Annulla' });
  $('#modal').onclick = e => { const b = e.target.closest('[data-gicon]'); if (b) { icon = b.dataset.gicon; document.querySelectorAll('[data-gicon]').forEach(x => x.classList.toggle('on', x === b)); } };
  sheet.ok = () => {
    const sel = types.filter(ty => $('#gt-' + ty.replace(/\W/g, '_'))?.checked);
    const all = groups(); all[i] = { ...all[i], name: $('#gName').value.trim() || all[i].name, icon, types: sel };
    U.groups = all; saveU(); closeSheet(); route();
  };
}
const clock = sec => { const t = Math.round(sec), h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), r = t % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`; };
/** Grafico ad area SVG di una serie (minuti, valore). */
function areaChart(pts, color, includeZero) {
  const W = 320, H = 110, xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs) || 1, y0 = includeZero ? 0 : Math.min(...ys), y1 = Math.max(...ys);
  const X = x => ((x - x0) / (x1 - x0 || 1)) * W, Y = y => H - 4 - ((y - y0) / (y1 - y0 || 1)) * (H - 10);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');
  const gid = 'g' + Math.random().toString(36).slice(2, 7);
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:110px;display:block"><defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".35"/><stop offset="1" stop-color="${color}" stop-opacity=".02"/></linearGradient></defs>
    <path d="${line}L${X(x1).toFixed(1)},${H}L${X(x0).toFixed(1)},${H}Z" fill="url(#${gid})"/><path d="${line}" fill="none" stroke="${color}" stroke-width="1.4" vector-effect="non-scaling-stroke"/></svg>
    <div class="row tiny" style="justify-content:space-between"><span>0'</span><span>${Math.round(y0)}–${Math.round(y1)}</span><span>${Math.round(x1)}'</span></div>`;
}
function zonesBars(zones, color) {
  const tot = Math.max(1, zones.reduce((a, z) => a + (z.secsInZone || 0), 0));
  return zones.map(z => `<div class="row" style="gap:8px"><b class="mono" style="width:26px">Z${z.zoneNumber}</b><div class="bar grow" style="height:10px"><i style="width:${(z.secsInZone || 0) / tot * 100}%;background:${color}"></i></div><span class="tiny mono" style="width:44px;text-align:right">${clock(z.secsInZone || 0)}</span><span class="tiny" style="width:32px;text-align:right">${Math.round((z.secsInZone || 0) / tot * 100)}%</span></div>`).join('');
}
const LABELS = { duration: 'Durata (s)', movingDuration: 'In movimento (s)', elapsedDuration: 'Tempo totale (s)', distance: 'Distanza (m)', averageSpeed: 'Velocità media (m/s)', maxSpeed: 'Velocità max (m/s)', averageHR: 'FC media', maxHR: 'FC max', minHR: 'FC minima', calories: 'Calorie', elevationGain: 'Dislivello + (m)', elevationLoss: 'Dislivello − (m)', maxElevation: 'Quota max (m)', minElevation: 'Quota min (m)', averagePower: 'Potenza media', maxPower: 'Potenza max', normalizedPower: 'Potenza normalizzata', trainingStressScore: 'TSS', intensityFactor: 'Intensity factor', trainingEffect: 'Effetto aerobico', anaerobicTrainingEffect: 'Effetto anaerobico', activityTrainingLoad: 'Carico allenante', averageBikeCadence: 'Cadenza media', maxBikeCadence: 'Cadenza max', averageTemperature: 'Temperatura media', waterEstimated: 'Sudore stimato (ml)', moderateIntensityMinutes: 'Minuti intensità moderata', vigorousIntensityMinutes: 'Minuti intensità alta', differenceBodyBattery: 'Variazione Body Battery', steps: 'Passi', startTimeLocal: 'Inizio (locale)' };
let leafletReady = null;
function loadLeaflet() {
  if (leafletReady) return leafletReady;
  leafletReady = new Promise((ok, ko) => {
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css'; document.head.appendChild(css);
    const js = document.createElement('script'); js.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js'; js.onload = ok; js.onerror = ko; document.head.appendChild(js);
  });
  return leafletReady;
}
async function openActivity(id) {
  const a = DATA.activities.find(x => x.id === id); if (!a) return;
  sheet(title4(a), `<div class="tiny" style="margin:0 4px">${C.pretty(a.key, 'long')}${a.startTime ? ` · ${hhmm(a.startTime)}` : ''} · ${esc(a.type)}</div><div id="actBody"><div class="empty" style="padding:30px 0"><div class="spinner"></div></div></div>`);
  let d = null;
  try { d = await getJSON(`api/act/${encodeURIComponent(id)}.json?t=${DATA.updated}`); } catch { }
  const box = $('#actBody'); if (!box) return;
  const s = d?.summary || {}, out = [];
  const stat = (k, v) => (v == null || v === '' || Number.isNaN(v) ? '' : `<div><div class="k">${k}</div><div class="v">${v}</div></div>`);
  // record personali stabiliti da questa attività
  const g = groups().find(x => x.types.includes(a.type));
  const peers = g ? DATA.activities.filter(x => g.types.includes(x.type)) : DATA.activities.filter(x => x.type === a.type);
  const mine = records(peers).filter(r => r.a.id === a.id);
  if (mine.length) out.push(`<section class="card"><div class="card-title">${ic('trophy')}${mine.length === 1 ? 'Record personale' : `${mine.length} record personali`}</div>${mine.map(r => `<div class="row"><span style="color:#ffcc00">${ic(r.icon)}</span><span class="grow">${r.title}</span><b class="mono">${r.v}</b></div>`).join('')}<div class="tiny">Confrontata con tutte le tue ${peers.length} attività ${esc((g?.name || a.type).toLowerCase())}.</div></section>`);
  // valutazione (come l'app)
  const as = X.assess(a, { activities: DATA.activities, days: DATA.days, ftp: ftp(), blockStart: U.blockStart }), [bl, bc] = X.BENEFIT[as.benefit], [vl, vc] = X.VERDICT[as.verdict];
  out.push(`<section class="card"><div class="card-title">${ic('medkit')}Valutazione</div>
    <div class="row"><span class="strong grow">Utilità per il corpo</span><span class="chip" style="color:${bc};background:color-mix(in srgb, ${bc} 14%, transparent)">● ${bl}</span></div>
    <div class="bar" style="height:8px"><i style="width:${Math.min(as.te, 5) / 5 * 100}%;background:${bc}"></i></div><div class="row tiny" style="justify-content:space-between"><span>0</span><b>${as.estimated ? `stima ${C.f1(as.te)}` : `Training Effect ${C.f1(as.te)}`}</b><span>5</span></div>
    <div class="row"><span class="strong grow">${esc(as.title)}</span><span class="chip" style="color:${vc};background:color-mix(in srgb, ${vc} 14%, transparent)">${vl}</span></div><div class="sub">${esc(as.summary)}</div>${as.points.map(p => bullet(p, 'chevron-forward', 'var(--muted)')).join('')}
    <div class="strong">Nei giorni successivi</div>${as.after.map(p => bullet(p, 'chevron-forward', 'var(--accent)')).join('')}
    <div class="strong">Commento</div><div class="sub">${esc(as.comment)}</div><div class="sub"><b>${esc(as.recovery)}</b></div></section>`);
  // riepilogo
  const km = v => `${C.f1(v / 1000, 2)} km`, kmh = v => `${C.f1(v * 3.6)} km/h`;
  const items = d ? [stat('Durata', s.duration != null ? clock(s.duration) : null), stat('In movimento', s.movingDuration != null ? clock(s.movingDuration) : null), stat('Distanza', s.distance ? km(s.distance) : null),
    stat('Velocità media', s.averageSpeed ? kmh(s.averageSpeed) : null), stat('Velocità max', s.maxSpeed ? kmh(s.maxSpeed) : null), stat('Dislivello +', s.elevationGain != null ? `${Math.round(s.elevationGain)} m` : null),
    stat('FC media', s.averageHR ? `${Math.round(s.averageHR)} bpm` : null), stat('FC max', s.maxHR ? `${Math.round(s.maxHR)} bpm` : null), stat('Calorie', s.calories ? `${Math.round(s.calories)} kcal` : null),
    stat('Potenza media', s.averagePower ? `${Math.round(s.averagePower)} W` : null), stat('Potenza norm.', s.normalizedPower ? `${Math.round(s.normalizedPower)} W` : null), stat('Potenza max', s.maxPower ? `${Math.round(s.maxPower)} W` : null),
    stat('Cadenza media', s.averageBikeCadence ? `${Math.round(s.averageBikeCadence)} rpm` : null), stat('TSS', s.trainingStressScore != null ? Math.round(s.trainingStressScore) : null), stat('IF', s.intensityFactor != null ? C.f1(s.intensityFactor, 2) : null),
    stat('Temperatura', s.averageTemperature != null ? `${Math.round(s.averageTemperature)} °C` : null), stat('Sudore stimato', s.waterEstimated ? `${Math.round(s.waterEstimated)} ml` : null), stat('Body Battery', s.differenceBodyBattery != null ? `${s.differenceBodyBattery > 0 ? '+' : ''}${s.differenceBodyBattery}` : null)]
    : [stat('Distanza', a.km ? `${C.f1(a.km)} km` : null), stat('Tempo', hmin(a.minutes)), stat('FC media', a.avgHR ? `${a.avgHR} bpm` : null), stat('Potenza media', a.avgPower ? `${a.avgPower} W` : null), stat('Dislivello', a.elevationGain ? `+${Math.round(a.elevationGain)} m` : null), stat('Velocità max', a.maxSpeed ? kmh(a.maxSpeed) : null)];
  out.push(`<section class="card"><div class="card-title">${ic('list')}Riepilogo</div><div class="stats3" style="row-gap:12px">${items.join('')}</div>${d ? '' : '<div class="tiny">Il dettaglio completo (percorso, grafici, zone, giri, meteo) arriva entro qualche aggiornamento.</div>'}</section>`);
  if (d) {
    // cosa ha prodotto nel corpo
    const aero = s.trainingEffect ?? s.aerobicTrainingEffect, ana = s.anaerobicTrainingEffect, load = s.activityTrainingLoad;
    const eff = (t, v, why) => `<div><div class="row"><span class="strong grow">${t}</span><b class="mono" style="font-size:18px">${C.f1(v)}</b></div><div class="bar" style="height:8px"><i style="width:${Math.min(v, 5) / 5 * 100}%;background:${v >= 4 ? 'var(--orange)' : 'var(--accent)'}"></i></div><div class="sub">${esc(X.teMeaning(v).replace(/^\w/, c => c.toUpperCase()))}. ${why}</div></div>`;
    let e = '';
    if (aero != null) e += eff('Effetto aerobico', aero, 'Allena cuore, polmoni e mitocondri: è ciò che ti fa durare più a lungo in gravel.');
    if (ana > 0) e += eff('Effetto anaerobico', ana, 'Allena gli sforzi brevi e intensi: utile ma richiede più recupero.');
    if (load != null) e += bullet(`Carico allenante ${Math.round(load)}: ${load < 50 ? 'leggero, recuperi in giornata.' : load < 120 ? 'moderato, utile per costruire forma.' : load < 200 ? 'alto, il giorno dopo meglio facile.' : 'molto alto: servono 48 h di recupero.'}`, 'fitness', '#af52de');
    if (s.moderateIntensityMinutes + s.vigorousIntensityMinutes > 0) e += bullet(`Minuti di intensità: ${s.moderateIntensityMinutes} moderati + ${s.vigorousIntensityMinutes} intensi (contano doppio) verso i 150 settimanali consigliati.`, 'time', '#34c759');
    if (e) out.push(`<section class="card"><div class="card-title">${ic('sparkles')}Cosa ha prodotto nel tuo corpo</div>${e}</section>`);
    if (d.route?.length > 1) out.push(`<section class="card"><div class="card-title">${ic('flag')}Percorso</div><div id="actMap" style="height:240px;border-radius:12px;overflow:hidden;background:var(--fill)"></div></section>`);
    const defs = [['directHeartRate', 'Frequenza cardiaca', 'bpm', '#ff3b30', false], ['directPower', 'Potenza', 'W', '#ff9500', true], ['directSpeed', 'Velocità', 'km/h', '#007aff', true], ['directElevation', 'Altitudine', 'm', '#a2845e', false], ['directBikeCadence', 'Cadenza', 'rpm', '#af52de', true], ['directRunCadence', 'Cadenza', 'ppm', '#af52de', true]];
    const present = defs.filter(x => d.series?.[x[0]]);
    if (present.length) out.push(`<section class="card"><div class="card-title">${ic('pulse')}Nel tempo</div>${present.map(([k, l, u, col, z]) => { const p = d.series[k]; return `<div><div class="row"><span class="strong grow" style="color:${col};font-size:13px">${l}</span><span class="tiny">media ${Math.round(p.reduce((x, q) => x + q[1], 0) / p.length)} ${u}</span></div>${areaChart(p, col, z)}</div>`; }).join('')}<div class="tiny">In orizzontale i minuti.</div></section>`);
    if (d.hrZones?.length) out.push(`<section class="card"><div class="card-title">${ic('heart')}Zone di frequenza cardiaca</div>${zonesBars(d.hrZones, '#ff3b30')}<div class="tiny">Tempo passato in ogni zona FC di Garmin.</div></section>`);
    if (d.powerZones?.length) out.push(`<section class="card"><div class="card-title">${ic('flash')}Zone di potenza</div>${zonesBars(d.powerZones, '#ff9500')}<div class="tiny">Tempo passato in ogni zona di potenza, calcolate sulla FTP.</div></section>`);
    if (d.laps?.length > 1) out.push(`<section class="card"><div class="card-title">${ic('flag')}Giri (${d.laps.length})</div><div class="laps"><b>#</b><b>Tempo</b><b>km</b><b>km/h</b><b>FC</b><b>W</b>${d.laps.map((l, i) => `<span>${i + 1}</span><span>${l.duration != null ? clock(l.duration) : '–'}</span><span>${l.distance != null ? C.f1(l.distance / 1000) : '–'}</span><span>${l.averageSpeed != null ? C.f1(l.averageSpeed * 3.6) : '–'}</span><span>${l.averageHR != null ? Math.round(l.averageHR) : '–'}</span><span>${l.averagePower != null ? Math.round(l.averagePower) : '–'}</span>`).join('')}</div></section>`);
    if (d.weather?.temp != null) out.push(`<section class="card"><div class="card-title">${ic('sunny')}Meteo</div><div class="row" style="gap:16px"><b>${Math.round((d.weather.temp - 32) * 5 / 9)} °C</b>${d.weather.humidity != null ? `<span>umidità ${d.weather.humidity}%</span>` : ''}${d.weather.wind != null ? `<span>vento ${Math.round(d.weather.wind * 1.609)} km/h</span>` : ''}</div>${d.weather.desc ? `<div class="tiny">${esc(d.weather.desc)}</div>` : ''}</section>`);
    const fields = Object.entries(s).map(([k, v]) => [LABELS[k] || k, typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : v]).sort((x, y) => (x[0] < y[0] ? -1 : 1));
    out.push(`<details class="card"><summary class="card-title" style="cursor:pointer">${ic('list')}Tutti i dati registrati (${fields.length})</summary>${fields.map(([k, v]) => `<div class="row tiny"><span class="grow">${esc(k)}</span><span class="mono" style="color:var(--ink)">${esc(v)}</span></div>`).join('')}</details>`);
  }
  out.push(`<button class="btn soft" data-act="rename" data-id="${esc(a.id)}">${ic('ellipsis-horizontal')}Rinomina</button>`);
  box.innerHTML = out.join('');
  if (d?.route?.length > 1) {
    try {
      await loadLeaflet();
      const L = window.L, m = L.map('actMap', { attributionControl: true, zoomControl: false });
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap' }).addTo(m);
      const line = L.polyline(d.route, { color: '#33c78c', weight: 4 }).addTo(m);
      m.fitBounds(line.getBounds(), { padding: [12, 12] });
    } catch { const el = $('#actMap'); if (el) el.innerHTML = '<div class="tiny" style="padding:12px">Mappa non disponibile offline.</div>'; }
  }
}

// ---------- ACCOUNT ----------
function viewAccount() {
  setHead('Account', refreshBtn);
  const out = [], days = DATA.days;
  out.push(`<div class="list-h">Collegamenti</div><div class="list">
    <button class="li" style="width:100%;text-align:left" data-act="linkgarmin"><div class="ico-c" style="background:#007cc3">${ic('pulse')}</div><div class="grow"><div class="ttl">Garmin Connect</div><div class="sub">${DATA.garminLinked ? 'Collegato' + (DATA.error ? ' · ' + esc(DATA.error) : '') : 'Non collegato'}</div></div><span class="chip">${DATA.garminLinked ? 'Ricollega' : 'Collega'}</span></button>
    <button class="li" style="width:100%;text-align:left" data-act="linkmw"><div class="ico-c" style="background:#af52de">${ic('bicycle')}</div><div class="grow"><div class="ttl">MyWhoosh</div><div class="sub">${MW.account(DATA) ? (MW.account(DATA).expired ? 'Accesso scaduto' : 'Collegato') : 'Non collegato'}</div></div><span class="chip">${MW.account(DATA) && !MW.account(DATA).expired ? 'Ricollega' : 'Collega'}</span></button></div>
    <div class="list-foot">${ghToken() || !repoInfo() ? '' : 'Al primo collegamento ti chiedo l\'autorizzazione GitHub (la stessa del pulsante ↻). '}Garmin e MyWhoosh non accettano richieste da una pagina web: il collegamento lo fa GitHub per te, con i dati cifrati.</div>`);
  out.push(`<div class="list-h">Garmin Connect</div><div class="list">
    <div class="li"><div class="grow">Account</div><b>${esc(DATA.profile?.name || 'collegato')}</b></div>
    <div class="li"><div class="grow">Ultimo aggiornamento</div><b>${DATA.updated ? `${ago(DATA.updated)} (${hhmm(DATA.updated)})` : '–'}</b></div>
    <div class="li"><div class="grow">Giorni in archivio</div><b>${days.length}${days.length ? ` · dal ${C.pretty(days[0].key, 'dm')}` : ''}</b></div>
    <div class="li"><div class="grow">Attività</div><b>${DATA.activities.length}</b></div>
    <div class="li"><div class="grow">Dispositivi</div><b style="text-align:right">${esc((DATA.devices || []).map(d => d.name).join(', ') || '–')}</b></div>
    ${DATA.error ? `<div class="li" style="color:var(--orange)">${ic('warning')}<div class="grow">${esc(DATA.error)}</div></div>` : ''}</div>
    <div class="list-foot">${location.hostname.endsWith('github.io') ? 'I dati Garmin si aggiornano da soli circa ogni 15 minuti, anche con il Mac spento.' : 'Con il server sul Mac i dati si aggiornano ogni 15 minuti; ↻ li aggiorna subito.'}</div>`);
  out.push(`<div class="list-h">Allenamento</div><div class="list">
    <div class="li"><div class="grow">FTP in uso</div><b>${ftp() ? ftp() + ' W' : '–'}</b></div>
    <div class="li"><div class="grow">MyWhoosh · Garmin</div><b>${DATA.mwFtp ? DATA.mwFtp + ' W' : '–'} · ${DATA.ftp ? DATA.ftp + ' W' : '–'}</b></div>
    <button class="li" style="width:100%;text-align:left${ftpConflict() ? ';color:var(--orange)' : ''}" data-act="ftpsrc">${ic('flash')}<span class="grow">${ftpConflict() ? 'FTP diverse: scegli la fonte' : 'Scegli la fonte della FTP'}</span>${ic('chevron-forward', 'chev')}</button></div>
    <div class="list-foot">La FTP regola i watt di tutti gli allenamenti sui rulli.</div>`);
  const acc = MW.account(DATA);
  out.push(`<div class="list-h">MyWhoosh</div><div class="list">
    <div class="li"><div class="grow">Allenamenti MyWhoosh</div><b>${acc ? (acc.expired ? 'accesso scaduto' : 'collegati') : 'non collegati'}</b></div>
    ${acc && !acc.expired ? `<div class="li"><div class="grow">Salvati su MyWhoosh</div><b>${MWLIST ? MWLIST.length : '…'}</b></div>
    <button class="li" style="width:100%;text-align:left" data-act="mwlib">${ic('bicycle')}<span class="grow">${MWLIST && MW.LIBRARY.every(w => MWLIST.some(x => x.name === w.code + ' ' + w.name)) ? 'W01–W09 sono già tutti su MyWhoosh' : 'Carica su MyWhoosh gli W01–W09 mancanti'}</span></button>` : ''}</div>
    <div class="list-foot">${acc ? (acc.exp ? `Accesso valido fino al ${new Date(acc.exp).toLocaleDateString('it-IT')}${DATA.mywhooshAuto ? ', poi si rinnova da solo' : ''}. ` : '') + 'Nei giorni di rulli la web app ti dice quale allenamento usare e, se serve, ne carica uno su misura (in MyWhoosh: Allenamenti › I miei allenamenti).' : 'Collegali da "Collegamenti" qui sopra.'}${MWSTATE ? ' ' + esc(MWSTATE) : ''}</div>`);
  out.push(`<div class="list-h">Corsa con l'AI (Gemini)</div><div class="list">
    <div class="li"><div class="grow">Chiave Gemini</div><input type="password" id="gemIn" placeholder="incolla la chiave" value="${esc(geminiKey())}" autocomplete="off" style="width:160px;background:var(--fill);border:0;border-radius:8px;padding:6px 10px"></div></div>
    <div class="list-foot">${geminiKey() ? 'Chiave Gemini collegata: la corsa con l\'AI usa Gemini su tutti i tuoi dispositivi.' : 'Gratis: apri <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener" style="color:var(--accent-ink);font-weight:600">aistudio.google.com/apikey</a>, accedi con Google, tocca "Create API key", copiala e incollala qui. Basta farlo una volta: vale su tutti i tuoi dispositivi.'}</div>`);
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
  $('#gemIn').oninput = e => { if (/^AIza[\w-]{30,}$/.test(e.target.value.trim())) e.target.blur(); };
  $('#gemIn').onchange = e => {
    const k = e.target.value.trim();
    store.set(GKEY, k);
    if (!k) return toast('Chiave Gemini tolta da questo dispositivo');
    if (!/^AIza[\w-]{30,}$/.test(k)) return toast('La chiave Gemini di solito inizia con "AIza": ricontrollala.', 5000);
    // la salva cifrata su GitHub: vale anche sugli altri dispositivi
    if (repoInfo()) sendAction({ azione: 'gemini', key: k }, 'Salvo la chiave Gemini'); else toast('Chiave Gemini salvata');
  };
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
  if (!acc) return card('Su MyWhoosh oggi', 'bicycle', `<div class="sub">${w.code === 'PIANO' || adj ? 'Crea su MyWhoosh un allenamento con i blocchi qui sopra' : `Su MyWhoosh avvia "${esc(w.code + ' ' + w.name)}"`}. </div><button class="btn soft" data-act="linkmw">${ic('bicycle')}Collega MyWhoosh per caricarlo da qui</button>`);
  if (acc.expired) return card('Su MyWhoosh oggi', 'bicycle', `<div class="banner">Accesso MyWhoosh scaduto.</div><button class="btn soft" data-act="linkmw">Ricollega MyWhoosh</button>`);
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
    $('#runSave').onclick = () => { U.aiRuns[k] = r; for (const x of Object.keys(U.aiRuns)) if (x < C.addDays(k, -7)) delete U.aiRuns[x]; saveU(); closeSheet(); route(); toast('Corsa di oggi impostata'); if (repoInfo() && ghToken()) setTimeout(sendRuns, 1500); };
  };
}

// ---------- azioni ----------
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-act],[data-kind],[data-mix],[data-week],[data-cat],[data-eat],[data-undo],[data-period],[data-layer],[data-oltre]');
  if (!t) { if (e.target.id === 'modal') closeSheet(); return; }
  const a = t.dataset.act, k = C.today();
  if (a === 'close') return closeSheet();
  if (a === 'sheet-ok') return sheet.ok && sheet.ok();
  if (a === 'reload') return location.reload();
  if (a === 'refresh') return refreshNow();
  if (a === 'group') { if (e.target.closest('.gedit')) return; return openGroup(+t.dataset.i); }
  if (a === 'groupedit') return openGroupEdit(+t.dataset.i);
  if (a === 'groupreset') { const g = U.groups || DEF_GROUPS.map(x => ({ ...x })); g[+t.dataset.i] = { ...DEF_GROUPS[+t.dataset.i] }; U.groups = g; saveU(); closeSheet(); return route(); }
  if (a === 'actdetail') return openActivity(t.dataset.id);
  if (a === 'linkgarmin') return openLinkGarmin();

  if (a === 'linkmw') return openLinkMyWhoosh();
  if (a === 'ghon') return openGhSetup(() => { route(); refreshNow(); });
  if (a === 'ghoff') { store.set(GH_KEY, ''); route(); return toast('GitHub scollegato da questo dispositivo'); }
  if (a === 'checkin') return openCheckIn();
  if (a === 'runai') return openRunAI();
  if (a === 'runai-del') { delete U.aiRuns[k]; saveU(); route(); return toast('Torna l\'allenamento previsto'); }
  if (a === 'mwupload') return mwUpload();
  if (a === 'mwlib') return mwLibrary();
  if (a === 'nightprev') { sleepIdx++; return redrawSleep(); }
  if (a === 'nightnext') { sleepIdx = Math.max(0, sleepIdx - 1); return redrawSleep(); }
  if (a === 'naps') return openNaps();
  if (a === 'napnew') return openNapForm();
  if (a === 'napedit') return openNapForm(t.dataset.day, +t.dataset.start, +t.dataset.end);
  if (a === 'napdel') { if (confirm('Eliminare questo sonnellino da Garmin?')) sendAction({ azione: 'sonnellino-del', day: t.dataset.day, start: +t.dataset.start }, 'Elimino il sonnellino'); return; }
  if (a === 'alarms') { ALARMS = null; return openAlarms(); }
  if (a === 'alarmnew') return openAlarmEdit(null);
  if (a === 'alarmedit') return openAlarmEdit(+t.dataset.i);
  if (a === 'wear') return openWear();
  if (a === 'wearset') return sendAction({ azione: 'posizione', value: t.dataset.v }, 'Aggiorno la posizione');
  if (a === 'sendruns') return sendRuns();
  if (a === 'ftpsrc') return openFtp();
  if (a === 'ftpset') { U.ftpSource = t.dataset.v; saveU(); route(); return openFtp(); }
  if (a === 'rename') {
    const ac = DATA.activities.find(x => x.id === t.dataset.id); if (!ac) return;
    const n = prompt('Nuovo nome dell\'attività', title4(ac)); if (!n || !n.trim()) return;
    U.names = { ...(U.names || {}), [ac.id]: n.trim() }; saveU(); route();
    return sendAction({ azione: 'rinomina', activityId: ac.id, name: n.trim() }, 'Rinomino su Garmin');
  }
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
  if (t.dataset.layer) { sleepLayer = t.dataset.layer; return redrawSleep(); }
  if (t.dataset.period) { ST.period = t.dataset.period; saveST(); return route(); }
  if (t.dataset.week) { weekOffset += +t.dataset.week; return route(); }
  if (t.dataset.cat) { dietCat = t.dataset.cat; return route(); }
  if (t.dataset.oltre) { D.eat(DIET, t.dataset.oltre, { force: true }); route(); return eatenBar(t.dataset.oltre, D.item(DIET, t.dataset.oltre)); }
  if (t.dataset.eat) { const before = DIET.eaten[t.dataset.eat] || 0; D.eat(DIET, t.dataset.eat); const it = D.item(DIET, t.dataset.eat); route(); return (DIET.eaten[t.dataset.eat] || 0) > before ? eatenBar(t.dataset.eat, it) : toast('Porzioni della settimana finite: usa il + in "Già mangiato" per segnarne un\'altra'); }
  if (a === 'eatundo') { D.undo(DIET, t.dataset.id); $('#eatBar')?.remove(); return route(); }
  if (t.dataset.undo) { D.undo(DIET, t.dataset.undo); return route(); }
});

// ---------- avvio ----------
try { screen.orientation?.lock?.('portrait').catch(() => { }); } catch { }
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { });
if (!location.hash) history.replaceState(null, '', location.pathname + location.search + '#/oggi');
loadData();
