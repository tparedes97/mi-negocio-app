/**
 * Onboarding del popup: agregar sitios (paso 1) y elegir horario de
 * bloqueo (paso 2). Guarda en chrome.storage.local — el service worker
 * (background.js) escucha los cambios y recalcula las reglas de bloqueo
 * automáticamente, así que este archivo no necesita saber nada de
 * declarativeNetRequest.
 */

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
document.getElementById('step2-label').textContent = chrome.i18n.getMessage('step2Label');
document.getElementById('schedule-title').textContent = chrome.i18n.getMessage('scheduleTitle');
document.getElementById('schedule-sub').textContent = chrome.i18n.getMessage('scheduleSub');
document.getElementById('label-start').textContent = chrome.i18n.getMessage('startLabel');
document.getElementById('label-end').textContent = chrome.i18n.getMessage('endLabel');
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

function renderSiteList(sites) {
  siteListEl.innerHTML = sites.map((site) => `
    <div class="site-pill" data-id="${site.id}">
      <span><span class="dot"></span>${site.domain}</span>
      <button data-remove="${site.id}" aria-label="${chrome.i18n.getMessage('removeSiteAriaLabel', [site.domain])}">✕</button>
    </div>
  `).join('');

  siteListEl.querySelectorAll('button[data-remove]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-remove');
      const sites = (await loadSites()).filter((s) => s.id !== id);
      await saveSites(sites);
      renderSiteList(sites);
      continueBtn.disabled = sites.length === 0;
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

function populateHourSelects() {
  selectStart.innerHTML = Array.from({ length: 24 }, (_, h) => `<option value="${h}">${String(h).padStart(2, '0')}:00</option>`).join('');
  selectEnd.innerHTML = Array.from({ length: 24 }, (_, h) => `<option value="${h + 1}">${h + 1 === 24 ? '24:00' : String(h + 1).padStart(2, '0') + ':00'}</option>`).join('');
  selectStart.value = '0';
  selectEnd.value = '24'; // "hasta las 24:00" = todo el día
}

/**
 * MVP: un solo horario aplicado a todos los sitios agregados en el paso 1
 * (configurar un horario distinto por sitio queda para una vuelta futura —
 * lo importante ahora es que el bloqueo funcione de verdad, cosa que antes
 * no pasaba porque schedule se guardaba siempre vacío y background.js
 * nunca encontraba una ventana activa).
 */
async function saveSchedule() {
  const startHour = Number(selectStart.value);
  const endHour = Number(selectEnd.value);
  const window = { startHour, endHour };
  const schedule = {};
  activeDays.forEach((day) => { schedule[day] = window; });

  const sites = await loadSites();
  await saveSites(sites.map((s) => ({ ...s, schedule })));
  showView(viewDone);
}

continueBtn.addEventListener('click', () => {
  renderDayToggles();
  populateHourSelects();
  showView(viewSchedule);
});

document.getElementById('btn-back-to-sites').addEventListener('click', () => showView(viewAddSite));
document.getElementById('btn-save-schedule').addEventListener('click', saveSchedule);
document.getElementById('btn-edit-more').addEventListener('click', () => showView(viewAddSite));

(async function init() {
  const sites = await loadSites();
  renderSiteList(sites);
  continueBtn.disabled = sites.length === 0;
})();
