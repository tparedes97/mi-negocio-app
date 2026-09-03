const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore } = require('firebase-admin/firestore');

/**
 * "Toca una casilla abierta para inscribirte. Toca una tuya para
 * cancelarla. Las de otros compañeros no se pueden tocar." — esta regla no
 * se puede aplicar de forma segura solo con Firestore Rules porque mutar una
 * sola celda sin poder tocar las demás no es expresable ahí, así que se
 * valida acá, en el servidor. (grid es un array de 7 mapas hora->uid, no un
 * array anidado — Firestore no soporta arrays dentro de arrays.)
 */
exports.toggleMyShift = onCall({ invoker: 'public' }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Debes iniciar sesión.');

  const { yearMonth, day, hour } = request.data;
  if (
    typeof yearMonth !== 'string' ||
    !Number.isInteger(day) || day < 0 || day > 6 ||
    !Number.isInteger(hour) || hour < 0 || hour > 23
  ) {
    throw new HttpsError('invalid-argument', 'yearMonth/day/hour inválidos.');
  }

  const db = getFirestore();
  const ref = db.collection('shiftAssignments').doc(yearMonth);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw new HttpsError('not-found', 'Todavía no hay programación para ese mes.');
    }

    const data = snap.data();
    const grid = data.grid.map((row) => ({ ...row })); // copia profunda de un array de mapas
    const current = grid[day][hour];

    if (current !== null && current !== uid) {
      throw new HttpsError('permission-denied', 'Esa casilla ya está tomada por otro compañero.');
    }

    grid[day][hour] = current === uid ? null : uid; // toggle: inscribirse u cancelar mi propia casilla

    tx.update(ref, { grid });
    return { ok: true, newValue: grid[day][hour] };
  });
});
