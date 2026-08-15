import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithCredential,
  onAuthStateChanged,
} from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { firebaseConfig } from '@limen/shared/src/firebaseConfig';

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

let cachedUser = null;
let authReadyResolve;
const authReady = new Promise((resolve) => { authReadyResolve = resolve; });

onAuthStateChanged(auth, (user) => {
  cachedUser = user;
  authReadyResolve(user);
});

/**
 * Usa el token de Google que ya maneja Chrome (el usuario nunca ve un
 * formulario de login separado) y lo intercambia por una sesión de
 * Firebase Auth. Requiere el permiso "identity" en el manifest y un
 * oauth2.client_id configurado (Google Cloud Console → mismo proyecto que
 * Firebase).
 */
export async function ensureSignedIn() {
  if (cachedUser) return cachedUser;

  const existing = await authReady;
  if (existing) return existing;

  const token = await new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, (t) => {
      if (chrome.runtime.lastError || !t) {
        reject(chrome.runtime.lastError || new Error('No se obtuvo token de Google'));
        return;
      }
      resolve(t);
    });
  });

  const credential = GoogleAuthProvider.credential(null, token);
  const result = await signInWithCredential(auth, credential);
  return result.user;
}
