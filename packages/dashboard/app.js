import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, collection, doc, setDoc, deleteDoc, onSnapshot, query, where, orderBy, limit, getDocs,
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

// Copiado a mano de packages/shared/src/constants.js (SUBSCRIPTION_PLANS.free)
// -- este paquete no usa bundler, así que no puede importar el módulo
// compartido con un specifier tipo '@limen/shared/...' desde el navegador.
// Si cambia el número allá, hay que cambiarlo acá también.
const FREE_MAX_BLOCKED_SITES = 5;

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
document.getElementById('btn-settings-logout').addEventListener('click', () => signOut(auth));
// Las suscripciones todavía no están implementadas en el backend (ver
// createCheckoutSession.js) -- en vez de ofrecer un botón que intente un
// pago y falle, se avisa directamente.
document.getElementById('btn-settings-premium').addEventListener('click', () => {
  alert(t('account.premium.comingSoon'));
});
document.getElementById('btn-metrics-locked-cta').addEventListener('click', () => {
  alert(t('account.premium.comingSoon'));
});

let currentUser = null;
let unsubscribeSites = null;
let unsubscribeAttempts = null;
let unsubscribeActiveUnlocks = null;
let unsubscribeUserDoc = null;
let currentSites = [];
let currentAttempts = [];
let currentActiveUnlocks = new Map(); // domain -> expiresAtMs
let unlockCountdownInterval = null;
let currentPlan = 'free'; // 'free' | 'premium' -- solo lo escribe el backend (ver firestore.rules)

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  document.getElementById('landing').style.display = user ? 'none' : 'block';
  // '' (no vacío el string, sino que borra el inline style) en vez de 'block' —
  // #app-shell usa display:grid en su CSS (el sidebar de escritorio necesita
  // el layout de 2 columnas); si acá pusiéramos 'block' inline, ese inline
  // style le gana al display:grid de la hoja de estilos (que no tiene
  // !important) y el sidebar se ve estirado a todo el ancho, sin layout.
  document.getElementById('app-shell').style.display = user ? '' : 'none';

  if (unsubscribeSites) { unsubscribeSites(); unsubscribeSites = null; }
  if (unsubscribeAttempts) { unsubscribeAttempts(); unsubscribeAttempts = null; }
  if (unsubscribeActiveUnlocks) { unsubscribeActiveUnlocks(); unsubscribeActiveUnlocks = null; }
  if (unsubscribeUserDoc) { unsubscribeUserDoc(); unsubscribeUserDoc = null; }
  if (unlockCountdownInterval) { clearInterval(unlockCountdownInterval); unlockCountdownInterval = null; }
  if (!user) { currentPlan = 'free'; return; }

  document.getElementById('user-email').textContent = user.email || '';
  document.getElementById('settings-email').textContent = user.email || '';
  unsubscribeSites = onSnapshot(collection(db, 'users', user.uid, 'blockedSites'), (snap) => {
    currentSites = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderSiteList();
  }, (err) => {
    console.error('[limen-dashboard] error escuchando blockedSites', err);
    document.getElementById('site-list').innerHTML = '<div class="field-error">No se pudo cargar tu lista: ' + (err.message || err.code) + '</div>';
  });

  const attemptsQuery = query(collection(db, 'users', user.uid, 'unlockAttempts'), orderBy('createdAt', 'desc'), limit(200));
  unsubscribeAttempts = onSnapshot(attemptsQuery, (snap) => {
    currentAttempts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderChatsList();
    renderPremiumMetrics();
  }, (err) => {
    console.error('[limen-dashboard] error escuchando unlockAttempts', err);
    document.getElementById('chats-list').innerHTML = '<div class="field-error">No se pudo cargar tu historial: ' + (err.message || err.code) + '</div>';
  });

  // Desbloqueos temporales pagados (mismo activeUnlocks/{uid}_{domain} que
  // lee la extensión) -- sin esto, un sitio con un desbloqueo activo se
  // seguía mostrando con el candado como si estuviera bloqueando de verdad,
  // sin ninguna señal de que en realidad ya se puede entrar y por cuánto
  // tiempo más.
  const activeUnlocksQuery = query(collection(db, 'activeUnlocks'), where('userId', '==', user.uid));
  unsubscribeActiveUnlocks = onSnapshot(activeUnlocksQuery, (snap) => {
    currentActiveUnlocks = new Map(
      snap.docs
        .map((d) => d.data())
        .filter((u) => u.expiresAt && u.expiresAt.toMillis() > Date.now())
        .map((u) => [u.domain, u.expiresAt.toMillis()]),
    );
    renderSiteList();
  }, (err) => {
    console.error('[limen-dashboard] error escuchando activeUnlocks', err);
  });

  if (!unlockCountdownInterval) {
    unlockCountdownInterval = setInterval(() => {
      if (currentActiveUnlocks.size > 0) renderSiteList();
    }, 15000);
  }

  // Plan real (gratis/premium) -- lo escribe únicamente el backend al
  // confirmar un pago (ver firestore.rules). Si el documento todavía no
  // existe, se trata como 'free' (nunca se asume premium por defecto).
  unsubscribeUserDoc = onSnapshot(doc(db, 'users', user.uid), (snap) => {
    currentPlan = snap.exists() && snap.data().plan === 'premium' ? 'premium' : 'free';
    renderSettingsPlan();
    renderPremiumMetrics();
  }, (err) => {
    console.error('[limen-dashboard] error escuchando el plan del usuario', err);
  });
});

document.getElementById('lp-period')?.addEventListener('change', renderPremiumMetrics);

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

function renderSettingsPlan() {
  const label = document.getElementById('settings-plan-label');
  const body = document.getElementById('settings-plan-body');
  const cta = document.getElementById('btn-settings-premium');
  if (!label) return;

  label.removeAttribute('data-i18n');
  label.textContent = currentPlan === 'premium' ? t('settings.planPremium') : t('settings.planFree');

  body.removeAttribute('data-i18n');
  body.textContent = currentPlan === 'premium' ? t('account.premium.bodyActive') : t('account.premium.body');
  cta.style.display = currentPlan === 'premium' ? 'none' : '';
}

function formatUnlockCountdown(msRemaining) {
  const totalMinutes = Math.max(0, Math.ceil(msRemaining / 60000));
  if (totalMinutes < 60) return t('sites.unlockedMinutes', { minutes: totalMinutes });
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return t('sites.unlockedHoursMinutes', { hours, minutes });
}

function renderSiteList() {
  const el = document.getElementById('site-list');
  if (!currentSites.length) {
    el.innerHTML = `<div class="sub">${t('sites.empty')}</div>`;
    return;
  }

  const now = Date.now();
  el.innerHTML = currentSites.map((site) => {
    const blockedNow = isWithinBlockedWindow(site);
    const unlockExpiresAt = currentActiveUnlocks.get(site.domain);
    const isTemporarilyUnlocked = blockedNow && unlockExpiresAt && unlockExpiresAt > now;

    if (isTemporarilyUnlocked) {
      return `
        <div class="site-row">
          <div>
            <div class="name"><span class="dot dot-unlocked"></span>${site.domain}</div>
            <div class="meta">${scheduleSummary(site)}</div>
          </div>
          <span class="unlock-badge" title="${t('sites.unlockTooltip')}">${formatUnlockCountdown(unlockExpiresAt - now)}</span>
        </div>`;
    }

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

  if (currentPlan !== 'premium' && currentSites.length >= FREE_MAX_BLOCKED_SITES) {
    showDomainError(t('addSite.freeLimitReached', { limit: FREE_MAX_BLOCKED_SITES }));
    return;
  }

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

const MILESTONES = [
  { days: 3, icon: '🌱' },
  { days: 7, icon: '🔥' },
  { days: 14, icon: '⚡' },
  { days: 30, icon: '🏅' },
  { days: 100, icon: '🏆' },
];


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

// ---------------------------------------------------------------
// Panel premium de métricas (Limen Premium) — todo lo de abajo lee
// currentAttempts, nunca inventa números. "Tiempo protegido" queda fuera
// a propósito: no guardamos una duración fiable del bloqueo todavía.
// ---------------------------------------------------------------
function attemptsWithinDays(attempts, days) {
  const since = new Date(); since.setHours(0, 0, 0, 0); since.setDate(since.getDate() - (days - 1));
  return attempts.filter((a) => a.createdAt?.toDate && a.createdAt.toDate() >= since);
}

function computeChallengingSites(attempts, max = 5) {
  const byDomain = {};
  attempts.forEach((a) => { if (a.domain) byDomain[a.domain] = (byDomain[a.domain] || 0) + 1; });
  const entries = Object.entries(byDomain).sort((a, b) => b[1] - a[1]).slice(0, max);
  const top = entries[0]?.[1] || 1;
  return entries.map(([domain, count]) => ({ domain, count, pct: Math.round((count / top) * 100) }));
}

function computeSupportComparison(attempts) {
  const decided = attempts.filter((a) => a.state === 'stayed_blocked' || a.state === 'unlocked');
  const withChat = decided.filter((a) => a.chatId);
  const withoutChat = decided.filter((a) => !a.chatId);
  if (withChat.length < 2 || withoutChat.length < 2) return null;
  const rate = (list) => Math.round((list.filter((a) => a.state === 'stayed_blocked').length / list.length) * 100);
  return {
    withChatRate: rate(withChat), withChatCount: withChat.length,
    withoutChatRate: rate(withoutChat), withoutChatCount: withoutChat.length,
  };
}

function computeHeatmap(attempts) {
  const withDate = attempts.filter((a) => a.createdAt?.toDate);
  const BLOCKS = 6; // franjas de 4 horas: 00-04, 04-08, ... 20-24
  const grid = Array.from({ length: BLOCKS }, () => Array(7).fill(0));
  withDate.forEach((a) => {
    const d = a.createdAt.toDate();
    const dow = (d.getDay() + 6) % 7; // lunes=0 ... domingo=6
    const block = Math.floor(d.getHours() / 4);
    grid[block][dow]++;
  });
  const max = Math.max(1, ...grid.flat());
  return { grid, max, total: withDate.length };
}

function computeEvolution(attempts, days) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const labels = [];
  const attemptsData = [];
  const resistedData = [];
  const unlockedData = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    labels.push(d.toLocaleDateString(LANG, { day: 'numeric', month: 'short' }));
    const key = dayKey(d);
    const dayAttempts = attempts.filter((a) => a.createdAt?.toDate && dayKey(a.createdAt.toDate()) === key);
    attemptsData.push(dayAttempts.length);
    resistedData.push(dayAttempts.filter((a) => a.state === 'stayed_blocked').length);
    unlockedData.push(dayAttempts.filter((a) => a.state === 'unlocked').length);
  }
  return { labels, attemptsData, resistedData, unlockedData };
}

let evolutionChartInstance = null;

function renderEvolutionChart(evolution) {
  const canvas = document.getElementById('lp-evolution-chart');
  if (!canvas || typeof Chart === 'undefined') return; // sin Chart.js (ej. sin internet) no rompe el resto del panel

  if (evolutionChartInstance) evolutionChartInstance.destroy();
  evolutionChartInstance = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: evolution.labels,
      datasets: [
        { label: t('chart.legendAttempts'), data: evolution.attemptsData, backgroundColor: 'rgba(154,52,18,.25)', borderRadius: 3, maxBarThickness: 14 },
        { label: t('metrics.evolution.legendResisted'), data: evolution.resistedData, backgroundColor: '#8FAE84', borderRadius: 3, maxBarThickness: 14 },
        { label: t('chart.legendUnlocked'), data: evolution.unlockedData, backgroundColor: '#C97C5F', borderRadius: 3, maxBarThickness: 14 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { grid: { display: false }, ticks: { color: 'var(--lp-axis, #8C7A63)', font: { size: 9.5 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
        y: { beginAtZero: true, ticks: { color: 'var(--lp-axis, #8C7A63)', stepSize: 1, precision: 0, font: { size: 10 } }, grid: { color: 'rgba(154,52,18,.08)' } },
      },
      plugins: { legend: { display: false } },
    },
  });
}

function renderHeatmap(heatmap) {
  const el = document.getElementById('lp-heatmap');
  if (!el) return;
  const BLOCK_LABELS = ['00', '04', '08', '12', '16', '20'];
  const DOW_LABELS = [t('weekday.1short'), t('weekday.2short'), t('weekday.3short'), t('weekday.4short'), t('weekday.5short'), t('weekday.6short'), t('weekday.0short')];

  let html = '<div class="dow"></div>' + DOW_LABELS.map((l) => `<div class="dow">${l}</div>`).join('');
  heatmap.grid.forEach((row, i) => {
    html += `<div class="label">${BLOCK_LABELS[i]}</div>`;
    row.forEach((count) => {
      const intensity = count / heatmap.max;
      html += `<div class="cell" style="background:${count ? `rgba(154,52,18,${(0.12 + intensity * 0.75).toFixed(2)})` : ''}" title="${count} ${count === 1 ? t('metrics.heatmap.attemptOne') : t('metrics.heatmap.attemptMany')}"></div>`;
    });
  });
  el.innerHTML = html;
}

function renderChallengingSites(sites) {
  const el = document.getElementById('lp-sites');
  if (!el) return;
  if (!sites.length) { el.innerHTML = `<p class="lpv2-critical">${t('metrics.sites.empty')}</p>`; return; }
  el.innerHTML = sites.map((s) => `
    <div class="site">
      <div class="lpv2-site-row"><span>${escapeHtmlDash(s.domain)}</span><small>${t(s.count === 1 ? 'metrics.sites.attemptOne' : 'metrics.sites.attemptMany', { n: s.count })}</small></div>
      <div class="lpv2-bar"><i style="width:${s.pct}%"></i></div>
    </div>`).join('');
}

function renderSupportComparison(support) {
  const el = document.getElementById('lp-support');
  if (!el) return;
  if (!support) { el.innerHTML = `<p class="lpv2-critical">${t('metrics.support.empty')}</p>`; return; }
  el.innerHTML = `
    <div class="lpv2-compare">
      <div class="lpv2-donut" style="--v:${support.withChatRate}%">${support.withChatRate}%</div>
      <div class="lpv2-compare-stats">
        <div class="lpv2-compare-stat"><b>${support.withChatRate}%</b><small>${t('metrics.support.withChat', { n: support.withChatCount })}</small></div>
        <div class="lpv2-compare-stat bad"><b>${support.withoutChatRate}%</b><small>${t('metrics.support.withoutChat', { n: support.withoutChatCount })}</small></div>
      </div>
    </div>`;
}

function renderPremiumMilestones(bestStreak) {
  const el = document.getElementById('lp-milestones');
  if (!el) return;
  el.innerHTML = MILESTONES.map((m) => {
    const reached = bestStreak >= m.days;
    return `<div class="lpv2-milestone ${reached ? 'ok' : ''}"><span><span class="icon">${m.icon}</span>${t('milestone.days', { n: m.days })}</span><span class="check">${reached ? '✓' : '○'}</span></div>`;
  }).join('') + (bestStreak >= MILESTONES[MILESTONES.length - 1].days ? '<div class="trophy">🏆</div>' : '');
}

function renderInsight(pattern) {
  const titleEl = document.getElementById('lp-insight-title');
  const textEl = document.getElementById('lp-insight-text');
  if (!titleEl || !textEl) return;
  if (!pattern) {
    titleEl.textContent = t('metrics.insight.emptyTitle');
    textEl.textContent = t('metrics.insight.emptyText');
    return;
  }
  titleEl.textContent = t('insight.patternTitle', { weekday: WEEKDAY_LABELS[pattern.day], hour: String(pattern.hour).padStart(2, '0') });
  textEl.textContent = t('insight.patternText', { weekday: WEEKDAY_LABELS[pattern.day], hour: String(pattern.hour).padStart(2, '0'), count: pattern.count, total: pattern.total }).replace(/<\/?strong>/g, '');
}

function renderEffectPeople(successRate) {
  const el = document.getElementById('lp-effect-people');
  if (!el) return;
  if (successRate === null) { el.innerHTML = ''; return; }
  const filled = Math.round(successRate / 10);
  el.innerHTML = Array.from({ length: 10 }, (_, i) => `<span class="${i < filled ? '' : 'off'}">●</span>`).join('');
}

// ---------------------------------------------------------------
// Comparación mensual (mes calendario actual vs. el anterior) — usa TODOS
// los intentos, no solo la ventana de 14/30 días del selector, porque acá
// "mes pasado" siempre significa el mes calendario anterior.
// ---------------------------------------------------------------
function computeMonthlyDeltas(attempts) {
  const now = new Date();
  const startThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endLastMonth = new Date(startThisMonth.getTime() - 1);

  const inRange = (d, start, end) => d >= start && d <= end;
  const thisMonthList = attempts.filter((a) => a.createdAt?.toDate && inRange(a.createdAt.toDate(), startThisMonth, now));
  const lastMonthList = attempts.filter((a) => a.createdAt?.toDate && inRange(a.createdAt.toDate(), startLastMonth, endLastMonth));

  const stats = (list) => {
    const resisted = list.filter((a) => a.state === 'stayed_blocked').length;
    const unlocked = list.filter((a) => a.state === 'unlocked').length;
    const decided = resisted + unlocked;
    return {
      attempts: list.length, resisted, unlocked, decided,
      successRate: decided ? Math.round((resisted / decided) * 100) : null,
      relapseRate: decided ? Math.round((unlocked / decided) * 100) : null,
    };
  };
  return { thisMonth: stats(thisMonthList), lastMonth: stats(lastMonthList) };
}

function pctDelta(curr, prev) {
  if (!prev) return null;
  return Math.round(((curr - prev) / prev) * 100);
}
function ptDelta(curr, prev) {
  if (curr === null || prev === null) return null;
  return curr - prev;
}

function monthDeltaNote(delta, unit) {
  if (delta === null) return t('metrics.month.noPrevData');
  const arrow = delta >= 0 ? '▲' : '▼';
  const value = Math.abs(delta) + (unit === 'pt' ? ' pts' : '%');
  return `${arrow} ${value} ${t('metrics.month.vsLastMonth')}`;
}

// ---------------------------------------------------------------
// Índice Limen — puntaje compuesto 0-100, pensado para resumir el
// progreso en un solo número. Fórmula (documentada a propósito, ajustable
// si el criterio de negocio cambia): 60% tasa de éxito del período +
// 40% racha actual normalizada contra 30 días. No es un dato que Limen
// "mida" directamente — es un cálculo derivado de datos reales, igual
// que un puntaje de crédito resume varias señales en un número.
// ---------------------------------------------------------------
function computeLimenIndex(successRate, streak) {
  if (successRate === null) return null;
  const streakScore = Math.min(streak / 30, 1) * 100;
  return Math.round(successRate * 0.6 + streakScore * 0.4);
}

function indexStatusLabel(index) {
  if (index === null) return '';
  if (index >= 80) return t('metrics.index.great');
  if (index >= 60) return t('metrics.index.good');
  if (index >= 40) return t('metrics.index.fair');
  return t('metrics.index.starting');
}

function renderMonthGrid(monthly) {
  const el = document.getElementById('lp-month-grid');
  if (!el) return;

  const successDelta = ptDelta(monthly.thisMonth.successRate, monthly.lastMonth.successRate);
  const unlockedDelta = pctDelta(monthly.thisMonth.unlocked, monthly.lastMonth.unlocked);
  const attemptsDelta = pctDelta(monthly.thisMonth.attempts, monthly.lastMonth.attempts);
  const relapseDelta = ptDelta(monthly.thisMonth.relapseRate, monthly.lastMonth.relapseRate);

  const rows = [
    { label: t('metrics.month.aligned'), value: monthly.thisMonth.successRate !== null ? monthly.thisMonth.successRate + '%' : '—', delta: successDelta, unit: 'pt', good: successDelta === null ? null : successDelta >= 0 },
    { label: t('metrics.month.unlocked'), value: String(monthly.thisMonth.unlocked), delta: unlockedDelta, unit: '%', good: unlockedDelta === null ? null : unlockedDelta <= 0 },
    { label: t('metrics.month.recovered'), value: null },
    { label: t('metrics.month.attempts'), value: String(monthly.thisMonth.attempts), delta: attemptsDelta, unit: '%', good: attemptsDelta === null ? null : attemptsDelta <= 0 },
    { label: t('metrics.month.relapse'), value: monthly.thisMonth.relapseRate !== null ? monthly.thisMonth.relapseRate + '%' : '—', delta: relapseDelta, unit: 'pt', good: relapseDelta === null ? null : relapseDelta <= 0 },
  ];

  el.innerHTML = rows.map((r) => {
    if (r.value === null) {
      return `<div><label>${r.label}</label><b>—</b><small>${t('metrics.kpi.recoveredNote')}</small></div>`;
    }
    const cls = r.good === false ? 'down' : '';
    const note = r.good === true ? `<strong>${t('metrics.month.goodNote')}</strong>` : '';
    return `<div><label>${r.label}</label><b class="${cls}">${r.value}</b><small>${monthDeltaNote(r.delta, r.unit)}</small>${note}</div>`;
  }).join('');
}

function renderPremiumMetrics() {
  if (!document.getElementById('lp-success')) return; // pestaña Métricas nunca abierta todavía

  const isPremium = currentPlan === 'premium';
  document.getElementById('metrics-locked').style.display = isPremium ? 'none' : 'block';
  document.getElementById('metrics-unlocked').style.display = isPremium ? 'block' : 'none';
  if (!isPremium) return; // sin plan pago no se calcula nada -- ni falta hace

  const days = Number(document.getElementById('lp-period')?.value || 30);
  const periodAttempts = attemptsWithinDays(currentAttempts, days);
  document.getElementById('lp-evolution-title').textContent = t('metrics.evolution.title', { days });

  const streak = computeStreak(currentAttempts);
  const bestStreak = computeBestStreak(currentAttempts);
  document.getElementById('lp-streak').textContent = streak;
  document.getElementById('lp-best').textContent = t('metrics.kpi.bestNote', { n: bestStreak });

  const resisted = periodAttempts.filter((a) => a.state === 'stayed_blocked').length;
  const unlocked = periodAttempts.filter((a) => a.state === 'unlocked').length;
  const decided = resisted + unlocked;
  const successRate = decided ? Math.round((resisted / decided) * 100) : null;

  const monthly = computeMonthlyDeltas(currentAttempts);

  document.getElementById('lp-success').textContent = successRate !== null ? successRate + '%' : '—';
  document.getElementById('lp-success-note').textContent = monthDeltaNote(ptDelta(monthly.thisMonth.successRate, monthly.lastMonth.successRate), 'pt');
  document.getElementById('lp-attempts').textContent = periodAttempts.length;
  document.getElementById('lp-attempts-note').textContent = monthDeltaNote(pctDelta(monthly.thisMonth.attempts, monthly.lastMonth.attempts), '%');
  document.getElementById('lp-unlocked').textContent = unlocked;
  document.getElementById('lp-unlocked-note').textContent = monthDeltaNote(pctDelta(monthly.thisMonth.unlocked, monthly.lastMonth.unlocked), '%');
  document.getElementById('lp-recovered').textContent = '—';

  const index = computeLimenIndex(successRate, streak);
  document.getElementById('lp-index').textContent = index !== null ? index : '—';
  document.getElementById('lp-index-ring-n').textContent = index !== null ? index : '—';
  document.getElementById('lp-index-ring').style.setProperty('--ring', (index || 0) + '%');
  document.getElementById('lp-index-status').textContent = indexStatusLabel(index);
  document.getElementById('lp-index-note').textContent = index === null ? '' : monthDeltaNote(ptDelta(index, computeLimenIndex(monthly.lastMonth.successRate, streak)), 'pt');

  renderPremiumMilestones(bestStreak);
  renderMonthGrid(monthly);

  const evolution = computeEvolution(periodAttempts, days);
  renderEvolutionChart(evolution);

  const heatmap = computeHeatmap(periodAttempts);
  renderHeatmap(heatmap);

  const pattern = computePatternInsight(periodAttempts);
  document.getElementById('lp-pattern').textContent = pattern
    ? t('insight.patternText', { weekday: WEEKDAY_LABELS[pattern.day], hour: String(pattern.hour).padStart(2, '0'), count: pattern.count, total: pattern.total }).replace(/<\/?strong>/g, '')
    : t('metrics.heatmap.empty');
  renderInsight(pattern);

  renderChallengingSites(computeChallengingSites(periodAttempts));
  renderSupportComparison(computeSupportComparison(periodAttempts));
  renderEffectPeople(successRate);

  const effectivenessEl = document.getElementById('lp-effectiveness');
  const effectTextEl = document.getElementById('lp-effect-text');
  const effectProgressEl = document.getElementById('lp-effect-progress');
  if (successRate !== null) {
    effectivenessEl.textContent = successRate + '%';
    effectTextEl.textContent = t('metrics.effect.text', { n: decided });
    effectProgressEl.style.width = successRate + '%';
  } else {
    effectivenessEl.textContent = '—%';
    effectTextEl.textContent = t('metrics.effect.empty');
    effectProgressEl.style.width = '0%';
  }
}
