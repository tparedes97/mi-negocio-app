const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { culqiRequest } = require('./culqiClient');

const culqiSecretKey = defineSecret('CULQI_SECRET_KEY');

/**
 * Todo lo que toca dinero pasa por aquí, nunca se confía en el cliente para
 * marcar un pago como exitoso. El monto y la metadata SIEMPRE se leen del
 * documento pendingPayments creado por createCheckoutSession — nunca del
 * payload que manda la páginita de checkout, que solo aporta el token de
 * la tarjeta y el email.
 *
 * Reemplaza al webhook de Stripe: el cargo con tarjeta en Culqi (v2/charges)
 * responde de forma síncrona (aprobado/rechazado en la misma respuesta),
 * así que no hace falta un webhook aparte para confirmar el pago.
 */
exports.confirmCulqiCharge = onCall({ secrets: [culqiSecretKey] }, async (request) => {
  const { paymentId, sourceId, email } = request.data;
  if (!paymentId || !sourceId || !email) {
    throw new HttpsError('invalid-argument', 'Faltan paymentId, sourceId o email.');
  }

  const db = getFirestore();
  const paymentRef = db.collection('pendingPayments').doc(paymentId);
  const paymentSnap = await paymentRef.get();
  if (!paymentSnap.exists) throw new HttpsError('not-found', 'Este enlace de pago ya no es válido.');

  const payment = paymentSnap.data();
  if (payment.status !== 'pending') {
    throw new HttpsError('failed-precondition', 'Este pago ya fue procesado.');
  }

  let charge;
  try {
    charge = await culqiRequest('/charges', {
      method: 'POST',
      secretKey: culqiSecretKey.value(),
      body: {
        amount: payment.amountCents,
        capture: true,
        currency_code: 'USD',
        description: payment.kind === 'donation' ? 'Donación a Limen' : 'Tarifa de desbloqueo — Limen',
        email,
        installments: 0,
        source_id: sourceId,
      },
    });
  } catch (err) {
    await paymentRef.update({ status: 'failed', failureReason: err.message });
    throw new HttpsError('aborted', err.message || 'El pago fue rechazado.');
  }

  const userId = payment.uid;

  if (payment.kind === 'donation') {
    await db.collection('donations').add({
      userId,
      chatId: payment.metadata.chatId || null,
      companionId: payment.metadata.companionId || null,
      amountCents: payment.amountCents,
      currency: 'usd',
      culqiChargeId: charge.id,
      createdAt: FieldValue.serverTimestamp(),
    });
  }

  if (payment.kind === 'unlock_fee') {
    const { attemptId, domain, minutes } = payment.metadata;
    const expiresAt = new Date(Date.now() + Number(minutes) * 60 * 1000);

    // Esto es lo único que realmente levanta el bloqueo — nunca el cliente.
    await db.collection('activeUnlocks').doc(`${userId}_${domain}`).set({
      userId,
      domain,
      attemptId,
      expiresAt,
      createdAt: FieldValue.serverTimestamp(),
    });

    await db
      .collection('users').doc(userId)
      .collection('unlockAttempts').doc(attemptId)
      .update({
        state: 'unlocked',
        feeAmountCents: payment.amountCents,
        feeMinutes: Number(minutes),
      });
  }

  await paymentRef.update({ status: 'completed', culqiChargeId: charge.id });

  return { success: true };
});
