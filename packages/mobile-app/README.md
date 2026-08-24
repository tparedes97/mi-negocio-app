# Limen Mobile (Android)

App Android armada con [Capacitor](https://capacitorjs.com/), separada de
`packages/extension`. **No es un port de la extensión** — Android no tiene
`chrome.declarativeNetRequest`, así que el bloqueo de sitios se resuelve
con un mecanismo completamente distinto: una VPN local (`VpnService`) que
filtra las consultas DNS del propio teléfono.

## ⚠️ Estado real de este código

Esto se escribió en un entorno sin Android SDK, sin emulador y sin acceso
a los repositorios de Google (`dl.google.com` está bloqueado por la
política de red del sandbox donde se generó) — así que **nada de esto se
compiló ni se corrió de verdad todavía**. El código Kotlin está escrito
con cuidado a partir del formato real de los protocolos (IPv4/UDP/DNS) y
de la API de `VpnService`/Capacitor, pero necesita:

1. Compilarlo en un entorno con Android SDK (Replit con el setup de abajo,
   Android Studio, o CI) y corregir lo que Gradle/el compilador de Kotlin
   marquen.
2. Probarlo en un dispositivo o emulador real — sobre todo el parseo de
   paquetes DNS en `DnsPacketUtil.kt`, que es la parte más delicada.

## Qué hace el bloqueo (y qué NO hace)

- **Sí bloquea:** resolución DNS de los dominios que le pases — la app que
  intenta abrir `instagram.com` no consigue una IP real, así que la carga
  falla.
- **No es un firewall completo:** el `Builder` de la VPN solo captura
  tráfico hacia la IP falsa de DNS (`10.111.222.2`), a propósito — el
  resto de internet (HTTP/HTTPS normal) no pasa por el túnel, para no
  tener que reimplementar un NAT completo en el teléfono. Esto significa
  que una app que ya tiene la IP cacheada, o que usa DNS-over-HTTPS
  hardcodeado ignorando el DNS del sistema, puede esquivar el bloqueo.
  Cerrar ese hueco (interceptar TODO el tráfico + inspeccionar SNI de
  TLS) es un proyecto bastante más grande — quedó fuera de este alcance.
- **No impide desinstalar la app ni forzarla a detenerse** desde Ajustes
  de Android. Eso requeriría Device Admin / Accessibility Service con
  permisos mucho más invasivos (y más revisión de Google Play) — es una
  capa aparte, no incluida acá.

## Estructura

```
mobile-app/
├── src/                        → web layer (Capacitor la empaqueta como WebView)
│   ├── index.html, app.js, firebase-config.js
├── android/                    → proyecto nativo generado por `npx cap add android`
│   └── app/src/main/java/app/limen/mobile/
│       ├── LimenVpnService.kt      → la VPN en sí (loop de paquetes)
│       ├── DnsPacketUtil.kt        → parseo/armado de paquetes IPv4+UDP+DNS
│       ├── LimenBlockerPlugin.kt   → puente Capacitor (JS ↔ Kotlin)
│       ├── BootReceiver.kt         → reactiva el bloqueo tras reiniciar el teléfono
│       └── MainActivity.java
├── capacitor.config.ts
├── .replit / replit.nix / setup-android-sdk.sh  → intento de dejarlo andando en Replit
```

## Cómo compilarlo (Replit u otro Linux)

```bash
# 1) Instalar el Android SDK mínimo (una sola vez)
./setup-android-sdk.sh
export ANDROID_SDK_ROOT=$HOME/android-sdk
export ANDROID_HOME=$ANDROID_SDK_ROOT

# 2) Instalar dependencias JS (desde la raíz del monorepo)
npm install

# 3) Sincronizar Capacitor (copia src/ y los plugins al proyecto Android)
npm run sync --workspace=packages/mobile-app

# 4) Compilar el APK de debug
cd packages/mobile-app/android
./gradlew assembleDebug
# El APK queda en app/build/outputs/apk/debug/app-debug.apk
```

**Nota sobre Replit específicamente:** Replit no está pensado principalmente
para builds de Android (Gradle + SDK completo pesan varios GB y el primer
build puede tardar bastante). Si el contenedor de Replit no aguanta o no
tiene espacio, la alternativa más simple es usar Replit solo para
editar/versionar el código y compilar el APK real en GitHub Actions (hay
actions oficiales de `android-actions/setup-android`) o en Android Studio
local — no hace falta forzarlo todo dentro de Replit si no anda bien.

## Notificaciones

- **Locales** (`@capacitor/local-notifications`): se disparan cuando
  `LimenVpnService` detecta un intento de abrir un sitio bloqueado
  (evento `blockedAttempt`).
- **Push** (`@capacitor/push-notifications`, Firebase Cloud Messaging):
  el token se captura en `app.js` y ya se guarda en `users/{uid}.fcmToken`
  (hay login real ahora — ver abajo). Falta todavía la Cloud Function que
  use ese token para mandar el push cuando llega un mensaje de chat nuevo
  o se confirma un pago. Para que el push funcione además hace falta bajar
  `google-services.json` desde la consola de Firebase (Configuración del
  proyecto → tus apps → agregar app Android con el `applicationId`
  `app.limen.mobile`) y ponerlo en `android/app/google-services.json` —
  sin ese archivo, `build.gradle` lo detecta y sigue compilando, pero los
  pushes no van a andar.

## Login y gestión de sitios (Firestore)

La app ya tiene la misma funcionalidad que la extensión de Chrome y el
panel web (`packages/dashboard`): login con Google, agregar/editar/quitar
sitios bloqueados con horario y motivo por sitio, y el candado que impide
tocar un sitio mientras está dentro de su horario bloqueado. Todo vive en
`users/{uid}/blockedSites` (Firestore), sincronizado en vivo — la misma
colección que usan la extensión y el panel web, así que agregar un sitio
en cualquiera de los tres aparece en los otros dos.

- El login usa `@capacitor-firebase/authentication` (Google Sign-In
  nativo) en vez de `signInWithPopup`/`signInWithRedirect` de Firebase Web
  — esos dos manejan mal los WebView de Android. El plugin nativo devuelve
  un `idToken` que se canjea por una sesión de Firebase Auth normal, igual
  que hace la extensión con `chrome.identity` (ver
  `packages/extension/src/lib/firebase.js`).
- `LimenVpnService` (Kotlin) no sabe nada de horarios — solo bloquea la
  lista de dominios que le pasa `startBlocking()`, y es idempotente si ya
  está corriendo (actualiza la lista en memoria sin reiniciar la VPN). El
  filtrado por horario (qué sitio está bloqueado *ahora mismo*) vive en
  `app.js`, igual que `syncBlockingRules()` en `background.js` de la
  extensión: se recalcula al cambiar los sitios, cada minuto mientras la
  app está abierta, y al volver del segundo plano.
- **Requiere configuración nativa que no se hizo en este entorno** (sin
  Android SDK/emulador — ver arriba): agregar `@capacitor-firebase/authentication`
  necesita su propio paso de setup nativo (habilitar el proveedor Google
  en la consola de Firebase, `google-services.json`, y en algunos casos
  el SHA-1 de firma de la app registrado en Firebase). Seguir la
  [documentación oficial del plugin](https://github.com/capawesome-team/capacitor-firebase/tree/main/packages/authentication)
  antes de compilar.

## Pendiente / siguiente paso natural

- Configurar el proveedor de Google en Firebase Auth + `google-services.json`
  real del proyecto `limen-3b8cf`, y probar el login en un dispositivo real.
- Cloud Function que use `users/{uid}.fcmToken` para mandar el push cuando
  llega un mensaje de chat nuevo o se confirma un pago.
- Ícono/splash screen reales (hoy usa los genéricos de Capacitor).
- Probar el flujo de permiso de VPN y el parseo DNS en un dispositivo real.
