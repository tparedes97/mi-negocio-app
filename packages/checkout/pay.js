import { PADDLE_CLIENT_TOKEN, PADDLE_ENVIRONMENT } from './paddle-config.js';

const params = new URLSearchParams(window.location.search);
const transactionId = params.get('transactionId');

const statusEl = document.getElementById('status');

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
}

if (!transactionId) {
  setStatus('Enlace de pago inválido — falta transactionId.', 'error');
} else {
  if (PADDLE_ENVIRONMENT === 'sandbox') {
    Paddle.Environment.set('sandbox');
  }

  Paddle.Setup({
    token: PADDLE_CLIENT_TOKEN,
    eventCallback(event) {
      // Estos eventos son solo para la UX de esta pantalla — la
      // confirmación real del pago (lo que desbloquea el sitio o registra
      // la donación) la hace únicamente firebase/functions/src/payments/
      // paddleWebhook.js, nunca este listener del cliente.
      if (event.name === 'checkout.completed') {
        setStatus('¡Pago confirmado! Ya puedes cerrar esta pestaña.', 'ok');
      } else if (event.name === 'checkout.error') {
        setStatus('Ocurrió un error con el pago. Intenta de nuevo.', 'error');
      }
    },
  });

  setStatus('');
  Paddle.Checkout.open({ transactionId });
}
