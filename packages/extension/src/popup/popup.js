/**
 * Pantalla "Agregar sitio" (1/12 del flujo del prototipo).
 * Guarda en chrome.storage.local — el service worker (background.js)
 * escucha los cambios y recalcula las reglas de bloqueo automáticamente,
 * así que este archivo no necesita saber nada de declarativeNetRequest.
 */

const domainInput = document.getElementById('input-domain');
const siteListEl = document.getElementById('site-list');
const continueBtn = document.getElementById('btn-continue');

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

function renderSiteList(sites) {
  siteListEl.innerHTML = sites.map((site) => `
    <div class="site-pill" data-id="${site.id}">
      <span><span class="dot"></span>${site.domain}</span>
      <button data-remove="${site.id}" aria-label="Quitar ${site.domain}">✕</button>
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

domainInput.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const value = domainInput.value.trim().toLowerCase();
  if (!value || !isValidDomain(value)) {
    domainInput.style.borderColor = 'var(--danger, #B0503F)';
    return;
  }
  domainInput.style.borderColor = '';

  const sites = await loadSites();
  if (sites.some((s) => s.domain === value)) {
    domainInput.value = '';
    return; // ya estaba en la lista, no duplicar
  }

  sites.push({
    id: crypto.randomUUID(),
    domain: value,
    schedule: {}, // se completa en la pantalla "Configurar horario" (siguiente paso, no incluido en este MVP)
    reasonWhy: '',
    reasonInstead: '',
  });

  await saveSites(sites);
  domainInput.value = '';
  renderSiteList(sites);
  continueBtn.disabled = false;
});

continueBtn.addEventListener('click', () => {
  // TODO: navegar a la pantalla "Configurar horario" — siguiente pieza a construir,
  // siguiendo el mismo patrón de esta pantalla (ver prototipo, pantalla 2/12).
  console.log('[limen] continuar a configurar horario (pendiente de implementar)');
});

(async function init() {
  const sites = await loadSites();
  renderSiteList(sites);
  continueBtn.disabled = sites.length === 0;
})();
