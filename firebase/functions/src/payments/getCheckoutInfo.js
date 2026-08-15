const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore } = require('firebase-admin/firestore');

/**
 * La páginita de checkout (packages/checkout) no tiene sesión de Firebase
 * Auth propia — solo tiene el paymentId de la URL. Esta función le da lo
 * mínimo necesario para mostrar el monto, nada del uid ni la metadata
 * interna del usuario.
 */
exports.getCheckoutInfo = onCall(async (request) => {
  const { paymentId } = request.data;
  if (!paymentId) throw new HttpsError('invalid-argument', 'Falta paymentId.');

  const db = getFirestore();
  const snap = await db.collection('pendingPayments').doc(paymentId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Este enlace de pago ya no es válido.');

  const payment = snap.data();
  if (payment.status !== 'pending') {
    throw new HttpsError('failed-precondition', 'Este pago ya fue procesado.');
  }

  return {
    amountCents: payment.amountCents,
    kind: payment.kind,
    description: payment.kind === 'donation' ? 'Donación a Limen' : 'Tarifa de desbloqueo — Limen',
  };
});
