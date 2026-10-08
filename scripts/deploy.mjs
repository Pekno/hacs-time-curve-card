// Copies dist/time-curve-card.js to $HA_WWW_PATH (e.g. a Samba share such as
// //homeassistant.local/config/www, or the host's IP address instead of homeassistant.local).
// The path is env-driven on purpose: nothing is hardcoded.
// A `.env` file at the repo root (HA_WWW_PATH=...) is honoured for convenience.
import { copyFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const envFile = join(root, '.env');
if (existsSync(envFile)) {
  for (const raw of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i.exec(raw);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const target = process.env.HA_WWW_PATH;
if (!target) {
  console.error(
    'HA_WWW_PATH is not set. Example: HA_WWW_PATH=//homeassistant.local/config/www (UNC with forward slashes works on Windows; the host name or IP address of your Home Assistant) or a mapped drive like Z:/www',
  );
  process.exit(1);
}
const src = join(root, 'dist', 'time-curve-card.js');
if (!existsSync(src)) {
  console.error(`Missing ${src}. Run "npm run build" first.`);
  process.exit(1);
}
const dest = join(target, 'time-curve-card.js');
copyFileSync(src, dest);
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
console.log(`Copied ${statSync(src).size} bytes to ${dest}`);
console.log(`Reminder: bump the Lovelace resource to /local/time-curve-card.js?v=${version}`);
