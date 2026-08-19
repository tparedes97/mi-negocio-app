/**
 * App vanilla (sin bundler), igual que el resto del monorepo — Capacitor
 * inyecta `window.Capacitor` automáticamente al correr dentro del shell
 * nativo (lo hace `cap sync`, agregando el script runtime a index.html).
 * Los plugins se llaman vía Capacitor.Plugins.<Nombre>, tanto los
 * oficiales (PushNotifications, LocalNotifications) como el nuestro
 * (LimenBlocker, ver android/.../LimenBlockerPlugin.kt).
 *
 * TODO siguiente paso: login (Google) para poder sincronizar
 * blockedSites/activeUnlocks reales desde Firestore — hoy la lista de
 * sitios se guarda local (Preferences) como demostración del flujo VPN.
 */
const { Capacitor } = window;
const Plugins = Capacitor ? Capacitor.Plugins : {};
const { PushNotifications, LocalNotifications, Preferences, LimenBlocker } = Plugins;

const DEFAULT_SITES = ['instagram.com', 'tiktok.com', 'twitter.com'];

const statusDot = document.getElementById('vpn-status-dot');
const statusLabel = document.getElementById('vpn-status-label');
const toggleBtn = document.getElementById('btn-toggle-vpn');
const sitesList = document.getElementById('sites-list');

function renderStatus(active) {
  statusDot.className = 'status-dot ' + (active ? 'on' : 'off');
  statusLabel.textContent = active ? 'Bloqueo activado' : 'Bloqueo desactivado';
  toggleBtn.textContent = active ? 'Desactivar bloqueo' : 'Activar bloqueo';
  toggleBtn.className = 'btn ' + (active ? 'btn-danger' : 'btn-primary');
}

async function getSites() {
  if (!Preferences) return DEFAULT_SITES;
  const { value } = await Preferences.get({ key: 'blockedSites' });
  return value ? JSON.parse(value) : DEFAULT_SITES;
}

async function renderSites() {
  const sites = await getSites();
  sitesList.innerHTML = sites
    .map((d) => `<div class="site-row"><span>${d}</span></div>`)
    .join('');
}

async function initNotifications() {
  if (!PushNotifications || !LocalNotifications) return;

  await LocalNotifications.requestPermissions();

  const pushPerm = await PushNotifications.requestPermissions();
  if (pushPerm.receive !== 'granted') return;
  await PushNotifications.register();

  PushNotifications.addListener('registration', async (token) => {
    // TODO: una vez que haya login, guardar token.value en
    // users/{uid}.fcmToken para que el backend pueda mandar pushes
    // (mensajes nuevos de chat, confirmación de pago, etc.)
    console.log('[limen-mobile] FCM token:', token.value);
  });

  PushNotifications.addListener('registrationError', (err) => {
    console.error('[limen-mobile] error de registro push', err);
  });
}

async function initBlockerEvents() {
  if (!LimenBlocker) return;

  const { active } = await LimenBlocker.getStatus();
  renderStatus(active);

  // Evento emitido desde LimenVpnService cuando el usuario intenta abrir
  // un dominio bloqueado — dispara una notificación local (el equivalente
  // móvil de redirigir a blocked.html en la extensión).
  LimenBlocker.addListener('blockedAttempt', async ({ domain }) => {
    if (!LocalNotifications) return;
    await LocalNotifications.schedule({
      notifications: [{
        id: Date.now() % 100000,
        title: 'Limen',
        body: `Intentaste abrir ${domain} — tocá para hablar con alguien o pagar el desbloqueo.`,
      }],
    });
  });
}

toggleBtn.addEventListener('click', async () => {
  if (!LimenBlocker) {
    alert('El plugin nativo de bloqueo no está disponible en este entorno (¿corriendo en navegador en vez del dispositivo?).');
    return;
  }
  const { active } = await LimenBlocker.getStatus();
  if (active) {
    await LimenBlocker.stopBlocking();
    renderStatus(false);
  } else {
    const sites = await getSites();
    const result = await LimenBlocker.startBlocking({ domains: sites });
    renderStatus(result.active);
  }
});

(async function init() {
  await renderSites();
  await initNotifications();
  await initBlockerEvents();
})();
