import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, signInWithEmailAndPassword, onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, collectionGroup, collection, doc, query, where, orderBy,
  onSnapshot, addDoc, updateDoc, serverTimestamp, runTransaction,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import {
  getFunctions, httpsCallable,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js';
import { firebaseConfig } from './firebase-config.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app);

// Sin límite de chats simultáneos, para nadie — ver packages/shared/src/constants.js (MAX_CONCURRENT_CHATS).
// Cada compañero atiende tantos como pueda manejar.
const ALIAS_POOL = ['Ana', 'Lucía', 'Sofía', 'Mateo', 'Andrés', 'Valeria'];
const CHAT_DURATION_SECONDS = 5 * 60;
const FAREWELL_DURATION_SECONDS = 60;

let currentUser = null;
let unsubscribeQueue = null;
let unsubscribeMyChats = null;
const chatSubscriptions = new Map(); // chatId -> { unsubChat, unsubMessages }
const openChats = new Map();          // chatId -> datos locales del chat (para las pestañas)
let currentChatId = null;

// ---------------------------------------------------------------
// Login
// ---------------------------------------------------------------
window.doLogin = async function doLogin() {
  const email = document.getElementById('login-user').value.trim();
  const pass = document.getElementById('login-pass').value;
  const errorEl = document.getElementById('login-error');
  errorEl.textContent = '';

  try {
    await signInWithEmailAndPassword(auth, email, pass);
  } catch (err) {
    errorEl.textContent = 'Usuario o contraseña incorrectos. Pídeselos a la administradora si no los tienes.';
    console.error('[limen] error de login', err);
  }
};

onAuthStateChanged(auth, (user) => {
  if (user) {
    currentUser = user;
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app-shell').style.display = 'flex';
    startQueueListener();
    startMyChatsListener();
    startShiftsListener();
  } else {
    currentUser = null;
    document.getElementById('login-screen').style.display = 'flex';
    document.getElementById('app-shell').style.display = 'none';
    if (unsubscribeQueue) unsubscribeQueue();
    if (unsubscribeMyChats) unsubscribeMyChats();
    if (unsubscribeShifts) unsubscribeShifts();
  }
});

// ---------------------------------------------------------------
// Cola: todos los intentos de desbloqueo en estado 'queued', de cualquier usuario
// ---------------------------------------------------------------
function startQueueListener() {
  const q = query(
    collectionGroup(db, 'unlockAttempts'),
    where('state', '==', 'queued'),
    orderBy('queuedAt', 'asc')
  );

  unsubscribeQueue = onSnapshot(q, (snap) => {
    const list = document.getElementById('queue-list');
    if (snap.empty) {
      list.innerHTML = '<div class="sub" style="margin-top:16px;">No hay nadie esperando en este momento.</div>';
      return;
    }

    list.innerHTML = snap.docs.map((docSnap) => {
      const attempt = docSnap.data();
      const userId = docSnap.ref.parent.parent.id; // users/{userId}/unlockAttempts/{attemptId}
      const waitLabel = attempt.queuedAt ? formatElapsed(attempt.queuedAt.toMillis()) : '—';
      return `
        <div class="queue-item">
          <div>
            <div class="queue-site">${attempt.domain}</div>
            <div class="queue-meta">esperando hace ${waitLabel}</div>
          </div>
          <div style="display:flex; align-items:center;">
            <span class="wait-badge">nuevo</span>
            <button class="btn btn-primary btn-sm" data-attend data-user-id="${userId}" data-attempt-id="${docSnap.id}" data-domain="${attempt.domain}">Atender</button>
          </div>
        </div>`;
    }).join('');

    list.querySelectorAll('[data-attend]').forEach((btn) => {
      btn.addEventListener('click', () => attendChat(btn.dataset.userId, btn.dataset.attemptId, btn.dataset.domain));
    });
  });
}

function formatElapsed(startedAtMs) {
  const seconds = Math.floor((Date.now() - startedAtMs) / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)} min`;
}

/**
 * Tomar una solicitud de la cola. Sin chequeo de límite — cualquier
 * compañero puede atender todos los que quiera. Crea el ChatSessionDoc y
 * escribe su id de vuelta en el attempt, que es justo lo que la extensión
 * está escuchando (ver packages/extension/src/blocked/blocked.js → renderQueued()).
 *
 * Envuelto en una transacción porque dos compañeros (o dos pestañas del
 * mismo compañero) pueden hacer clic en "Atender" para la misma solicitud
 * casi al mismo tiempo -- sin esto, ambos clics crean un chat cada uno,
 * pero el attempt.chatId solo puede apuntar a uno, así que el otro chat
 * queda "huérfano" (el compañero que lo abrió nunca recibe respuesta,
 * porque el usuario terminó conectado al otro chat). La transacción
 * relee el estado del attempt antes de escribir: si ya no está en
 * 'queued' (porque alguien más lo atendió primero), aborta en vez de
 * crear un segundo chat.
 */
async function attendChat(userId, attemptId, domain) {
  const alias = ALIAS_POOL[Math.floor(Math.random() * ALIAS_POOL.length)];
  const attemptRef = doc(db, 'users', userId, 'unlockAttempts', attemptId);
  const chatRef = doc(collection(db, 'chats'));

  try {
    await runTransaction(db, async (tx) => {
      const attemptSnap = await tx.get(attemptRef);
      if (!attemptSnap.exists() || attemptSnap.data().state !== 'queued') {
        throw new Error('LIMEN_ALREADY_ATTENDED');
      }

      tx.set(chatRef, {
        unlockAttemptId: attemptId,
        userId,
        domain, // denormalizado desde el attempt — así el admin no necesita ir a buscarlo aparte para sus estadísticas
        companionId: currentUser.uid,
        aliasUsed: alias,
        state: 'waiting_reply', // el cronómetro NO arranca hasta que el usuario responda
        startedAt: serverTimestamp(),
        timerStartedAt: null,
        farewellStartedAt: null,
        closedAt: null,
        closingMessage: null,
        durationSeconds: null,
      });

      tx.update(attemptRef, {
        chatId: chatRef.id,
        state: 'chat_waiting',
      });
    });
  } catch (err) {
    if (err.message === 'LIMEN_ALREADY_ATTENDED') {
      alert('Otra persona ya está atendiendo esta solicitud.');
      return;
    }
    throw err;
  }
}

// ---------------------------------------------------------------
// Mis chats abiertos (sin límite) — pestañas
// ---------------------------------------------------------------
function startMyChatsListener() {
  const q = query(
    collection(db, 'chats'),
    where('companionId', '==', currentUser.uid),
    where('state', 'in', ['waiting_reply', 'running', 'farewell'])
  );

  unsubscribeMyChats = onSnapshot(q, (snap) => {
    const seenIds = new Set();
    snap.forEach((docSnap) => {
      seenIds.add(docSnap.id);
      if (!chatSubscriptions.has(docSnap.id)) {
        subscribeToChat(docSnap.id);
      }
    });
    // Limpiar suscripciones de chats que ya no están activos (se cerraron)
    for (const chatId of chatSubscriptions.keys()) {
      if (!seenIds.has(chatId)) {
        unsubscribeFromChat(chatId);
      }
    }
    renderTabs();
    document.getElementById('multichat-area').style.display = openChats.size > 0 ? 'block' : 'none';
  });
}

function subscribeToChat(chatId) {
  const chatRef = doc(db, 'chats', chatId);
  const unsubChat = onSnapshot(chatRef, (snap) => {
    const data = snap.data();
    if (!data) return;
    openChats.set(chatId, { ...(openChats.get(chatId) || {}), ...data, id: chatId });
    renderTabs();
    if (currentChatId === chatId) renderChatPanel(chatId);
  });

  const messagesQuery = query(collection(db, 'chats', chatId, 'messages'), orderBy('sentAt', 'asc'));
  const unsubMessages = onSnapshot(messagesQuery, (snap) => {
    const messages = snap.docs.map((d) => d.data());
    const entry = openChats.get(chatId) || {};
    entry.messages = messages;
    openChats.set(chatId, entry);
    if (currentChatId === chatId) renderChatPanel(chatId);
  });

  chatSubscriptions.set(chatId, { unsubChat, unsubMessages });
  if (!currentChatId) currentChatId = chatId;
}

function unsubscribeFromChat(chatId) {
  const subs = chatSubscriptions.get(chatId);
  if (subs) { subs.unsubChat(); subs.unsubMessages(); }
  chatSubscriptions.delete(chatId);
  openChats.delete(chatId);
  if (currentChatId === chatId) {
    currentChatId = openChats.size > 0 ? [...openChats.keys()][0] : null;
  }
}

function renderTabs() {
  const tabsEl = document.getElementById('chat-tabs');
  tabsEl.innerHTML = [...openChats.values()].map((chat) => `
    <div class="chat-tab ${chat.id === currentChatId ? 'selected' : ''}" data-select-chat="${chat.id}">
      <span class="tab-dot ${stateToTabClass(chat.state)}"></span> ${chat.domainLabel || chat.unlockAttemptId}
    </div>
  `).join('');
  tabsEl.querySelectorAll('[data-select-chat]').forEach((el) => {
    el.addEventListener('click', () => {
      currentChatId = el.dataset.selectChat;
      renderTabs();
      renderChatPanel(currentChatId);
    });
  });
  if (currentChatId) renderChatPanel(currentChatId);
}

function stateToTabClass(state) {
  if (state === 'waiting_reply') return 'waiting';
  if (state === 'farewell') return 'farewell';
  return 'running';
}

function renderChatPanel(chatId) {
  const chat = openChats.get(chatId);
  const el = document.getElementById('chat-panel-content');
  if (!chat) { el.innerHTML = ''; return; }

  const bubbles = (chat.messages || []).map((m) =>
    `<div class="bubble ${m.from === 'companion' ? 'me' : 'them'}">${escapeHtml(m.text)}</div>`
  ).join('');

  if (chat.state === 'waiting_reply') {
    el.innerHTML = `
      <div class="chat-top">
        <div>
          <div class="chat-alias-badge">Estás chateando como <b>${chat.aliasUsed}</b></div>
        </div>
      </div>
      <div class="chat-bubbles">${bubbles}</div>
      <div class="waiting-box">
        El tiempo aún no corre — esperando a que la persona responda.
      </div>
      <div class="chat-input-row">
        <input type="text" id="msg-input-${chat.id}" placeholder="Escribe tu mensaje inicial...">
        <button class="btn btn-primary btn-sm" data-send="${chat.id}">Enviar</button>
      </div>`;
  } else if (chat.state === 'running' || chat.state === 'farewell') {
    const timerId = `timer-${chat.id}`;
    el.innerHTML = `
      <div class="chat-top">
        <div><div class="chat-alias-badge">Estás chateando como <b>${chat.aliasUsed}</b></div></div>
        <div class="timer-pill" id="${timerId}">--:--</div>
      </div>
      <div class="chat-bubbles">${bubbles}</div>
      <div class="chat-input-row">
        <input type="text" id="msg-input-${chat.id}" placeholder="Escribe tu respuesta...">
        <button class="btn btn-primary btn-sm" data-send="${chat.id}">Enviar</button>
      </div>
      ${chat.state === 'running' ? `
        <div class="chat-actions">
          <button class="btn btn-amber btn-sm" data-farewell="${chat.id}">Pedir 1 min. para despedirme</button>
        </div>
        <div class="sub" style="margin:8px 0 0; font-size:11.5px;">No puedes cortar el chat de golpe. Solo puedes pedir el minuto de despedida — el sistema lo cierra solo.</div>
      ` : `
        <div class="end-panel active">
          <span class="field-label">Se está cerrando — el sistema cortará el chat solo</span>
          <textarea id="closing-msg-${chat.id}" placeholder="Mensaje de despedida (opcional)">${chat.closingMessage || ''}</textarea>
          <button class="btn btn-primary btn-block" data-save-closing="${chat.id}">Guardar mensaje</button>
        </div>
      `}
    `;
    startTabTimer(chat, timerId);
  }

  const sendBtn = el.querySelector('[data-send]');
  if (sendBtn) sendBtn.addEventListener('click', () => sendMessage(chat.id));
  const input = el.querySelector(`#msg-input-${chat.id}`);
  if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMessage(chat.id); });

  const farewellBtn = el.querySelector('[data-farewell]');
  if (farewellBtn) farewellBtn.addEventListener('click', () => requestFarewell(chat.id));

  const saveClosingBtn = el.querySelector('[data-save-closing]');
  if (saveClosingBtn) saveClosingBtn.addEventListener('click', () => saveClosingMessage(chat.id));
}

let tabTimerInterval = null;
function startTabTimer(chat, elementId) {
  clearInterval(tabTimerInterval);
  const startedAtMs = chat.state === 'farewell'
    ? chat.farewellStartedAt?.toMillis()
    : chat.timerStartedAt?.toMillis();
  const duration = chat.state === 'farewell' ? FAREWELL_DURATION_SECONDS : CHAT_DURATION_SECONDS;
  if (!startedAtMs) return;

  function tick() {
    const el = document.getElementById(elementId);
    if (!el) { clearInterval(tabTimerInterval); return; }
    const remaining = Math.max(0, duration - Math.floor((Date.now() - startedAtMs) / 1000));
    const m = Math.floor(remaining / 60), s = remaining % 60;
    el.textContent = `${m}:${String(s).padStart(2, '0')}`;
    el.classList.toggle('low', remaining <= 60);
  }
  tick();
  tabTimerInterval = setInterval(tick, 1000);
}

async function sendMessage(chatId) {
  const input = document.getElementById(`msg-input-${chatId}`);
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  await addDoc(collection(db, 'chats', chatId, 'messages'), {
    chatId, from: 'companion', text, sentAt: serverTimestamp(),
  });
}

async function requestFarewell(chatId) {
  const fn = httpsCallable(functions, 'requestFarewell');
  await fn({ chatId });
}

async function saveClosingMessage(chatId) {
  const text = document.getElementById(`closing-msg-${chatId}`).value;
  await updateDoc(doc(db, 'chats', chatId), { closingMessage: text });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------------------------------------------------------------
// Navegación y disponibilidad (sin cambios de lógica de negocio)
// ---------------------------------------------------------------
document.querySelectorAll('.app-nav-item').forEach((item) => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.app-nav-item').forEach((el) => el.classList.remove('active'));
    document.querySelectorAll('.app-panel').forEach((el) => el.classList.remove('active'));
    item.classList.add('active');
    document.getElementById('panel-' + item.dataset.panel).classList.add('active');
  });
});

const availToggle = document.getElementById('toggle-avail');
const availTrack = document.getElementById('toggle-track');
const availText = document.getElementById('toggle-text');
let available = true;
availToggle.addEventListener('click', () => {
  available = !available;
  availTrack.classList.toggle('off', !available);
  availText.textContent = available ? 'Disponible' : 'No disponible';
  // TODO: persistir en companions/{uid}.available cuando se implemente
  // la vista de Cobertura consumiendo esto en vivo desde el admin.
});

// ---------------------------------------------------------------
// Turnos disponibles + Mi horario
// ---------------------------------------------------------------
const DAYS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
let unsubscribeShifts = null;
let currentShiftGrid = null;

function currentYearMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function startShiftsListener() {
  const yearMonth = currentYearMonth();
  const monthLabel = new Date().toLocaleDateString('es', { month: 'long', year: 'numeric' });
  document.getElementById('turnos-month-label').textContent = `Calendario de ${monthLabel}`;

  const ref = doc(db, 'shiftAssignments', yearMonth);
  unsubscribeShifts = onSnapshot(ref, (snap) => {
    if (!snap.exists()) {
      document.getElementById('comp-shift-grid').innerHTML =
        '<div class="sub" style="padding:16px;">La administradora todavía no publicó el calendario de este mes.</div>';
      document.getElementById('mi-horario-card').innerHTML =
        '<div class="sched-row"><span class="sched-day">Sin calendario publicado este mes</span></div>';
      return;
    }
    currentShiftGrid = snap.data().grid;
    renderShiftGrid();
    renderMiHorario();
  });
}

function renderShiftGrid() {
  const yearMonth = currentYearMonth();
  let html = '<div class="shift-grid"><div class="shift-head"></div>';
  DAYS.forEach((d) => { html += `<div class="shift-head">${d}</div>`; });

  for (let h = 0; h < 24; h++) {
    html += `<div class="shift-hour-label">${String(h).padStart(2, '0')}:00</div>`;
    for (let d = 0; d < 7; d++) {
      const val = currentShiftGrid[d][h];
      const isMine = val === currentUser.uid;
      const isTaken = val && !isMine;
      const clickable = !isTaken;
      const cls = 'shift-cell'
        + (!val ? ' open' : '')
        + (isMine ? ' mine' : '')
        + (isTaken ? ' not-clickable' : '');
      const title = isMine ? 'Es tuya — toca para cancelar' : isTaken ? 'Ocupada por otro compañero' : 'Abierta — toca para inscribirte';
      const attr = clickable ? `data-toggle-shift="${d}:${h}"` : '';
      html += `<div class="${cls}" title="${title}" ${attr}>${isMine ? 'Yo' : isTaken ? '·' : ''}</div>`;
    }
  }
  html += '</div>';

  const container = document.getElementById('comp-shift-grid');
  container.innerHTML = html;
  container.querySelectorAll('[data-toggle-shift]').forEach((cell) => {
    cell.addEventListener('click', async () => {
      const [day, hour] = cell.dataset.toggleShift.split(':').map(Number);
      cell.style.opacity = '0.5'; // feedback inmediato mientras confirma el servidor
      try {
        const fn = httpsCallable(functions, 'toggleMyShift');
        await fn({ yearMonth, day, hour });
        // no hace falta releer manualmente — el onSnapshot de arriba re-renderiza solo
      } catch (err) {
        cell.style.opacity = '1';
        console.error('[limen] no se pudo cambiar la casilla', err);
      }
    });
  });
}

function renderMiHorario() {
  const card = document.getElementById('mi-horario-card');
  const rows = DAYS.map((dayName, d) => {
    const myHours = [];
    for (let h = 0; h < 24; h++) {
      if (currentShiftGrid[d][h] === currentUser.uid) myHours.push(h);
    }
    const label = myHours.length ? formatHourRanges(myHours) : 'Sin turno asignado';
    return `<div class="sched-row"><span class="sched-day">${fullDayName(dayName)}</span><span class="sched-time">${label}</span></div>`;
  }).join('');
  card.innerHTML = rows;
}

function fullDayName(short) {
  const map = { Lun: 'Lunes', Mar: 'Martes', Mié: 'Miércoles', Jue: 'Jueves', Vie: 'Viernes', Sáb: 'Sábado', Dom: 'Domingo' };
  return map[short] || short;
}

/** Convierte [20,21,22,23,0,1] en algo como "20:00 – 02:00" agrupando horas consecutivas */
function formatHourRanges(hours) {
  const sorted = [...hours].sort((a, b) => a - b);
  const ranges = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const h = sorted[i];
    if (h !== prev + 1) {
      ranges.push([start, prev]);
      start = h;
    }
    prev = h;
  }
  return ranges.map(([s, e]) => `${String(s).padStart(2, '0')}:00 – ${String((e + 1) % 24).padStart(2, '0')}:00`).join(', ');
}

