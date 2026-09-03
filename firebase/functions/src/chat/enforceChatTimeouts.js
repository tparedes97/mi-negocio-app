const { onSchedule } = require('firebase-functions/v2/scheduler');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const {
  CHAT_DURATION_SECONDS,
  FAREWELL_DURATION_SECONDS,
} = require('../../shared/constants');

/**
 * Esta función es la implementación real de la regla más importante del
 * producto: "el corte del chat es una regla técnica dura, nunca queda a
 * discreción del acompañante". Corre cada minuto y:
 *
 *   1. Chats en estado 'running' que ya pasaron los 5 minutos → pasan a
 *      'farewell' automáticamente (el compañero no tuvo que pedirlo).
 *   2. Chats en estado 'farewell' que ya pasaron el minuto extra → se
 *      cierran solos, sin intervención humana.
 *
 * No confiar en que el cliente (portal del compañero) haga este corte por
 * su cuenta — el cliente puede quedarse abierto en una pestaña dormida,
 * perder conexión, etc. La fuente de verdad del corte es siempre el backend.
 */
exports.enforceChatTimeouts = onSchedule('every 1 minutes', async () => {
  const db = getFirestore();
  const now = Timestamp.now();

  // --- 1. running → farewell ---
  const runningCutoff = Timestamp.fromMillis(now.toMillis() - CHAT_DURATION_SECONDS * 1000);
  const runningSnap = await db
    .collection('chats')
    .where('state', '==', 'running')
    .where('timerStartedAt', '<=', runningCutoff)
    .get();

  const farewellBatch = db.batch();
  runningSnap.forEach((doc) => {
    farewellBatch.update(doc.ref, {
      state: 'farewell',
      farewellStartedAt: FieldValue.serverTimestamp(),
    });
  });
  if (!runningSnap.empty) await farewellBatch.commit();

  // --- 2. farewell → closed ---
  const farewellCutoff = Timestamp.fromMillis(now.toMillis() - FAREWELL_DURATION_SECONDS * 1000);
  const farewellSnap = await db
    .collection('chats')
    .where('state', '==', 'farewell')
    .where('farewellStartedAt', '<=', farewellCutoff)
    .get();

  const closeBatch = db.batch();
  farewellSnap.forEach((doc) => {
    const data = doc.data();
    const durationSeconds = data.timerStartedAt
      ? Math.round((now.toMillis() - data.timerStartedAt.toMillis()) / 1000)
      : null;
    closeBatch.update(doc.ref, {
      state: 'closed',
      closedAt: FieldValue.serverTimestamp(),
      durationSeconds,
    });
  });
  if (!farewellSnap.empty) await closeBatch.commit();
});
