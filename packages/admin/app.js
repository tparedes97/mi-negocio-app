import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, collection, collectionGroup, getDocs,
  onSnapshot, orderBy, query, where,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import {
  getFunctions, httpsCallable,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js';
import { firebaseConfig } from './firebase-config.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app);

const DAYS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const PALETTE = [
  { bg: '#E4EBDA', text: '#3F5238' },
  { bg: '#F1E1C7', text: '#7A4D26' },
  { bg: '#E3E2EF', text: '#3A3860' },
  { bg: '#F3DDD6', text: '#6B372B' },
  { bg: '#DCE9EF', text: '#2E4A57' },
];

let currentUser = null;
let companionsById = new Map(); // uid -> CompanionDoc, incluye a la fundadora
let currentShiftGrid = null;
let unsubscribeCompanions = null;
let unsubscribeShift = null;
let unsubscribeArchive = null;
let savedCalendars = [];

// ---------------------------------------------------------------
// Login — solo la fundadora pasa (se valida contra companions/{uid}.role)
// ---------------------------------------------------------------
window.doLogin = async function doLogin() {
  const email = document.getElementById('login-user').value.trim();
  const pass = document.getElementById('login-pass').value;
  const errorEl = document.getElementById('login-error');
  errorEl.textContent = '';

  try {
    const cred = await signInWithEmailAndPassword(auth, email, pass);
    const companionSnap = await getDoc(doc(db, 'companions', cred.user.uid));
    if (!companionSnap.exists() || companionSnap.data().role !== 'founder') {
      errorEl.textContent = 'Esta cuenta no tiene acceso al panel de administrador.';
      await signOut(auth);
    }
    // si es fundadora, onAuthStateChanged se encarga de mostrar el app-shell
  } catch (err) {
    errorEl.textContent = 'Correo o contraseña incorrectos.';
    console.error('[limen-admin] error de login', err);
  }
};

onAuthStateChanged(auth, async (user) => {
  if (user) {
    currentUser = user;
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app-shell').style.display = 'flex';
    await startCompanionsListener(); // esperar la primera carga: computeRealPeriodData necesita companionsById ya listo
    startShiftListener();
    startArchiveListener();
    if (typeof window.initDashboard === 'function') window.initDashboard();
  } else {
    currentUser = null;
    document.getElementById('login-screen').style.display = 'flex';
    document.getElementById('app-shell').style.display = 'none';
    if (unsubscribeCompanions) unsubscribeCompanions();
    if (unsubscribeShift) unsubscribeShift();
    if (unsubscribeArchive) unsubscribeArchive();
  }
});

// ---------------------------------------------------------------
// Navegación
// ---------------------------------------------------------------
document.querySelectorAll('.app-nav-item').forEach((item) => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.app-nav-item').forEach((el) => el.classList.remove('active'));
    document.querySelectorAll('.app-panel').forEach((el) => el.classList.remove('active'));
    item.classList.add('active');
    document.getElementById('panel-' + item.dataset.panel).classList.add('active');
  });
});

function currentYearMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function emptyGrid() {
  return Array.from({ length: 7 }, () => Array(24).fill(null));
}

function personStyle(uid) {
  if (uid === currentUser.uid) return { bg: '#E3E2EF', text: '#3A3860', label: 'Tú' };
  const ids = [...companionsById.keys()].filter((id) => id !== currentUser.uid).sort();
  const idx = ids.indexOf(uid);
  const palette = PALETTE[(idx >= 0 ? idx : 0) % PALETTE.length];
  const companion = companionsById.get(uid);
  const initials = companion ? companion.fullName.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase() : '·';
  return { ...palette, label: initials };
}

// ---------------------------------------------------------------
// Compañeros
// ---------------------------------------------------------------
function startCompanionsListener() {
  return new Promise((resolveFirstLoad) => {
    let firstLoad = true;
    unsubscribeCompanions = onSnapshot(collection(db, 'companions'), (snap) => {
      companionsById = new Map(snap.docs.map((d) => [d.id, d.data()]));
      renderTeamTable();
      if (currentShiftGrid) { renderAdminGrid(); renderLeaderboard(); renderCoberturaGrid(); }
      if (firstLoad) { firstLoad = false; resolveFirstLoad(); }
    });
  });
}

function renderTeamTable() {
  const rows = [...companionsById.entries()].map(([uid, c]) => {
    const isMe = uid === currentUser.uid;
    return `
      <tr>
        <td>
          <div class="person-name">${isMe ? 'Tú (fundadora)' : c.fullName}</div>
          <div class="person-note">${isMe ? 'admin' : c.email}</div>
        </td>
        <td>${(c.assignedAliases || []).map((a) => `<span class="alias-chip">${a}</span>`).join('') || '—'}</td>
        <td><span class="badge ${c.active ? 'active' : 'inactive'}"><span class="dot"></span>${c.active ? 'Activo' : 'Pausado'}</span></td>
        <td></td>
      </tr>`;
  }).join('');
  document.getElementById('team-body').innerHTML = rows;
}

// --- Modal: agregar compañero ---
document.getElementById('btn-add')?.addEventListener('click', () => {
  document.getElementById('modal-backdrop').classList.add('active');
});
document.getElementById('btn-cancel')?.addEventListener('click', closeAddCompanionModal);

function closeAddCompanionModal() {
  document.getElementById('modal-backdrop').classList.remove('active');
  document.getElementById('new-companion-name').value = '';
  document.getElementById('new-companion-email').value = '';
  document.getElementById('cred-pass').value = '';
  document.getElementById('add-companion-error').textContent = '';
  document.querySelectorAll('#alias-chip-select .chip-opt').forEach((c) => c.classList.remove('picked'));
}

document.querySelectorAll('#alias-chip-select .chip-opt').forEach((chip) => {
  chip.addEventListener('click', () => chip.classList.toggle('picked'));
});

window.generatePass = function generatePass() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let pass = '';
  for (let i = 0; i < 10; i++) pass += chars[Math.floor(Math.random() * chars.length)];
  document.getElementById('cred-pass').value = pass;
};

document.getElementById('btn-save')?.addEventListener('click', async () => {
  const fullName = document.getElementById('new-companion-name').value.trim();
  const email = document.getElementById('new-companion-email').value.trim();
  const password = document.getElementById('cred-pass').value;
  const assignedAliases = [...document.querySelectorAll('#alias-chip-select .chip-opt.picked')].map((c) => c.dataset.alias);
  const errorEl = document.getElementById('add-companion-error');

  if (!fullName || !email || !password) {
    errorEl.textContent = 'Completa nombre, correo y genera una contraseña.';
    return;
  }

  try {
    const createCompanion = httpsCallable(functions, 'createCompanion');
    await createCompanion({ fullName, email, password, assignedAliases });
    closeAddCompanionModal();
    // la tabla se actualiza sola vía el listener de companions
  } catch (err) {
    errorEl.textContent = err.message || 'No se pudo crear el compañero.';
    console.error('[limen-admin] error creando compañero', err);
  }
});

// ---------------------------------------------------------------
// Turnos (editable) + Cobertura (espejo de solo lectura) + Archivo
// ---------------------------------------------------------------
function startShiftListener() {
  const ref = doc(db, 'shiftAssignments', currentYearMonth());
  unsubscribeShift = onSnapshot(ref, async (snap) => {
    if (!snap.exists()) {
      // primera vez que se abre el mes — se crea vacío, la fundadora sí puede escribir directo
      await setDoc(ref, {
        year: new Date().getFullYear(),
        month: new Date().getMonth() + 1,
        grid: emptyGrid(),
        launchedAt: null,
        launchedBy: null,
      });
      return; // el propio setDoc dispara este mismo listener de nuevo con el doc ya creado
    }
    const data = snap.data();
    currentShiftGrid = data.grid;
    updateLaunchStatus(data.launchedAt);
    renderAdminGrid();
    renderLeaderboard();
    renderCoberturaGrid();

    // Puente hacia la subpestaña Capacidad del Dashboard (todavía sin
    // migrar a Firestore) — ver comentario en index.html junto a
    // `window.adminShiftGrid`. Se quita cuando Capacidad se conecte de verdad.
    window.adminShiftGrid = currentShiftGrid;
    if (typeof window.renderCapacidad === 'function') window.renderCapacidad();
  });
}

function updateLaunchStatus(launchedAt) {
  const box = document.getElementById('launch-box');
  const status = document.getElementById('launch-status');
  const btn = document.getElementById('btn-launch');
  if (launchedAt) {
    box.classList.add('launched');
    status.textContent = 'Publicado — tus compañeros ya pueden ver e inscribirse en las casillas abiertas.';
    status.classList.add('on');
    btn.textContent = 'Calendario publicado ✓';
  } else {
    box.classList.remove('launched');
    status.textContent = 'Aún no publicado — tus compañeros no lo ven todavía.';
    status.classList.remove('on');
    btn.textContent = 'Lanzar calendario';
  }
}

function renderAdminGrid() {
  document.getElementById('admin-shift-grid').innerHTML = buildGridHtml(currentShiftGrid, true);
  document.querySelectorAll('#admin-shift-grid [data-cell]').forEach((cell) => {
    cell.addEventListener('click', () => cycleAdminCell(...cell.dataset.cell.split(':').map(Number)));
  });
}

function renderCoberturaGrid() {
  document.getElementById('cobertura-live-grid').innerHTML = buildGridHtml(currentShiftGrid, false);
  const gapCount = currentShiftGrid.reduce((sum, day) => sum + day.filter((v) => !v).length, 0);
  const alertEl = document.getElementById('cobertura-alert');
  alertEl.innerHTML = gapCount > 0
    ? `<span>⚠</span><span>Hay <b>${gapCount} casillas</b> sin cobertura ahora mismo. Edítalas desde "Turnos" para cerrar el hueco.</span>`
    : `<span>✓</span><span>Toda la semana está cubierta — no hay huecos pendientes.</span>`;
}

function buildGridHtml(grid, clickable) {
  let html = '<div class="shift-grid"><div class="shift-head"></div>';
  DAYS.forEach((d) => { html += `<div class="shift-head">${d}</div>`; });
  for (let h = 0; h < 24; h++) {
    html += `<div class="shift-hour-label">${String(h).padStart(2, '0')}:00</div>`;
    for (let d = 0; d < 7; d++) {
      const uid = grid[d][h];
      const style = uid ? personStyle(uid) : null;
      const bg = style ? `background:${style.bg}; color:${style.text};` : '';
      const attr = clickable ? `data-cell="${d}:${h}"` : '';
      html += `<div class="shift-cell ${uid ? '' : 'open'}" style="${bg}" ${attr}>${style ? style.label : ''}</div>`;
    }
  }
  return html + '</div>';
}

const CYCLE_EXTRA = [null]; // clic en admin cicla: abierto → cada compañero (en orden) → abierto
async function cycleAdminCell(d, h) {
  const ids = [null, ...companionsById.keys()];
  const current = currentShiftGrid[d][h];
  const idx = ids.indexOf(current);
  const next = ids[(idx + 1) % ids.length];

  const grid = currentShiftGrid.map((row) => row.slice());
  grid[d][h] = next;
  await setDoc(doc(db, 'shiftAssignments', currentYearMonth()), { grid }, { merge: true });
  // no hace falta releer — el onSnapshot de arriba re-renderiza solo
}

function renderLeaderboard() {
  const counts = new Map();
  currentShiftGrid.forEach((day) => day.forEach((uid) => {
    if (uid) counts.set(uid, (counts.get(uid) || 0) + 1);
  }));
  const ranked = [...counts.entries()]
    .map(([uid, count]) => ({ uid, count, name: uid === currentUser.uid ? 'Tú (fundadora)' : (companionsById.get(uid)?.fullName || uid) }))
    .sort((a, b) => b.count - a.count);

  document.getElementById('turnos-leaderboard').innerHTML = ranked.map((r, i) => `
    <div class="lb-item ${i === 0 ? 'rank-1' : ''}">
      <div class="lb-rank">${i === 0 ? '🏆' : (i + 1)}</div>
      <div><div class="lb-name">${r.name}</div><div class="lb-count">${r.count} horas de turno este mes</div></div>
    </div>
  `).join('');
}

window.launchCalendar = async function launchCalendar() {
  const fn = httpsCallable(functions, 'launchShiftCalendar');
  try {
    await fn({ yearMonth: currentYearMonth() });
    // updateLaunchStatus() se actualiza solo vía el listener de shiftAssignments;
    // la lista de calendarios guardados se actualiza vía el listener de shiftArchive.
  } catch (err) {
    console.error('[limen-admin] error al lanzar calendario', err);
    alert('No se pudo lanzar el calendario: ' + (err.message || err.code || 'error desconocido'));
  }
};

// --- Archivo de calendarios (Cobertura) ---
function startArchiveListener() {
  const q = query(collection(db, 'shiftArchive'), orderBy('savedAt', 'desc'));
  unsubscribeArchive = onSnapshot(q, (snap) => {
    savedCalendars = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderSavedCalendarsList();
  });
}

function renderSavedCalendarsList() {
  const listEl = document.getElementById('saved-calendars-list');
  if (!savedCalendars.length) {
    listEl.innerHTML = '<div style="padding:16px; font-size:12.5px; color:var(--text-muted);">Todavía no has lanzado ningún calendario. Cuando lo hagas desde "Turnos", quedará guardado aquí.</div>';
    return;
  }
  listEl.innerHTML = `<table><tbody>${savedCalendars.map((c) => `
    <tr>
      <td><div class="person-name">${c.label}</div></td>
      <td style="text-align:right;"><button class="link-btn" data-view-archive="${c.id}">Ver</button></td>
    </tr>
  `).join('')}</tbody></table>`;

  listEl.querySelectorAll('[data-view-archive]').forEach((btn) => {
    btn.addEventListener('click', () => viewSavedCalendar(btn.dataset.viewArchive));
  });
}

function viewSavedCalendar(archiveId) {
  const c = savedCalendars.find((x) => x.id === archiveId);
  if (!c) return;
  document.getElementById('saved-calendar-title').textContent = c.label;
  const savedAtDate = c.savedAt?.toDate ? c.savedAt.toDate() : null;
  document.getElementById('saved-calendar-meta').textContent = savedAtDate
    ? 'Guardado el ' + savedAtDate.toLocaleDateString('es', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
    : '';
  document.getElementById('saved-calendar-grid').innerHTML = buildGridHtml(c.grid, false);
  document.getElementById('saved-calendar-backdrop').classList.add('active');
}

window.closeSavedCalendar = function closeSavedCalendar() {
  document.getElementById('saved-calendar-backdrop').classList.remove('active');
};

// --- Ver conversación (aún con datos de ejemplo — pertenece a la subpestaña
// Actividad del Dashboard, que se conecta en una próxima vuelta) ---
window.openTranscript = function openTranscript() {
  document.getElementById('transcript-backdrop').classList.add('active');
};
window.closeTranscript = function closeTranscript() {
  document.getElementById('transcript-backdrop').classList.remove('active');
};

// ---------------------------------------------------------------
// Dashboard: estadísticas reales por rango de fechas (reemplaza periodData
// de ejemplo). Se expone en window para que el <script> clásico de
// index.html (que todavía maneja setPeriod/applyCustomRange/render*) la
// pueda llamar sin tener que migrar todo ese código a este módulo.
//
// Aproximaciones documentadas (no hay tracking dedicado para esto todavía):
//   - `compliance` (cumplimiento de horario) se deja fijo en 100 — medirlo
//     de verdad requiere comparar sesiones de login contra shiftAssignments.
//   - `retention` de usuarios queda en null — requiere trackear altas/bajas
//     mes a mes, no solo el estado actual.
//   - El embudo de Servicio usa los 3 puntos que sí son reconstruibles del
//     estado actual de cada intento (no hay historial de transiciones de
//     estado guardado); "pidieron hablar" específicamente no es
//     reconstruible sin un log de eventos.
//   - `abandonRate` es un proxy: intentos que quedaron atascados en
//     'queued'/'chat_waiting' sobre el total del período.
// ---------------------------------------------------------------
const SUBSCRIPTION_PRICE_USD = { basic: 3, premium: 6 };

function fmtMinSec(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.round(totalSeconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

window.computeRealPeriodData = async function computeRealPeriodData(start, end) {
  const [donationsSnap, usersAllSnap, newUsersSnap, chatsSnap, attemptsSnap, cancellationsSnap] = await Promise.all([
    getDocs(query(collection(db, 'donations'), where('createdAt', '>=', start), where('createdAt', '<', end))),
    getDocs(collection(db, 'users')),
    getDocs(query(collection(db, 'users'), where('createdAt', '>=', start), where('createdAt', '<', end))),
    getDocs(query(collection(db, 'chats'), where('startedAt', '>=', start), where('startedAt', '<', end))),
    getDocs(query(collectionGroup(db, 'unlockAttempts'), where('createdAt', '>=', start), where('createdAt', '<', end))),
    getDocs(query(collection(db, 'cancellations'), where('canceledAt', '>=', start), where('canceledAt', '<', end))),
  ]);

  // --- Donaciones, por compañero ---
  let donationsTotalCents = 0;
  const donationsByCompanion = new Map();
  donationsSnap.forEach((d) => {
    const v = d.data();
    donationsTotalCents += v.amountCents;
    donationsByCompanion.set(v.companionId, (donationsByCompanion.get(v.companionId) || 0) + v.amountCents);
  });

  // --- Usuarios activos / plan / MRR (snapshot actual, no acotado al rango) ---
  let activeUsers = 0, planBasicCount = 0, planPremiumCount = 0;
  usersAllSnap.forEach((d) => {
    const u = d.data();
    if (u.subscriptionStatus === 'active') {
      activeUsers++;
      if (u.plan === 'premium') planPremiumCount++; else planBasicCount++;
    }
  });
  const mrr = planBasicCount * SUBSCRIPTION_PRICE_USD.basic + planPremiumCount * SUBSCRIPTION_PRICE_USD.premium;
  const planBasicPct = activeUsers ? Math.round((planBasicCount / activeUsers) * 100) : 0;

  // --- Chats: productividad por compañero, sitios más atendidos ---
  const byCompanion = new Map();
  const topSitesMap = new Map();
  chatsSnap.forEach((d) => {
    const c = d.data();
    const entry = byCompanion.get(c.companionId) || { chats: 0, respSecondsSum: 0, respCount: 0, hoursSum: 0, recentChats: [] };
    entry.chats++;
    if (c.timerStartedAt && c.startedAt) {
      entry.respSecondsSum += (c.timerStartedAt.toMillis() - c.startedAt.toMillis()) / 1000;
      entry.respCount++;
    }
    if (c.durationSeconds) entry.hoursSum += c.durationSeconds / 3600;
    if (entry.recentChats.length < 5 && c.domain) {
      entry.recentChats.push({ site: c.domain, duration: c.durationSeconds ? fmtMinSec(c.durationSeconds) : '—' });
    }
    byCompanion.set(c.companionId, entry);
    if (c.domain) topSitesMap.set(c.domain, (topSitesMap.get(c.domain) || 0) + 1);
  });

  // --- Tarifas pagadas, atribuidas al compañero vía el chat del mismo intento ---
  let feesTotalCents = 0;
  const attemptFeeById = new Map();
  attemptsSnap.forEach((d) => {
    const a = d.data();
    if (a.state === 'unlocked' && a.feeAmountCents) {
      feesTotalCents += a.feeAmountCents;
      attemptFeeById.set(d.id, a.feeAmountCents);
    }
  });
  const feesByCompanion = new Map();
  chatsSnap.forEach((d) => {
    const c = d.data();
    const fee = attemptFeeById.get(c.unlockAttemptId);
    if (fee) feesByCompanion.set(c.companionId, (feesByCompanion.get(c.companionId) || 0) + fee);
  });

  const periodMs = end.getTime() - start.getTime();
  const periodFractionOfMonth = periodMs / (30 * 24 * 3600 * 1000);
  const subsRevenueCents = Math.round(mrr * 100 * periodFractionOfMonth);
  const incomeTotalCents = subsRevenueCents + feesTotalCents + donationsTotalCents;

  // --- Filas de productividad por compañero ---
  const rows = [...companionsById.entries()].map(([uid, c]) => {
    const isMe = uid === currentUser.uid;
    const chatStats = byCompanion.get(uid) || { chats: 0, respSecondsSum: 0, respCount: 0, hoursSum: 0, recentChats: [] };
    const donationsCents = donationsByCompanion.get(uid) || 0;
    const feesCents = feesByCompanion.get(uid) || 0;
    return {
      name: isMe ? 'Tú (fundador)' : c.fullName,
      chats: chatStats.chats,
      resp: chatStats.respCount ? fmtMinSec(chatStats.respSecondsSum / chatStats.respCount) : '—',
      donations: Math.round(donationsCents / 100),
      income: Math.round((donationsCents + feesCents) / 100),
      compliance: 100, // ver nota de aproximación arriba
      hours: Math.round(chatStats.hoursSum * 10) / 10,
      recentChats: chatStats.recentChats,
    };
  }).sort((a, b) => b.chats - a.chats);

  const topDonor = [...donationsByCompanion.entries()].sort((a, b) => b[1] - a[1])[0];
  const topName = topDonor ? (topDonor[0] === currentUser.uid ? 'Tú (fundador)' : (companionsById.get(topDonor[0])?.fullName || '—')) : '—';
  const topAmount = topDonor ? Math.round(topDonor[1] / 100) : 0;

  // --- Servicio: efectividad, reincidencia, abandono (aproximado, ver nota arriba) ---
  let stayedBlocked = 0, unlocked = 0, recurrent = 0, stillQueued = 0;
  attemptsSnap.forEach((d) => {
    const a = d.data();
    if (a.state === 'stayed_blocked') stayedBlocked++;
    if (a.state === 'unlocked') { unlocked++; if (a.weeklyRecurrenceCount > 0) recurrent++; }
    if (a.state === 'queued' || a.state === 'chat_waiting') stillQueued++;
  });
  const decided = stayedBlocked + unlocked;
  const effectiveness = decided ? Math.round((stayedBlocked / decided) * 100) : 0;
  const recurrence = unlocked ? Math.round((recurrent / unlocked) * 100) : 0;
  const abandonRate = attemptsSnap.size ? Math.round((stillQueued / attemptsSnap.size) * 100) : 0;

  const topSites = [...topSitesMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([site, count]) => ({ site, count }));

  // TODO: distribución real de chats por hora — requeriría agrupar
  // chats.startedAt por hora del día. Por ahora se aproxima repartiendo el
  // total real de chats con una curva genérica (más carga de tarde/noche),
  // en vez de usar un número inventado sin relación con los datos reales.
  const GENERIC_HOUR_WEIGHTS = [2,1,1,1,1,1,2,3,4,5,6,6,7,6,5,5,6,8,10,14,18,16,10,4];
  const weightSum = GENERIC_HOUR_WEIGHTS.reduce((s, v) => s + v, 0);
  const hourlyVolume = GENERIC_HOUR_WEIGHTS.map((w) => Math.round((w / weightSum) * chatsSnap.size));

  const cancellations = [];
  cancellationsSnap.forEach((d) => {
    const c = d.data();
    cancellations.push({
      user: 'Usuario #' + d.id.slice(0, 4),
      date: c.canceledAt ? c.canceledAt.toDate().toLocaleDateString('es', { day: 'numeric', month: 'short' }) : '—',
      lastCompanion: c.lastCompanionId === currentUser.uid ? 'Tú (fundador)' : (companionsById.get(c.lastCompanionId)?.fullName || 'Desconocido'),
    });
  });

  return {
    donations: Math.round(donationsTotalCents / 100),
    income: Math.round(incomeTotalCents / 100),
    topName, topAmount,
    chartLabels: rows.map((r) => r.name.split(' ')[0]),
    chartData: rows.map((r) => r.donations),
    rows,
    incomeBreakdown: {
      subs: Math.round(subsRevenueCents / 100),
      fees: Math.round(feesTotalCents / 100),
      donations: Math.round(donationsTotalCents / 100),
    },
    hourlyVolume,
    prev: null,
    users: {
      activeUsers, newUsers: newUsersSnap.size, retention: null, mrr,
      planBasic: planBasicPct, planPremium: 100 - planBasicPct,
      topSites, cancellations,
    },
    service: {
      effectiveness, recurrence, totalChats: chatsSnap.size, abandonRate,
      funnel: [
        { label: 'Intentos de desbloqueo', value: attemptsSnap.size, pct: 100 },
        { label: 'Llegaron a chatear', value: chatsSnap.size, pct: attemptsSnap.size ? Math.round((chatsSnap.size / attemptsSnap.size) * 100) : 0 },
        { label: 'Decidieron NO desbloquear', value: stayedBlocked, pct: attemptsSnap.size ? Math.round((stayedBlocked / attemptsSnap.size) * 100) : 0 },
      ],
    },
  };
};
