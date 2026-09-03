const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

/**
 * Crear la cuenta de un compañero requiere el SDK de administrador —
 * no es algo que el cliente pueda hacer por su cuenta (no existe
 * "createUserForSomeoneElse" en el SDK normal de Firebase Auth). Por eso
 * esto vive acá, protegido para que solo la fundadora pueda llamarlo.
 */
exports.createCompanion = onCall({ invoker: 'public' }, async (request) => {
  const callerUid = request.auth?.uid;
  if (!callerUid) throw new HttpsError('unauthenticated', 'Debes iniciar sesión.');

  const db = getFirestore();
  const callerDoc = await db.collection('companions').doc(callerUid).get();
  if (!callerDoc.exists || callerDoc.data().role !== 'founder') {
    throw new HttpsError('permission-denied', 'Solo la fundadora puede agregar compañeros.');
  }

  const { fullName, email, password, assignedAliases } = request.data;
  if (!fullName || !email || !password) {
    throw new HttpsError('invalid-argument', 'Falta nombre, correo o contraseña.');
  }
  if (password.length < 8) {
    throw new HttpsError('invalid-argument', 'La contraseña debe tener al menos 8 caracteres.');
  }

  const auth = getAuth();
  const userRecord = await auth.createUser({ email, password, displayName: fullName });

  await db.collection('companions').doc(userRecord.uid).set({
    uid: userRecord.uid,
    fullName,       // PRIVADO — nunca exponer al usuario final (ver types.ts)
    email,
    role: 'staff',
    active: true,
    assignedAliases: assignedAliases || [],
    createdAt: FieldValue.serverTimestamp(),
  });

  return { ok: true, uid: userRecord.uid };
});
