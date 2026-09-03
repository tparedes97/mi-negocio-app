const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const {
  UNLOCK_FEES_USD,
  RECURRENCE_FEE_MULTIPLIER,
} = require('../../shared/constants');

function startOfWeekMonday(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Se calcula en el backend, nunca en el cliente, para que no se pueda
 * manipular el conteo de reincidencia y pagar de menos. La escalada de
 * tarifas se reinicia cada semana (lunes), tal como se definió en la
 * especificación.
 */
exports.computeWeeklyRecurrence = onDocumentCreated(
  'users/{userId}/unlockAttempts/{attemptId}',
  async (event) => {
    const db = getFirestore();
    const attemptRef = event.data.ref;
    const attempt = event.data.data();

    const weekStart = Timestamp.fromDate(startOfWeekMonday(new Date()));

    const previousThisWeek = await db
      .collection('users').doc(event.params.userId)
      .collection('unlockAttempts')
      .where('domain', '==', attempt.domain)
      .where('createdAt', '>=', weekStart)
      .where('state', 'in', ['unlocked']) // solo cuentan los que sí terminaron en desbloqueo pagado
      .get();

    const recurrenceCount = previousThisWeek.size; // no incluye el actual, que aún no está en 'unlocked'

    // La tarifa base se decide en la pantalla de tarifas (10/30/60 min);
    // aquí solo dejamos calculado el multiplicador para que la UI lo aplique.
    const feeMultiplier = recurrenceCount > 0 ? RECURRENCE_FEE_MULTIPLIER : 1;

    await attemptRef.update({
      weeklyRecurrenceCount: recurrenceCount,
      feeMultiplierApplied: feeMultiplier,
    });
  }
);

module.exports.UNLOCK_FEES_USD = UNLOCK_FEES_USD; // re-exportado por si algún consumidor lo necesita
