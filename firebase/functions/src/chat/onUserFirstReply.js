const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

/**
 * Regla de negocio: "el tiempo del chat debe iniciar una vez que la persona
 * le responde, no antes". El compañero puede tener el chat abierto y hasta
 * enviar el primer mensaje, pero el cronómetro de 5 minutos no arranca
 * hasta este trigger.
 */
exports.onUserFirstReply = onDocumentCreated(
  'chats/{chatId}/messages/{messageId}',
  async (event) => {
    const message = event.data.data();
    if (message.from !== 'user') return; // solo el primer mensaje DEL USUARIO dispara el timer

    const db = getFirestore();
    const chatRef = db.collection('chats').doc(event.params.chatId);

    await db.runTransaction(async (tx) => {
      const chatSnap = await tx.get(chatRef);
      const chat = chatSnap.data();

      // Idempotente: si ya se inició (ej. el usuario mandó un segundo mensaje), no hacer nada.
      if (chat.timerStartedAt !== null) return;
      if (chat.state !== 'waiting_reply') return;

      tx.update(chatRef, {
        timerStartedAt: FieldValue.serverTimestamp(),
        state: 'running',
      });
    });
  }
);
