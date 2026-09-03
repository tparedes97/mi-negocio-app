/**
 * Constantes de negocio de Limen.
 * Cambiar un número aquí lo cambia en toda la app — la extensión, el admin,
 * el portal de compañeros y las Cloud Functions importan de este archivo.
 * No dupliques estos valores en otro lado.
 *
 * CommonJS a propósito: las Cloud Functions usan require() (Node por
 * defecto es CJS). esbuild, que empaqueta la extensión, interopera CJS→ESM
 * sin problema, así que este mismo archivo sirve para ambos consumidores.
 */

// ---- Suscripción ----
// Solo dos niveles: gratis (tope de sitios bloqueados, sin métricas) y
// premium (sitios ilimitados + métricas). El acompañamiento (chat con
// compañeros) es siempre gratuito en ambos niveles — no depende del plan.
const FREE_MAX_BLOCKED_SITES = 5;
const SUBSCRIPTION_PLANS = {
  free: { id: 'free', priceUsd: 0, label: 'Gratis', includesStats: false, maxBlockedSites: FREE_MAX_BLOCKED_SITES },
  premium: { id: 'premium', priceUsd: 5, label: 'Premium', includesStats: true, maxBlockedSites: Infinity },
};

// ---- Chat: duración y reglas de cierre ----
const CHAT_DURATION_SECONDS = 5 * 60;   // el tiempo NO corre hasta que el usuario responde
const FAREWELL_DURATION_SECONDS = 60;   // minuto final de despedida, corte automático sin excepción
const CHAT_LOW_TIME_THRESHOLD_SECONDS = 60; // cuándo la UI empieza a avisar que se acaba el tiempo

// ---- Concurrencia de chats por compañero ----
// Sin límite artificial: cada compañero (incluida la fundadora) atiende
// tantos chats simultáneos como pueda manejar. No hay distinción por rol.
const MAX_CONCURRENT_CHATS = Infinity;

// ---- Alias rotativos (nunca un nombre fijo por compañero) ----
const ALIAS_POOL = ['Ana', 'Lucía', 'Sofía', 'Mateo', 'Andrés', 'Valeria'];

// ---- Tarifas de desbloqueo ----
// Escalan por reincidencia del mismo sitio; el contador se reinicia semanalmente.
const UNLOCK_FEES_USD = {
  10: 2.0,
  30: 6.0,
  60: 12.0,
};
const RECURRENCE_FEE_MULTIPLIER = 2; // tarifa x2 desde el 2º desbloqueo del mismo sitio en la semana
const RECURRENCE_RESET = 'weekly';

// ---- Donaciones ----
const DONATION_SUGGESTED_AMOUNTS_USD = [2, 5, 10];
const DONATIONS_REFUNDABLE = false; // no reembolsable bajo ninguna circunstancia — ver especificación

// ---- Nómina ----
const COMPANION_SALARY_PEN = 400;     // sueldo fijo mensual, 4h diarias — no es pago por hora
const EXCHANGE_RATE_PEN_PER_USD = 3.37; // aproximado — en producción, consultar una API de tipo de cambio real

// ---- Capacidad operativa ----
const CAPACITY_CHATS_PER_HOUR_PER_PERSON = 8; // asunción a validar con datos reales de producción

// ---- Sistema de diseño (debe coincidir con los prototipos HTML) ----
const DESIGN_TOKENS = {
  pageBg: '#F6EFE2',
  surface: '#FFFCF5',
  surface2: '#F2E7D3',
  amber: '#BE7A42',
  amberDim: '#F1E1C7',
  sage: '#6E8768',
  sageDim: '#E4EBDA',
  danger: '#B0503F',
  dangerDim: '#F3DDD6',
  text: '#3B2E22',
  textMuted: '#8C7A63',
  line: '#E6D9C0',
};

// ---- Roles ----
const COMPANION_ROLES = { FOUNDER: 'founder', STAFF: 'staff' };

module.exports = {
  SUBSCRIPTION_PLANS,
  FREE_MAX_BLOCKED_SITES,
  CHAT_DURATION_SECONDS,
  FAREWELL_DURATION_SECONDS,
  CHAT_LOW_TIME_THRESHOLD_SECONDS,
  MAX_CONCURRENT_CHATS,
  ALIAS_POOL,
  UNLOCK_FEES_USD,
  RECURRENCE_FEE_MULTIPLIER,
  RECURRENCE_RESET,
  DONATION_SUGGESTED_AMOUNTS_USD,
  DONATIONS_REFUNDABLE,
  COMPANION_SALARY_PEN,
  EXCHANGE_RATE_PEN_PER_USD,
  CAPACITY_CHATS_PER_HOUR_PER_PERSON,
  DESIGN_TOKENS,
  COMPANION_ROLES,
};
