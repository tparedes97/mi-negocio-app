import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

/**
 * Empaqueta dist/ para subir al Chrome Web Store. El manifest de dist/
 * conserva el campo "key" a propósito (pin de ID estable para pruebas
 * locales con "Cargar descomprimida", necesario para que el client_id de
 * OAuth funcione siempre con el mismo ID de extensión) — pero el Web
 * Store rechaza cualquier paquete que traiga ese campo ("No se admite el
 * campo key"), así que este script arma una copia sin él antes de zipear.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const stagingDir = path.join(root, 'store-package');
const zipPath = path.join(root, 'limen-extension.zip');

if (!existsSync(dist)) {
  console.error('[package-store] no existe dist/ — corre "npm run build" primero.');
  process.exit(1);
}

rmSync(stagingDir, { recursive: true, force: true });
mkdirSync(stagingDir, { recursive: true });
cpSync(dist, stagingDir, { recursive: true });
rmSync(path.join(stagingDir, 'background.js.map'), { force: true });
rmSync(path.join(stagingDir, 'blocked.js.map'), { force: true });
rmSync(path.join(stagingDir, 'popup.js.map'), { force: true });

const manifestPath = path.join(stagingDir, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
delete manifest.key;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

rmSync(zipPath, { force: true });
execSync(`cd "${stagingDir}" && zip -r "${zipPath}" . -x ".*"`, { stdio: 'inherit' });
rmSync(stagingDir, { recursive: true, force: true });

console.log(`[package-store] listo: ${zipPath}`);
