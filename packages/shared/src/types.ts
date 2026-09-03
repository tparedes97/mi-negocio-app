/**
 * Tipos compartidos de Limen.
 * Estos tipos son la fuente de verdad del modelo de datos — la extensión,
 * el admin, el portal de compañeros y las Cloud Functions deben importar
 * de aquí en vez de redefinir formas de objetos por su cuenta.
 *
 * Corresponden 1:1 a las colecciones de Firestore descritas en
 * /firebase/firestore-schema.md
 */

export type PlanId = 'basic' | 'premium';

export interface UserDoc {
  uid: string;
  email: string;
  createdAt: FirestoreTimestamp;
  plan: PlanId;
  subscriptionStatus: 'active' | 'past_due' | 'canceled';
  paddleCustomerId: string | null; // reservado para cuando se implementen suscripciones recurrentes
  browserInstanceId: string; // las estadísticas son por navegador, no hay cuenta central de uso
  countryCode: string | null; // para tipo de cambio / precios regionales a futuro
  timezone: string | null;
}

export interface BlockedSiteDoc {
  id: string;
  userId: string;
  domain: string; // ej. "instagram.com"
  schedule: WeeklySchedule;
  reasonWhy: string; // "¿Por qué eliges bloquear esto?"
  reasonInstead: string; // "¿Qué te gustaría hacer en su lugar?"
  createdAt: FirestoreTimestamp;
  archived: boolean;
}

/** día 0 = lunes ... día 6 = domingo, para que coincida con el resto del producto */
export type WeeklySchedule = {
  [day in 0 | 1 | 2 | 3 | 4 | 5 | 6]?: { startHour: number; endHour: number };
};

export type UnlockAttemptState =
  | 'motivational_questions'   // las 3 preguntas iniciales
  | 'offered_chat'              // "¿deseas hablar con alguien?"
  | 'queued'                    // esperando a que un compañero atienda (sin ver su tiempo de espera)
  | 'chat_waiting'               // el compañero atendió, esperando la primera respuesta del usuario (el timer aún no corre)
  | 'chat_active'                // el timer de 5 min está corriendo
  | 'chat_farewell'              // el minuto final de despedida
  | 'donation_prompt'
  | 'final_confirmation'
  | 'fee_selection'
  | 'unlocked'
  | 'stayed_blocked'
  | 'reincidence_reminder';      // ya se desbloqueó ese sitio hoy

export interface UnlockAttemptDoc {
  id: string;
  userId: string;
  siteId: string;
  domain: string;
  state: UnlockAttemptState;
  createdAt: FirestoreTimestamp;
  queuedAt: FirestoreTimestamp | null;
  chatId: string | null;
  waitSeconds: number | null;      // compilado para admin/compañero, NUNCA mostrado al usuario
  donationAmountCents: number | null;
  feeAmountCents: number | null;
  feeMinutes: number | null;
  weeklyRecurrenceCount: number;   // cuántas veces se desbloqueó este sitio esta semana (reinicia semanalmente)
}

export type ChatState = 'waiting_reply' | 'running' | 'farewell' | 'closed';

export interface ChatSessionDoc {
  id: string;
  unlockAttemptId: string;
  userId: string;
  domain: string;                  // denormalizado desde el UnlockAttemptDoc — evita una lectura extra para mostrar estadísticas
  companionId: string;             // uid del compañero/fundadora que atiende
  aliasUsed: string;                // alias aleatorio asignado a esta conversación, nunca el nombre real
  state: ChatState;
  startedAt: FirestoreTimestamp;    // cuándo el compañero tomó el chat de la cola
  timerStartedAt: FirestoreTimestamp | null; // cuándo el usuario respondió por primera vez — AQUÍ empieza a correr el tiempo
  farewellStartedAt: FirestoreTimestamp | null;
  closedAt: FirestoreTimestamp | null;
  closingMessage: string | null;   // mensaje opcional del compañero al cerrar
  durationSeconds: number | null;
}

export interface ChatMessageDoc {
  id: string;
  chatId: string;
  from: 'user' | 'companion';
  text: string;
  sentAt: FirestoreTimestamp;
}

export type CompanionRole = 'founder' | 'staff';

export interface CompanionDoc {
  uid: string;
  fullName: string;          // PRIVADO — nunca exponer al usuario final
  email: string;
  role: CompanionRole;       // 'founder' = sin límite de chats simultáneos; 'staff' = límite (ver constants.ts)
  active: boolean;
  assignedAliases: string[]; // pool de alias que puede usar (rotativo por conversación)
  createdAt: FirestoreTimestamp;
}

/** Programación mensual — se redefine cada mes, no es un horario recurrente indefinido */
export interface ShiftAssignmentDoc {
  id: string;               // `${year}-${month}`
  year: number;
  month: number;             // 1-12
  /** grid[dayOfWeek][hour] = companionUid | null. Cada día es un mapa (no un
   * array) porque Firestore no soporta arrays anidados dentro de arrays. */
  grid: Record<string, string | null>[]; // 7 días, cada uno {"0": uid|null, ..., "23": uid|null}
  launchedAt: FirestoreTimestamp | null; // null mientras no se publique
  launchedBy: string | null;
}

/** Snapshot inmutable guardado cada vez que se lanza un calendario — vive en Cobertura, no se edita */
export interface ShiftArchiveDoc {
  id: string;
  yearMonth: string;         // "2026-08" — para poder contar versiones del mismo mes
  label: string;              // ej. "agosto 2026 — v1"
  savedAt: FirestoreTimestamp;
  grid: Record<string, string | null>[];
}

export interface DonationDoc {
  id: string;
  userId: string;
  chatId: string | null;
  companionId: string;       // a quién se le atribuye, para el ranking de donaciones
  amountCents: number;
  currency: 'usd';
  paddleTransactionId: string;
  createdAt: FirestoreTimestamp;
}

export interface CancellationDoc {
  id: string;
  userId: string;
  canceledAt: FirestoreTimestamp;
  lastCompanionId: string | null; // último compañero que atendió a este usuario antes de cancelar
  reasonText: string | null;
}

/** Marcador de tipo — reemplazar por firebase/firestore Timestamp en el código real */
export type FirestoreTimestamp = { seconds: number; nanoseconds: number };

/**
 * Escrito ÚNICAMENTE por paddleWebhook al confirmar el pago de una
 * tarifa de desbloqueo — nunca por el cliente. El service worker de la
 * extensión escucha esta colección (filtrada a su propio usuario) para
 * saber qué dominios levantar del bloqueo, y por cuánto tiempo.
 */
export interface ActiveUnlockDoc {
  id: string;              // `${userId}_${domain}`
  userId: string;
  domain: string;
  attemptId: string;
  expiresAt: FirestoreTimestamp;
  createdAt: FirestoreTimestamp;
}

