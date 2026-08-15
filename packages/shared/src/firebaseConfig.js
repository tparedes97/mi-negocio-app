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
  apiKey: 'AIzaSyAsaEjpkZRdL9SPQHtcYv3LRAAO6FQzXzU',
  authDomain: 'limen-3b8cf.firebaseapp.com',
  projectId: 'limen-3b8cf',
  storageBucket: 'limen-3b8cf.firebasestorage.app',
  messagingSenderId: '886284444237',
  appId: '1:886284444237:web:d1e6b811299e25f102f204',
};

module.exports = { firebaseConfig };
