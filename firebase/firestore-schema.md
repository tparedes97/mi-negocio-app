# Esquema de Firestore — Limen

Colecciones de nivel raíz. Los tipos exactos de cada documento están en
`packages/shared/src/types.ts` — este archivo es solo el mapa de colecciones
y quién puede leer/escribir qué (ver `firestore.rules` para la aplicación real).

```
users/{uid}                          → UserDoc
  blockedSites/{siteId}               → BlockedSiteDoc (subcolección)
  unlockAttempts/{attemptId}          → UnlockAttemptDoc (subcolección)

chats/{chatId}                        → ChatSessionDoc
  messages/{messageId}                → ChatMessageDoc (subcolección)

companions/{uid}                      → CompanionDoc  (privado, solo admin + el propio compañero)

shiftAssignments/{yearMonth}          → ShiftAssignmentDoc   ej. "2026-08"
shiftArchive/{archiveId}              → ShiftArchiveDoc      (snapshots inmutables, "Cobertura")

donations/{donationId}                → DonationDoc
cancellations/{cancellationId}        → CancellationDoc
activeUnlocks/{userId_domain}         → ActiveUnlockDoc  (solo la escribe paddleWebhook)
```

## Notas de diseño importantes

- **`unlockAttempts.waitSeconds`**: se calcula y guarda, pero la extensión del
  usuario NUNCA lo lee ni lo muestra — es exclusivamente para el portal de
  compañeros (tiempo real) y el admin (compilado). Aplicar esto también en
  las reglas de seguridad, no solo en la UI.

- **`chats.timerStartedAt`**: se queda en `null` hasta que llega el primer
  mensaje del usuario. El cronómetro de 5 minutos se calcula siempre como
  `now - timerStartedAt`, nunca `now - startedAt`.

- **`companions.fullName`**: nunca debe ser legible por un usuario final ni
  aparecer en ningún documento de `chats/*` — el chat solo guarda `aliasUsed`.

- **`shiftAssignments`** es el documento *editable* del mes en curso.
  **`shiftArchive`** son fotos de solo lectura que se crean (nunca se editan)
  cada vez que se presiona "Lanzar calendario" en el admin.

- **`activeUnlocks`**: el service worker de la extensión NUNCA decide por su
  cuenta que un pago fue exitoso — solo lee esta colección, que exclusivamente
  escribe `paddleWebhook` tras verificar la firma del evento `transaction.completed` de Paddle.
  Esto evita que alguien manipule el cliente (ej. editando `chrome.storage`
  a mano) para desbloquearse sin pagar.

- **`shiftAssignments` — quién puede tocar qué casilla**: las Firestore
  Rules solo dejan escribir a la fundadora (`allow write: if isFounder()`).
  Un compañero normal nunca escribe el documento directo — pasa siempre por
  la Cloud Function `toggleMyShift`, que valida en el servidor que la
  casilla esté abierta o le pertenezca antes de tocarla. Esto no se puede
  expresar de forma segura solo con Firestore Rules porque el grid es un
  array anidado (no hay forma de decir "solo puede cambiar el elemento
  [d][h] sin poder tocar los demás" en el lenguaje de reglas).

- **Reincidencia semanal**: `unlockAttemptDoc.weeklyRecurrenceCount` se
  calcula en una Cloud Function al crear el attempt, contando cuántos
  `unlockAttempts` de ese `userId` + `domain` existen desde el lunes de esa
  semana. No se debe calcular en el cliente (evita manipulación).
