/**
 * Lógica de horario de bloqueo compartida entre la extensión
 * (background.js, para decidir si redirige) y el propio popup (para saber
 * si un sitio se puede editar/eliminar ahora mismo — solo se permite
 * durante las horas en las que ESE sitio está libre, nunca mientras está
 * bloqueado; si no, bastaría con borrar el sitio de la lista para saltarse
 * todo el bloqueo). Cuando exista la app de Android, debe usar esta misma
 * lógica — no reimplementarla ahí.
 *
 * CommonJS a propósito, igual que constants.js — ver ese archivo.
 */

/** día 0 = lunes ... 6 = domingo (no como Date.getDay(), que empieza en domingo) */
function currentDayIndexMondayFirst() {
  const jsDay = new Date().getDay(); // 0 = domingo
  return jsDay === 0 ? 6 : jsDay - 1;
}

/** @param {{ schedule?: Record<number, {startHour:number, endHour:number}> }} site */
function isWithinBlockedWindow(site) {
  const window = site.schedule?.[currentDayIndexMondayFirst()];
  if (!window) return false;
  const now = new Date();
  const currentHour = now.getHours() + now.getMinutes() / 60;
  return currentHour >= window.startHour && currentHour < window.endHour;
}

module.exports = { currentDayIndexMondayFirst, isWithinBlockedWindow };
