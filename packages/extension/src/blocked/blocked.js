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
// ---------------------------------------------------------------
// Pools de frases — contenido provisto por la fundadora, en español
// únicamente (no hay traducción al inglés todavía; si algún día hace
// falta, se agrega como _locales/en igual que el resto de la copia).
// Cada intento de desbloqueo saca su propia selección al azar.
// ---------------------------------------------------------------
const REFLECTION_QUESTIONS_POOL = [
  'Si lo bloqueaste por una razón, recuerda cuál era antes de deshacerlo.',
  'A veces volver a abrir una puerta no significa que hayas cambiado; significa que olvidaste por qué la cerraste.',
  '¿Realmente quieres entrar, o solo quieres comprobar si todavía puedes?',
  'Lo que estás buscando quizá no está al otro lado de ese bloqueo.',
  'Tu decisión de ayer también merece ser escuchada.',
  'Si bloquearlo te dio tranquilidad, ¿qué esperas encontrar al desbloquearlo?',
  'No todo lo que extrañas merece volver a formar parte de tu vida.',
  'Antes de desbloquearlo, pregúntate qué esperas que cambie esta vez.',
  'A veces la curiosidad se disfraza de necesidad.',
  'Lo bloqueaste cuando estabas intentando protegerte. ¿Qué cambió?',
  'No confundas ganas con una buena decisión.',
  'Quizá no necesitas volver. Quizá necesitas seguir adelante.',
  '¿Quieres entrar porque realmente lo necesitas o porque lo extrañas?',
  'Hay decisiones que duelen al principio y agradeces después.',
  'Cerrar una puerta también puede ser una forma de cuidarte.',
  'Si tu versión de hace unos días decidió bloquearlo, quizá tenía algo que decirte.',
  'No necesitas tocar una herida para saber que todavía duele.',
  '¿Vale la pena arriesgar tu tranquilidad por unos minutos de curiosidad?',
  'A veces desbloquear no resuelve nada; simplemente reinicia el ciclo.',
  'Lo conocido no siempre es lo conveniente.',
  'Recuerda cómo te sentías cuando decidiste bloquearlo.',
  'No todas las puertas que puedes abrir merecen ser abiertas.',
  'Si esperas encontrar algo diferente, pregúntate si realmente ha cambiado algo.',
  'Tu paz también es una razón válida.',
  'Quizá este impulso pase. No tienes que actuar sobre él.',
  'No tomes una decisión permanente para calmar una emoción momentánea.',
  'Esperar también es una decisión.',
  'Lo que te hizo bloquearlo sigue existiendo, aunque hoy lo recuerdes de otra manera.',
  'A veces queremos regresar no porque estemos mejor, sino porque olvidamos lo mal que estábamos.',
  '¿Qué perderías si lo desbloquearas? ¿Y qué ganarías?',
  'No necesitas comprobar nuevamente algo que ya te hizo daño.',
  'El impulso dura minutos. Las consecuencias pueden durar mucho más.',
  'Tal vez no extrañas el sitio; extrañas cómo te sentías antes de necesitar bloquearlo.',
  'Si necesitas una razón para desbloquearlo, quizá todavía no estás seguro.',
  'No todo deseo merece convertirse en acción.',
  'Antes de volver, recuerda por qué decidiste irte.',
  'A veces avanzar significa resistir las ganas de mirar atrás.',
  '¿Estás desbloqueando por elección o por impulso?',
  'Tu tranquilidad de mañana puede depender de la decisión que tomes ahora.',
  'No tienes que demostrarte que puedes volver. Ya sabes que puedes.',
  'Puedes cambiar de opinión, pero también puedes darle otra oportunidad a la decisión que te protegió.',
  'Quizá el verdadero progreso sea no volver a comprobar.',
  'Hay cosas que parecen irresistibles hasta que esperas unos minutos.',
  'Si desbloquearlo no cambia nada, ¿por qué hacerlo?',
  'No necesitas una nueva experiencia para confirmar una vieja lección.',
  'La pregunta no es "¿puedo desbloquearlo?", sino "¿me conviene hacerlo?"',
  'A veces la mejor decisión no es la que más satisface tu curiosidad, sino la que protege tu paz.',
  'Si llegaste hasta aquí, probablemente hubo una razón para bloquearlo.',
  'Darte otra oportunidad también puede significar darte la oportunidad de no volver.',
  'Antes de desbloquearlo: respira, espera un momento y pregúntate si tu yo de mañana te lo agradecerá.',
];

function pickRandom(pool) {
  return pool[Math.floor(Math.random() * pool.length)];
}

function pickRandomDistinct(pool, n) {
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

const TALK_INVITE_PHRASES = [
  '¿Necesitas una mano para mantener la disciplina?',
  '¿Quieres que alguien te acompañe un ratito?',
  '¿Te vendría bien distraerte unos minutos?',
  '¿Quieres hablar con alguien antes de tomar una decisión?',
  '¿Necesitas un pequeño empujón para mantenerte firme?',
  '¿Quieres que te acompañemos mientras pasa este impulso?',
  '¿Te gustaría conversar un momento para despejar la mente?',
  '¿Necesitas compañía para no caer en la tentación?',
  '¿Quieres distraerte un rato antes de decidir?',
  '¿Te vendría bien hablar de cualquier cosa por unos minutos?',
  '¿Quieres que te ayudemos a pasar este momento?',
  '¿Necesitas recordar por qué empezaste?',
  '¿Quieres mantenerte firme un poquito más?',
  '¿Te gustaría que alguien se quede contigo un momento?',
  '¿Quieres cambiar de tema y distraerte un rato?',
  '¿Necesitas un pequeño respiro antes de decidir?',
  '¿Quieres hablar hasta que pase el impulso?',
  '¿Te ayudaría tener compañía ahora mismo?',
  '¿Quieres posponer la decisión y conversar un momento?',
  '¿Necesitas que alguien te ayude a mantener el rumbo?',
  '¿Quieres que te acompañemos durante estos próximos minutos?',
  '¿Te gustaría distraerte antes de desbloquearlo?',
  '¿Quieres darte unos minutos antes de cambiar de opinión?',
  '¿Necesitas un poco de apoyo para mantener tu decisión?',
  '¿Quieres que te acompañemos mientras decides?',
  '¿Te apetece hablar de algo completamente diferente?',
  '¿Quieres hacer tiempo hasta que pase este impulso?',
  '¿Necesitas que alguien te recuerde por qué lo bloqueaste?',
  '¿Quieres quedarte un ratito más antes de desbloquearlo?',
  '¿Te vendría bien compañía ahora?',
];

const CELEBRATION_PHRASES = [
  'El éxito es la suma de pequeños esfuerzos, repetidos día tras día. — Robert Collier',
  'No importa cuán despacio vayas, siempre y cuando no te detengas. — Confucio',
  'El futuro depende de lo que haces hoy. — Mahatma Gandhi',
  'La disciplina es elegir entre lo que quieres ahora y lo que más quieres. — atribuida a Abraham Lincoln',
  'No cuentes los días; haz que los días cuenten. — Muhammad Ali',
  'Somos lo que hacemos repetidamente. — atribuida a Aristóteles',
  'Nuestra mayor gloria no es no caer nunca, sino levantarnos cada vez que caemos. — atribuida a Confucio',
  'Lo que haces cada día importa más que lo que haces de vez en cuando.',
  'La perseverancia no es una carrera larga; son muchas carreras cortas, una tras otra. — Walter Elliot',
  'La fuerza no viene de la capacidad física. Viene de una voluntad indomable. — Mahatma Gandhi',
  'Lo hiciste. Esta vez elegiste por ti.',
  '¿Ves? Sí podías.',
  'Lo lograste. El impulso pasó y tú seguiste adelante.',
  'Hoy ganaste una pequeña batalla contigo mismo.',
  'No necesitabas ser más fuerte. Solo necesitabas aguantar un poquito más. Y lo hiciste.',
  'Lo que acaba de pasar importa: elegiste no volver.',
  'Esta vez no seguiste el impulso. Seguiste tu decisión.',
  'Lo lograste incluso cuando tenías ganas de rendirte.',
  'Quédate con esta sensación: pudiste hacerlo.',
  'Acabas de demostrarte algo que quizá necesitabas recordar: sí puedes.',
  'No fue suerte. Tomaste una decisión diferente.',
  'Ese pequeño "no" que dijiste hoy puede significar mucho mañana.',
  'Hoy te elegiste a ti.',
  'Lo hiciste. Y nadie tuvo que hacerlo por ti.',
  'Quizá parece pequeño, pero tú sabes lo difícil que fue.',
  'Nadie vio este momento, pero tú sabes lo que acabas de conseguir.',
  'No necesitas una gran victoria. Esta también cuenta.',
  'El impulso quería una respuesta inmediata. Tú elegiste esperar.',
  'Lo lograste. Ahora puedes seguir con tu día sabiendo que pudiste.',
  'Guarda este momento para la próxima vez que dudes de ti.',
  'Cada vez que eliges lo que realmente quieres sobre lo que quieres en este instante, te estás acercando a la persona que quieres ser.',
  'La disciplina no siempre se siente como fuerza. A veces simplemente se siente como cerrar una página.',
  'No cambiaste tu vida en cinco minutos. Pero sí cambiaste lo que hiciste durante esos cinco minutos.',
  'Quizá mañana vuelvas a sentir el impulso. Cuando pase, recuerda que ya sabes que puedes dejarlo pasar.',
  'No necesitas ganar para siempre. Solo necesitas ganar este momento.',
  'Una decisión pequeña puede ser la primera señal de un cambio grande.',
  'Hoy aprendiste que una emoción puede ser intensa sin tener que obedecerla.',
  'No se trata de nunca tener ganas. Se trata de descubrir que no siempre tienes que hacer lo que tus ganas te dicen.',
  'El orgullo que sientes ahora nació de una decisión que nadie más podía tomar por ti.',
  'Quizá esto parezca pequeño para los demás. Pero tú sabes lo que significó.',
];

const COMPASSIONATE_PHRASES = [
  'Está bien. De verdad. A veces simplemente cedemos. No tienes que castigarte por eso.',
  'Bueno… pasó. Respira un poquito. Todavía puedes cerrar esto y seguir con tu día.',
  'No te voy a juzgar. Solo fue un momento difícil.',
  'Que hayas entrado no significa que hayas perdido. Todavía puedes decidir parar aquí.',
  'No pasa nada si hoy te costó un poco más.',
  'Sé que probablemente esperabas tener más fuerza esta vez. Pero no eres menos por haber cedido.',
  'No tienes que sentirte mal contigo por esto. Mañana puedes volver a intentarlo.',
  'Quizá hoy necesitabas un poco más de tiempo para estar listo. Y está bien.',
  'No arruinaste nada. Una decisión que no salió como querías no borra todo lo demás.',
  'Si te arrepentiste de haber entrado, todavía puedes cerrar la página. No tienes que quedarte.',
  'No te quedes aquí solo porque ya entraste. Puedes irte ahora.',
  'A veces sabemos exactamente qué queremos hacer… y aun así hacemos lo contrario. Somos humanos.',
  'No tienes que explicarte ni justificarte. Solo respira y piensa qué quieres hacer ahora.',
  'Quizá necesitabas comprobarlo una vez más. Ahora ya sabes cómo se siente.',
  'No fue tu mejor momento. Eso es todo. No tiene que convertirse en algo más grande.',
  'Mírate con un poquito de paciencia. Estás intentando cambiar algo y eso nunca es fácil.',
  'No necesitas empezar de nuevo. Simplemente continúa desde aquí.',
  'Si esto te hizo sentir mal, no te castigues por haberlo hecho. Úsalo para recordar por qué querías dejarlo.',
  'Está bien tener días en los que cuesta más.',
  'No tienes que ganar todas las veces. Solo tienes que seguir intentándolo.',
  'Quizá hoy no pudiste resistir. Pero eso no significa que mañana tampoco puedas.',
  'No eres débil. Tuviste un momento débil.',
  'Lo que hiciste hace unos minutos no decide quién eres.',
  'No necesitas sentir culpa para saber que quieres hacerlo diferente.',
  'Puedes estar decepcionado contigo y aun así tratarte con cariño.',
  'Ya pasó. No te quedes atrapado ahí.',
  'Si necesitas un momento, tómalo. No tienes que decidir nada ahora.',
  'Quizá hoy solo necesitabas que alguien te recordara que puedes volver a intentarlo.',
  'No pasa nada. Cierra esto cuando estés listo y sigue.',
  'Mañana nadie te va a preguntar si hoy fuiste perfecto. Solo importa que sigas cuidándote.',
];

let currentQuestionIndex = 0;
const MOTIVATIONAL_QUESTIONS = pickRandomDistinct(REFLECTION_QUESTIONS_POOL, 3);
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
      '<div class="title">' + escapeHtml(pickRandom(TALK_INVITE_PHRASES)) + '</div>' +
      '<div class="sub">Conversa con alguien por unos minutos para despejarte \u2014 es gratis.</div>' +
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
    '<div class="custom-amount-row">' +
      '<span class="custom-amount-prefix">$</span>' +
      '<input type="number" id="donation-custom" min="0" step="0.01" placeholder="Otro monto">' +
    '</div>' +
    '<button class="btn btn-primary" id="btn-donate" disabled>' + escapeHtml(chrome.i18n.getMessage('donateBtn')) + '</button>' +
    '<button class="btn-link" id="btn-skip-donation">' + escapeHtml(chrome.i18n.getMessage('skipDonationBtn')) + '</button>';

  let selectedAmount = null;
  const customInput = document.getElementById('donation-custom');
  const donateBtn = document.getElementById('btn-donate');

  document.querySelectorAll('#donation-chips .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('#donation-chips .chip').forEach((c) => c.classList.remove('selected'));
      chip.classList.add('selected');
      customInput.value = '';
      selectedAmount = Number(chip.dataset.amount);
      donateBtn.disabled = false;
      donateBtn.textContent = chrome.i18n.getMessage('donateAmountBtn', [String(selectedAmount)]);
    });
  });

  customInput.addEventListener('input', () => {
    const value = parseFloat(customInput.value);
    if (!value || value <= 0) {
      selectedAmount = null;
      donateBtn.disabled = true;
      donateBtn.textContent = escapeHtml(chrome.i18n.getMessage('donateBtn'));
      return;
    }
    document.querySelectorAll('#donation-chips .chip').forEach((c) => c.classList.remove('selected'));
    selectedAmount = value;
    donateBtn.disabled = false;
    donateBtn.textContent = chrome.i18n.getMessage('donateAmountBtn', [value.toFixed(2)]);
  });

  document.getElementById('btn-donate').addEventListener('click', async () => {
    if (!selectedAmount) return;
    const createCheckoutSession = httpsCallable(functions, 'createCheckoutSession');
    const { data } = await createCheckoutSession({
      kind: 'donation',
      amountCents: Math.round(selectedAmount * 100),
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
    '<div class="celebrate-block">' +
      '<div class="confetti-layer" id="confetti-layer"></div>' +
      '<div class="trophy-wrap">' +
        '<span class="sparkle sparkle-1">\u2728</span>' +
        '<span class="trophy">\ud83c\udfc6</span>' +
        '<span class="sparkle sparkle-2">\ud83c\udf89</span>' +
      '</div>' +
      '<div class="celebrate-faces">\ud83d\ude04 \ud83d\ude4c \ud83c\udf8a</div>' +
      '<div class="title">' + escapeHtml(chrome.i18n.getMessage('stayedBlockedTitle')) + '</div>' +
      '<div class="sub">' + escapeHtml(pickRandom(CELEBRATION_PHRASES)) + '</div>' +
    '</div>';

  spawnConfetti();
}

const CONFETTI_COLORS = ['#B0503F', '#BE7A42', '#6E8768', '#D9A441', '#3E4E37'];

function spawnConfetti() {
  const layer = document.getElementById('confetti-layer');
  if (!layer) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  for (let i = 0; i < 36; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    piece.style.left = Math.random() * 100 + '%';
    piece.style.background = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
    piece.style.animationDuration = (1.8 + Math.random() * 1.4) + 's';
    piece.style.animationDelay = (Math.random() * 0.6) + 's';
    piece.style.transform = 'rotate(' + Math.floor(Math.random() * 360) + 'deg)';
    layer.appendChild(piece);
  }
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
      '<div class="sub">' + escapeHtml(pickRandom(COMPASSIONATE_PHRASES)) + '</div>' +
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

function renderInitError(err) {
  console.error('[limen] no se pudo iniciar la pantalla de bloqueo', err);
  root.innerHTML =
    '<div class="center-block">' +
      '<div class="title">' + escapeHtml(chrome.i18n.getMessage('initErrorTitle')) + '</div>' +
      '<div class="sub">' + escapeHtml(err?.message || String(err)) + '</div>' +
    '</div>' +
    '<button class="btn btn-primary" id="btn-retry-init">' + escapeHtml(chrome.i18n.getMessage('retryBtn')) + '</button>';
  document.getElementById('btn-retry-init').addEventListener('click', () => location.reload());
}

// Antes, si ensureSignedIn() (u otra parte de init) fallaba, la pantalla se
// quedaba en "Cargando…" para siempre sin mostrar nada — el error solo era
// visible abriendo DevTools. Ahora sí se muestra en pantalla.
init().catch(renderInitError);
