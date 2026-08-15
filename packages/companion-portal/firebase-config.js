/**
 * Misma configuración que packages/shared/src/firebaseConfig.js, pero en
 * formato ES module para poder importarla directo en el navegador sin
 * bundler (companion-portal y admin no pasan por esbuild, a diferencia de
 * la extensión). Si cambias las claves, cambia ambos archivos.
 */
export const firebaseConfig = {
  apiKey: 'AIzaSyAsaEjpkZRdL9SPQHtcYv3LRAAO6FQzXzU',
  authDomain: 'limen-3b8cf.firebaseapp.com',
  projectId: 'limen-3b8cf',
  storageBucket: 'limen-3b8cf.firebasestorage.app',
  messagingSenderId: '886284444237',
  appId: '1:886284444237:web:d1e6b811299e25f102f204',
};

export const FIREBASE_SDK_VERSION = '10.12.2';
