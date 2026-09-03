# Limen

Extensión de bloqueo de sitios con acompañamiento humano en vivo. Ver
`docs/especificacion.md` para el producto completo (flujo, modelo de
negocio, reglas de cierre de chat, etc.) — este README es solo el mapa
técnico de cómo está armado el código.

## Estructura

```
limen/
├── packages/
│   ├── shared/              → tipos TS + constantes de negocio. TODO lo demás importa de aquí.
│   ├── extension/           → la extensión de Chrome (Manifest V3)
│   ├── admin/                → panel de la fundadora (prototipo HTML/CSS/JS, por conectar a Firestore)
│   └── companion-portal/     → portal de trabajo de acompañantes (ídem)
├── firebase/
│   ├── firestore.rules       → reglas de seguridad
│   ├── firestore-schema.md   → mapa de colecciones
│   └── functions/            → Cloud Functions (chat, pagos, turnos)
└── docs/
    └── especificacion.md     → spec de producto completa
```

## Por qué existe `packages/shared`

Antes de este paso, cada prototipo (admin, portal, extensión) tenía sus
propias constantes hardcodeadas — el precio del plan, el límite de chats
simultáneos, el tiempo del temporizador, etc., cada uno por su lado. Eso es
justo lo que generaba huecos: cambiar un número en un lugar y olvidarlo en
otro. Ahora todo vive en `packages/shared/src/constants.js` y
`packages/shared/src/types.ts`, y todo lo demás importa de ahí.

## Cómo instalar

```bash
npm install     # instala todo el monorepo de una — npm workspaces resuelve @limen/shared automáticamente
```

## Qué está realmente implementado vs. qué es esqueleto

### ✅ Implementado (código real, no solo mockup)

- **`packages/shared`** — tipos y constantes completos, reflejan toda la
  especificación (temporizadores, tarifas, roles, capacidad).
- **`firebase/firestore.rules`** — reglas reales: un usuario nunca puede leer
  `waitSeconds` de otro, un compañero nunca puede leer `fullName` de otro
  compañero salvo que sea la fundadora, `activeUnlocks` es de solo lectura
  para el propio usuario (nunca se escribe desde el cliente).
- **`firebase/functions/src/chat/enforceChatTimeouts.js`** — el corte
  automático del chat (la regla más importante del producto) implementado
  como Cloud Function programada, no como algo que depende del cliente.
- **`firebase/functions/src/chat/onUserFirstReply.js`** — el cronómetro
  arranca cuando el usuario responde, no antes.
- **`firebase/functions/src/unlock/computeWeeklyRecurrence.js`** — escalada
  de tarifas por reincidencia, calculada en el backend (no manipulable desde
  el cliente).
- **`firebase/functions/src/payments/`** — Checkout de Stripe + webhook que
  (a) registra donaciones, (b) cruza cancelaciones con el último compañero
  que atendió a ese usuario, y (c) al confirmar el pago de una tarifa de
  desbloqueo, escribe en `activeUnlocks` — que es lo único que realmente
  levanta el bloqueo. El cliente nunca decide por su cuenta que pagó.
- **`packages/extension`** — manifest, service worker con bloqueo real por
  horario (`declarativeNetRequest`) que además escucha `activeUnlocks` en
  tiempo real (`onSnapshot`) para levantar el bloqueo apenas Stripe confirma
  el pago, y el flujo COMPLETO de `blocked.html`: 3 preguntas motivadoras →
  "¿hablar con alguien?" → cola (sin contador visible) → chat en vivo con
  temporizador visual + corte real hecho por el backend → donación opcional
  → confirmación final → tarifas → espera de pago → desbloqueado. Además el
  recordatorio de reincidencia si ya se desbloqueó ese sitio hoy. Todo
  conectado a Firestore de verdad, no HTML estático.
- **`packages/companion-portal`** — panel "Cola de chats" conectado a
  Firestore de verdad (`app.js`): escucha la cola global de intentos en
  estado `queued` vía `collectionGroup`, "Atender" crea el `ChatSessionDoc`
  y escribe `chatId` de vuelta en el intento (que es justo lo que la
  extensión está escuchando del otro lado), chat en vivo con mensajes
  reales, y "Pedir 1 min. para despedirme" llama a la Cloud Function
  `requestFarewell`. **Sin límite de chats simultáneos, para nadie** — cada
  compañero atiende tantos como pueda manejar. El panel "Turnos disponibles"
  también está conectado: lee `shiftAssignments/{yearMonth}` en vivo, y
  cada clic en una casilla llama a la Cloud Function `toggleMyShift`, que
  valida en el servidor que solo puedas tocar tu propia casilla (nunca la
  de otro compañero) — necesario porque esa regla no es expresable en
  Firestore Rules para un array anidado. "Mi horario" se arma solo,
  agrupando tus propias casillas en rangos legibles.
- **`packages/admin`** — login con verificación real de rol (solo entra
  quien tiene `companions/{uid}.role === 'founder'`). Panel **Compañeros**
  conectado: la tabla se llena sola desde Firestore, y "+ Agregar
  compañero" llama a la Cloud Function `createCompanion` (crea la cuenta de
  Firebase Auth de verdad — eso no se puede hacer desde el cliente). Panel
  **Turnos**: el calendario se edita en vivo contra `shiftAssignments`, el
  leaderboard se calcula solo, y "Lanzar calendario" llama a
  `launchShiftCalendar`. Panel **Cobertura**: espejo de solo lectura del
  mismo documento + el archivo de calendarios guardados, ambos en vivo.
  **Dashboard (Negocio/Usuarios/Servicio/Capacidad)**: conectado a datos
  reales vía `computeRealPeriodData()` en `app.js` — donaciones, ingreso,
  productividad por compañero, usuarios activos/nuevos, MRR, cancelaciones
  cruzadas con el compañero, y las métricas de Servicio, todo calculado con
  consultas reales a Firestore para el rango de fechas seleccionado (semana,
  mes o rango personalizado), incluyendo la comparación contra el período
  anterior para las flechas de tendencia. Ver el bloque de comentarios al
  inicio de `computeRealPeriodData()` para las aproximaciones documentadas
  (cumplimiento de horario, retención, y el embudo de servicio dependen de
  tracking que todavía no existe — se dejan explícitamente marcadas, no
  inventadas como si fueran precisas).
- **Íconos de la extensión** generados (`icon16/48/128.png`), con el color
  ámbar de la marca — el manifest ya no apunta a archivos inexistentes.
- El build completo (`npm run build:extension`) fue probado de punta a
  punta: instala, resuelve `@limen/shared` a través de los workspaces de
  npm, y compila sin errores.

### 🚧 Lo único que queda — y es trabajo de configuración, no de código

En este punto, **todo el código está escrito y validado sintácticamente**.
Lo que falta es pegar credenciales reales y desplegar — el tipo de trabajo
que conviene hacer con Claude Code (terminal/VS Code/app de escritorio), no
en este chat, porque implica correr comandos interactivos, crear cuentas en
paneles externos, y mantener sesiones largas:

1. **Crear el proyecto real de Firebase** (console.firebase.google.com) y
   pegar sus claves en los tres `firebaseConfig.js`
   (`packages/shared`, `packages/companion-portal`, `packages/admin` — mismo
   valor en los tres).
2. **Cuenta de Stripe** — Secret Key y Webhook Signing Secret van como
   secretos de Firebase (`firebase functions:secrets:set`), nunca en un
   archivo del repo.
3. **Cliente OAuth de Google** (console.cloud.google.com, mismo proyecto)
   para que `chrome.identity` funcione — el `client_id` va en
   `packages/extension/manifest.json`.
4. **Desplegar**: `firebase deploy` (reglas, índices, functions) y
   `npm run build:extension` para cargar la extensión sin empaquetar en
   `chrome://extensions`.
5. **Crear la primera cuenta de fundadora** — el primer documento en
   `companions/{uid}` con `role: 'founder'` hay que crearlo a mano una vez
   (por consola o un script), ya que `createCompanion` requiere que ya
   exista una fundadora para poder llamarla.

### Simplificaciones conocidas (no bloqueantes, pero vale la pena saberlas)

- **Tamaño del bundle** de la extensión — `blocked.js` y `background.js`
  pesan ~800kb cada uno por incluir el SDK completo de Firebase. Vale la
  pena migrar a Firestore Lite o dividir el código antes de publicar.
- **Distribución de chats por hora** (Capacidad) se aproxima repartiendo el
  total real de chats con una curva genérica, no con datos de hora real
  todavía — requeriría agrupar `chats.startedAt` por hora del día.
- **Cumplimiento de horario y retención de usuarios** quedan como
  placeholders explícitos (no inventados) — requieren tracking adicional
  de sesiones de login y de altas/bajas mes a mes, respectivamente.

## Cómo correr cada pieza

```bash
# Extensión: compila a packages/extension/dist/
npm run build:extension
# Luego: chrome://extensions → Modo desarrollador → Cargar descomprimida → seleccionar dist/

# Admin (por ahora sirve el HTML estático tal cual)
npm run dev:admin        # http://localhost:4001

# Portal de compañeros
npm run dev:companion    # http://localhost:4002

# Emuladores de Firebase (Firestore + Functions + Auth, todo local, sin tocar producción)
npm run emulators
```

## Antes de conectar dinero real

La especificación (`docs/especificacion.md`, sección "Requisitos operativos
obligatorios") deja pendiente una revisión legal de los Términos y
Condiciones antes de cobrar con dinero real — el modelo de "no reembolsable"
ya está en el código (`DONATIONS_REFUNDABLE = false` en `constants.js`),
pero eso no reemplaza la revisión legal.
