/**
 * Misma configuración que packages/shared/src/firebaseConfig.js — esta
 * página solo necesita Cloud Functions (getCheckoutInfo, confirmCulqiCharge),
 * no Auth ni Firestore directo. Si cambias las claves, cambia los cuatro
 * archivos (shared, admin, companion-portal, checkout).
 */
export const firebaseConfig = {
  apiKey: 'AIzaSyAsaEjpkZRdL9SPQHtcYv3LRAAO6FQzXzU',
  authDomain: 'limen-3b8cf.firebaseapp.com',
  projectId: 'limen-3b8cf',
  storageBucket: 'limen-3b8cf.firebasestorage.app',
  messagingSenderId: '886284444237',
  appId: '1:886284444237:web:d1e6b811299e25f102f204',
};
