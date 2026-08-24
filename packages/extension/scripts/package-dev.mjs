import { existsSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

/**
 * Empaqueta dist/ TAL CUAL (con el campo "key" del manifest) para pruebas
 * locales — a diferencia de package-store.mjs, que lo quita porque el Web
 * Store lo rechaza. "key" fija el ID de la extensión aunque se cargue sin
 * empaquetar ("Cargar descomprimida"); ese ID es justo el que está
 * autorizado en el cliente OAuth de Google Cloud, así que sin él
 * chrome.identity.getAuthToken() falla en silencio (la pantalla de
 * bloqueo se queda pegada en "Cargando…" para siempre). Este ZIP es el
 * que hay que usar para probar el inicio de sesión con Google en local —
 * el de package:store NUNCA sirve para eso, solo para subir a la tienda.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const zipPath = path.join(root, 'limen-extension-dev.zip');

if (!existsSync(dist)) {
  console.error('[package-dev] no existe dist/ — corre "npm run build" primero.');
  process.exit(1);
}

execSync(`rm -f "${zipPath}"`, { stdio: 'inherit' });
execSync(`cd "${dist}" && zip -r "${zipPath}" . -x ".*" -x "*.map"`, { stdio: 'inherit' });

console.log(`[package-dev] listo: ${zipPath}`);
