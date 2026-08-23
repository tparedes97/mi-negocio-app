const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

/**
 * El compañero "no finaliza el chat, indica que quiere ampliar 1 minuto más
 * para despedirse". Este callable es la única forma en que el compañero
 * puede intervenir en el cierre — mueve el chat a 'farewell' antes de que
 * se cumplan los 5 minutos, si la conversación ya llegó a un buen punto.
 * El cierre real, pasado ese minuto, lo sigue haciendo enforceChatTimeouts.
 */
exports.requestFarewell = onCall({ invoker: 'public' }, async (request) => {
  const { chatId } = request.data;
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Debes iniciar sesión.');

  const db = getFirestore();
  const chatRef = db.collection('chats').doc(chatId);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(chatRef);
    if (!snap.exists) throw new HttpsError('not-found', 'Chat no encontrado.');
    const chat = snap.data();

    if (chat.companionId !== uid) {
      throw new HttpsError('permission-denied', 'Solo el compañero asignado puede pedir la despedida.');
    }
    if (chat.state !== 'running') {
      // ya está en farewell o cerrado — operación idempotente, no es error
      return;
    }

    tx.update(chatRef, {
      state: 'farewell',
      farewellStartedAt: FieldValue.serverTimestamp(),
    });
  });

  return { ok: true };
});
