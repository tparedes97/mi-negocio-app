import {
  doc, setDoc, addDoc, collection, onSnapshot,
  updateDoc, serverTimestamp, query, orderBy, where, getDocs, limit,
} from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { getApp } from 'firebase/app';
import { db, ensureSignedIn } from '../lib/firebase.js';
import {
  UNLOCK_FEES_USD,
  RECURRENCE_FEE_MULTIPLIER,
  DONATION_SUGGESTED_AMOUNTS_USD,
  CHAT_DURATION_SECONDS,
  FAREWELL_DURATION_SECONDS,
} from '@limen/shared/src/constants';

const params = new URLSearchParams(location.search);
const domain = params.get('site');
const siteId = params.get('siteId');
const root = document.getElementById('view-root');
const functions = getFunctions(getApp());

let user = null;
let attemptId = null;
let attempt = null; // espejo local del UnlockAttemptDoc
let unsubscribeAttempt = null;
let unsubscribeChat = null;
let unsubscribeMessages = null;
let chatTimerInterval = null;
let currentQuestionIndex = 0;
const MOTIVATIONAL_QUESTIONS = [
  '¿Qué es exactamente lo que quieres ver ahora?',
  '¿Qué pasaría si esperas 10 minutos más antes de decidir?',
  '¿Qué tenías pensado hacer en este horario antes de que apareciera la idea de entrar?',
];
const questionAnswers = ['', '', ''];

// ---------------------------------------------------------------
// Arranque: sesión, y revisar si ya hay un intento vigente hoy
// ---------------------------------------------------------------
async function init() {
  user = await ensureSignedIn();

  const reincident = await checkReincidenceToday();
  if (reincident) {
    renderReincidenceReminder();
    return;
  }

  attemptId = crypto.randomUUID();
  attempt = {
    id: attemptId,
    userId: user.uid,
    siteId,
    domain,
    state: 'motivational_questions',
    createdAt: serverTimestamp(),
    queuedAt: null,
    chatId: null,
    waitSeconds: null,
    donationAmountCents: null,
    feeAmountCents: null,
    feeMinutes: null,
    weeklyRecurrenceCount: 0,
  };

  await setDoc(attemptDocRef(), attempt);
  renderMotivationalQuestions();
}

function attemptDocRef() {
  return doc(db, 'users', user.uid, 'unlockAttempts', attemptId);
}

async function checkReincidenceToday() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const q = query(
    collection(db, 'users', user.uid, 'unlockAttempts'),
    where('domain', '==', domain),
    where('state', '==', 'unlocked'),
    where('createdAt', '>=', startOfDay),
    limit(1)
  );
  const snap = await getDocs(q);
  return !snap.empty;
}

async function patchAttempt(fields) {
  attempt = { ...attempt, ...fields };
  await updateDoc(attemptDocRef(), fields);
}

// ---------------------------------------------------------------
// Pantalla: 3 preguntas motivadoras
// ---------------------------------------------------------------
function renderMotivationalQuestions() {
  const dots = MOTIVATIONAL_QUESTIONS.map((_, i) => {
    const cls = i < currentQuestionIndex ? 'done' : i === currentQuestionIndex ? 'now' : '';
    return '<div class="step-dot ' + cls + '"></div>';
  }).join('');

  root.innerHTML =
    '<div class="stepper">' + dots + '</div>' +
    '<div class="eyebrow">' + domain + ' está bloqueado</div>' +
    '<div class="title">Pregunta ' + (currentQuestionIndex + 1) + ' de ' + MOTIVATIONAL_QUESTIONS.length + '</div>' +
    '<div class="sub">' + MOTIVATIONAL_QUESTIONS[currentQuestionIndex] + '</div>' +
    '<textarea id="q-answer" placeholder="Responde con honestidad...">' + questionAnswers[currentQuestionIndex] + '</textarea>' +
    '<button class="btn btn-primary" id="btn-next">Aún quiero seguir</button>';

  document.getElementById('btn-next').addEventListener('click', async () => {
    questionAnswers[currentQuestionIndex] = document.getElementById('q-answer').value;
    currentQuestionIndex++;
    if (currentQuestionIndex < MOTIVATIONAL_QUESTIONS.length) {
      renderMotivationalQuestions();
    } else {
      await patchAttempt({ state: 'offered_chat' });
      renderOfferedChat();
    }
  });
}

// ---------------------------------------------------------------
// Pantalla: ¿deseas hablar con alguien?
// ---------------------------------------------------------------
function renderOfferedChat() {
  root.innerHTML =
    '<div class="center-block">' +
      '<div class="big-emoji">\u2609</div>' +
      '<div class="title">\u00bfDeseas hablar con alguien antes de continuar?</div>' +
      '<div class="sub">Una persona real \u2014 no un bot \u2014 puede acompa\u00f1arte 5 minutos antes de que decidas.</div>' +
    '</div>' +
    '<button class="btn btn-primary" id="btn-yes-chat">S\u00ed, quiero hablar 5 min</button>' +
    '<button class="btn-link" id="btn-no-chat">No, continuar sin hablar</button>';

  document.getElementById('btn-yes-chat').addEventListener('click', async () => {
    await patchAttempt({ state: 'queued', queuedAt: serverTimestamp() });
    renderQueued();
  });

  document.getElementById('btn-no-chat').addEventListener('click', async () => {
    await patchAttempt({ state: 'donation_prompt' });
    renderDonationPrompt();
  });
}

// ---------------------------------------------------------------
// Pantalla: esperando (sin contador visible — ver especificación)
// ---------------------------------------------------------------
function renderQueued() {
  root.innerHTML =
    '<div class="center-block" style="margin-top:20px;">' +
      '<div class="big-emoji">\u2609</div>' +
      '<div class="title">Buscando a alguien disponible</div>' +
      '<div class="sub">Ya avisamos a tu acompa\u00f1ante. El tiempo de tu chat todav\u00eda no empieza a correr \u2014 eso pasa reci\u00e9n cuando comienza la conversaci\u00f3n.</div>' +
      '<div class="wait-dots"><span></span><span></span><span></span></div>' +
    '</div>' +
    '<button class="btn-link" id="btn-cancel-wait">Cancelar y seguir bloqueado</button>';

  document.getElementById('btn-cancel-wait').addEventListener('click', async () => {
    await patchAttempt({ state: 'stayed_blocked' });
    renderStayedBlocked();
  });

  // Un compañero, desde su portal, crea el ChatSessionDoc al "atender" esta
  // solicitud y escribe su id de vuelta en el attempt — eso es lo que
  // dispara la transición de esta pantalla al chat.
  unsubscribeAttempt = onSnapshot(attemptDocRef(), (snap) => {
    const data = snap.data();
    if (data.chatId && !attempt.chatId) {
      attempt.chatId = data.chatId;
      if (unsubscribeAttempt) unsubscribeAttempt();
      renderChat(data.chatId);
    }
  });
}

// ---------------------------------------------------------------
// Pantalla: chat en vivo
// ---------------------------------------------------------------
function renderChat(chatId) {
  root.innerHTML =
    '<div class="chat-header">' +
      '<div class="avatar" id="chat-avatar">\u00b7</div>' +
      '<div class="chat-meta">' +
        '<div class="name" id="chat-name">Conectando\u2026</div>' +
        '<div class="status">\u25cf en l\u00ednea, persona real</div>' +
      '</div>' +
      '<div class="chat-timer" id="chat-timer" style="display:none;">5:00</div>' +
    '</div>' +
    '<div id="farewell-banner"></div>' +
    '<div class="chat-bubbles" id="chat-bubbles"></div>' +
    '<div class="chat-input-row">' +
      '<input type="text" id="chat-input" placeholder="Escribe tu mensaje...">' +
      '<button class="btn btn-primary" id="btn-send" style="width:auto; padding:10px 16px;">Enviar</button>' +
    '</div>';

  const chatRef = doc(db, 'chats', chatId);
  let lastRenderedState = null;

  unsubscribeChat = onSnapshot(chatRef, (snap) => {
    const chat = snap.data();
    document.getElementById('chat-name').textContent = chat.aliasUsed + ' \u00b7 Acompa\u00f1amiento';
    document.getElementById('chat-avatar').textContent = (chat.aliasUsed || '\u00b7')[0];

    if (chat.state === 'running' && chat.timerStartedAt) {
      startLocalTimer(chat.timerStartedAt.toMillis(), CHAT_DURATION_SECONDS, 'chat-timer');
    }

    if (chat.state === 'farewell' && lastRenderedState !== 'farewell') {
      document.getElementById('farewell-banner').innerHTML =
        '<div class="farewell-banner">Tu acompa\u00f1ante est\u00e1 por despedirse \u2014 el chat se cierra en un minuto.</div>';
      if (chat.farewellStartedAt) {
        startLocalTimer(chat.farewellStartedAt.toMillis(), FAREWELL_DURATION_SECONDS, 'chat-timer');
      }
    }

    if (chat.state === 'closed' && lastRenderedState !== 'closed') {
      clearInterval(chatTimerInterval);
      if (unsubscribeChat) unsubscribeChat();
      if (unsubscribeMessages) unsubscribeMessages();
      renderChatClosed(chat.closingMessage);
    }

    lastRenderedState = chat.state;
  });

  const messagesQuery = query(collection(db, 'chats', chatId, 'messages'), orderBy('sentAt', 'asc'));
  unsubscribeMessages = onSnapshot(messagesQuery, (snap) => {
    const bubbles = snap.docs.map((d) => {
      const m = d.data();
      const cls = m.from === 'user' ? 'user' : 'them';
      return '<div class="bubble ' + cls + '">' + escapeHtml(m.text) + '</div>';
    }).join('');
    const el = document.getElementById('chat-bubbles');
    el.innerHTML = bubbles;
    el.scrollTop = el.scrollHeight;
  });

  const sendMessage = async () => {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    // Este primer mensaje del usuario es justo el que dispara
    // onUserFirstReply() en el backend y arranca el cron\u00f3metro.
    await addDoc(collection(db, 'chats', chatId, 'messages'), {
      chatId, from: 'user', text, sentAt: serverTimestamp(),
    });
  };
  document.getElementById('btn-send').addEventListener('click', sendMessage);
  document.getElementById('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendMessage();
  });
}

function startLocalTimer(startedAtMs, durationSeconds, elementId) {
  clearInterval(chatTimerInterval);
  const el = document.getElementById(elementId);
  el.style.display = 'inline-block';

  function tick() {
    const elapsed = Math.floor((Date.now() - startedAtMs) / 1000);
    const remaining = Math.max(0, durationSeconds - elapsed);
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    el.textContent = m + ':' + String(s).padStart(2, '0');
    // El corte real lo hace el backend (enforceChatTimeouts) — este
    // temporizador es solo visual, nunca cierra el chat por su cuenta.
  }
  tick();
  chatTimerInterval = setInterval(tick, 1000);
}

function renderChatClosed(closingMessage) {
  root.innerHTML =
    '<div class="center-block">' +
      '<div class="big-emoji">\u2713</div>' +
      '<div class="title">Chat terminado</div>' +
      (closingMessage ? '<div class="sub">"' + escapeHtml(closingMessage) + '"</div>' : '') +
    '</div>' +
    '<button class="btn btn-primary" id="btn-continue-after-chat">Continuar</button>';

  document.getElementById('btn-continue-after-chat').addEventListener('click', async () => {
    await patchAttempt({ state: 'donation_prompt', chatId: attempt.chatId });
    renderDonationPrompt();
  });
}

// ---------------------------------------------------------------
// Pantalla: donación opcional
// ---------------------------------------------------------------
function renderDonationPrompt() {
  root.innerHTML =
    '<div class="eyebrow">Despu\u00e9s del chat</div>' +
    '<div class="title">Ay\u00fadanos a mantener este espacio</div>' +
    '<div class="sub">Tu donaci\u00f3n ayuda a pagar el tiempo de las personas que te acompa\u00f1an. Es 100% opcional.</div>' +
    '<div class="chip-row" id="donation-chips">' +
      DONATION_SUGGESTED_AMOUNTS_USD.map((amt) => '<div class="chip" data-amount="' + amt + '">$' + amt + '</div>').join('') +
    '</div>' +
    '<button class="btn btn-primary" id="btn-donate" disabled>Donar</button>' +
    '<button class="btn-link" id="btn-skip-donation">Omitir, no donar</button>';

  let selectedAmount = null;
  document.querySelectorAll('#donation-chips .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('#donation-chips .chip').forEach((c) => c.classList.remove('selected'));
      chip.classList.add('selected');
      selectedAmount = Number(chip.dataset.amount);
      const btn = document.getElementById('btn-donate');
      btn.disabled = false;
      btn.textContent = 'Donar $' + selectedAmount;
    });
  });

  document.getElementById('btn-donate').addEventListener('click', async () => {
    if (!selectedAmount) return;
    const createCheckoutSession = httpsCallable(functions, 'createCheckoutSession');
    const { data } = await createCheckoutSession({
      kind: 'donation',
      amountCents: selectedAmount * 100,
      metadata: { chatId: attempt.chatId || null, companionId: attempt.companionId || null },
    });
    window.open(data.url, '_blank'); // El checkout SIEMPRE en pestaña externa, nunca dentro de la extensión
    await goToFinalConfirmation();
  });

  document.getElementById('btn-skip-donation').addEventListener('click', goToFinalConfirmation);
}

async function goToFinalConfirmation() {
  await patchAttempt({ state: 'final_confirmation' });
  renderFinalConfirmation();
}

// ---------------------------------------------------------------
// Pantalla: confirmación final
// ---------------------------------------------------------------
function renderFinalConfirmation() {
  root.innerHTML =
    '<div class="center-block">' +
      '<div class="title">\u00bfA\u00fan quieres desbloquear ' + domain + '?</div>' +
      '<div class="sub">Esta es tu decisi\u00f3n, t\u00f3mate un segundo antes de responder.</div>' +
    '</div>' +
    '<button class="btn btn-primary" id="btn-stay-blocked">No, seguir bloqueado</button>' +
    '<button class="btn-ghost" id="btn-want-unlock">S\u00ed, quiero desbloquear</button>';

  document.getElementById('btn-stay-blocked').addEventListener('click', async () => {
    await patchAttempt({ state: 'stayed_blocked' });
    renderStayedBlocked();
  });

  document.getElementById('btn-want-unlock').addEventListener('click', async () => {
    await patchAttempt({ state: 'fee_selection' });
    renderFeeSelection();
  });
}

function renderStayedBlocked() {
  root.innerHTML =
    '<div class="center-block">' +
      '<div class="big-emoji">\ud83c\udf3f</div>' +
      '<div class="title">Sigues bloqueado \u2014 bien hecho</div>' +
      '<div class="sub">Puedes cerrar esta pesta\u00f1a cuando quieras.</div>' +
    '</div>';
}

// ---------------------------------------------------------------
// Pantalla: tarifas de desbloqueo
// ---------------------------------------------------------------
function renderFeeSelection() {
  const multiplier = attempt.weeklyRecurrenceCount > 0 ? RECURRENCE_FEE_MULTIPLIER : 1;

  root.innerHTML =
    '<div class="eyebrow">' + domain + (attempt.weeklyRecurrenceCount > 0 ? ' \u00b7 ' + (attempt.weeklyRecurrenceCount + 1) + '\u00b0 desbloqueo esta semana' : '') + '</div>' +
    '<div class="title">Elige cu\u00e1nto tiempo necesitas</div>' +
    '<div class="sub">' + (multiplier > 1 ? 'La tarifa est\u00e1 duplicada por reincidencia esta semana.' : '') + '</div>' +
    '<div id="fee-rows">' +
      Object.entries(UNLOCK_FEES_USD).map(([minutes, baseUsd]) => {
        const price = (baseUsd * multiplier).toFixed(2);
        return '<div class="fee-row" data-minutes="' + minutes + '" data-price="' + price + '">' +
          '<div><div class="fee-time">' + minutes + ' minutos</div><div class="fee-note">' + (multiplier > 1 ? 'tarifa x2' : 'tarifa base') + '</div></div>' +
          '<div class="fee-price">$' + price + '</div>' +
        '</div>';
      }).join('') +
    '</div>' +
    '<button class="btn btn-primary" id="btn-pay" disabled>Selecciona una opci\u00f3n</button>';

  let selected = null;
  document.querySelectorAll('.fee-row').forEach((row) => {
    row.addEventListener('click', () => {
      document.querySelectorAll('.fee-row').forEach((r) => r.classList.remove('selected'));
      row.classList.add('selected');
      selected = { minutes: Number(row.dataset.minutes), price: Number(row.dataset.price) };
      const btn = document.getElementById('btn-pay');
      btn.disabled = false;
      btn.textContent = 'Pagar y desbloquear ' + selected.minutes + ' min';
    });
  });

  document.getElementById('btn-pay').addEventListener('click', async () => {
    if (!selected) return;
    const createCheckoutSession = httpsCallable(functions, 'createCheckoutSession');
    const { data } = await createCheckoutSession({
      kind: 'unlock_fee',
      amountCents: Math.round(selected.price * 100),
      metadata: { attemptId, domain, siteId, minutes: String(selected.minutes) },
    });
    window.open(data.url, '_blank');
    renderWaitingForPayment();
  });
}

function renderWaitingForPayment() {
  root.innerHTML =
    '<div class="center-block">' +
      '<div class="wait-dots"><span></span><span></span><span></span></div>' +
      '<div class="title" style="margin-top:16px;">Esperando la confirmaci\u00f3n del pago</div>' +
      '<div class="sub">Se abri\u00f3 en otra pesta\u00f1a. En cuanto se confirme el cobro, este sitio se desbloquea solo.</div>' +
    '</div>';

  // paddleWebhook es quien realmente marca el attempt como
  // 'unlocked' (ver firebase/functions/src/payments/paddleWebhook.js).
  unsubscribeAttempt = onSnapshot(attemptDocRef(), (snap) => {
    const data = snap.data();
    if (data.state === 'unlocked') {
      if (unsubscribeAttempt) unsubscribeAttempt();
      renderUnlocked();
    }
  });
}

function renderUnlocked() {
  root.innerHTML =
    '<div class="center-block">' +
      '<div class="big-emoji">\u2713</div>' +
      '<div class="title">' + domain + ' est\u00e1 desbloqueado</div>' +
      '<div class="sub">Puedes cerrar esta pesta\u00f1a y volver a entrar.</div>' +
    '</div>';
}

// ---------------------------------------------------------------
// Pantalla: recordatorio de reincidencia (ya desbloqueado hoy)
// ---------------------------------------------------------------
function renderReincidenceReminder() {
  root.innerHTML =
    '<div class="center-block" style="margin-top:40px;">' +
      '<div class="big-emoji">\ud83c\udf3f</div>' +
      '<div class="title">Ya tomaste esta decisi\u00f3n hoy</div>' +
      '<div class="sub">Desbloqueaste ' + domain + ' antes. No hace falta decidir de nuevo \u2014 ma\u00f1ana es un d\u00eda nuevo y puedes volver a empezar.</div>' +
    '</div>';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

init();
