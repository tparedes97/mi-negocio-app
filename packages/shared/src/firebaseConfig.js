/**
 * Configuración del proyecto de Firebase.
 *
 * ⚠️ Reemplazar con las claves reales del proyecto antes de compilar para
 * producción — estas son placeholders. La API key de Firebase NO es un
 * secreto (está diseñada para ir en el cliente; la seguridad real la dan
 * las Firestore Rules), así que es seguro que viva en este archivo dentro
 * del repo. Lo que nunca va aquí es STRIPE_SECRET_KEY ni credenciales de
 * servicio — esas viven en Secret Manager (ver firebase/functions).
 */
const firebaseConfig = {
  apiKey: 'TODO_REEMPLAZAR',
  authDomain: 'limen-app.firebaseapp.com',
  projectId: 'limen-app',
  storageBucket: 'limen-app.appspot.com',
  messagingSenderId: 'TODO_REEMPLAZAR',
  appId: 'TODO_REEMPLAZAR',
};

module.exports = { firebaseConfig };
