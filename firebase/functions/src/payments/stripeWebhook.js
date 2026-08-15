const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const Stripe = require('stripe');

const stripeSecretKey = defineSecret('STRIPE_SECRET_KEY');
const stripeWebhookSecret = defineSecret('STRIPE_WEBHOOK_SECRET');

/**
 * Todo lo que toca dinero pasa por aquí, nunca se confía en el cliente para
 * marcar un pago como exitoso. Importante para el punto de "no quiero
 * denuncias ni vacíos legales" de la especificación: esta es la única
 * fuente de verdad de qué se cobró y cuándo.
 */
exports.stripeWebhook = onRequest(
  { secrets: [stripeSecretKey, stripeWebhookSecret] },
  async (req, res) => {
    const stripe = new Stripe(stripeSecretKey.value());
    const db = getFirestore();

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.rawBody,
        req.headers['stripe-signature'],
        stripeWebhookSecret.value()
      );
    } catch (err) {
      res.status(400).send(`Firma de webhook inválida: ${err.message}`);
      return;
    }

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.client_reference_id;

        if (session.metadata?.kind === 'donation') {
          await db.collection('donations').add({
            userId,
            chatId: session.metadata.chatId || null,
            companionId: session.metadata.companionId,
            amountCents: session.amount_total,
            currency: 'usd',
            stripePaymentIntentId: session.payment_intent,
            createdAt: FieldValue.serverTimestamp(),
          });
        }

        if (session.metadata?.kind === 'unlock_fee') {
          const { attemptId, domain, minutes } = session.metadata;
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
              feeAmountCents: session.amount_total,
              feeMinutes: Number(minutes),
            });
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const userId = subscription.metadata?.userId;
        if (!userId) break;

        // Cruce con el último compañero que atendió a este usuario —
        // alimenta la sección de cancelaciones del dashboard.
        const lastChatSnap = await db
          .collection('chats')
          .where('userId', '==', userId)
          .orderBy('startedAt', 'desc')
          .limit(1)
          .get();
        const lastCompanionId = lastChatSnap.empty ? null : lastChatSnap.docs[0].data().companionId;

        await db.collection('cancellations').add({
          userId,
          canceledAt: FieldValue.serverTimestamp(),
          lastCompanionId,
          reasonText: null, // si más adelante se agrega encuesta de salida, va aquí
        });

        await db.collection('users').doc(userId).update({
          subscriptionStatus: 'canceled',
        });
        break;
      }

      default:
        break; // otros eventos de Stripe se ignoran por ahora
    }

    res.status(200).send({ received: true });
  }
);
