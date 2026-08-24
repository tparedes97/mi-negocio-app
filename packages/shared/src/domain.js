/**
 * Validación y normalización de dominios, compartida entre la extensión
 * (popup, hoy retirado a favor del panel web) y packages/dashboard — la
 * gente casi siempre pega un link completo (https://www.sitio.com/algo),
 * no un dominio pelado, así que primero se intenta rescatar el dominio de
 * eso antes de validar.
 *
 * CommonJS a propósito, igual que constants.js y schedule.js — ver esos
 * archivos para el porqué.
 */

function isValidDomain(value) {
  // validación simple — el objetivo es atrapar errores de tipeo obvios, no ser un parser RFC completo
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(value.trim());
}

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

module.exports = { isValidDomain, normalizeDomain };
