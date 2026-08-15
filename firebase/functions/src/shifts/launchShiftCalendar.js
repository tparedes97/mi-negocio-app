const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const MONTH_NAMES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];

/**
 * "Lanzar calendario" en el admin: marca la programación del mes como
 * publicada (visible para los compañeros, quienes ya pueden inscribirse en
 * casillas abiertas) y guarda una copia inmutable en shiftArchive — esto es
 * lo que alimenta la sección "Calendarios guardados" de Cobertura.
 */
exports.launchShiftCalendar = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Debes iniciar sesión.');

  const db = getFirestore();
  const companionSnap = await db.collection('companions').doc(uid).get();
  if (!companionSnap.exists || companionSnap.data().role !== 'founder') {
    throw new HttpsError('permission-denied', 'Solo la fundadora puede lanzar el calendario.');
  }

  const { yearMonth } = request.data; // ej. "2026-08"
  const assignmentRef = db.collection('shiftAssignments').doc(yearMonth);
  const assignmentSnap = await assignmentRef.get();
  if (!assignmentSnap.exists) {
    throw new HttpsError('not-found', 'No hay programación para ese mes todavía.');
  }
  const grid = assignmentSnap.data().grid;

  const existingVersions = await db.collection('shiftArchive')
    .where('yearMonth', '==', yearMonth).get();
  const [year, month] = yearMonth.split('-').map(Number);
  const label = `${MONTH_NAMES[month - 1]} ${year} — v${existingVersions.size + 1}`;

  const archiveRef = db.collection('shiftArchive').doc();
  await archiveRef.set({
    yearMonth,
    label,
    savedAt: FieldValue.serverTimestamp(),
    grid,
  });

  await assignmentRef.update({
    launchedAt: FieldValue.serverTimestamp(),
    launchedBy: uid,
  });

  return { ok: true, archiveId: archiveRef.id };
});
