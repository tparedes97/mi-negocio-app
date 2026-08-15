const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

/**
 * Se abre en una pestaña externa, nunca dentro de la extensión —
 * Chrome Web Store no permite cobrar directamente dentro de una extensión.
 * El monto real lo decide el backend y queda guardado en pendingPayments;
 * el id de ese documento actúa como capability token de la URL devuelta —
 * quien lo tiene puede pagar esa orden puntual, nada más. Es el mismo
 * patrón de confianza que usaba la Checkout Session de Stripe, solo que
 * ahora la página de cobro la hosteamos nosotros (packages/checkout) en
 * vez de que la hostee el proveedor de pagos.
 * El descriptor de facturación se configura en el dashboard de Culqi como
 * "LIMEN", nunca con el nombre legal de la fundadora.
 */
exports.createCheckoutSession = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Debes iniciar sesión.');

  const { kind } = request.data; // 'subscription' | 'unlock_fee' | 'donation'

  if (kind === 'subscription') {
    // La recurrencia de Culqi (Planes) es una API aparte de las Órdenes/
    // Cargos usados acá — no implementado todavía porque el modelo real
    // del negocio hoy es donaciones + tarifas de desbloqueo puntuales.
    throw new HttpsError('unimplemented', 'Las suscripciones todavía no están implementadas.');
  }

  if (kind !== 'unlock_fee' && kind !== 'donation') {
    throw new HttpsError('invalid-argument', 'kind debe ser unlock_fee o donation.');
  }

  const { amountCents, metadata } = request.data;
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new HttpsError('invalid-argument', 'amountCents inválido.');
  }

  const db = getFirestore();
  const paymentRef = db.collection('pendingPayments').doc();
  await paymentRef.set({
    uid,
    kind,
    amountCents,
    metadata: metadata || {},
    status: 'pending',
    createdAt: FieldValue.serverTimestamp(),
  });

  const baseUrl = process.env.CHECKOUT_BASE_URL || `https://${process.env.GCLOUD_PROJECT}.web.app`;
  return { url: `${baseUrl}/pay.html?paymentId=${paymentRef.id}` };
});
