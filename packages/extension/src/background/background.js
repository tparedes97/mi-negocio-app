/**
 * Service worker de Limen.
 *
 * Responsabilidad: mantener sincronizadas las reglas de
 * declarativeNetRequest con (a) el horario configurado de cada sitio
 * bloqueado y (b) los desbloqueos activos confirmados por pago.
 *
 * Importante: este archivo NUNCA decide por su cuenta que un pago fue
 * exitoso. Solo lee `activeUnlocks` desde Firestore, colección que
 * exclusivamente escribe paddleWebhook (ver
 * firebase/functions/src/payments/paddleWebhook.js). Si alguien edita
 * chrome.storage.local a mano para intentar desbloquearse gratis, el
 * siguiente ciclo del listener de Firestore lo revierte.
 */

import { onSnapshot, collection, query, where } from 'firebase/firestore';
import { db, ensureSignedIn } from '../lib/firebase.js';
import { isWithinBlockedWindow } from '@limen/shared/src/schedule';

const RULE_ID_BASE = 1000; // IDs de regla reservados para Limen (evitar colisión con otras extensiones)
const ALARM_NAME = 'limen-schedule-check';

// La extensión ya no tiene popup — agregar/editar/quitar sitios se hace en
// el panel web (packages/dashboard), que escribe directo en Firestore.
// El ícono de la barra abre esa pestaña (ver chrome.action.onClicked más
// abajo). Cambiar esta URL si cambia el sitio de Hosting del dashboard.
const DASHBOARD_URL = 'https://limen-app-3b8cf.web.app';

/**
 * @typedef {{ startHour: number, endHour: number }} DayWindow
 * @typedef {{ id: string, domain: string, schedule: Record<number, DayWindow> }} BlockedSite
 * @typedef {{ domain: string, expiresAtMs: number }} ActiveUnlock
 */

async function getBlockedSites() {
  const { blockedSites = [] } = await chrome.storage.local.get('blockedSites');
  return blockedSites;
}

async function getActiveUnlocks() {
  const { activeUnlocks = [] } = await chrome.storage.local.get('activeUnlocks');
  const now = Date.now();
  return activeUnlocks.filter((u) => u.expiresAtMs > now); // los vencidos se ignoran aunque no se hayan limpiado aún
}

function extensionUrl(path) {
  return chrome.runtime.getURL(path);
}

async function syncBlockingRules() {
  const [sites, activeUnlocks] = await Promise.all([getBlockedSites(), getActiveUnlocks()]);
  const unlockedDomains = new Set(activeUnlocks.map((u) => u.domain));

  const sitesToBlock = sites.filter((site) => isWithinBlockedWindow(site) && !unlockedDomains.has(site.domain));

  const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
  const existingIds = existingRules.map((r) => r.id);

  /** @type {chrome.declarativeNetRequest.Rule[]} */
  const newRules = sitesToBlock.map((site, index) => ({
    id: RULE_ID_BASE + index,
    priority: 1,
    action: {
      type: 'redirect',
      redirect: {
        url: extensionUrl(`blocked.html?site=${encodeURIComponent(site.domain)}&siteId=${site.id}`),
      },
    },
    condition: {
      urlFilter: `||${site.domain}^`,
      resourceTypes: ['main_frame'],
    },
  }));

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existingIds,
    addRules: newRules,
  });

  console.log(
    `[limen] bloqueando ${newRules.length} de ${sites.length} sitios configurados ` +
    `(${unlockedDomains.size} con desbloqueo activo)`
  );
}

let unsubscribeActiveUnlocks = null;
let unsubscribeBlockedSites = null;

async function startActiveUnlocksListener() {
  if (unsubscribeActiveUnlocks) return; // ya está escuchando

  try {
    const user = await ensureSignedIn();
    const q = query(collection(db, 'activeUnlocks'), where('userId', '==', user.uid));

    unsubscribeActiveUnlocks = onSnapshot(q, async (snapshot) => {
      const activeUnlocks = snapshot.docs.map((d) => {
        const data = d.data();
        return { domain: data.domain, expiresAtMs: data.expiresAt.toMillis() };
      });
      await chrome.storage.local.set({ activeUnlocks });
      syncBlockingRules();
    });
  } catch (err) {
    // Sin sesión todavía (ej. primera instalación) — se reintenta en el próximo alarm.
    console.log('[limen] no se pudo iniciar el listener de desbloqueos activos:', err.message);
  }
}

/**
 * blockedSites ya no lo escribe nadie local — vive en Firestore
 * (users/{uid}/blockedSites), gestionado desde el panel web
 * (packages/dashboard). Este listener mantiene chrome.storage.local como
 * caché de lectura para que declarativeNetRequest pueda seguir bloqueando
 * aunque el dispositivo se quede sin internet momentáneamente. Mismo
 * patrón que startActiveUnlocksListener() de arriba.
 */
async function startBlockedSitesListener() {
  if (unsubscribeBlockedSites) return;

  try {
    const user = await ensureSignedIn();
    const q = collection(db, 'users', user.uid, 'blockedSites');

    unsubscribeBlockedSites = onSnapshot(q, async (snapshot) => {
      const blockedSites = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
      await chrome.storage.local.set({ blockedSites });
      syncBlockingRules();
    });
  } catch (err) {
    console.log('[limen] no se pudo iniciar el listener de sitios bloqueados:', err.message);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  syncBlockingRules();
  startActiveUnlocksListener();
  startBlockedSitesListener();
});

chrome.runtime.onStartup.addListener(() => {
  syncBlockingRules();
  startActiveUnlocksListener();
  startBlockedSitesListener();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    syncBlockingRules(); // también limpia desbloqueos ya vencidos, aunque Firestore no haya cambiado
    startActiveUnlocksListener(); // no-op si ya está corriendo; reintenta si falló antes por falta de sesión
    startBlockedSitesListener();
  }
});

// La extensión ya no tiene popup: el ícono de la barra abre el panel web
// completo en una pestaña nueva, en vez de un popup chico.
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: DASHBOARD_URL });
});
