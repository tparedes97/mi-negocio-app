import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, collection, doc, setDoc, deleteDoc, onSnapshot, query, orderBy, limit, getDocs,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

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
    errorEl.textContent = 'No se pudo iniciar sesión. Intenta de nuevo.';
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
  const DAY_LABELS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
  const window = Object.values(site.schedule)[0];
  const dayList = days.map((d) => DAY_LABELS[Number(d)]).join(', ');
  return dayList + ' · ' + String(window.startHour).padStart(2, '0') + ':00–' + (window.endHour === 24 ? '24:00' : String(window.endHour).padStart(2, '0') + ':00');
}

function renderSiteList() {
  const el = document.getElementById('site-list');
  if (!currentSites.length) {
    el.innerHTML = '<div class="sub">Todavía no agregaste ningún sitio.</div>';
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
          <span class="lock-badge" title="No puedes editar ni quitar esto mientras está bloqueado. Solo puedes hacerlo en las horas libres de este sitio.">${ICON_LOCK}</span>
        </div>`;
    }

    if (confirmingRemovalIds.has(site.id)) {
      return `
        <div class="site-row confirming">
          <b>¿Eliminar el bloqueo de ${site.domain}?</b>
          <div class="confirm-actions">
            <button class="confirm-yes" data-confirm-remove="${site.id}">Sí, eliminar</button>
            <button class="confirm-no" data-cancel-remove="${site.id}">No</button>
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
          <button data-edit="${site.id}" aria-label="Editar ${site.domain}">${ICON_EDIT}</button>
          <button data-remove="${site.id}" aria-label="Quitar ${site.domain}">${ICON_CLOSE}</button>
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
    showDomainError('Eso no parece un sitio válido. Escribe solo el dominio, por ejemplo instagram.com (sin "https://").');
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
const DAY_LABELS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
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
    reasonWhyErrorEl.textContent = 'Cuéntanos aunque sea brevemente por qué — ayuda a que la decisión pese más.';
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
  motivational_questions: 'Pensándolo',
  offered_chat: 'Le ofrecieron hablar',
  queued: 'Esperando a alguien',
  donation_prompt: 'Terminó de hablar',
  final_confirmation: 'Decidiendo',
  fee_selection: 'Eligiendo desbloqueo',
  stayed_blocked: 'Se quedó bloqueado',
  unlocked: 'Desbloqueó',
};

function attemptStateBadgeClass(state) {
  if (state === 'stayed_blocked') return 'resisted';
  if (state === 'unlocked') return 'unlocked';
  return 'progress';
}

function formatAttemptWhen(createdAt) {
  if (!createdAt?.toDate) return 'Justo ahora';
  return createdAt.toDate().toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const loadedChatMessages = new Map();

async function toggleChatMessages(chatId, containerEl, toggleBtn) {
  const isOpen = containerEl.classList.toggle('open');
  toggleBtn.textContent = isOpen ? 'Ocultar conversación ▲' : 'Ver conversación ▼';
  if (!isOpen || loadedChatMessages.has(chatId)) return;

  containerEl.innerHTML = '<div class="sub">Cargando mensajes…</div>';
  try {
    const messagesQuery = query(collection(db, 'chats', chatId, 'messages'), orderBy('sentAt', 'asc'));
    const snap = await getDocs(messagesQuery);
    const messages = snap.docs.map((d) => d.data());
    loadedChatMessages.set(chatId, messages);
    renderChatMessages(containerEl, messages);
  } catch (err) {
    console.error('[limen-dashboard] error cargando mensajes del chat', err);
    containerEl.innerHTML = '<div class="field-error">No se pudo cargar la conversación.</div>';
  }
}

function renderChatMessages(containerEl, messages) {
  if (!messages.length) {
    containerEl.innerHTML = '<div class="sub">No hubo mensajes en esta conversación.</div>';
    return;
  }
  containerEl.innerHTML = messages.map((m) => `
    <div class="chat-msg ${m.from === 'user' ? 'user' : ''}">
      <div class="who">${m.from === 'user' ? 'Vos' : 'Tu persona de apoyo'}</div>
      ${escapeHtmlDash(m.text || '')}
    </div>`).join('');
}

function escapeHtmlDash(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderChatsList() {
  const el = document.getElementById('chats-list');
  if (!currentAttempts.length) {
    el.innerHTML = '<div class="sub">Todavía no tuviste ningún intento de desbloqueo — buena señal.</div>';
    return;
  }

  el.innerHTML = currentAttempts.map((a) => `
    <div class="chat-attempt">
      <div class="chat-attempt-head" data-expand="${a.id}">
        <div>
          <div class="chat-attempt-domain"><span class="m-dot" style="width:6px;height:6px;border-radius:50%;background:var(--amber);"></span>${escapeHtmlDash(a.domain || '')}</div>
          <div class="chat-attempt-when">${formatAttemptWhen(a.createdAt)}</div>
        </div>
        <span class="chat-state-badge ${attemptStateBadgeClass(a.state)}">${ATTEMPT_STATE_LABELS[a.state] || a.state}</span>
      </div>
      ${a.chatId ? `
        <button class="chat-toggle-messages" data-toggle-chat="${a.chatId}">Ver conversación ▼</button>
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
// ---------------------------------------------------------------
function renderMetrics() {
  const el = document.getElementById('metrics-grid');
  const total = currentAttempts.length;

  if (!total) {
    el.innerHTML = '<div class="sub">Todavía no hay datos — van a aparecer acá apenas tengas tu primer intento de desbloqueo.</div>';
    return;
  }

  const talked = currentAttempts.filter((a) => a.chatId).length;
  const resisted = currentAttempts.filter((a) => a.state === 'stayed_blocked').length;
  const unlocked = currentAttempts.filter((a) => a.state === 'unlocked').length;
  const spentCents = currentAttempts.reduce((sum, a) => sum + (a.state === 'unlocked' ? (a.feeAmountCents || 0) : 0), 0);

  el.innerHTML = `
    <div class="metric-tile"><div class="n">${total}</div><div class="l">Intentos de desbloqueo</div></div>
    <div class="metric-tile"><div class="n">${talked}</div><div class="l">Veces que hablaste con una persona de apoyo</div></div>
    <div class="metric-tile"><div class="n">${resisted}</div><div class="l">Veces que te quedaste bloqueado</div></div>
    <div class="metric-tile"><div class="n">$${(spentCents / 100).toFixed(2)}</div><div class="l">Gastado en desbloqueos (${unlocked} pagos)</div></div>
    <div class="metric-note">Hablar con tu persona de apoyo siempre es gratis — lo único que tiene costo es el desbloqueo temporal, y solo si lo confirmás.</div>
  `;
}
