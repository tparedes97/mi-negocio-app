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

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  syncBlockingRules();
  startActiveUnlocksListener();
});

chrome.runtime.onStartup.addListener(() => {
  syncBlockingRules();
  startActiveUnlocksListener();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    syncBlockingRules(); // también limpia desbloqueos ya vencidos, aunque Firestore no haya cambiado
    startActiveUnlocksListener(); // no-op si ya está corriendo; reintenta si falló antes por falta de sesión
  }
});

// Si el usuario agrega/edita/borra un sitio desde el popup, recalcular al toque
// en vez de esperar hasta el próximo minuto del alarm.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.blockedSites) {
    syncBlockingRules();
  }
});
