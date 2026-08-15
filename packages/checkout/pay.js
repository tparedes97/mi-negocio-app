import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js';
import { firebaseConfig } from './firebase-config.js';
import { CULQI_PUBLIC_KEY } from './culqi-config.js';

const app = initializeApp(firebaseConfig);
const functions = getFunctions(app);

const params = new URLSearchParams(window.location.search);
const paymentId = params.get('paymentId');

const loadingEl = document.getElementById('loading');
const contentEl = document.getElementById('content');
const amountEl = document.getElementById('amount-label');
const descEl = document.getElementById('desc-label');
const statusEl = document.getElementById('status');
const emailInput = document.getElementById('email');
const payBtn = document.getElementById('btn-pay');

let checkoutInfo = null;

function formatUsd(cents) {
  return '$' + (cents / 100).toFixed(2);
}

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
}

async function init() {
  if (!paymentId) {
    loadingEl.textContent = 'Enlace de pago inválido — falta paymentId.';
    return;
  }

  try {
    const getCheckoutInfo = httpsCallable(functions, 'getCheckoutInfo');
    const { data } = await getCheckoutInfo({ paymentId });
    checkoutInfo = data;
  } catch (err) {
    loadingEl.textContent = err.message || 'Este enlace de pago ya no es válido.';
    return;
  }

  descEl.textContent = checkoutInfo.description;
  amountEl.textContent = formatUsd(checkoutInfo.amountCents);
  loadingEl.style.display = 'none';
  contentEl.style.display = 'block';

  Culqi.publicKey = CULQI_PUBLIC_KEY;
}

payBtn.addEventListener('click', () => {
  const email = emailInput.value.trim();
  if (!email || !email.includes('@')) {
    setStatus('Escribe un correo válido antes de pagar.', 'error');
    return;
  }

  setStatus('', '');
  Culqi.settings({
    title: 'Limen',
    currency: 'USD',
    amount: checkoutInfo.amountCents,
    description: checkoutInfo.description,
  });
  Culqi.options({
    lang: 'auto',
    installments: false,
    paymentMethods: { tarjeta: true, yape: false, bancaMovil: false, agente: false, billetera: false, cuotealo: false },
  });
  Culqi.open();
});

// Callback global que Culqi invoca al cerrar el checkout — ver
// https://checkout.culqi.com/js/v4. Si en el futuro se migra a "Custom
// Checkout" (checkout-js) este flujo cambia: ese modo requiere además
// una xculqirsaid/rsapublickey del panel de Culqi para cifrar el payload.
window.culqi = async function culqi() {
  if (Culqi.token) {
    const token = Culqi.token;
    payBtn.disabled = true;
    setStatus('Procesando el pago…', '');

    try {
      const confirmCulqiCharge = httpsCallable(functions, 'confirmCulqiCharge');
      await confirmCulqiCharge({
        paymentId,
        sourceId: token.id,
        email: token.email || emailInput.value.trim(),
      });
      setStatus('¡Pago confirmado! Ya puedes cerrar esta pestaña.', 'ok');
      contentEl.style.display = 'none';
    } catch (err) {
      payBtn.disabled = false;
      setStatus(err.message || 'El pago fue rechazado. Intenta con otra tarjeta.', 'error');
    }
  } else if (Culqi.order) {
    setStatus('Este método de pago no está habilitado todavía — paga con tarjeta.', 'error');
  } else if (Culqi.error) {
    setStatus(Culqi.error.user_message || 'Ocurrió un error con el pago.', 'error');
  }
};

init();
