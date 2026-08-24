/**
 * Onboarding del popup: agregar sitios (paso 1) y elegir horario de
 * bloqueo (paso 2). Guarda en chrome.storage.local — el service worker
 * (background.js) escucha los cambios y recalcula las reglas de bloqueo
 * automáticamente, así que este archivo no necesita saber nada de
 * declarativeNetRequest.
 */

import { isWithinBlockedWindow } from '@limen/shared/src/schedule';

const domainInput = document.getElementById('input-domain');
const siteListEl = document.getElementById('site-list');
const continueBtn = document.getElementById('btn-continue');
const addSiteBtn = document.getElementById('btn-add-site');
const domainErrorEl = document.getElementById('domain-error');

const viewAddSite = document.getElementById('view-add-site');
const viewSchedule = document.getElementById('view-schedule');
const viewDone = document.getElementById('view-done');
const dayTogglesEl = document.getElementById('day-toggles');
const selectStart = document.getElementById('select-start');
const selectEnd = document.getElementById('select-end');
const reasonWhyEl = document.getElementById('reason-why');
const reasonInsteadEl = document.getElementById('reason-instead');
const reasonWhyErrorEl = document.getElementById('reason-why-error');
const siteEyebrowEl = document.getElementById('step2-label');

/** día 0 = lunes ... 6 = domingo, igual que background.js y el resto del producto */
const DAY_KEYS = ['dayMon', 'dayTue', 'dayWed', 'dayThu', 'dayFri', 'daySat', 'daySun'];
let activeDays = new Set([0, 1, 2, 3, 4, 5, 6]); // por defecto: bloquea todos los días

// chrome.i18n usa automáticamente el idioma del navegador (chrome.i18n.getUILanguage())
// y cae de vuelta a default_locale ("es") si no hay traducción para ese idioma —
// ver _locales/{es,en}/messages.json. No hace falta detectar nada a mano.
document.documentElement.lang = chrome.i18n.getUILanguage();
document.title = chrome.i18n.getMessage('popupTitle');
document.getElementById('step-label').textContent = chrome.i18n.getMessage('step1Label');
document.getElementById('add-site-title').textContent = chrome.i18n.getMessage('addSiteTitle');
document.getElementById('add-site-sub').textContent = chrome.i18n.getMessage('addSiteSub');
document.getElementById('confidential-text').textContent = chrome.i18n.getMessage('confidentialNote');
continueBtn.textContent = chrome.i18n.getMessage('continueButton');
addSiteBtn.setAttribute('aria-label', chrome.i18n.getMessage('addSiteBtnLabel'));
document.getElementById('schedule-title').textContent = chrome.i18n.getMessage('scheduleTitle');
document.getElementById('schedule-sub').textContent = chrome.i18n.getMessage('scheduleSub');
document.getElementById('days-hours-label').textContent = chrome.i18n.getMessage('daysHoursLabel');
document.getElementById('label-start').textContent = chrome.i18n.getMessage('startLabel');
document.getElementById('label-end').textContent = chrome.i18n.getMessage('endLabel');
document.getElementById('reason-why-label').textContent = chrome.i18n.getMessage('reasonWhyLabel');
reasonWhyEl.placeholder = chrome.i18n.getMessage('reasonWhyPlaceholder');
document.getElementById('reason-instead-label').textContent = chrome.i18n.getMessage('reasonInsteadLabel');
reasonInsteadEl.placeholder = chrome.i18n.getMessage('reasonInsteadPlaceholder');
document.getElementById('btn-save-schedule').textContent = chrome.i18n.getMessage('saveScheduleBtn');
document.getElementById('btn-back-to-sites').textContent = chrome.i18n.getMessage('backToSitesBtn');
document.getElementById('done-title').textContent = chrome.i18n.getMessage('doneTitle');
document.getElementById('done-sub').textContent = chrome.i18n.getMessage('doneSub');
document.getElementById('btn-edit-more').textContent = chrome.i18n.getMessage('editMoreBtn');

/** @returns {Promise<Array<{id:string, domain:string, schedule: object}>>} */
async function loadSites() {
  const { blockedSites = [] } = await chrome.storage.local.get('blockedSites');
  return blockedSites;
}

async function saveSites(sites) {
  await chrome.storage.local.set({ blockedSites: sites });
}

function isValidDomain(value) {
  // validación simple — el objetivo es atrapar errores de tipeo obvios, no ser un parser RFC completo
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(value.trim());
}

/**
 * La gente normalmente pega un link completo (https://www.instagram.com/algo?x=1),
 * no un dominio pelado — antes eso simplemente fallaba la validación sin
 * explicar por qué. Esto intenta rescatar el dominio de lo que sea que
 * hayan pegado (con protocolo, www, ruta, query, puerto) antes de validar.
 */
function normalizeDomain(raw) {
  let value = raw.trim().toLowerCase();
  if (!value) return '';
  if (!/^[a-z]+:\/\//.test(value)) value = 'https://' + value; // para que URL() lo pueda parsear igual
  try {
    const url = new URL(value);
    return url.hostname.replace(/^www\./, '');
  } catch {
    return raw.trim().toLowerCase(); // no era ni siquiera parseable como URL — se deja tal cual para que isValidDomain() lo rechace con el mensaje de error
  }
}

function showDomainError(message) {
  domainInput.style.borderColor = 'var(--danger, #B0503F)';
  domainErrorEl.textContent = message;
  domainErrorEl.style.display = message ? 'block' : 'none';
}

function clearDomainError() {
  showDomainError('');
  domainInput.style.borderColor = '';
}

async function addCurrentDomain() {
  const value = normalizeDomain(domainInput.value);
  if (!value || !isValidDomain(value)) {
    showDomainError(chrome.i18n.getMessage('invalidDomainError'));
    return;
  }
  clearDomainError();

  const sites = await loadSites();
  if (sites.some((s) => s.domain === value)) {
    domainInput.value = '';
    return; // ya estaba en la lista, no duplicar
  }

  sites.push({
    id: crypto.randomUUID(),
    domain: value,
    schedule: {}, // se completa al guardar en la pantalla de horario (ver saveSchedule())
    reasonWhy: '',
    reasonInstead: '',
  });

  await saveSites(sites);
  domainInput.value = '';
  renderSiteList(sites);
  continueBtn.disabled = false;
}

// Sitios cuya "x" está en modo confirmación ("¿de verdad quieres
// eliminarlo?") ahora mismo — se resetea cada vez que se vuelve a
// renderizar la lista desde cero (ej. al reabrir el popup).
const confirmingRemovalIds = new Set();

/**
 * Quitar (o editar) un sitio de la lista NUNCA debe ser posible mientras
 * ese sitio está en su horario bloqueado — si lo fuera, bastaría con
 * borrarlo de acá para saltarse todo el bloqueo sin pasar por blocked.html
 * ni por el acompañante. Solo se puede tocar en sus horas libres, y
 * todavía ahí pidiendo confirmación (no es un trámite de un solo clic).
 */
function renderSiteList(sites) {
  siteListEl.innerHTML = sites.map((site) => {
    const blockedNow = isWithinBlockedWindow(site);

    if (blockedNow) {
      return `
        <div class="site-pill" data-id="${site.id}">
          <span><span class="dot"></span>${site.domain}</span>
          <span class="lock-ico" title="${chrome.i18n.getMessage('lockedWhileBlockedTooltip')}">🔒</span>
        </div>`;
    }

    if (confirmingRemovalIds.has(site.id)) {
      return `
        <div class="site-pill confirming" data-id="${site.id}">
          <span class="confirm-text">${chrome.i18n.getMessage('confirmRemoveText', [site.domain])}</span>
          <div class="confirm-actions">
            <button class="confirm-yes" data-confirm-remove="${site.id}">${chrome.i18n.getMessage('confirmRemoveYesBtn')}</button>
            <button class="confirm-no" data-cancel-remove="${site.id}">${chrome.i18n.getMessage('confirmRemoveNoBtn')}</button>
          </div>
        </div>`;
    }

    return `
      <div class="site-pill" data-id="${site.id}">
        <span><span class="dot"></span>${site.domain}</span>
        <button data-remove="${site.id}" aria-label="${chrome.i18n.getMessage('removeSiteAriaLabel', [site.domain])}">✕</button>
      </div>`;
  }).join('');

  siteListEl.querySelectorAll('button[data-remove]').forEach((btn) => {
    btn.addEventListener('click', () => {
      confirmingRemovalIds.add(btn.getAttribute('data-remove'));
      renderSiteList(sites);
    });
  });

  siteListEl.querySelectorAll('button[data-cancel-remove]').forEach((btn) => {
    btn.addEventListener('click', () => {
      confirmingRemovalIds.delete(btn.getAttribute('data-cancel-remove'));
      renderSiteList(sites);
    });
  });

  siteListEl.querySelectorAll('button[data-confirm-remove]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-confirm-remove');
      confirmingRemovalIds.delete(id);
      const remaining = (await loadSites()).filter((s) => s.id !== id);
      await saveSites(remaining);
      renderSiteList(remaining);
      continueBtn.disabled = remaining.length === 0;
    });
  });
}

domainInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  addCurrentDomain();
});
domainInput.addEventListener('input', clearDomainError); // el error desaparece apenas la persona vuelve a escribir
addSiteBtn.addEventListener('click', addCurrentDomain);

function showView(view) {
  [viewAddSite, viewSchedule, viewDone].forEach((v) => { v.style.display = v === view ? '' : 'none'; });
}

function renderDayToggles() {
  dayTogglesEl.innerHTML = DAY_KEYS.map((key, i) => `
    <div class="day-toggle ${activeDays.has(i) ? 'active' : ''}" data-day="${i}">${chrome.i18n.getMessage(key)}</div>
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

// La configuración de horario + motivo es POR SITIO (así era en el diseño
// original: cada sitio tiene su propia razón, no una compartida) — por eso
// esto es una cola: si agregaste 3 sitios, se pregunta uno por uno.
let scheduleQueue = [];
let scheduleIndex = 0;

function currentQueuedSite() {
  return scheduleQueue[scheduleIndex];
}

function showScheduleStep() {
  const site = currentQueuedSite();
  siteEyebrowEl.textContent = site.domain;

  // el horario y la ventana de días por defecto: los que ya tenía este
  // sitio guardados (si vuelves atrás a editarlo) o "todos los días,
  // todo el día" si es la primera vez.
  const existingWindow = Object.values(site.schedule || {})[0];
  activeDays = new Set(
    Object.keys(site.schedule || {}).length
      ? Object.keys(site.schedule).map(Number)
      : [0, 1, 2, 3, 4, 5, 6]
  );
  renderDayToggles();
  populateHourSelects(existingWindow?.startHour ?? 0, existingWindow?.endHour ?? 24);

  reasonWhyEl.value = site.reasonWhy || '';
  reasonInsteadEl.value = site.reasonInstead || '';
  reasonWhyErrorEl.style.display = 'none';
  reasonWhyEl.style.borderColor = '';

  showView(viewSchedule);
}

async function saveCurrentScheduleStep() {
  const reasonWhy = reasonWhyEl.value.trim();
  if (!reasonWhy) {
    // Piénsalo bien de verdad: sin al menos una razón escrita no se guarda
    // el bloqueo — es la fricción intencional que hace que esto no sea un
    // trámite en piloto automático.
    reasonWhyErrorEl.textContent = chrome.i18n.getMessage('reasonWhyRequiredError');
    reasonWhyErrorEl.style.display = 'block';
    reasonWhyEl.style.borderColor = 'var(--danger, #B0503F)';
    reasonWhyEl.focus();
    return;
  }

  const startHour = Number(selectStart.value);
  const endHour = Number(selectEnd.value);
  const window = { startHour, endHour };
  const schedule = {};
  activeDays.forEach((day) => { schedule[day] = window; });

  const site = currentQueuedSite();
  const sites = await loadSites();
  await saveSites(sites.map((s) => (s.id === site.id
    ? { ...s, schedule, reasonWhy, reasonInstead: reasonInsteadEl.value.trim() }
    : s)));

  scheduleIndex++;
  if (scheduleIndex < scheduleQueue.length) {
    showScheduleStep();
  } else {
    showView(viewDone);
  }
}

continueBtn.addEventListener('click', async () => {
  scheduleQueue = await loadSites();
  scheduleIndex = 0;
  if (scheduleQueue.length === 0) return;
  showScheduleStep();
});

document.getElementById('btn-back-to-sites').addEventListener('click', () => {
  if (scheduleIndex > 0) { scheduleIndex--; showScheduleStep(); return; }
  showView(viewAddSite);
});
document.getElementById('btn-save-schedule').addEventListener('click', saveCurrentScheduleStep);
reasonWhyEl.addEventListener('input', () => {
  reasonWhyErrorEl.style.display = 'none';
  reasonWhyEl.style.borderColor = '';
});
document.getElementById('btn-edit-more').addEventListener('click', async () => {
  const sites = await loadSites();
  renderSiteList(sites);
  showView(viewAddSite);
});

(async function init() {
  const sites = await loadSites();
  renderSiteList(sites);
  continueBtn.disabled = sites.length === 0;
})();
