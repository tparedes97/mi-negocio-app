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

// chrome.i18n usa automáticamente el idioma del navegador (chrome.i18n.getUILanguage())
// y cae de vuelta a default_locale ("es") si no hay traducción — ver
// _locales/{es,en}/messages.json. No hace falta detectar nada a mano.
document.documentElement.lang = chrome.i18n.getUILanguage();
document.title = chrome.i18n.getMessage('blockedPageTitle');
document.getElementById('loading-state').textContent = chrome.i18n.getMessage('loadingState');

let user = null;
let attemptId = null;
let attempt = null; // espejo local del UnlockAttemptDoc
let unsubscribeAttempt = null;
let unsubscribeChat = null;
let unsubscribeMessages = null;
let chatTimerInterval = null;
let currentQuestionIndex = 0;
const MOTIVATIONAL_QUESTIONS = [
  chrome.i18n.getMessage('motivationalQuestion1'),
  chrome.i18n.getMessage('motivationalQuestion2'),
  chrome.i18n.getMessage('motivationalQuestion3'),
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
    '<div class="eyebrow">' + escapeHtml(chrome.i18n.getMessage('domainBlockedEyebrow', [domain])) + '</div>' +
    '<div class="title">' + escapeHtml(chrome.i18n.getMessage('questionOfLabel', [String(currentQuestionIndex + 1), String(MOTIVATIONAL_QUESTIONS.length)])) + '</div>' +
    '<div class="sub">' + escapeHtml(MOTIVATIONAL_QUESTIONS[currentQuestionIndex]) + '</div>' +
    '<textarea id="q-answer" placeholder="' + escapeHtml(chrome.i18n.getMessage('answerPlaceholder')) + '">' + escapeHtml(questionAnswers[currentQuestionIndex]) + '</textarea>' +
    '<button class="btn btn-primary" id="btn-next">' + escapeHtml(chrome.i18n.getMessage('stillWantBtn')) + '</button>';

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
      '<div class="title">' + escapeHtml(chrome.i18n.getMessage('offerChatTitle')) + '</div>' +
      '<div class="sub">' + escapeHtml(chrome.i18n.getMessage('offerChatSub')) + '</div>' +
    '</div>' +
    '<button class="btn btn-primary" id="btn-yes-chat">' + escapeHtml(chrome.i18n.getMessage('yesChatBtn')) + '</button>' +
    '<button class="btn-link" id="btn-no-chat">' + escapeHtml(chrome.i18n.getMessage('noChatBtn')) + '</button>';

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
      '<div class="title">' + escapeHtml(chrome.i18n.getMessage('queuedTitle')) + '</div>' +
      '<div class="sub">' + escapeHtml(chrome.i18n.getMessage('queuedSub')) + '</div>' +
      '<div class="wait-dots"><span></span><span></span><span></span></div>' +
    '</div>' +
    '<button class="btn-link" id="btn-cancel-wait">' + escapeHtml(chrome.i18n.getMessage('cancelWaitBtn')) + '</button>';

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
        '<div class="name" id="chat-name">' + escapeHtml(chrome.i18n.getMessage('connectingName')) + '</div>' +
        '<div class="status">' + escapeHtml(chrome.i18n.getMessage('onlineStatus')) + '</div>' +
      '</div>' +
      '<div class="chat-timer" id="chat-timer" style="display:none;">5:00</div>' +
    '</div>' +
    '<div id="farewell-banner"></div>' +
    '<div class="chat-bubbles" id="chat-bubbles"></div>' +
    '<div class="chat-input-row">' +
      '<input type="text" id="chat-input" placeholder="' + escapeHtml(chrome.i18n.getMessage('chatInputPlaceholder')) + '">' +
      '<button class="btn btn-primary" id="btn-send" style="width:auto; padding:10px 16px;">' + escapeHtml(chrome.i18n.getMessage('sendBtn')) + '</button>' +
    '</div>';

  const chatRef = doc(db, 'chats', chatId);
  let lastRenderedState = null;

  unsubscribeChat = onSnapshot(chatRef, (snap) => {
    const chat = snap.data();
    document.getElementById('chat-name').textContent = chrome.i18n.getMessage('chatAliasSuffix', [chat.aliasUsed]);
    document.getElementById('chat-avatar').textContent = (chat.aliasUsed || '\u00b7')[0];

    if (chat.state === 'running' && chat.timerStartedAt) {
      startLocalTimer(chat.timerStartedAt.toMillis(), CHAT_DURATION_SECONDS, 'chat-timer');
    }

    if (chat.state === 'farewell' && lastRenderedState !== 'farewell') {
      document.getElementById('farewell-banner').innerHTML =
        '<div class="farewell-banner">' + escapeHtml(chrome.i18n.getMessage('farewellBanner')) + '</div>';
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
      '<div class="title">' + escapeHtml(chrome.i18n.getMessage('chatEndedTitle')) + '</div>' +
      (closingMessage ? '<div class="sub">"' + escapeHtml(closingMessage) + '"</div>' : '') +
    '</div>' +
    '<button class="btn btn-primary" id="btn-continue-after-chat">' + escapeHtml(chrome.i18n.getMessage('continueAfterChatBtn')) + '</button>';

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
    '<div class="eyebrow">' + escapeHtml(chrome.i18n.getMessage('afterChatEyebrow')) + '</div>' +
    '<div class="title">' + escapeHtml(chrome.i18n.getMessage('donationTitle')) + '</div>' +
    '<div class="sub">' + escapeHtml(chrome.i18n.getMessage('donationSub')) + '</div>' +
    '<div class="chip-row" id="donation-chips">' +
      DONATION_SUGGESTED_AMOUNTS_USD.map((amt) => '<div class="chip" data-amount="' + amt + '">$' + amt + '</div>').join('') +
    '</div>' +
    '<button class="btn btn-primary" id="btn-donate" disabled>' + escapeHtml(chrome.i18n.getMessage('donateBtn')) + '</button>' +
    '<button class="btn-link" id="btn-skip-donation">' + escapeHtml(chrome.i18n.getMessage('skipDonationBtn')) + '</button>';

  let selectedAmount = null;
  document.querySelectorAll('#donation-chips .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('#donation-chips .chip').forEach((c) => c.classList.remove('selected'));
      chip.classList.add('selected');
      selectedAmount = Number(chip.dataset.amount);
      const btn = document.getElementById('btn-donate');
      btn.disabled = false;
      btn.textContent = chrome.i18n.getMessage('donateAmountBtn', [String(selectedAmount)]);
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
      '<div class="title">' + escapeHtml(chrome.i18n.getMessage('finalConfirmTitle', [domain])) + '</div>' +
      '<div class="sub">' + escapeHtml(chrome.i18n.getMessage('finalConfirmSub')) + '</div>' +
    '</div>' +
    '<button class="btn btn-primary" id="btn-stay-blocked">' + escapeHtml(chrome.i18n.getMessage('stayBlockedBtn')) + '</button>' +
    '<button class="btn-ghost" id="btn-want-unlock">' + escapeHtml(chrome.i18n.getMessage('wantUnlockBtn')) + '</button>';

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
      '<div class="title">' + escapeHtml(chrome.i18n.getMessage('stayedBlockedTitle')) + '</div>' +
      '<div class="sub">' + escapeHtml(chrome.i18n.getMessage('stayedBlockedSub')) + '</div>' +
    '</div>';
}

// ---------------------------------------------------------------
// Pantalla: tarifas de desbloqueo
// ---------------------------------------------------------------
function renderFeeSelection() {
  const multiplier = attempt.weeklyRecurrenceCount > 0 ? RECURRENCE_FEE_MULTIPLIER : 1;

  root.innerHTML =
    '<div class="eyebrow">' + escapeHtml(domain) + (attempt.weeklyRecurrenceCount > 0 ? escapeHtml(chrome.i18n.getMessage('recurrenceEyebrowSuffix', [String(attempt.weeklyRecurrenceCount + 1)])) : '') + '</div>' +
    '<div class="title">' + escapeHtml(chrome.i18n.getMessage('feeSelectionTitle')) + '</div>' +
    '<div class="sub">' + (multiplier > 1 ? escapeHtml(chrome.i18n.getMessage('recurrenceFeeNote')) : '') + '</div>' +
    '<div id="fee-rows">' +
      Object.entries(UNLOCK_FEES_USD).map(([minutes, baseUsd]) => {
        const price = (baseUsd * multiplier).toFixed(2);
        return '<div class="fee-row" data-minutes="' + minutes + '" data-price="' + price + '">' +
          '<div><div class="fee-time">' + escapeHtml(chrome.i18n.getMessage('feeMinutesLabel', [minutes])) + '</div><div class="fee-note">' + escapeHtml(multiplier > 1 ? chrome.i18n.getMessage('feeNoteDouble') : chrome.i18n.getMessage('feeNoteBase')) + '</div></div>' +
          '<div class="fee-price">$' + price + '</div>' +
        '</div>';
      }).join('') +
    '</div>' +
    '<button class="btn btn-primary" id="btn-pay" disabled>' + escapeHtml(chrome.i18n.getMessage('selectOptionBtn')) + '</button>';

  let selected = null;
  document.querySelectorAll('.fee-row').forEach((row) => {
    row.addEventListener('click', () => {
      document.querySelectorAll('.fee-row').forEach((r) => r.classList.remove('selected'));
      row.classList.add('selected');
      selected = { minutes: Number(row.dataset.minutes), price: Number(row.dataset.price) };
      const btn = document.getElementById('btn-pay');
      btn.disabled = false;
      btn.textContent = chrome.i18n.getMessage('payAndUnlockBtn', [String(selected.minutes)]);
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
      '<div class="title" style="margin-top:16px;">' + escapeHtml(chrome.i18n.getMessage('waitingPaymentTitle')) + '</div>' +
      '<div class="sub">' + escapeHtml(chrome.i18n.getMessage('waitingPaymentSub')) + '</div>' +
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
      '<div class="title">' + escapeHtml(chrome.i18n.getMessage('unlockedTitle', [domain])) + '</div>' +
      '<div class="sub">' + escapeHtml(chrome.i18n.getMessage('unlockedSub')) + '</div>' +
    '</div>';
}

// ---------------------------------------------------------------
// Pantalla: recordatorio de reincidencia (ya desbloqueado hoy)
// ---------------------------------------------------------------
function renderReincidenceReminder() {
  root.innerHTML =
    '<div class="center-block" style="margin-top:40px;">' +
      '<div class="big-emoji">\ud83c\udf3f</div>' +
      '<div class="title">' + escapeHtml(chrome.i18n.getMessage('reincidenceTitle')) + '</div>' +
      '<div class="sub">' + escapeHtml(chrome.i18n.getMessage('reincidenceSub', [domain])) + '</div>' +
    '</div>';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

init();
