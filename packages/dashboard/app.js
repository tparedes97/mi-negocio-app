import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, collection, doc, setDoc, deleteDoc, onSnapshot, query, orderBy, limit, getDocs,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';
import { t, LANG, applyStaticTranslations } from './i18n.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

document.documentElement.lang = LANG;
applyStaticTranslations();

// Chrome Web Store asigna este ID apenas se sube el primer paquete (incluso
// en borrador) — el link empieza a funcionar solo cuando Google aprueba la
// publicación, no hace falta tocar este código en ese momento.
const EXTENSION_STORE_URL = 'https://chromewebstore.google.com/detail/ckiogdenolblgafclplhpnfhompaogil';
document.querySelectorAll('.js-extension-download').forEach((el) => {
  el.href = EXTENSION_STORE_URL;
});

// ---------------------------------------------------------------
// Validación/normalización de dominios y ventana de bloqueo — copia
// intencional de packages/shared/src/domain.js y schedule.js: esta página
// se carga como <script type="module"> plano sin bundler (igual que
// admin/companion-portal/checkout), así que no puede resolver el import
// CommonJS de @limen/shared directamente. Si cambias esta lógica, cámbiala
// también allá (y en packages/extension y packages/mobile-app).
// ---------------------------------------------------------------
function isValidDomain(value) {
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(value.trim());
}

function normalizeDomain(raw) {
  let value = raw.trim().toLowerCase();
  if (!value) return '';
  if (!/^[a-z]+:\/\//.test(value)) value = 'https://' + value;
  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return raw.trim().toLowerCase();
  }
}

function currentDayIndexMondayFirst() {
  const jsDay = new Date().getDay();
  return jsDay === 0 ? 6 : jsDay - 1;
}

function isWithinBlockedWindow(site) {
  const window = site.schedule?.[currentDayIndexMondayFirst()];
  if (!window) return false;
  const now = new Date();
  const currentHour = now.getHours() + now.getMinutes() / 60;
  return currentHour >= window.startHour && currentHour < window.endHour;
}

// ---------------------------------------------------------------
// Login
// ---------------------------------------------------------------
async function handleGoogleLogin() {
  const errorEl = document.getElementById('login-error');
  errorEl.textContent = '';
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
    // onAuthStateChanged se encarga de mostrar el app-shell
  } catch (err) {
    errorEl.textContent = t('login.error');
    console.error('[limen-dashboard] error de login', err);
  }
}

// Varios botones "Comenzar ahora" en la página de aterrizaje (nav, hero,
// refuerzo final) — todos comparten esta clase y el mismo handler.
document.querySelectorAll('.js-google-login').forEach((btn) => {
  btn.addEventListener('click', handleGoogleLogin);
});

document.getElementById('btn-logout').addEventListener('click', () => signOut(auth));

let currentUser = null;
let unsubscribeSites = null;
let unsubscribeAttempts = null;
let currentSites = [];
let currentAttempts = [];

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  document.getElementById('landing').style.display = user ? 'none' : 'block';
  document.getElementById('app-shell').style.display = user ? 'block' : 'none';

  if (unsubscribeSites) { unsubscribeSites(); unsubscribeSites = null; }
  if (unsubscribeAttempts) { unsubscribeAttempts(); unsubscribeAttempts = null; }
  if (!user) return;

  document.getElementById('user-email').textContent = user.email || '';
  unsubscribeSites = onSnapshot(collection(db, 'users', user.uid, 'blockedSites'), (snap) => {
    currentSites = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderSiteList();
  }, (err) => {
    console.error('[limen-dashboard] error escuchando blockedSites', err);
    document.getElementById('site-list').innerHTML = '<div class="field-error">No se pudo cargar tu lista: ' + (err.message || err.code) + '</div>';
  });

  const attemptsQuery = query(collection(db, 'users', user.uid, 'unlockAttempts'), orderBy('createdAt', 'desc'), limit(50));
  unsubscribeAttempts = onSnapshot(attemptsQuery, (snap) => {
    currentAttempts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderChatsList();
    renderMetrics();
  }, (err) => {
    console.error('[limen-dashboard] error escuchando unlockAttempts', err);
    document.getElementById('chats-list').innerHTML = '<div class="field-error">No se pudo cargar tu historial: ' + (err.message || err.code) + '</div>';
    document.getElementById('metrics-grid').innerHTML = '<div class="field-error">No se pudo cargar tus métricas.</div>';
  });
});

// ---------------------------------------------------------------
// Pestañas del panel logueado
// ---------------------------------------------------------------
document.querySelectorAll('.app-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.app-tab').forEach((t) => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
    tab.classList.add('active');
    tab.setAttribute('aria-selected', 'true');
    document.querySelectorAll('.tab-panel').forEach((p) => { p.style.display = 'none'; });
    document.getElementById('tab-' + tab.dataset.tab).style.display = 'block';
  });
});

function sitesCollectionRef() {
  return collection(db, 'users', currentUser.uid, 'blockedSites');
}

// ---------------------------------------------------------------
// Lista de sitios: candado mientras está bloqueado, confirmación al quitar
// (mismas reglas que packages/extension/src/popup — ver commit que las
// introdujo: sin esto, bastaría con borrar el sitio acá para saltarse todo
// el bloqueo).
// ---------------------------------------------------------------
const confirmingRemovalIds = new Set();

const ICON_LOCK = '<svg class="icon" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
const ICON_EDIT = '<svg class="icon" viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
const ICON_CLOSE = '<svg class="icon" viewBox="0 0 24 24"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg>';

function scheduleSummary(site) {
  const days = Object.keys(site.schedule || {});
  if (!days.length) return '';
  const DAY_LABELS = [t('days.mon'), t('days.tue'), t('days.wed'), t('days.thu'), t('days.fri'), t('days.sat'), t('days.sun')];
  const window = Object.values(site.schedule)[0];
  const dayList = days.map((d) => DAY_LABELS[Number(d)]).join(', ');
  return dayList + ' · ' + String(window.startHour).padStart(2, '0') + ':00–' + (window.endHour === 24 ? '24:00' : String(window.endHour).padStart(2, '0') + ':00');
}

function renderSiteList() {
  const el = document.getElementById('site-list');
  if (!currentSites.length) {
    el.innerHTML = `<div class="sub">${t('sites.empty')}</div>`;
    return;
  }

  el.innerHTML = currentSites.map((site) => {
    const blockedNow = isWithinBlockedWindow(site);

    if (blockedNow) {
      return `
        <div class="site-row">
          <div>
            <div class="name"><span class="dot"></span>${site.domain}</div>
            <div class="meta">${scheduleSummary(site)}</div>
          </div>
          <span class="lock-badge" title="${t('sites.lockTooltip')}">${ICON_LOCK}</span>
        </div>`;
    }

    if (confirmingRemovalIds.has(site.id)) {
      return `
        <div class="site-row confirming">
          <b>${t('sites.confirmRemove', { domain: site.domain })}</b>
          <div class="confirm-actions">
            <button class="confirm-yes" data-confirm-remove="${site.id}">${t('sites.confirmYes')}</button>
            <button class="confirm-no" data-cancel-remove="${site.id}">${t('sites.confirmNo')}</button>
          </div>
        </div>`;
    }

    return `
      <div class="site-row">
        <div>
          <div class="name"><span class="dot"></span>${site.domain}</div>
          <div class="meta">${scheduleSummary(site)}</div>
        </div>
        <div class="actions">
          <button data-edit="${site.id}" aria-label="${t('sites.editAria', { domain: site.domain })}">${ICON_EDIT}</button>
          <button data-remove="${site.id}" aria-label="${t('sites.removeAria', { domain: site.domain })}">${ICON_CLOSE}</button>
        </div>
      </div>`;
  }).join('');

  el.querySelectorAll('button[data-remove]').forEach((btn) => {
    btn.addEventListener('click', () => { confirmingRemovalIds.add(btn.dataset.remove); renderSiteList(); });
  });
  el.querySelectorAll('button[data-cancel-remove]').forEach((btn) => {
    btn.addEventListener('click', () => { confirmingRemovalIds.delete(btn.dataset.cancelRemove); renderSiteList(); });
  });
  el.querySelectorAll('button[data-confirm-remove]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.confirmRemove;
      confirmingRemovalIds.delete(id);
      await deleteDoc(doc(sitesCollectionRef(), id));
    });
  });
  el.querySelectorAll('button[data-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const site = currentSites.find((s) => s.id === btn.dataset.edit);
      if (site && !isWithinBlockedWindow(site)) openScheduleCard(site);
    });
  });
}

// ---------------------------------------------------------------
// Agregar sitio
// ---------------------------------------------------------------
const domainInput = document.getElementById('input-domain');
const domainErrorEl = document.getElementById('domain-error');

function showDomainError(message) {
  domainInput.style.borderColor = 'var(--danger)';
  domainErrorEl.textContent = message;
  domainErrorEl.style.display = message ? 'block' : 'none';
}
function clearDomainError() { showDomainError(''); domainInput.style.borderColor = ''; }
domainInput.addEventListener('input', clearDomainError);

async function addCurrentDomain() {
  const value = normalizeDomain(domainInput.value);
  if (!value || !isValidDomain(value)) {
    showDomainError(t('addSite.invalidDomain'));
    return;
  }
  clearDomainError();
  if (currentSites.some((s) => s.domain === value)) { domainInput.value = ''; return; }

  const ref = doc(sitesCollectionRef());
  const site = { id: ref.id, domain: value, schedule: {}, reasonWhy: '', reasonInstead: '' };
  await setDoc(ref, site);
  domainInput.value = '';
  openScheduleCard(site);
}

document.getElementById('btn-add-site').addEventListener('click', addCurrentDomain);
domainInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addCurrentDomain(); });

// ---------------------------------------------------------------
// Horario + motivo (mismo diseño que el popup de la extensión — ver
// prototype-reference.html, pantalla "Configurar horario")
// ---------------------------------------------------------------
const DAY_LABELS = [t('days.mon'), t('days.tue'), t('days.wed'), t('days.thu'), t('days.fri'), t('days.sat'), t('days.sun')];
const scheduleCard = document.getElementById('schedule-card');
const dayTogglesEl = document.getElementById('day-toggles');
const selectStart = document.getElementById('select-start');
const selectEnd = document.getElementById('select-end');
const reasonWhyEl = document.getElementById('reason-why');
const reasonInsteadEl = document.getElementById('reason-instead');
const reasonWhyErrorEl = document.getElementById('reason-why-error');

let editingSite = null;
let activeDays = new Set();

function renderDayToggles() {
  dayTogglesEl.innerHTML = DAY_LABELS.map((label, i) => `
    <div class="day-toggle ${activeDays.has(i) ? 'active' : ''}" data-day="${i}">${label}</div>
  `).join('');
  dayTogglesEl.querySelectorAll('.day-toggle').forEach((el) => {
    el.addEventListener('click', () => {
      const day = Number(el.dataset.day);
      if (activeDays.has(day)) activeDays.delete(day); else activeDays.add(day);
      el.classList.toggle('active');
    });
  });
}

function populateHourSelects(startHour, endHour) {
  selectStart.innerHTML = Array.from({ length: 24 }, (_, h) => `<option value="${h}">${String(h).padStart(2, '0')}:00</option>`).join('');
  selectEnd.innerHTML = Array.from({ length: 24 }, (_, h) => `<option value="${h + 1}">${h + 1 === 24 ? '24:00' : String(h + 1).padStart(2, '0') + ':00'}</option>`).join('');
  selectStart.value = String(startHour);
  selectEnd.value = String(endHour);
}

function openScheduleCard(site) {
  editingSite = site;
  document.getElementById('schedule-eyebrow').textContent = site.domain;

  const existingWindow = Object.values(site.schedule || {})[0];
  activeDays = new Set(
    Object.keys(site.schedule || {}).length ? Object.keys(site.schedule).map(Number) : [0, 1, 2, 3, 4, 5, 6]
  );
  renderDayToggles();
  populateHourSelects(existingWindow?.startHour ?? 0, existingWindow?.endHour ?? 24);

  reasonWhyEl.value = site.reasonWhy || '';
  reasonInsteadEl.value = site.reasonInstead || '';
  reasonWhyErrorEl.style.display = 'none';
  reasonWhyEl.style.borderColor = '';

  scheduleCard.style.display = 'block';
  scheduleCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

document.getElementById('btn-cancel-schedule').addEventListener('click', () => {
  scheduleCard.style.display = 'none';
  editingSite = null;
});

reasonWhyEl.addEventListener('input', () => {
  reasonWhyErrorEl.style.display = 'none';
  reasonWhyEl.style.borderColor = '';
});

document.getElementById('btn-save-schedule').addEventListener('click', async () => {
  const reasonWhy = reasonWhyEl.value.trim();
  if (!reasonWhy) {
    reasonWhyErrorEl.textContent = t('schedule.whyRequired');
    reasonWhyErrorEl.style.display = 'block';
    reasonWhyEl.style.borderColor = 'var(--danger)';
    reasonWhyEl.focus();
    return;
  }

  const startHour = Number(selectStart.value);
  const endHour = Number(selectEnd.value);
  const window = { startHour, endHour };
  const schedule = {};
  activeDays.forEach((day) => { schedule[day] = window; });

  await setDoc(doc(sitesCollectionRef(), editingSite.id), {
    ...editingSite, schedule, reasonWhy, reasonInstead: reasonInsteadEl.value.trim(),
  });

  scheduleCard.style.display = 'none';
  editingSite = null;
});

// ---------------------------------------------------------------
// Chats — historial real de users/{uid}/unlockAttempts (lo mismo que
// escribe packages/extension/src/blocked/blocked.js). Los mensajes de
// cada conversación se cargan recién al expandir, desde chats/{chatId}/messages.
// ---------------------------------------------------------------
const ATTEMPT_STATE_LABELS = {
  motivational_questions: () => t('state.motivational_questions'),
  offered_chat: () => t('state.offered_chat'),
  queued: () => t('state.queued'),
  donation_prompt: () => t('state.donation_prompt'),
  final_confirmation: () => t('state.final_confirmation'),
  fee_selection: () => t('state.fee_selection'),
  stayed_blocked: () => t('state.stayed_blocked'),
  unlocked: () => t('state.unlocked'),
};

function attemptStateBadgeClass(state) {
  if (state === 'stayed_blocked') return 'resisted';
  if (state === 'unlocked') return 'unlocked';
  return 'progress';
}

function formatAttemptWhen(createdAt) {
  if (!createdAt?.toDate) return t('chats.justNow');
  return createdAt.toDate().toLocaleString(LANG, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const loadedChatMessages = new Map();

async function toggleChatMessages(chatId, containerEl, toggleBtn) {
  const isOpen = containerEl.classList.toggle('open');
  toggleBtn.textContent = isOpen ? t('chats.hideConversation') : t('chats.viewConversation');
  if (!isOpen || loadedChatMessages.has(chatId)) return;

  containerEl.innerHTML = `<div class="sub">${t('chats.loadingMessages')}</div>`;
  try {
    const messagesQuery = query(collection(db, 'chats', chatId, 'messages'), orderBy('sentAt', 'asc'));
    const snap = await getDocs(messagesQuery);
    const messages = snap.docs.map((d) => d.data());
    loadedChatMessages.set(chatId, messages);
    renderChatMessages(containerEl, messages);
  } catch (err) {
    console.error('[limen-dashboard] error cargando mensajes del chat', err);
    containerEl.innerHTML = `<div class="field-error">${t('chats.errorLoad')}</div>`;
  }
}

function renderChatMessages(containerEl, messages) {
  if (!messages.length) {
    containerEl.innerHTML = `<div class="sub">${t('chats.noMessages')}</div>`;
    return;
  }
  containerEl.innerHTML = messages.map((m) => `
    <div class="chat-msg ${m.from === 'user' ? 'user' : ''}">
      <div class="who">${m.from === 'user' ? t('chats.you') : t('chats.yourSupport')}</div>
      ${escapeHtmlDash(m.text || '')}
    </div>`).join('');
}

function escapeHtmlDash(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderChatsList() {
  const el = document.getElementById('chats-list');
  if (!currentAttempts.length) {
    el.innerHTML = `<div class="sub">${t('chats.empty')}</div>`;
    return;
  }

  el.innerHTML = currentAttempts.map((a) => `
    <div class="chat-attempt">
      <div class="chat-attempt-head" data-expand="${a.id}">
        <div>
          <div class="chat-attempt-domain"><span class="m-dot" style="width:6px;height:6px;border-radius:50%;background:var(--amber);"></span>${escapeHtmlDash(a.domain || '')}</div>
          <div class="chat-attempt-when">${formatAttemptWhen(a.createdAt)}</div>
        </div>
        <span class="chat-state-badge ${attemptStateBadgeClass(a.state)}">${ATTEMPT_STATE_LABELS[a.state] ? ATTEMPT_STATE_LABELS[a.state]() : a.state}</span>
      </div>
      ${a.chatId ? `
        <button class="chat-toggle-messages" data-toggle-chat="${a.chatId}">${t('chats.viewConversation')}</button>
        <div class="chat-messages" data-messages="${a.chatId}"></div>
      ` : ''}
    </div>`).join('');

  el.querySelectorAll('button[data-toggle-chat]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const chatId = btn.dataset.toggleChat;
      const container = el.querySelector(`[data-messages="${chatId}"]`);
      toggleChatMessages(chatId, container, btn);
    });
  });
}

// ---------------------------------------------------------------
// Métricas — calculadas en el momento a partir de currentAttempts,
// nada precomputado ni inventado.
//
// La racha se calcula desde la fecha real de creación de la cuenta
// (auth currentUser.metadata.creationTime — la da Firebase gratis, sin
// necesidad de guardar un campo aparte) y se rompe el día que hay un
// intento con state === 'unlocked' (pagaste para saltarte el bloqueo).
// ---------------------------------------------------------------
function dayKey(date) { return date.toISOString().slice(0, 10); }

function accountStartDate() {
  const raw = currentUser?.metadata?.creationTime;
  const d = raw ? new Date(raw) : new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function unlockedDaySet(attempts) {
  return new Set(
    attempts
      .filter((a) => a.state === 'unlocked' && a.createdAt?.toDate)
      .map((a) => dayKey(a.createdAt.toDate()))
  );
}

function computeStreak(attempts) {
  const unlockedDays = unlockedDaySet(attempts);
  const start = accountStartDate();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let streak = 0;
  for (const d = new Date(today); d >= start; d.setDate(d.getDate() - 1)) {
    if (unlockedDays.has(dayKey(d))) break;
    streak++;
  }
  return streak;
}

function computeBestStreak(attempts) {
  const unlockedDays = unlockedDaySet(attempts);
  const start = accountStartDate();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let best = 0;
  let run = 0;
  for (const d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
    if (unlockedDays.has(dayKey(d))) { run = 0; } else { run++; if (run > best) best = run; }
  }
  return best;
}

function mostTemptingDomain(attempts) {
  const counts = {};
  attempts.forEach((a) => { if (a.domain) counts[a.domain] = (counts[a.domain] || 0) + 1; });
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return entries[0] || null;
}

const MILESTONES = [
  { days: 3, icon: '🌱' },
  { days: 7, icon: '🔥' },
  { days: 14, icon: '⚡' },
  { days: 30, icon: '🏅' },
  { days: 100, icon: '🏆' },
];

function renderMilestones(bestStreak) {
  return `<div class="milestone-row">${MILESTONES.map((m) => `
    <div class="milestone ${bestStreak >= m.days ? 'unlocked' : ''}" title="${bestStreak >= m.days ? t('milestone.reached') : t('milestone.remaining', { n: m.days - bestStreak })}">
      <div class="m-icon">${m.icon}</div>
      <div class="m-n">${t('milestone.days', { n: m.days })}</div>
    </div>`).join('')}</div>`;
}

const WEEKDAY_LABELS = [t('weekday.0'), t('weekday.1'), t('weekday.2'), t('weekday.3'), t('weekday.4'), t('weekday.5'), t('weekday.6')];

function computePatternInsight(attempts) {
  const withDate = attempts.filter((a) => a.createdAt?.toDate);
  if (withDate.length < 3) return null;
  const counts = {};
  withDate.forEach((a) => {
    const d = a.createdAt.toDate();
    const key = d.getDay() + '-' + d.getHours();
    counts[key] = (counts[key] || 0) + 1;
  });
  const [topKey, topCount] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const [day, hour] = topKey.split('-').map(Number);
  return { day, hour, count: topCount, total: withDate.length };
}

function computeWeekCompare(attempts) {
  const now = new Date();
  const startThis = new Date(now); startThis.setDate(startThis.getDate() - 6); startThis.setHours(0, 0, 0, 0);
  const startLast = new Date(startThis); startLast.setDate(startLast.getDate() - 7);
  const endLast = new Date(startThis.getTime() - 1);

  let thisWeekResisted = 0;
  let lastWeekResisted = 0;
  attempts.forEach((a) => {
    if (!a.createdAt?.toDate || a.state !== 'stayed_blocked') return;
    const d = a.createdAt.toDate();
    if (d >= startThis && d <= now) thisWeekResisted++;
    else if (d >= startLast && d <= endLast) lastWeekResisted++;
  });
  return { thisWeekResisted, lastWeekResisted };
}

let metricsChartInstance = null;

function renderChart(attempts) {
  const canvas = document.getElementById('metrics-chart');
  if (!canvas || typeof Chart === 'undefined') return; // sin Chart.js (ej. sin internet) no rompe el resto del panel

  const start = accountStartDate();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const daysSinceStart = Math.round((today - start) / 86400000) + 1;
  const daysToShow = Math.min(14, daysSinceStart);

  const labels = [];
  const resistedData = [];
  const unlockedData = [];
  for (let i = daysToShow - 1; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    labels.push(d.toLocaleDateString(LANG, { weekday: 'short' }).replace('.', ''));
    const key = dayKey(d);
    const dayAttempts = attempts.filter((a) => a.createdAt?.toDate && dayKey(a.createdAt.toDate()) === key);
    resistedData.push(dayAttempts.filter((a) => a.state === 'stayed_blocked').length);
    unlockedData.push(dayAttempts.filter((a) => a.state === 'unlocked').length);
  }

  if (metricsChartInstance) metricsChartInstance.destroy();
  metricsChartInstance = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: t('chart.legendResisted'), data: resistedData, backgroundColor: '#8FAE84', borderRadius: 4, maxBarThickness: 22 },
        { label: t('chart.legendUnlocked'), data: unlockedData, backgroundColor: '#C97C5F', borderRadius: 4, maxBarThickness: 22 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { color: 'rgba(251,243,231,.55)', font: { size: 10.5 } } },
        y: { stacked: true, beginAtZero: true, ticks: { color: 'rgba(251,243,231,.4)', stepSize: 1, font: { size: 10.5 } }, grid: { color: 'rgba(251,243,231,.06)' } },
      },
      plugins: {
        legend: { display: true, position: 'bottom', labels: { color: 'rgba(251,243,231,.7)', boxWidth: 10, font: { size: 11 }, padding: 12 } },
      },
    },
  });
}

function renderStreakDots(attempts) {
  const unlockedDays = unlockedDaySet(attempts);
  const start = accountStartDate();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const daysSinceStart = Math.round((today - start) / 86400000) + 1;
  const daysToShow = Math.min(14, daysSinceStart);

  let dots = '';
  for (let i = daysToShow - 1; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const held = !unlockedDays.has(dayKey(d));
    const label = d.toLocaleDateString(LANG, { day: 'numeric', month: 'short' });
    dots += `<span class="streak-dot ${held ? 'held' : 'broken'}" title="${label} · ${held ? t('streak.dotHeld') : t('streak.dotBroken')}"></span>`;
  }
  return dots;
}

function renderMetrics() {
  const el = document.getElementById('metrics-grid');
  const total = currentAttempts.length;

  const start = accountStartDate();
  const daysSinceStart = Math.max(1, Math.round((new Date() - start) / 86400000) + 1);
  const streak = computeStreak(currentAttempts);
  const bestStreak = computeBestStreak(currentAttempts);

  const streakBlock = `
    <div class="streak-card">
      <div class="streak-row">
        <div class="streak-main">
          <div class="streak-num"><span class="fire">🔥</span>${streak}</div>
          <div class="streak-label">${streak === 1 ? t('streak.dayOne') : t('streak.dayMany')}</div>
        </div>
        <div class="streak-best">
          <div class="streak-best-n">${bestStreak}</div>
          <div class="streak-best-l">${t('streak.record')}</div>
        </div>
      </div>
      <div class="streak-dots">${renderStreakDots(currentAttempts)}</div>
      <div class="streak-since">${t(daysSinceStart === 1 ? 'streak.sinceOne' : 'streak.sinceMany', { n: daysSinceStart })}</div>
    </div>`;

  const milestonesBlock = renderMilestones(bestStreak);

  if (!total) {
    el.innerHTML = streakBlock + milestonesBlock + `
      <div class="metrics-preview">
        <div class="eyebrow">${t('metrics.exampleEyebrow')}</div>
        <div class="sub">${t('metrics.exampleSub')}</div>
        <div class="metric-grid ghost">
          <div class="metric-tile"><div class="n">6</div><div class="l">${t('metrics.example.attempts')}</div></div>
          <div class="metric-tile"><div class="n">4</div><div class="l">${t('metrics.example.talked')}</div></div>
          <div class="metric-tile"><div class="n">3</div><div class="l">${t('metrics.example.resisted')}</div></div>
          <div class="metric-tile"><div class="n">$8.00</div><div class="l">${t('metrics.example.spent')}</div></div>
          <div class="metric-tile"><div class="n">75%</div><div class="l">${t('metrics.example.successRate')}</div></div>
          <div class="metric-tile"><div class="n" style="font-size:19px;">instagram.com</div><div class="l">${t('metrics.example.topSite')}</div></div>
        </div>
      </div>`;
    return;
  }

  const talked = currentAttempts.filter((a) => a.chatId).length;
  const resisted = currentAttempts.filter((a) => a.state === 'stayed_blocked').length;
  const unlocked = currentAttempts.filter((a) => a.state === 'unlocked').length;
  const spentCents = currentAttempts.reduce((sum, a) => sum + (a.state === 'unlocked' ? (a.feeAmountCents || 0) : 0), 0);
  const donatedCents = currentAttempts.reduce((sum, a) => sum + (a.donationAmountCents || 0), 0);
  const decided = resisted + unlocked;
  const successRate = decided ? Math.round((resisted / decided) * 100) : null;
  const topSite = mostTemptingDomain(currentAttempts);
  const pattern = computePatternInsight(currentAttempts);
  const week = computeWeekCompare(currentAttempts);
  const weekDelta = week.thisWeekResisted - week.lastWeekResisted;

  const insightRow = `
    <div class="insight-row">
      <div class="insight-card">
        <div class="k">${t('insight.pattern')}</div>
        ${pattern
          ? `<p>${t('insight.patternText', { weekday: WEEKDAY_LABELS[pattern.day], hour: String(pattern.hour).padStart(2, '0'), count: pattern.count, total: pattern.total })}</p>`
          : `<p>${t('insight.patternEmpty')}</p>`}
      </div>
      <div class="insight-card">
        <div class="k">${t('insight.weekCompare')}</div>
        <div class="big">
          <span class="v">${week.thisWeekResisted}</span>
          <span>${t('insight.daysThisWeek')}</span>
        </div>
        <p style="margin-top:6px;">${
          weekDelta > 0 ? `<span class="d up">${t('insight.moreThanLastWeek', { n: weekDelta, m: week.lastWeekResisted })}`
          : weekDelta < 0 ? `<span class="d down">${t('insight.lessThanLastWeek', { n: Math.abs(weekDelta), m: week.lastWeekResisted })}`
          : t('insight.sameAsLastWeek', { m: week.lastWeekResisted })
        }</p>
      </div>
    </div>`;

  el.innerHTML = streakBlock + milestonesBlock + insightRow + `
    <div class="chart-card">
      <div class="k">${t('chart.title')}</div>
      <div class="chart-wrap"><canvas id="metrics-chart"></canvas></div>
    </div>
    <div class="metric-grid">
      <div class="metric-tile"><div class="n">${total}</div><div class="l">${t('metrics.attempts')}</div></div>
      <div class="metric-tile"><div class="n">${talked}</div><div class="l">${t('metrics.talked')}</div></div>
      <div class="metric-tile"><div class="n">${resisted}</div><div class="l">${t('metrics.resisted')}</div></div>
      <div class="metric-tile"><div class="n">$${(spentCents / 100).toFixed(2)}</div><div class="l">${t('metrics.spent', { n: unlocked })}</div></div>
      ${successRate !== null ? `<div class="metric-tile"><div class="n">${successRate}%</div><div class="l">${t('metrics.successRate', { n: decided })}</div></div>` : ''}
      ${topSite ? `<div class="metric-tile"><div class="n" style="font-size:19px;">${escapeHtmlDash(topSite[0])}</div><div class="l">${t(topSite[1] === 1 ? 'metrics.topSiteOne' : 'metrics.topSiteMany', { n: topSite[1] })}</div></div>` : ''}
      ${donatedCents ? `<div class="metric-tile"><div class="n">$${(donatedCents / 100).toFixed(2)}</div><div class="l">${t('metrics.donated')}</div></div>` : ''}
      <div class="metric-note">${t('metrics.freeNote')}</div>
    </div>`;

  renderChart(currentAttempts);
}
