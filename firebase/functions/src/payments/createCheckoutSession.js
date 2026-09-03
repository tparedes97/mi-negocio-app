const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { Paddle, Environment } = require('@paddle/paddle-node-sdk');

const paddleApiKey = defineSecret('PADDLE_API_KEY');
const paddleEnv = defineSecret('PADDLE_ENVIRONMENT'); // 'sandbox' o 'production'

/**
 * Se abre en una pestaña externa, nunca dentro de la extensión —
 * Chrome Web Store no permite cobrar directamente dentro de una extensión.
 * El monto siempre lo decide el backend, nunca el cliente. Crea una
 * Transaction de Paddle con un producto/precio "no-catálogo" (inline, sin
 * necesidad de tenerlo precreado en el dashboard) y le mete la metadata
 * interna en customData — eso es lo que después llega firmado al webhook,
 * así que no hace falta guardar un documento propio de "pago pendiente"
 * como con Culqi: la propia Transaction de Paddle es la fuente de verdad.
 * El nombre del negocio se configura en el dashboard de Paddle
 * ("LIMEN"), nunca con el nombre legal de la fundadora.
 */
exports.createCheckoutSession = onCall(
  { secrets: [paddleApiKey, paddleEnv], invoker: 'public' },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Debes iniciar sesión.');

    const { kind } = request.data; // 'subscription' | 'unlock_fee' | 'donation'

    if (kind === 'subscription') {
      // Paddle maneja recurrencia con Subscriptions, una API aparte de
      // Transactions — no implementado todavía porque el modelo real del
      // negocio hoy es donaciones + tarifas de desbloqueo puntuales.
      throw new HttpsError('unimplemented', 'Las suscripciones todavía no están implementadas.');
    }

    if (kind !== 'unlock_fee' && kind !== 'donation') {
      throw new HttpsError('invalid-argument', 'kind debe ser unlock_fee o donation.');
    }

    const { amountCents, metadata } = request.data;
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new HttpsError('invalid-argument', 'amountCents inválido.');
    }

    const paddle = new Paddle(paddleApiKey.value(), {
      environment: paddleEnv.value() === 'production' ? Environment.production : Environment.sandbox,
    });

    const description = kind === 'donation' ? 'Donación a Limen' : 'Tarifa de desbloqueo — Limen';

    const transaction = await paddle.transactions.create({
      items: [
        {
          price: {
            description,
            name: description,
            unitPrice: {
              amount: String(amountCents),
              currencyCode: 'USD',
            },
            taxMode: 'account_setting',
            product: {
              name: description,
              taxCategory: 'standard',
            },
          },
          quantity: 1,
        },
      ],
      customData: {
        uid,
        kind,
        amountCents: String(amountCents),
        ...(metadata || {}),
      },
    });

    const baseUrl = process.env.CHECKOUT_BASE_URL || `https://${process.env.GCLOUD_PROJECT}.web.app`;
    return { url: `${baseUrl}/pay.html?transactionId=${transaction.id}` };
  },
);
