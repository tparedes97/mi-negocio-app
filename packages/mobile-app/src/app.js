/**
 * App vanilla (sin bundler), igual que el resto del monorepo — Capacitor
 * inyecta `window.Capacitor` automáticamente al correr dentro del shell
 * nativo (lo hace `cap sync`, agregando el script runtime a index.html).
 * Los plugins se llaman vía Capacitor.Plugins.<Nombre>, tanto los
 * oficiales (PushNotifications, LocalNotifications, FirebaseAuthentication)
 * como el nuestro (LimenBlocker, ver android/.../LimenBlockerPlugin.kt).
 *
 * El SDK de Firebase (Auth/Firestore) sí se importa como módulo ES normal,
 * vía CDN — igual que packages/admin y packages/dashboard — porque corre
 * dentro del WebView como cualquier página web.
 *
 * ⚠️ No probado en un dispositivo/emulador real (no hay Android SDK en el
 * entorno donde se escribió esto — ver README.md). Revisar con cuidado,
 * sobre todo el login con Google, antes de confiar en esto en producción.
 */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithCredential, onAuthStateChanged, signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, collection, doc, setDoc, deleteDoc, onSnapshot, query, orderBy, limit,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);

const { Capacitor } = window;
const Plugins = Capacitor ? Capacitor.Plugins : {};
const {
  PushNotifications, LocalNotifications, LimenBlocker, FirebaseAuthentication, App: CapApp,
} = Plugins;

const statusDot = document.getElementById('vpn-status-dot');
const statusLabel = document.getElementById('vpn-status-label');
const toggleBtn = document.getElementById('btn-toggle-vpn');
const sitesList = document.getElementById('sites-list');

function renderStatus(active) {
  statusDot.className = 'status-dot ' + (active ? 'on' : 'off');
  statusLabel.textContent = active ? 'Bloqueo activado' : 'Bloqueo desactivado';
  toggleBtn.textContent = active ? 'Desactivar bloqueo' : 'Activar bloqueo';
  toggleBtn.className = 'btn ' + (active ? 'btn-danger' : 'btn-primary');
}

// ---------------------------------------------------------------
// Validación de dominios y ventana de bloqueo — copia intencional de
// packages/shared/src/domain.js y schedule.js (esta página no tiene
// bundler, así que no puede resolver ese import CommonJS directo). Si
// cambias esta lógica, cámbiala también allá, en packages/extension y en
// packages/dashboard.
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
// Login con Google — vía el plugin nativo (@capacitor-firebase/authentication),
// no vía popup web: los WebView de Android no manejan bien signInWithPopup/
// signInWithRedirect de Firebase. El plugin hace el flujo nativo de Google
// Sign-In y devuelve un idToken que canjeamos por una sesión de Firebase
// Auth — mismo patrón que ensureSignedIn() en packages/extension/src/lib/firebase.js
// (ahí es chrome.identity + GoogleAuthProvider.credential(), acá es el
// plugin nativo + lo mismo).
// ---------------------------------------------------------------
document.getElementById('btn-google-login').addEventListener('click', async () => {
  const errorEl = document.getElementById('login-error');
  errorEl.textContent = '';

  if (!FirebaseAuthentication) {
    errorEl.textContent = 'El login nativo no está disponible en este entorno (¿corriendo en navegador en vez del dispositivo?).';
    return;
  }

  try {
    const result = await FirebaseAuthentication.signInWithGoogle();
    const idToken = result?.credential?.idToken;
    if (!idToken) throw new Error('Google no devolvió un idToken.');
    const credential = GoogleAuthProvider.credential(idToken, result.credential.accessToken);
    await signInWithCredential(auth, credential);
    // onAuthStateChanged se encarga de mostrar el app-shell
  } catch (err) {
    errorEl.textContent = 'No se pudo iniciar sesión. Intenta de nuevo.';
    console.error('[limen-mobile] error de login', err);
  }
});

let currentUser = null;
let currentSites = [];
let currentAttempts = [];
let unsubscribeSites = null;
let unsubscribeAttempts = null;

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  document.getElementById('login-screen').style.display = user ? 'none' : 'block';
  document.getElementById('app-shell').style.display = user ? 'block' : 'none';

  if (unsubscribeSites) { unsubscribeSites(); unsubscribeSites = null; }
  if (unsubscribeAttempts) { unsubscribeAttempts(); unsubscribeAttempts = null; }
  if (!user) return;

  document.getElementById('settings-email').textContent = user.email || '';

  unsubscribeSites = onSnapshot(collection(db, 'users', user.uid, 'blockedSites'), (snap) => {
    currentSites = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderSiteList();
    applyBlockingIfActive();
  }, (err) => {
    console.error('[limen-mobile] error escuchando blockedSites', err);
    sitesList.innerHTML = 'No se pudo cargar tu lista: ' + (err.message || err.code);
  });

  // Mismos intentos de desbloqueo que ve el panel web (packages/dashboard) —
  // los crea la extensión de Chrome cuando alguien entra a un sitio
  // bloqueado, pero como es la misma cuenta de Firebase, las métricas acá
  // salen exactamente iguales, sin importar desde qué dispositivo se generaron.
  const attemptsQuery = query(collection(db, 'users', user.uid, 'unlockAttempts'), orderBy('createdAt', 'desc'), limit(200));
  unsubscribeAttempts = onSnapshot(attemptsQuery, (snap) => {
    currentAttempts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderChatsList();
    renderPremiumMetrics();
  }, (err) => {
    console.error('[limen-mobile] error escuchando unlockAttempts', err);
    document.getElementById('chats-list').textContent = 'No se pudo cargar tu historial.';
  });

  initNotifications();
  initBlockerEvents();
});

document.getElementById('lp-period')?.addEventListener('change', renderPremiumMetrics);
document.getElementById('btn-settings-logout')?.addEventListener('click', () => signOut(auth));

// ---------------------------------------------------------------
// Pestañas (Bloqueos / Métricas) — mismo mecanismo que packages/dashboard.
// ---------------------------------------------------------------
document.querySelectorAll('.app-tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.app-tab').forEach((b) => {
      b.classList.toggle('active', b === btn);
      b.setAttribute('aria-selected', String(b === btn));
    });
    document.querySelectorAll('.tab-panel').forEach((panel) => {
      panel.style.display = panel.id === 'tab-' + btn.dataset.tab ? 'block' : 'none';
    });
  });
});

function sitesCollectionRef() {
  return collection(db, 'users', currentUser.uid, 'blockedSites');
}

// ---------------------------------------------------------------
// Bloqueo real: el plugin nativo (LimenVpnService) no sabe nada de
// horarios, solo bloquea la lista de dominios que le pasemos mientras la
// VPN está activa — LimenVpnService.startVpn() además es idempotente si ya
// está corriendo (actualiza blockedDomains en memoria en vez de reiniciar
// la conexión), así que es seguro volver a llamar startBlocking() seguido.
// Por eso el filtrado por horario (qué sitio está bloqueado AHORA) vive
// acá, en JS, igual que syncBlockingRules() en background.js de la
// extensión — se recalcula cada vez que cambian los sitios, cada minuto
// mientras la app está abierta, y al volver del segundo plano.
// ---------------------------------------------------------------
async function applyBlockingIfActive() {
  if (!LimenBlocker) return;
  const { active } = await LimenBlocker.getStatus();
  if (!active) return;
  const domainsToBlock = currentSites.filter(isWithinBlockedWindow).map((s) => s.domain);
  await LimenBlocker.startBlocking({ domains: domainsToBlock });
}

setInterval(applyBlockingIfActive, 60 * 1000);

toggleBtn.addEventListener('click', async () => {
  if (!LimenBlocker) {
    alert('El plugin nativo de bloqueo no está disponible en este entorno (¿corriendo en navegador en vez del dispositivo?).');
    return;
  }
  const { active } = await LimenBlocker.getStatus();
  if (active) {
    await LimenBlocker.stopBlocking();
    renderStatus(false);
  } else {
    const domainsToBlock = currentSites.filter(isWithinBlockedWindow).map((s) => s.domain);
    const result = await LimenBlocker.startBlocking({ domains: domainsToBlock });
    renderStatus(result.active);
  }
});

async function initNotifications() {
  if (!PushNotifications || !LocalNotifications) return;

  await LocalNotifications.requestPermissions();

  const pushPerm = await PushNotifications.requestPermissions();
  if (pushPerm.receive !== 'granted') return;
  await PushNotifications.register();

  PushNotifications.addListener('registration', async (token) => {
    // El backend (Cloud Functions) todavía no manda pushes con esto —
    // guardarlo acá es la parte que le tocaba a esta app; falta la Cloud
    // Function que lo use para avisar de mensajes de chat nuevos o
    // confirmación de pago.
    if (currentUser) {
      await setDoc(doc(db, 'users', currentUser.uid), { fcmToken: token.value }, { merge: true });
    }
  });

  PushNotifications.addListener('registrationError', (err) => {
    console.error('[limen-mobile] error de registro push', err);
  });
}

let blockerEventsInitialized = false;

async function initBlockerEvents() {
  if (!LimenBlocker || blockerEventsInitialized) return;
  blockerEventsInitialized = true;

  const { active } = await LimenBlocker.getStatus();
  renderStatus(active);

  // Evento emitido desde LimenVpnService cuando el usuario intenta abrir
  // un dominio bloqueado — dispara una notificación local (el equivalente
  // móvil de redirigir a blocked.html en la extensión).
  LimenBlocker.addListener('blockedAttempt', async ({ domain }) => {
    if (!LocalNotifications) return;
    await LocalNotifications.schedule({
      notifications: [{
        id: Date.now() % 100000,
        title: 'Limen',
        body: `Intentaste abrir ${domain} — tocá para hablar con alguien o pagar el desbloqueo.`,
      }],
    });
  });
}

// Al volver del segundo plano, recalcular al toque en vez de esperar hasta
// el próximo minuto del setInterval.
if (CapApp) {
  CapApp.addListener('resume', applyBlockingIfActive);
}

// ---------------------------------------------------------------
// Lista de sitios: candado mientras está bloqueado, confirmación al
// quitar — mismas reglas que packages/extension y packages/dashboard: sin
// esto, bastaría con borrar el sitio acá para saltarse todo el bloqueo.
// ---------------------------------------------------------------
const confirmingRemovalIds = new Set();
const DAY_LABELS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

function scheduleSummary(site) {
  const days = Object.keys(site.schedule || {});
  if (!days.length) return '';
  const window = Object.values(site.schedule)[0];
  const dayList = days.map((d) => DAY_LABELS[Number(d)]).join(', ');
  return dayList + ' · ' + String(window.startHour).padStart(2, '0') + ':00–' + (window.endHour === 24 ? '24:00' : String(window.endHour).padStart(2, '0') + ':00');
}

function renderSiteList() {
  if (!currentSites.length) {
    sitesList.innerHTML = 'Todavía no agregaste ningún sitio.';
    return;
  }

  sitesList.innerHTML = currentSites.map((site) => {
    const blockedNow = isWithinBlockedWindow(site);

    if (blockedNow) {
      return `
        <div class="site-row">
          <div><span>${site.domain}</span><div class="meta">${scheduleSummary(site)}</div></div>
          <span class="lock-ico">🔒</span>
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
        <div><span>${site.domain}</span><div class="meta">${scheduleSummary(site)}</div></div>
        <div class="actions">
          <button data-edit="${site.id}">✎</button>
          <button data-remove="${site.id}">✕</button>
        </div>
      </div>`;
  }).join('');

  sitesList.querySelectorAll('button[data-remove]').forEach((btn) => {
    btn.addEventListener('click', () => { confirmingRemovalIds.add(btn.dataset.remove); renderSiteList(); });
  });
  sitesList.querySelectorAll('button[data-cancel-remove]').forEach((btn) => {
    btn.addEventListener('click', () => { confirmingRemovalIds.delete(btn.dataset.cancelRemove); renderSiteList(); });
  });
  sitesList.querySelectorAll('button[data-confirm-remove]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.confirmRemove;
      confirmingRemovalIds.delete(id);
      await deleteDoc(doc(sitesCollectionRef(), id));
    });
  });
  sitesList.querySelectorAll('button[data-edit]').forEach((btn) => {
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
// Horario + motivo por sitio (mismo diseño que packages/dashboard y el
// popup retirado de la extensión — ver prototype-reference.html)
// ---------------------------------------------------------------
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
// Métricas — mismas cuentas que packages/dashboard/app.js (copia
// intencional, ver nota de normalizeDomain más arriba sobre por qué esta
// página no puede importar el módulo compartido directo). Si cambias el
// cálculo de una métrica, cámbialo también allá para que no se desalineen.
// ---------------------------------------------------------------
function escapeHtmlDash(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function dayKey(date) { return date.toISOString().slice(0, 10); }

function accountStartDate() {
  const raw = currentUser?.metadata?.creationTime;
  const d = raw ? new Date(raw) : new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function unlockedDaySet(attempts) {
  return new Set(
    attempts.filter((a) => a.state === 'unlocked' && a.createdAt?.toDate).map((a) => dayKey(a.createdAt.toDate()))
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
  { days: 3, icon: '🌱' }, { days: 7, icon: '🔥' }, { days: 14, icon: '⚡' }, { days: 30, icon: '🏅' }, { days: 100, icon: '🏆' },
];

const WEEKDAY_LABELS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const DOW_SHORT = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];

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
// Panel premium de métricas — mismo cálculo y mismo orden de contenido
// que packages/dashboard/app.js (KPIs, evolución, heatmap, sitios,
// acompañamiento, efectividad, hitos, insight). Acá el gráfico de
// evolución es CSS puro (3 mini sparklines) en vez de Chart.js, para no
// sumarle una dependencia externa al WebView de la app nativa.
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
  const BLOCKS = 6;
  const grid = Array.from({ length: BLOCKS }, () => Array(7).fill(0));
  withDate.forEach((a) => {
    const d = a.createdAt.toDate();
    const dow = (d.getDay() + 6) % 7;
    const block = Math.floor(d.getHours() / 4);
    grid[block][dow]++;
  });
  const max = Math.max(1, ...grid.flat());
  return { grid, max };
}

function computeEvolution(attempts, days) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const attemptsData = [], resistedData = [], unlockedData = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const key = dayKey(d);
    const dayAttempts = attempts.filter((a) => a.createdAt?.toDate && dayKey(a.createdAt.toDate()) === key);
    attemptsData.push(dayAttempts.length);
    resistedData.push(dayAttempts.filter((a) => a.state === 'stayed_blocked').length);
    unlockedData.push(dayAttempts.filter((a) => a.state === 'unlocked').length);
  }
  return { attemptsData, resistedData, unlockedData };
}

function renderMiniBars(elId, data, color) {
  const el = document.getElementById(elId);
  if (!el) return;
  const max = Math.max(1, ...data);
  el.innerHTML = data.map((v) => `<i style="height:${v ? Math.max(Math.round((v / max) * 100), 10) : 2}%;background:${color}"></i>`).join('');
}

function renderHeatmap(heatmap) {
  const el = document.getElementById('lp-heatmap');
  if (!el) return;
  const BLOCK_LABELS = ['00', '04', '08', '12', '16', '20'];
  let html = '<div class="dow"></div>' + DOW_SHORT.map((l) => `<div class="dow">${l}</div>`).join('');
  heatmap.grid.forEach((row, i) => {
    html += `<div class="label">${BLOCK_LABELS[i]}</div>`;
    row.forEach((count) => {
      const intensity = count / heatmap.max;
      html += `<div class="cell" style="background:${count ? `rgba(190,122,66,${(0.15 + intensity * 0.75).toFixed(2)})` : ''}"></div>`;
    });
  });
  el.innerHTML = html;
}

function renderChallengingSites(sites) {
  const el = document.getElementById('lp-sites');
  if (!el) return;
  if (!sites.length) { el.innerHTML = `<p class="lp-callout">Todavía no hay suficientes intentos para ver tus sitios más desafiantes.</p>`; return; }
  el.innerHTML = sites.map((s) => `
    <div class="lp-site">
      <div class="lp-site-row"><span>${escapeHtmlDash(s.domain)}</span><small>${s.count} ${s.count === 1 ? 'intento' : 'intentos'}</small></div>
      <div class="lp-bar"><i style="width:${s.pct}%"></i></div>
    </div>`).join('');
}

function renderSupportComparison(support) {
  const el = document.getElementById('lp-support');
  if (!el) return;
  if (!support) { el.innerHTML = `<p class="lp-callout">Todavía no hay suficientes datos para comparar tus decisiones con y sin conversación.</p>`; return; }
  el.innerHTML = `
    <div class="lp-support">
      <div class="lp-donut" style="--v:${support.withChatRate}%">${support.withChatRate}%</div>
      <div class="lp-support-stats">
        <div class="lp-support-stat"><b>${support.withChatRate}%</b><small>Con conversación (${support.withChatCount})</small></div>
        <div class="lp-support-stat"><b>${support.withoutChatRate}%</b><small>Sin conversación (${support.withoutChatCount})</small></div>
      </div>
    </div>`;
}

function renderPremiumMilestones(bestStreak) {
  const el = document.getElementById('lp-milestones');
  if (!el) return;
  el.innerHTML = MILESTONES.map((m) => {
    const reached = bestStreak >= m.days;
    return `<div class="lp-milestone ${reached ? 'ok' : ''}"><span>${m.icon} ${m.days} días</span><span>${reached ? 'Alcanzado' : `Te faltan ${m.days - bestStreak} días`}</span></div>`;
  }).join('');
}

function renderInsight(pattern) {
  const titleEl = document.getElementById('lp-insight-title');
  const textEl = document.getElementById('lp-insight-text');
  if (!titleEl || !textEl) return;
  if (!pattern) {
    titleEl.textContent = 'Estamos conociendo tus patrones.';
    textEl.textContent = 'A medida que uses Limen, van a aparecer insights basados en tus propios momentos difíciles.';
    return;
  }
  const weekday = WEEKDAY_LABELS[pattern.day];
  const hour = String(pattern.hour).padStart(2, '0');
  titleEl.textContent = `${weekday} a las ${hour}:00 es tu momento más difícil`;
  textEl.textContent = `Los ${weekday} a las ${hour}:00 es tu momento más difícil — ahí cayeron ${pattern.count} de tus ${pattern.total} intentos.`;
}

function renderPremiumMetrics() {
  if (!document.getElementById('lp-success')) return; // pestaña Métricas nunca abierta todavía
  const days = Number(document.getElementById('lp-period')?.value || 30);
  const periodAttempts = attemptsWithinDays(currentAttempts, days);

  const streak = computeStreak(currentAttempts);
  const bestStreak = computeBestStreak(currentAttempts);
  document.getElementById('lp-streak').textContent = streak;
  document.getElementById('lp-best').textContent = `Mejor: ${bestStreak}`;

  const resisted = periodAttempts.filter((a) => a.state === 'stayed_blocked').length;
  const unlocked = periodAttempts.filter((a) => a.state === 'unlocked').length;
  const decided = resisted + unlocked;
  const successRate = decided ? Math.round((resisted / decided) * 100) : null;

  document.getElementById('lp-success').textContent = successRate !== null ? successRate + '%' : '—';
  document.getElementById('lp-success-note').textContent = decided ? `Sobre ${decided} decisiones tomadas` : 'Aún sin decisiones tomadas';
  document.getElementById('lp-attempts').textContent = periodAttempts.length;
  document.getElementById('lp-attempts-note').textContent = `Últimos ${days} días`;
  document.getElementById('lp-unlocked').textContent = unlocked;

  renderPremiumMilestones(bestStreak);

  const evolution = computeEvolution(periodAttempts, days);
  renderMiniBars('lp-mini-attempts', evolution.attemptsData, 'rgba(190,122,66,.55)');
  renderMiniBars('lp-mini-resisted', evolution.resistedData, 'var(--sage)');
  renderMiniBars('lp-mini-unlocked', evolution.unlockedData, 'var(--danger)');

  const heatmap = computeHeatmap(periodAttempts);
  renderHeatmap(heatmap);

  const pattern = computePatternInsight(periodAttempts);
  document.getElementById('lp-pattern').textContent = pattern
    ? `Los ${WEEKDAY_LABELS[pattern.day]} a las ${String(pattern.hour).padStart(2, '0')}:00 es tu momento más difícil — ahí cayeron ${pattern.count} de tus ${pattern.total} intentos.`
    : 'Estamos aprendiendo de tus patrones.';
  renderInsight(pattern);

  renderChallengingSites(computeChallengingSites(periodAttempts));
  renderSupportComparison(computeSupportComparison(periodAttempts));

  const effectivenessEl = document.getElementById('lp-effectiveness');
  const effectTextEl = document.getElementById('lp-effect-text');
  const effectProgressEl = document.getElementById('lp-effect-progress');
  if (successRate !== null) {
    effectivenessEl.textContent = successRate + '%';
    effectTextEl.textContent = `Sobre ${decided} decisiones tomadas en este período.`;
    effectProgressEl.style.width = successRate + '%';
  } else {
    effectivenessEl.textContent = '—%';
    effectTextEl.textContent = 'Aún no hay suficientes decisiones para calcular tu efectividad.';
    effectProgressEl.style.width = '0%';
  }
}

// ---------------------------------------------------------------
// Chats — mismo historial que packages/dashboard (users/{uid}/unlockAttempts)
// ---------------------------------------------------------------
function attemptStateLabel(state) {
  if (state === 'stayed_blocked') return 'Te quedaste bloqueado';
  if (state === 'unlocked') return 'Desbloqueaste';
  return 'En curso';
}

function formatAttemptWhen(createdAt) {
  if (!createdAt?.toDate) return '';
  return createdAt.toDate().toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function renderChatsList() {
  const el = document.getElementById('chats-list');
  if (!el) return;
  if (!currentAttempts.length) { el.textContent = 'Todavía no tenés intentos de desbloqueo registrados.'; return; }
  el.innerHTML = currentAttempts.map((a) => `
    <div class="site-row" style="flex-direction:column; align-items:stretch;">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span>${escapeHtmlDash(a.domain || '')}</span>
        <small>${attemptStateLabel(a.state)}</small>
      </div>
      <div class="meta">${formatAttemptWhen(a.createdAt)}</div>
    </div>`).join('');
}
