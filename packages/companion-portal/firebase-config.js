/**
 * Misma configuración que packages/shared/src/firebaseConfig.js, pero en
 * formato ES module para poder importarla directo en el navegador sin
 * bundler (companion-portal y admin no pasan por esbuild, a diferencia de
 * la extensión). Si cambias las claves, cambia ambos archivos.
 */
export const firebaseConfig = {
  apiKey: 'TODO_REEMPLAZAR',
  authDomain: 'limen-app.firebaseapp.com',
  projectId: 'limen-app',
  storageBucket: 'limen-app.appspot.com',
  messagingSenderId: 'TODO_REEMPLAZAR',
  appId: 'TODO_REEMPLAZAR',
};

export const FIREBASE_SDK_VERSION = '10.12.2';
