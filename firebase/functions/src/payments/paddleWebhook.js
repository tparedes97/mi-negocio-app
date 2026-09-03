const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { Paddle, Environment } = require('@paddle/paddle-node-sdk');

const paddleApiKey = defineSecret('PADDLE_API_KEY');
const paddleWebhookSecret = defineSecret('PADDLE_WEBHOOK_SECRET');
const paddleEnv = defineSecret('PADDLE_ENVIRONMENT');

/**
 * Única fuente de verdad de que un pago se cobró de verdad — el cliente
 * (la páginita de checkout) nunca decide por su cuenta que pagó, ni
 * siquiera el evento client-side de Paddle.js cuenta para eso, solo este
 * webhook firmado. El monto y la metadata interna (uid, kind, attemptId,
 * etc.) vienen en customData, que se seteó server-side al crear la
 * Transaction en createCheckoutSession.js — nunca se confía en nada que
 * mande el navegador del que paga.
 */
exports.paddleWebhook = onRequest(
  { secrets: [paddleApiKey, paddleWebhookSecret, paddleEnv] },
  async (req, res) => {
    const paddle = new Paddle(paddleApiKey.value(), {
      environment: paddleEnv.value() === 'production' ? Environment.production : Environment.sandbox,
    });

    const signature = req.headers['paddle-signature'];
    let event;
    try {
      event = await paddle.webhooks.unmarshal(req.rawBody, paddleWebhookSecret.value(), signature);
    } catch (err) {
      console.error('[paddleWebhook] firma inválida', err.message);
      res.status(400).send('invalid signature');
      return;
    }

    if (!event || event.eventType !== 'transaction.completed') {
      res.status(200).send('ignored');
      return;
    }

    const txn = event.data;
    const customData = txn.customData || {};
    const { uid, kind, amountCents: amountCentsStr } = customData;

    if (!uid || !kind || !amountCentsStr) {
      console.error('[paddleWebhook] transaction sin customData esperado', txn.id);
      res.status(200).send('missing custom data');
      return;
    }

    const amountCents = Number(amountCentsStr);
    const db = getFirestore();

    if (kind === 'donation') {
      await db.collection('donations').add({
        userId: uid,
        chatId: customData.chatId || null,
        companionId: customData.companionId || null,
        amountCents,
        currency: 'usd',
        paddleTransactionId: txn.id,
        createdAt: FieldValue.serverTimestamp(),
      });
    }

    if (kind === 'unlock_fee') {
      const { attemptId, domain, minutes } = customData;
      const expiresAt = new Date(Date.now() + Number(minutes) * 60 * 1000);

      // Esto es lo único que realmente levanta el bloqueo — nunca el cliente.
      await db.collection('activeUnlocks').doc(`${uid}_${domain}`).set({
        userId: uid,
        domain,
        attemptId,
        expiresAt,
        createdAt: FieldValue.serverTimestamp(),
      });

      await db
        .collection('users').doc(uid)
        .collection('unlockAttempts').doc(attemptId)
        .update({
          state: 'unlocked',
          feeAmountCents: amountCents,
          feeMinutes: Number(minutes),
        });
    }

    res.status(200).send('ok');
  },
);
