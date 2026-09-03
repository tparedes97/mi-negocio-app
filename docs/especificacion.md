# Limen — Especificación de producto (MVP)

**Bloqueo de sitios con fricción humana.** Una extensión de navegador que bloquea sitios/apps según el horario que la persona misma configura, e interpone una conversación real (no un bot) antes de permitir el desbloqueo anticipado.

---

## 1. Concepto y nombre

- **Nombre:** Limen — del latín *limen*, "umbral". Neutro en español e inglés (no se lee marcado hacia ningún idioma), corto, sin conflictos de nombre encontrados en la categoría de bloqueo/enfoque.
- **Pendiente de verificar por el fundador:** disponibilidad de dominio (limen.app / limen.co) y búsqueda de marca registrada en USPTO si se opera en EE. UU.
- **Tono de marca:** cálido, reflexivo, no punitivo. Nunca "te atrapamos", siempre "tú decides".

---

## 2. Flujo completo

1. **Onboarding** — la persona agrega los sitios que quiere bloquear. Mensaje de confidencialidad: *"Este es tu espacio, solo tuyo. Los sitios que agregues aquí son confidenciales."*
2. **Configuración de horario** — preguntas incisivas antes de guardar: *¿Por qué eliges bloquear esto en este horario?* / *¿Qué te gustaría hacer en su lugar?*
3. **Intento de desbloqueo** — dentro del horario bloqueado, 3 preguntas con frases motivadoras (fricción de baja intensidad, sin persona todavía).
4. **¿Hablar con alguien?** — si aún quiere continuar: *"¿Deseas hablar con alguien por 5 minutos?"* Se aclara explícitamente que es una persona real, no IA.
5. **Chat en vivo** — conversación de hasta 5 minutos con el operador humano (alias, nunca nombre real).
6. **Donación opcional** — después del chat: *"Ayúdanos a mantener este espacio y pagar a las personas que te acompañan."* Montos parametrizables (chips + monto libre). 100% opcional.
7. **Confirmación final** — pregunta explícita y separada de la donación: *"¿Aún quieres desbloquear [sitio]?"* Decisión consciente, no arrastrada por el paso anterior.
8. **Tarifas de desbloqueo** — si confirma que sí: tarifas por tiempo (10 min / 30 min / 1 h), **escalando con cada reincidencia del mismo sitio en el día**.
9. **Recordatorio de reincidencia** — si vuelve a intentar el mismo sitio ya desbloqueado ese día: *"Ya tomaste esta decisión hoy. Mañana es un día nuevo, puedes volver a empezar."* Sin culpa, tono de autocompasión.
10. **Logros** — hitos que se desbloquean con el uso (racha de 7/30/100 días, meses sin gasto, etc.), con mensajes de auto-reconocimiento ("date el crédito", nunca "te premiamos").
11. **Estadísticas** — racha actual, tiempo respetado, desbloqueos del mes, gasto total. Incluye nota de alcance: los datos son **por navegador**, no hay cuenta central en el MVP.

### Decisiones ya tomadas
- El chat de 5 minutos es **una vez por sitio** (no una vez al día en total).
- Las tarifas **escalan con la reincidencia** del mismo sitio, y la escalada **se reinicia semanalmente**.
- Fuera del horario disponible del operador: el fundador buscará una segunda persona que cubra otros horarios (pendiente de definir el mecanismo exacto de turnos/disponibilidad).
- El alias del operador **es aleatorio en cada chat** (no siempre "Ana") — evita que el usuario asocie un nombre fijo a una persona identificable a lo largo del tiempo.

---

## 3. El operador humano (fase 1: el fundador + una segunda persona por conseguir)

- **Nunca IA.** El chat lo atiende una persona real desde el día uno.
- **Cobertura de horario:** el chat **siempre se ofrece**, sin excepción — es parte de la promesa central del producto. El fundador está reclutando a una segunda persona para cubrir los horarios en que él no está disponible, de forma que siempre haya alguien real atendiendo.
- **Escalamiento futuro, no requisito de día uno:** contratar trabajador social calificado para *cada* chat encarece demasiado el MVP. Alternativa recomendada:
  - El fundador (y la segunda persona) atienden la mayoría de conversaciones (fricción simple de decisión).
  - Se define un **protocolo de derivación** (diseñado con apoyo puntual de un profesional, por horas, no en plantilla) para casos que muestren señales de angustia real, dependencia emocional o riesgo.
  - Esto queda para una siguiente fase de trabajo, ya acordado con el fundador.
- **Mensaje fijo en todo chat:** desde el primer mensaje, se aclara que quien atiende es una *persona de compañía/acompañamiento*, no un profesional de salud mental, y que **siempre es mejor acudir a un especialista** si lo que la persona necesita va más allá de una decisión puntual. Este mensaje aparece siempre, no solo en casos de alerta.

### Duración y cierre del chat (regla técnica, no a discreción del acompañante)
- **Duración base:** 5 minutos, sin opción de extenderla.
- **Aviso de cierre próximo:** el sistema avisa dentro del chat que el tiempo está por terminar, antes de que se corte.
- **Cierre:** al llegar al límite de los 5 minutos, hay exactamente **1 minuto adicional** solo para despedirse — el compañero lo pide con el botón "Pedir 1 min. para despedirme"; si no lo pide, el sistema lo activa solo.
- **Corte automático, sin excepción:** pasado ese minuto, el chat se cierra por diseño técnico, no por decisión del acompañante en el momento. Esto es intencional — es fácil sensibilizarse con una persona y alargar la conversación más de lo que el modelo puede sostener operativamente. El límite protege tanto al acompañante (carga emocional, tiempo) como la consistencia del servicio.

### Mensaje de cierre personalizado
- Al terminar cada chat, el acompañante puede dejar un **mensaje opcional de texto libre** que aparece en la pantalla del usuario justo después de que el chat se cierra.
- Puede ser un mensaje de aliento, o una indicación de seguridad si la conversación lo ameritó (ej. "si estás en peligro, llama a la policía o a una línea de emergencia").
- No es obligatorio — el acompañante decide caso a caso si lo deja o no.

### Protección de identidad del operador
- **Alias aleatorio por conversación** — un pool de nombres rotativos (ej. Ana, Lucía, Mateo, Sofía...), nunca el nombre real del fundador ni de quien atienda. Ningún alias queda fijo/asociado a una persona específica de forma reconocible.
- Plataforma de chat propia (no WhatsApp ni redes personales); si se usa un proveedor (Intercom, Crisp, Firebase custom), conectarse siempre desde un usuario/admin separado de la identidad personal.
- Sin número de teléfono ni redes sociales personales expuestas en ningún punto del flujo.
- Privacidad WHOIS activada en el registro del dominio.
- Revisar el descriptor de facturación en Stripe/procesador de pago para que no exponga el nombre legal del fundador en el estado de cuenta del usuario.
- Límite de rol explícito en el guion de conversación: acompañar la decisión del momento, no dar consejo clínico. Aviso en términos de servicio: es un servicio de bienestar digital, no terapia.

---

## 4. Modelo de monetización

### Suscripción (ingreso principal, obligatorio)
- **$3 USD/mes** — acceso a la extensión (bloqueo + chat de acompañamiento).
- **$6 USD/mes** — incluye además acceso a estadísticas y logros.
- **Precio bajo intencional**, confirmado por el fundador — la accesibilidad es parte de la estrategia, no un descuido. *(Considerar más adelante ajuste por región/poder adquisitivo, pero manteniendo el espíritu de precio accesible.)*

### Pago al equipo de acompañantes
- **Sueldo fijo mensual de S/ 400** por compañero, por 4 horas diarias — no es pago por hora variable, es un monto fijo acordado.
- El fundador no se paga a sí mismo un sueldo dentro de este modelo.
- **Punto de equilibrio por compañero** (con tipo de cambio ~S/ 3.37 por USD, solo con ingreso de suscripción, sin contar tarifas ni donaciones que son variables):
  - Si todos los suscriptores están en el plan de $3: ~40 usuarios.
  - Si todos están en el plan de $6: ~20 usuarios.
  - Con una mezcla realista (58% plan básico / 42% premium): ~28 usuarios.
  - Esto cubre solo el sueldo — no incluye comisión de Stripe, hosting, ni otros costos.
- **Capacidad física vs. capacidad financiera:** con el supuesto de 8 chats/hora por persona, 4 horas diarias equivalen a ~32 chats/día de capacidad, suficiente para sostener varios cientos de usuarios activos — muy por encima del punto de equilibrio financiero (28-40 usuarios). Es decir, **el dinero es la restricción inicial, no el tiempo del equipo** — solo con cientos de usuarios activos la capacidad de atención se vuelve el cuello de botella.

### Tarifas de desbloqueo y donaciones (ingreso variable)
- **Donación opcional** post-chat, montos parametrizables, nunca obligatoria.
- **Tarifa de desbloqueo**, escalonada por reincidencia del mismo sitio, **reinicio semanal**.

### Destino del fondo (tarifas + donaciones)
**Regla definida:** el dinero de las tarifas de desbloqueo y las donaciones **no es reembolsable bajo ninguna circunstancia**. Se queda con el fundador desde el momento del cobro, sin condición de racha ni devolución posterior.

Esto simplifica bastante el riesgo legal frente al esquema condicional que se había planteado antes: es equivalente a cualquier tarifa de servicio pagada por adelantado (como pagar por tiempo extra o una función premium), no una retención condicional de fondos de terceros. Aun así, sigue aplicando lo siguiente:
- Debe quedar **explícito y aceptado en los Términos y Condiciones antes del primer pago**: "las tarifas de desbloqueo y las donaciones no son reembolsables."
- El dinero es **ingreso gravable** desde el momento del cobro — se declara como tal, sin ambigüedad de "fondo pendiente".
- Recomendado igual una revisión rápida de los Términos y Condiciones por un abogado antes de lanzar con pagos reales, aunque el riesgo ya es bastante menor que el esquema anterior.

### Requisitos operativos obligatorios (control de pagos)
- **Aceptación explícita de Términos y Condiciones** en el onboarding, antes de cualquier cobro — debe incluir con total claridad la regla del fondo, la política de reembolso (o su ausencia), y el manejo de tipo de cambio.
- **Tipo de cambio:** los precios se fijan en USD; especificar en el onboarding y en cada cobro que el monto en la moneda local puede variar según el tipo de cambio del procesador de pago al momento de la transacción.
- **Comprobantes por correo:** cada cobro (suscripción, tarifa de desbloqueo, donación) debe generar un correo de confirmación/recibo automático — esto es tanto buena práctica de control financiero como respaldo ante cualquier reclamo.
- **Registro contable interno:** llevar un libro separado de (a) ingresos por suscripción, (b) tarifas de desbloqueo cobradas, (c) donaciones, (d) fondo pendiente de devolución vs. fondo ya consolidado como ingreso — para evitar mezclar dinero que aún podría deberse a un usuario con ingreso ya definitivo del fundador.

### Procesamiento de pagos
- Stripe Checkout en pestaña externa — no se puede cobrar dentro de la extensión por las políticas de Chrome Web Store.
- Stripe permite fijar el descriptor de facturación (nombre que ve el usuario en su estado de cuenta) — usar el nombre de la marca (Limen), no el nombre legal personal del fundador.

---

## 5. Diseño

### Paleta (tokens)
| Token | Valor | Uso |
|---|---|---|
| `--page-bg` | `#F6EFE2` | Fondo general, lino cálido |
| `--surface` | `#FFFCF5` | Tarjetas, superficies |
| `--sage` | `#6E8768` | Confirmación, calma, compromiso |
| `--amber` | `#BE7A42` | Decisión, tarifas, tensión suave |
| `--text` | `#3B2E22` | Texto principal |
| `--line` | `#E6D9C0` | Bordes suaves |

### Tipografía
- Display: **Source Serif 4** — cálida, tipo "diario personal".
- Cuerpo: **Inter**.
- Utilitario/datos: **IBM Plex Mono**.

### Elemento de firma: "el horizonte"
En vez de un contador digital tipo cronómetro, el tiempo restante de bloqueo se muestra como un degradado de amanecer/atardecer con un sol que se posiciona según el tiempo transcurrido — conecta directamente con el significado de "Limen" (el momento entre el impulso y la decisión) y evita la sensación de urgencia/ansiedad de un countdown técnico.

### Prototipo
Archivo interactivo con las 11 pantallas en vista móvil (marco de teléfono) y vista de escritorio (dashboard con sidebar: Inicio / Bloqueos / Estadísticas), incluyendo simulación del modal de intento de desbloqueo → chat.

---

## 6. Stack técnico recomendado (MVP)

- **Extensión:** Chrome Extension Manifest V3 (HTML/CSS/JS), bloqueo de sitios vía `declarativeNetRequest` o `webRequest`.
- **Backend / chat en tiempo real:** Firebase (Firestore + Auth) o Supabase — ambos permiten chat simple y almacenamiento de estadísticas por usuario/navegador sin infraestructura propia.
- **Pagos:** Stripe Checkout (redirección a pestaña externa).
- **Dominio y privacidad WHOIS:** cualquier registrador con privacidad incluida (Namecheap, Cloudflare Registrar).

---

## 6.5 Panel de administrador (solo fundador)

Herramienta interna, separada de la extensión, para gestionar al equipo de acompañantes:

- **Dashboard (pantalla principal), con cinco subpestañas:**
  - **Negocio:** donaciones recibidas, ingreso total (clickeable — despliega el desglose entre suscripciones/tarifas/donaciones), compañero que más donaciones genera, margen operativo (ingreso − nómina real en soles), gráfico de donaciones por compañero, y tabla de productividad ordenable con **filas expandibles**.
  - **Usuarios:** usuarios activos, usuarios nuevos, retención de suscripción, MRR, distribución de suscriptores por plan, sitios más bloqueados, y cancelaciones cruzadas con quién atendió a esa persona por última vez.
  - **Servicio:** efectividad del acompañamiento, reincidencia, chats atendidos, abandono de cola, y embudo de conversión.
  - **Capacidad:** capacidad semanal del equipo, utilización, hora pico de chats, tiempo estimado hasta saturación, alerta de crecimiento cruzada con la cobertura real de Turnos, y huecos de horario sin cubrir.
  - **Actividad:** conexión y cumplimiento por compañero, tiempos de espera compilados, y chats recientes con transcripción.
  - **Filtro por compañero** y **filtro de periodo** (semana / mes / rango personalizado con fechas propias) que recalculan las cinco subpestañas.
- **Gestión de compañeros:** agregar, editar, activar/desactivar personas. Cada una tiene nombre real y correo (privados, visibles solo para el administrador), uno o más alias asignados del pool rotativo, y horario disponible por día.
- **Vista de cobertura:** refleja en tiempo real el mismo calendario que se edita en "Turnos" (de solo lectura aquí), con alerta calculada de verdad sobre cuántas casillas están sin cubrir — crítico porque el chat **siempre debe ofrecerse**, sin excepción.
- **Archivo de calendarios lanzados:** cada vez que se publica un calendario desde "Turnos", queda guardada una copia exacta (foto) en Cobertura, con fecha de publicación, para poder consultar programaciones de meses anteriores.
- **Programaciones mensuales:** el horario de cada compañero se define mes a mes, no es un horario fijo recurrente indefinido — se vuelve a asignar cada mes.
- **Calendario de turnos por hora ("Turnos"):** vista detallada de 24 horas × 7 días donde el admin puede lanzar/publicar el calendario del mes y asignar manualmente cada casilla (clic para ciclar entre compañeros). Incluye un ranking de quién toma más turnos (horas asignadas en el mes). Este mismo calendario es visible para los compañeros desde su portal, donde pueden **inscribirse ellos mismos** en las casillas abiertas o cancelar las suyas — las de otros compañeros no son editables por ellos.
- **Vista de actividad (seguimiento):**
  - Tabla resumen por compañero: última conexión, chats atendidos en el mes, horas conectado en la semana, y porcentaje de cumplimiento del horario asignado.
  - Grilla de cumplimiento semanal por persona (mismo formato visual que la vista de cobertura): verde si se conectó dentro de su bloque asignado, rojo si no.
  - Lista de chats atendidos recientes con fecha, sitio, duración y alias usado.
  - **Revisión de conversaciones:** cada chat se puede abrir en modo lectura para ver la transcripción completa — control de calidad y supervisión del acompañamiento.
  - **Nota de privacidad a incluir en Términos y Condiciones:** si las conversaciones se guardan y son revisables por el administrador, esto debe estar informado con claridad tanto al usuario final como al compañero antes de que empiecen a chatear — no puede ser un hecho oculto, aunque el propósito sea legítimo (calidad, seguridad, protección ante reclamos).
- **Acceso:** solo el fundador (admin) debe poder entrar a este panel — requiere autenticación separada de la de los usuarios finales, nunca comparte sesión con la extensión.
- **Prototipo:** archivo interactivo aparte (`limen-admin-prototipo.html`), con el mismo sistema de diseño que el resto del producto.

---

## 6.6 Portal de trabajo (para acompañantes)

Interfaz donde el fundador y cada compañero atienden los chats en vivo:

- **Cola de chats:** lista de personas esperando hablar, con el sitio que intentan desbloquear y tiempo de espera. El compañero elige a quién atender.
- **Visibilidad del tiempo de espera, por rol:** el usuario final **nunca ve cuánto lleva esperando** — en su pantalla solo hay un indicador genérico de "buscando a alguien disponible", sin número. El compañero sí ve el tiempo real en su cola. La dueña lo ve compilado en el panel de Actividad (espera promedio del día, de 7 días, y la espera más larga registrada) como métrica de desempeño del equipo, no como dato expuesto al usuario.
- **Chat en vivo:** muestra el alias asignado para esa conversación específica (rotativo, no fijo), el temporizador de 5 minutos con barra visual que cambia de color cuando queda poco tiempo.
- **El cronómetro no inicia al atender, sino cuando la persona responde.** Al tomar un chat de la cola, entra en estado "esperando" sin tiempo corriendo — el compañero puede escribir su mensaje inicial, pero el conteo de 5 minutos solo empieza cuando la persona contesta. Esto evita penalizar el tiempo que la persona tarda en responder.
- **Sin límite de chats simultáneos, para nadie.** Cada compañero (incluida la fundadora) atiende tantos chats a la vez como pueda manejar — no hay un tope artificial por rol. Mientras un chat está en estado "esperando" respuesta, el compañero puede atender otro en paralelo — así no queda bloqueado sin poder trabajar mientras alguien tarda en escribir.
- **Cierre — el compañero no finaliza el chat directamente.** Su única acción posible es "pedir 1 minuto para despedirse", lo cual activa la fase de cierre. Si no la pide, **el sistema la activa solo** en cuanto se acaba el tiempo. Una vez en esa fase, ya no se puede extender ni volver atrás: a los 60 segundos el chat se cierra automáticamente, sin intervención humana. Esto mantiene el corte como una regla técnica dura, consistente con la razón original (evitar que el acompañante alargue la conversación por sensibilizarse con la persona).
- **Mensaje de cierre:** durante ese minuto de despedida, el compañero puede escribir un mensaje opcional (con sugerencias rápidas prearmadas: aliento / aviso de seguridad) que se envía junto con el cierre automático.
- **Disponibilidad:** toggle para marcarse como disponible/no disponible sin cerrar sesión.
- **Horario:** vista de solo lectura del horario asignado — la edición la controla exclusivamente el admin.
- **Acceso:** login con usuario y contraseña **otorgados desde el panel de administrador**, no hay autorregistro. Al agregar un compañero, el panel genera un usuario sugerido (a partir del nombre) y permite generar una contraseña temporal aleatoria, visible una sola vez para que el admin la copie y la comparta por un canal seguro. Recomendado para producción: forzar cambio de contraseña en el primer inicio de sesión del compañero.
- **Prototipo:** archivo interactivo aparte (`limen-companion-portal.html`).

---

## 7. Roadmap de escalabilidad

- **MVP actual:** extensión de Chrome, un solo operador (el fundador), estadísticas por navegador.
- **Validación:** 20–50 usuarios reales, medir si pagan y si valoran el chat.
- **App móvil (fase 2, no antes):**
  - iOS: **Screen Time API / Family Controls** (nativo, Swift/SwiftUI) — es la única forma oficial de bloquear apps a nivel de sistema.
  - Android: **Accessibility Services / UsageStatsManager** — más permisivo pero cada vez más restringido por Google.
  - Recomendado: **React Native o Flutter** para una sola base de código, integrando el SDK nativo de cada plataforma solo para la parte de bloqueo. Toda la lógica de backend (chat, pagos, logros, estadísticas) se reutiliza tal cual.

---

## 8. Preguntas abiertas (a resolver por el fundador)

- [x] ¿Qué pasa si alguien intenta desbloquear fuera del horario disponible del operador? → Se resuelve consiguiendo una segunda persona; falta definir qué pasa mientras tanto (fallback).
- [x] ¿Cada cuánto se reinicia la escalada de tarifas por reincidencia? → Semanal.
- [x] ¿El fondo de tarifas/donaciones se devuelve al usuario o es no recuperable? → **No reembolsable**, se queda con el fundador desde el cobro. Se mantiene la recomendación de revisar los T&C con un abogado antes de lanzar, aunque el riesgo bajó bastante con esta simplificación.
- [ ] ¿En qué momento se define el protocolo de derivación a ayuda profesional, y quién lo redacta? → Aún sin definir; mientras tanto, el mensaje fijo de "esto es acompañamiento, no terapia" ya queda incorporado en todo chat (sección 3).
- [ ] **Nuevo:** ¿Quién revisará legalmente la regla del fondo y los Términos y Condiciones antes del lanzamiento con pagos reales?
- [x] ¿Qué pasa con la disponibilidad de chat mientras se consigue a la segunda persona? → **El chat siempre se ofrece**, sin excepción. Implica que la cobertura de horarios (encontrar a esa segunda persona, y probablemente más adelante un equipo con turnos) es urgente y crítica para el lanzamiento — no es opcional ni un "nice to have".
