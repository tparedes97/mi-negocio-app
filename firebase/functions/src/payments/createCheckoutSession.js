const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const Stripe = require('stripe');
const { SUBSCRIPTION_PLANS } = require('@limen/shared/src/constants');

const stripeSecretKey = defineSecret('STRIPE_SECRET_KEY');

/**
 * Se abre en una pestaña externa, nunca dentro de la extensión —
 * Chrome Web Store no permite cobrar directamente dentro de una extensión.
 * El descriptor de facturación se configura en el dashboard de Stripe como
 * "LIMEN", nunca con el nombre legal de la fundadora.
 */
exports.createCheckoutSession = onCall({ secrets: [stripeSecretKey] }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Debes iniciar sesión.');

  const stripe = new Stripe(stripeSecretKey.value());
  const { kind } = request.data; // 'subscription' | 'unlock_fee' | 'donation'

  if (kind === 'subscription') {
    const { planId } = request.data; // 'basic' | 'premium'
    const plan = SUBSCRIPTION_PLANS[planId];
    if (!plan) throw new HttpsError('invalid-argument', 'Plan inválido.');

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: plan.stripePriceId /* configurar en Stripe Dashboard */, quantity: 1 }],
      client_reference_id: uid,
      success_url: `${process.env.APP_URL}/checkout/success`,
      cancel_url: `${process.env.APP_URL}/checkout/cancel`,
    });
    return { url: session.url };
  }

  if (kind === 'unlock_fee' || kind === 'donation') {
    const { amountCents, metadata } = request.data;
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: kind === 'donation' ? 'Donación a Limen' : 'Tarifa de desbloqueo' },
          unit_amount: amountCents,
        },
        quantity: 1,
      }],
      client_reference_id: uid,
      metadata: { kind, ...metadata },
      success_url: `${process.env.APP_URL}/checkout/success`,
      cancel_url: `${process.env.APP_URL}/checkout/cancel`,
    });
    return { url: session.url };
  }

  throw new HttpsError('invalid-argument', 'kind debe ser subscription, unlock_fee o donation.');
});
