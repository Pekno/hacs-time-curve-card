// Screenshots the dev harness (dev/index.html) with a headless Chromium browser (Edge on Windows).
// Starts a Vite dev server on --port, captures one PNG per shot, then stops the server.
//
//   node scripts/screenshot.mjs --port 5211 --out shots --set default
//   node scripts/screenshot.mjs --port 5211 --out shots --query "theme=dark&narrow=1&now=03:00" --name night
//
// --set default = light/dark x 520px/360px at now=21:30. --query/--name may be repeated (pairs).
// Browser lookup order: $BCC_BROWSER, Edge (x86/x64 paths), Chrome (x64/x86/user paths).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
  const out = {
    port: 5211,
    out: 'shots',
    set: null,
    shots: [],
    width: 560,
    height: 720,
    budget: 4000,
  };
  const queries = [];
  const names = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--port') out.port = Number(next());
    else if (a === '--out') out.out = next();
    else if (a === '--set') out.set = next();
    else if (a === '--query') queries.push(next());
    else if (a === '--name') names.push(next());
    else if (a === '--width') out.width = Number(next());
    else if (a === '--height') out.height = Number(next());
    else if (a === '--budget') out.budget = Number(next());
    else throw new Error(`unknown argument ${a}`);
  }
  queries.forEach((q, i) => out.shots.push({ name: names[i] ?? `shot-${i + 1}`, query: q }));
  if (out.set === 'default') {
    out.shots.unshift(
      { name: 'light-520', query: 'now=21:30' },
      { name: 'dark-520', query: 'theme=dark&now=21:30' },
      { name: 'light-360', query: 'narrow=1&now=21:30' },
      { name: 'dark-360', query: 'theme=dark&narrow=1&now=21:30' },
    );
  }
  if (out.shots.length === 0)
    throw new Error('nothing to capture: pass --set default and/or --query');
  return out;
}

function findBrowser() {
  const candidates = [
    process.env.BCC_BROWSER,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA &&
      join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found)
    throw new Error(
      `no Chromium-based browser found; set BCC_BROWSER. Tried:\n${candidates.join('\n')}`,
    );
  return found;
}

function startVite(port) {
  const child = spawn(
    process.execPath,
    [
      join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  return { child, log: () => log };
}

async function waitForServer(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Vite did not answer on ${url} within ${timeoutMs} ms`);
}

function stopProcess(child) {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

function capture(browser, url, file, { width, height, budget }) {
  return new Promise((resolvePromise, reject) => {
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      `--window-size=${width},${height}`,
      `--virtual-time-budget=${budget}`,
      `--screenshot=${file}`,
      url,
    ];
    const child = spawn(browser, args, { stdio: 'ignore' });
    const timer = setTimeout(() => {
      stopProcess(child);
      reject(new Error(`browser timed out capturing ${url}`));
    }, 30000);
    child.on('exit', () => {
      clearTimeout(timer);
      if (existsSync(file)) resolvePromise();
      else reject(new Error(`browser exited without writing ${file}`));
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const browser = findBrowser();
  const outDir = resolve(root, opts.out);
  mkdirSync(outDir, { recursive: true });
  const base = `http://127.0.0.1:${opts.port}/`;
  const vite = startVite(opts.port);
  try {
    await waitForServer(base);
    for (const shot of opts.shots) {
      const file = join(outDir, `${shot.name}.png`);
      const url = shot.query ? `${base}?${shot.query}` : base;
      await capture(browser, url, file, opts);
      console.log(`${shot.name}: ${file}  (${url})`);
    }
  } catch (e) {
    console.error(String(e));
    console.error('--- vite log ---\n' + vite.log());
    process.exitCode = 1;
  } finally {
    stopProcess(vite.child);
  }
}

await main();
