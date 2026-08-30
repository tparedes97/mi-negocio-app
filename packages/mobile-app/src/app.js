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

  unsubscribeSites = onSnapshot(collection(db, 'users', user.uid, 'blockedSites'), (snap) => {
    currentSites = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderSiteList();
    applyBlockingIfActive();
    renderMetrics();
  }, (err) => {
    console.error('[limen-mobile] error escuchando blockedSites', err);
    sitesList.innerHTML = 'No se pudo cargar tu lista: ' + (err.message || err.code);
  });

  // Mismos intentos de desbloqueo que ve el panel web (packages/dashboard) —
  // los crea la extensión de Chrome cuando alguien entra a un sitio
  // bloqueado, pero como es la misma cuenta de Firebase, las métricas acá
  // salen exactamente iguales, sin importar desde qué dispositivo se generaron.
  const attemptsQuery = query(collection(db, 'users', user.uid, 'unlockAttempts'), orderBy('createdAt', 'desc'), limit(50));
  unsubscribeAttempts = onSnapshot(attemptsQuery, (snap) => {
    currentAttempts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderMetrics();
  }, (err) => {
    console.error('[limen-mobile] error escuchando unlockAttempts', err);
    document.getElementById('metrics-grid').innerHTML = 'No se pudieron cargar tus métricas.';
  });

  initNotifications();
  initBlockerEvents();
});

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

function mostTemptingDomain(attempts) {
  const counts = {};
  attempts.forEach((a) => { if (a.domain) counts[a.domain] = (counts[a.domain] || 0) + 1; });
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return entries[0] || null;
}

function computeBestResistedSite(attempts) {
  const byDomain = {};
  attempts.forEach((a) => {
    if (!a.domain || (a.state !== 'stayed_blocked' && a.state !== 'unlocked')) return;
    if (!byDomain[a.domain]) byDomain[a.domain] = { resisted: 0, decided: 0 };
    byDomain[a.domain].decided++;
    if (a.state === 'stayed_blocked') byDomain[a.domain].resisted++;
  });
  const entries = Object.entries(byDomain).filter(([, v]) => v.decided >= 2);
  if (!entries.length) return null;
  entries.sort((a, b) => (b[1].resisted / b[1].decided) - (a[1].resisted / a[1].decided));
  const [domain, v] = entries[0];
  return { domain, rate: Math.round((v.resisted / v.decided) * 100), decided: v.decided };
}

const MILESTONES = [
  { days: 3, icon: '🌱' }, { days: 7, icon: '🔥' }, { days: 14, icon: '⚡' }, { days: 30, icon: '🏅' }, { days: 100, icon: '🏆' },
];

function renderMilestones(bestStreak) {
  return `<div class="milestone-row">${MILESTONES.map((m) => `
    <div class="milestone ${bestStreak >= m.days ? 'unlocked' : ''}">
      <div class="m-icon">${m.icon}</div><div class="m-n">${m.days} días</div>
    </div>`).join('')}</div>`;
}

const WEEKDAY_LABELS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

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
  let thisWeekResisted = 0, lastWeekResisted = 0;
  attempts.forEach((a) => {
    if (!a.createdAt?.toDate || a.state !== 'stayed_blocked') return;
    const d = a.createdAt.toDate();
    if (d >= startThis && d <= now) thisWeekResisted++;
    else if (d >= startLast && d <= endLast) lastWeekResisted++;
  });
  return { thisWeekResisted, lastWeekResisted };
}

function computeMonthCompare(attempts) {
  const now = new Date();
  const startThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endLastMonth = new Date(startThisMonth.getTime() - 1);
  let thisMonthResisted = 0, lastMonthResisted = 0;
  attempts.forEach((a) => {
    if (!a.createdAt?.toDate || a.state !== 'stayed_blocked') return;
    const d = a.createdAt.toDate();
    if (d >= startThisMonth && d <= now) thisMonthResisted++;
    else if (d >= startLastMonth && d <= endLastMonth) lastMonthResisted++;
  });
  return { thisMonthResisted, lastMonthResisted };
}

function computeWeeklyFrequency(attempts) {
  const start = accountStartDate();
  const weeks = Math.max(1, (new Date() - start) / (7 * 86400000));
  return attempts.length / weeks;
}

function renderChartBars(attempts) {
  const start = accountStartDate();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const daysSinceStart = Math.round((today - start) / 86400000) + 1;
  const daysToShow = Math.min(14, daysSinceStart);
  const maxCount = Math.max(1, ...Array.from({ length: daysToShow }, (_, i) => {
    const d = new Date(today); d.setDate(d.getDate() - (daysToShow - 1 - i));
    const key = dayKey(d);
    return attempts.filter((a) => a.createdAt?.toDate && dayKey(a.createdAt.toDate()) === key).length;
  }));

  let bars = '';
  for (let i = daysToShow - 1; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const key = dayKey(d);
    const dayAttempts = attempts.filter((a) => a.createdAt?.toDate && dayKey(a.createdAt.toDate()) === key);
    const count = dayAttempts.length;
    const heightPct = Math.round((count / maxCount) * 100);
    bars += `<div class="bar" style="height:${Math.max(heightPct, count ? 8 : 2)}%"></div>`;
  }
  return bars;
}

function renderMetrics() {
  const el = document.getElementById('metrics-grid');
  if (!currentUser) return;
  const total = currentAttempts.length;

  const start = accountStartDate();
  const daysSinceStart = Math.max(1, Math.round((new Date() - start) / 86400000) + 1);
  const streak = computeStreak(currentAttempts);
  const bestStreak = computeBestStreak(currentAttempts);

  const streakBlock = `
    <div class="streak-card">
      <div class="streak-row">
        <div>
          <div class="streak-num">🔥 ${streak}</div>
          <div class="streak-label">${streak === 1 ? 'día cumplido seguido' : 'días cumplidos seguidos'}</div>
        </div>
        <div class="streak-best">
          <div class="streak-best-n">${bestStreak}</div>
          <div class="streak-best-l">récord</div>
        </div>
      </div>
      <div class="streak-since">Programando con Limen hace ${daysSinceStart} ${daysSinceStart === 1 ? 'día' : 'días'} — sin pagar por saltarte un bloqueo.</div>
    </div>`;

  const milestonesBlock = renderMilestones(bestStreak);

  if (!total) {
    el.innerHTML = streakBlock + milestonesBlock + `
      <div class="insight-card">
        <div class="k">Ejemplo — todavía no tenés datos propios</div>
        <p>Así se va a ver esta sección apenas tengas tu primer intento de desbloqueo.</p>
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
  const bestSite = computeBestResistedSite(currentAttempts);
  const pattern = computePatternInsight(currentAttempts);
  const week = computeWeekCompare(currentAttempts);
  const weekDelta = week.thisWeekResisted - week.lastWeekResisted;
  const month = computeMonthCompare(currentAttempts);
  const monthDelta = month.thisMonthResisted - month.lastMonthResisted;
  const weeklyFrequency = computeWeeklyFrequency(currentAttempts);
  const talkRate = total ? Math.round((talked / total) * 100) : null;

  const insightsBlock = `
    <div class="insight-card">
      <div class="k">Tu patrón</div>
      ${pattern
        ? `<p>Los <b>${WEEKDAY_LABELS[pattern.day]} a las ${String(pattern.hour).padStart(2, '0')}:00</b> es tu momento más difícil — ahí cayeron ${pattern.count} de tus ${pattern.total} intentos.</p>`
        : `<p>Todavía no hay suficientes intentos para ver un patrón por día y hora.</p>`}
    </div>
    <div class="insight-card">
      <div class="k">Esta semana vs. la anterior</div>
      <div class="big"><span class="v">${week.thisWeekResisted}</span><span>días cumplidos esta semana</span></div>
      <p style="margin-top:4px;">${
        weekDelta > 0 ? `<span class="d up">▲ ${weekDelta} más</span> que la semana pasada (${week.lastWeekResisted}).`
        : weekDelta < 0 ? `<span class="d down">▼ ${Math.abs(weekDelta)} menos</span> que la semana pasada (${week.lastWeekResisted}).`
        : `Igual que la semana pasada (${week.lastWeekResisted}).`
      }</p>
    </div>
    <div class="insight-card">
      <div class="k">Este mes vs. el anterior</div>
      <div class="big"><span class="v">${month.thisMonthResisted}</span><span>días cumplidos este mes</span></div>
      <p style="margin-top:4px;">${
        monthDelta > 0 ? `<span class="d up">▲ ${monthDelta} más</span> que el mes pasado (${month.lastMonthResisted}).`
        : monthDelta < 0 ? `<span class="d down">▼ ${Math.abs(monthDelta)} menos</span> que el mes pasado (${month.lastMonthResisted}).`
        : `Igual que el mes pasado (${month.lastMonthResisted}).`
      }</p>
    </div>
    ${talkRate !== null ? `
    <div class="insight-card">
      <div class="k">Cuánto hablas</div>
      <div class="big"><span class="v">${talkRate}%</span></div>
      <p style="margin-top:4px;">Hablaste con alguien en ${talked} de tus ${total} intentos.</p>
    </div>` : ''}`;

  el.innerHTML = streakBlock + milestonesBlock + insightsBlock + `
    <div class="chart-card">
      <div class="k">Últimos días</div>
      <div class="chart-bars">${renderChartBars(currentAttempts)}</div>
    </div>
    <div class="metric-grid">
      <div class="metric-tile"><div class="n">${total}</div><div class="l">Intentos de desbloqueo</div></div>
      <div class="metric-tile"><div class="n">${weeklyFrequency.toFixed(1)}</div><div class="l">Intentos por semana, en promedio</div></div>
      <div class="metric-tile"><div class="n">${talked}</div><div class="l">Veces que hablaste con una persona de apoyo</div></div>
      <div class="metric-tile"><div class="n">${resisted}</div><div class="l">Veces que te quedaste bloqueado</div></div>
      <div class="metric-tile"><div class="n">$${(spentCents / 100).toFixed(2)}</div><div class="l">Gastado en desbloqueos (${unlocked} pagos)</div></div>
      ${successRate !== null ? `<div class="metric-tile"><div class="n">${successRate}%</div><div class="l">Tasa de éxito, sobre ${decided} decisiones tomadas</div></div>` : ''}
      ${topSite ? `<div class="metric-tile"><div class="n" style="font-size:15px;">${escapeHtmlDash(topSite[0])}</div><div class="l">Tu sitio más tentador (${topSite[1]} ${topSite[1] === 1 ? 'intento' : 'intentos'})</div></div>` : ''}
      ${bestSite ? `<div class="metric-tile"><div class="n" style="font-size:15px;">${escapeHtmlDash(bestSite.domain)}</div><div class="l">Tu sitio con mejor tasa de éxito (${bestSite.rate}% sobre ${bestSite.decided})</div></div>` : ''}
      <div class="metric-tile"><div class="n">${currentSites.length}</div><div class="l">${currentSites.length === 1 ? 'Sitio bajo protección' : 'Sitios bajo protección'}</div></div>
      ${donatedCents ? `<div class="metric-tile"><div class="n">$${(donatedCents / 100).toFixed(2)}</div><div class="l">Donado a tu persona de apoyo</div></div>` : ''}
      <div class="metric-note">Hablar con tu persona de apoyo siempre es gratis.</div>
    </div>`;
}
