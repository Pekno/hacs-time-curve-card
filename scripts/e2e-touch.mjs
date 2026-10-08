// End-to-end TOUCH test of the card's interactions (M3) in a real Chromium (Edge on Windows)
// driven over the Chrome DevTools Protocol with touch emulation - no Puppeteer, only the global
// WebSocket of Node >= 22.
//
// Starts Vite on --port, launches headless Edge with --remote-debugging-port=--cdp-port, emulates
// a 360x740 phone (device pixel ratio 2, one touch point), loads the dev harness
// (dev/index.html, `?now=21:30&latency=300` by default), drives it with Input.dispatchTouchEvent
// and checks what the card persisted through the mock hass (`window.__tcc`, see dev/main.ts).
// Scenarios: (a) drag, (b) add, (c) select, (d) no scroll, (e) rejected save, (f) echo timeout
// (optional, slow), (g) touches 15 px off a marker centre still hit its 44 px target, (h) the
// 8 px touch slop against small finger rolls, (i) hit targets of markers on the plot's top /
// right edge, (j) tooltip placement for a point at 100 %, (k) a drag that leaves the chart, (l) a
// long press before dragging, (m) the detail row driven by touch, (n) no keyboard focus ring
// after a touch tap. Screenshots go to --out.
// Prints PASS / FAIL per scenario, exits 1 when a scenario failed and 2 when the tooling itself
// failed (no browser, Vite down...). Always kills Edge and Vite.
//
//   node scripts/e2e-touch.mjs --port 5301 --cdp-port 9301 --out shots/e2e
//   node scripts/e2e-touch.mjs --only drag,fail        # a subset (ids from --list)
//   node scripts/e2e-touch.mjs --all                   # also the slow optional scenarios
//
// Browser lookup order: $BCC_BROWSER, Edge (x86/x64 paths), Chrome (x64/x86/user paths).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** Harness query used by every scenario unless it adds its own knobs. */
const DEFAULT_QUERY = 'now=21:30&latency=300';

/** Emulated phone. */
const DEVICE = { width: 360, height: 740, deviceScaleFactor: 2 };

/**
 * Plot margins of the card's SVG (docs/card-rendering-spec.md, section 2.4): used to find an
 * empty spot inside the plot for the "add a point" scenario.
 */
const PLOT_MARGINS = { left: 40, right: 14, top: 14, bottom: 24 };

/** Radius of the point hit targets (44 px); an "empty" spot keeps clear of it. */
const HIT_RADIUS = 22;

/** How far off a marker centre the "hit zone" scenario touches (well inside the 22 px radius). */
const OFFSET_PX = 15;

/** Unit vectors of the 8 compass directions tried for an off-centre touch. */
const OFFSET_DIRECTIONS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [Math.SQRT1_2, Math.SQRT1_2],
  [-Math.SQRT1_2, Math.SQRT1_2],
  [Math.SQRT1_2, -Math.SQRT1_2],
  [-Math.SQRT1_2, -Math.SQRT1_2],
];

/** Debounce (400 ms) + mock latency (300 ms) + margin: how long a save takes to land. */
const SAVE_WAIT_MS = 1000;

/** Card echo timeout (5 s) + SAVE_WAIT_MS + margin, for the optional `noecho` scenario. */
const ECHO_TIMEOUT_WAIT_MS = 6500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { port: 5301, cdpPort: 9301, out: 'shots/e2e', only: null, all: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${a} needs a value`);
      return value;
    };
    if (a === '--port') out.port = Number(next());
    else if (a === '--cdp-port') out.cdpPort = Number(next());
    else if (a === '--out') out.out = next();
    else if (a === '--only')
      out.only = next()
        .split(',')
        .map((s) => s.trim());
    else if (a === '--all') out.all = true;
    else if (a === '--list') out.list = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!Number.isInteger(out.port) || !Number.isInteger(out.cdpPort)) {
    throw new Error('--port and --cdp-port must be integers');
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Processes: Vite dev server and the browser (same helpers as scripts/screenshot.mjs)
// ---------------------------------------------------------------------------------------------

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
  if (!found) {
    throw new Error(
      `no Chromium-based browser found; set BCC_BROWSER. Tried:\n${candidates.join('\n')}`,
    );
  }
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
    await sleep(250);
  }
  throw new Error(`Vite did not answer on ${url} within ${timeoutMs} ms`);
}

/** Kills a child process (and its tree on Windows) and waits for it to exit. */
async function stopProcess(child, timeoutMs = 5000) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((r) => child.once('exit', r));
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    await new Promise((r) => killer.once('exit', r));
  } else {
    child.kill('SIGTERM');
  }
  await Promise.race([exited, sleep(timeoutMs)]);
}

function launchBrowser(browser, cdpPort, profileDir) {
  return spawn(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${cdpPort}`,
      '--remote-allow-origins=*',
      `--window-size=${DEVICE.width + 40},${DEVICE.height + 160}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
}

async function waitForPageTarget(cdpPort, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // not up yet
    }
    await sleep(200);
  }
  throw new Error(`no CDP page target on port ${cdpPort} within ${timeoutMs} ms`);
}

// ---------------------------------------------------------------------------------------------
// Minimal CDP client over the global WebSocket
// ---------------------------------------------------------------------------------------------

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    ws.onmessage = (ev) => {
      this.onMessage(JSON.parse(String(ev.data)));
    };
    ws.onclose = () => {
      this.closed = true;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`${p.method}: the CDP connection closed`));
      }
      this.pending.clear();
    };
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolvePromise, reject) => {
      ws.onopen = resolvePromise;
      ws.onerror = () => {
        reject(new Error(`cannot connect to ${url}`));
      };
    });
    return new Cdp(ws);
  }

  onMessage(msg) {
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result ?? {});
    } else if (msg.method) {
      for (const cb of this.listeners.get(msg.method) ?? []) cb(msg.params ?? {});
    }
  }

  send(method, params = {}, timeoutMs = 15000) {
    return new Promise((resolvePromise, reject) => {
      if (this.closed) {
        reject(new Error(`${method}: the CDP connection is closed`));
        return;
      }
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no reply within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timer, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, cb) {
    const list = this.listeners.get(method) ?? [];
    list.push(cb);
    this.listeners.set(method, list);
  }

  /** Resolves with the params of the next `method` event (rejects after `timeoutMs`). */
  once(method, timeoutMs = 20000) {
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`no ${method} event within ${timeoutMs} ms`));
      }, timeoutMs);
      const cb = (params) => {
        clearTimeout(timer);
        const list = this.listeners.get(method) ?? [];
        this.listeners.set(
          method,
          list.filter((x) => x !== cb),
        );
        resolvePromise(params);
      };
      this.on(method, cb);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}

function describeException(details) {
  const text = details.exception?.description ?? details.exception?.value ?? details.text;
  return String(text).split('\n').slice(0, 3).join(' | ');
}

// ---------------------------------------------------------------------------------------------
// Page-side helpers, installed after every load (stringified into Runtime.evaluate).
// They run in the browser: only DOM APIs and window.__tcc from dev/main.ts.
// ---------------------------------------------------------------------------------------------

function installHelpers() {
  const card = () => document.querySelector('time-curve-card');
  const root = () => card()?.shadowRoot ?? null;
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return {
      x: r.x,
      y: r.y,
      w: r.width,
      h: r.height,
      cx: r.x + r.width / 2,
      cy: r.y + r.height / 2,
    };
  };
  const tcc = () => window.__tcc;
  const curveEntity = () =>
    Object.keys(tcc().mock.hass.states).find((id) => id.startsWith('input_text.')) ?? null;
  const text = (selector) =>
    root()?.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
  const pointerLog = [];
  window.__e2e = {
    ready: () => root() !== null,
    entity: curveEntity,
    state: () => {
      const id = curveEntity();
      return id === null ? null : (tcc().mock.hass.states[id]?.state ?? null);
    },
    calls: () =>
      tcc()
        .mock.calls.filter((c) => c.domain === 'input_text' && c.service === 'set_value')
        .map((c) => ({ entity_id: String(c.data.entity_id), value: String(c.data.value) })),
    // cx/cy are viewport coordinates (what a touch needs); rx/ry are relative to the SVG, so a
    // layout shift above the chart (a status chip wrapping onto a new line) is not "movement".
    markers: () => {
      const svg = root()?.querySelector('svg');
      const origin = svg ? box(svg) : { x: 0, y: 0 };
      return Array.from(root()?.querySelectorAll('g.point') ?? []).map((g, i) => {
        const b = box(g.querySelector('.dot') ?? g);
        return {
          index: Number(g.getAttribute('data-index') ?? i),
          ...b,
          rx: b.cx - origin.x,
          ry: b.cy - origin.y,
        };
      });
    },
    svg: () => {
      const el = root()?.querySelector('svg');
      return el ? box(el) : null;
    },
    // The invisible hit circle of every point: its `r` attribute and rendered size (CSS px).
    hits: () =>
      Array.from(root()?.querySelectorAll('g.point') ?? []).map((g, i) => {
        const hit = g.querySelector('.hit');
        const b = hit ? box(hit) : { w: 0, h: 0 };
        return {
          index: Number(g.getAttribute('data-index') ?? i),
          r: Number(hit?.getAttribute('r') ?? 0),
          w: b.w,
          h: b.h,
        };
      }),
    selected: () => {
      const g = root()?.querySelector('g.point.selected');
      return g ? Number(g.getAttribute('data-index')) : null;
    },
    // What holds the focus inside the card after an interaction, and whether the browser paints
    // its keyboard focus ring for it (`:focus-visible`).
    focus: () => {
      const active = root()?.activeElement ?? null;
      if (!active) return { active: null, focusVisible: false };
      const g = active.closest('g.point');
      const index = g?.getAttribute('data-index');
      return {
        active: `${active.tagName.toLowerCase()}${index === undefined || index === null ? '' : `[data-index=${index}]`}`,
        focusVisible: active.matches(':focus-visible'),
      };
    },
    // Plan C4: the host's [pointer-focus] attribute and the painted state of the dashed keyboard
    // ring on the focused point's 44 px hit circle (computed stroke-dasharray: "none" = no ring).
    focusRing: () => {
      const host = card();
      const active = root()?.activeElement ?? null;
      const g = active?.closest?.('g.point') ?? null;
      const hit = g?.querySelector('.hit') ?? null;
      const style = hit ? getComputedStyle(hit) : null;
      return {
        pointerFocus: host?.hasAttribute('pointer-focus') ?? false,
        group: g ? Number(g.getAttribute('data-index')) : null,
        focusVisible: active ? active.matches(':focus-visible') : false,
        stroke: style?.stroke ?? null,
        dash: style?.strokeDasharray ?? null,
        ring: style !== null && style.strokeDasharray !== 'none' && style.stroke !== 'none',
      };
    },
    count: (selector) => root()?.querySelectorAll(selector).length ?? 0,
    text,
    visible: (selector) => {
      const el = root()?.querySelector(selector);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    },
    value: (selector) => {
      const el = root()?.querySelector(selector);
      return el && 'value' in el ? String(el.value) : null;
    },
    lightBox: (selector) => {
      const el = document.querySelector(selector);
      return el ? box(el) : null;
    },
    shadowBox: (selector) => {
      const el = root()?.querySelector(selector);
      return el ? box(el) : null;
    },
    scroll: () => ({
      scrollY: window.scrollY,
      mainTop: document.querySelector('main')?.getBoundingClientRect().top ?? null,
      innerHeight: window.innerHeight,
      scrollHeight: document.documentElement.scrollHeight,
      scrollable: document.documentElement.scrollHeight > window.innerHeight + 1,
    }),
    makeScrollable: () => {
      document.body.style.paddingBottom = '1200px';
      return true;
    },
    env: () => ({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      dpr: window.devicePixelRatio,
      maxTouchPoints: navigator.maxTouchPoints,
      coarse: matchMedia('(pointer: coarse)').matches,
    }),
    watchPointers: () => {
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
        document.addEventListener(
          type,
          (e) => {
            pointerLog.push(`${e.type}:${e.pointerType}`);
          },
          true,
        );
      }
      return true;
    },
    pointerLog: () => pointerLog.slice(),
    settle: () =>
      new Promise((resolvePromise) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolvePromise(true);
          });
        });
      }),
    updateComplete: () => tcc().card.updateComplete.then(() => true),
  };
  return true;
}

// ---------------------------------------------------------------------------------------------
// Curve helpers (a copy of the v2 token grammar of src/core/curve.ts, enough for assertions: the
// scenarios drive the default brightness range, 1..100)
// ---------------------------------------------------------------------------------------------

const TOKEN_RE = /^[ \t]*(\d{1,2}):(\d{2})@(-?\d{1,4}(?:\.\d{1,2})?)[ \t]*$/;
const sortKey = (time) => (((time - 720) % 1440) + 1440) % 1440;

function parseCurve(text, min = 1, max = 100) {
  const byTime = new Map();
  for (const token of String(text ?? '').split(';')) {
    const m = TOKEN_RE.exec(token);
    if (!m) continue;
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour > 23 || minute > 59) continue;
    byTime.set(hour * 60 + minute, Math.min(max, Math.max(min, Number(m[3]))));
  }
  return [...byTime]
    .map(([time, value]) => ({ time, value }))
    .sort((a, b) => sortKey(a.time) - sortKey(b.time));
}

const formatTime = (t) =>
  `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
const formatPoint = (p) => (p ? `${formatTime(p.time)}@${p.value}` : '(none)');
const round1 = (n) => Math.round(n * 10) / 10;

// ---------------------------------------------------------------------------------------------
// Scenario context: page driving primitives
// ---------------------------------------------------------------------------------------------

class CheckError extends Error {}

function check(condition, reason) {
  if (!condition) throw new CheckError(reason);
}

function makeContext({ cdp, base, outDir, notes, pageErrors }) {
  const evaluate = async (expression, { awaitPromise = false } = {}) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
    });
    if (r.exceptionDetails) {
      throw new Error(`page evaluate failed: ${describeException(r.exceptionDetails)}`);
    }
    return r.result?.value;
  };
  const helper = (call, awaitPromise = false) => evaluate(`window.__e2e.${call}`, { awaitPromise });

  const waitForHarness = async (url) => {
    const deadline = Date.now() + 20000;
    for (;;) {
      const ready = await evaluate(
        "typeof window.__tcc === 'object' && window.__tcc !== null && !!window.__tcc.card",
      ).catch(() => false);
      if (ready) return;
      if (Date.now() > deadline) throw new Error(`window.__tcc never appeared on ${url}`);
      await sleep(100);
    }
  };

  const settleCard = async () => {
    await evaluate(`(${installHelpers.toString()})()`);
    await helper('updateComplete()', true);
    await helper('settle()', true);
    await helper('updateComplete()', true);
  };

  /** Navigates the harness to `?query`, waits for window.__tcc and the rendered point markers. */
  const load = async (query) => {
    const url = `${base}?${query}`;
    notes.push(`url: ${url}`);
    // Neutralise the previous document's hook so the poll below cannot see a stale one.
    await evaluate('delete window.__tcc; delete window.__e2e; true').catch(() => false);
    const loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url });
    await loaded;
    await waitForHarness(url);
    await settleCard();
    // A Vite dependency re-optimisation reloads the page once: detect it and settle again.
    await sleep(300);
    const stillThere = await evaluate("typeof window.__e2e === 'object'").catch(() => false);
    if (!stillThere) {
      notes.push('page reloaded itself once after load (Vite dep optimizer?), settled again');
      await waitForHarness(url);
      await settleCard();
    }
    const deadline = Date.now() + 10000;
    while ((await helper("count('g.point')")) < 2) {
      if (Date.now() > deadline) {
        const invalid = await helper("text('.invalid')");
        const errorCard = await evaluate(
          "document.querySelector('.error-card')?.textContent ?? null",
        );
        throw new Error(
          `no point markers rendered within 10 s (` +
            `${invalid ? `invalid block: "${invalid}"` : errorCard ? `error card: "${errorCard}"` : 'no .invalid block, no error card'})`,
        );
      }
      await sleep(100);
    }
    return url;
  };

  const touch = (type, points) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: points.map((p, i) => ({
        x: Math.round(p.x * 100) / 100,
        y: Math.round(p.y * 100) / 100,
        radiusX: 8,
        radiusY: 8,
        force: 1,
        id: i,
      })),
    });

  const tap = async (at, holdMs = 60) => {
    await touch('touchStart', [at]);
    await sleep(holdMs);
    await touch('touchEnd', []);
    await sleep(80);
  };

  /** A tap whose finger rolls by (dx, dy) px between touchStart and touchEnd (real fingers do). */
  const roll = async (at, dx, dy) => {
    await touch('touchStart', [at]);
    await sleep(50);
    await touch('touchMove', [{ x: at.x + dx, y: at.y + dy }]);
    await sleep(50);
    await touch('touchEnd', []);
    await sleep(80);
  };

  /**
   * One-finger drag from `from` to `to` in `steps` touchMove events; `beforeRelease` runs while
   * the finger is still down at the final position (the drag tooltip is visible then).
   */
  const drag = async (from, to, { steps = 8, stepDelayMs = 30, beforeRelease } = {}) => {
    await touch('touchStart', [from]);
    await sleep(50);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await touch('touchMove', [
        { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t },
      ]);
      await sleep(stepDelayMs);
    }
    if (beforeRelease) await beforeRelease();
    await touch('touchEnd', []);
    await sleep(80);
  };

  /** Full-viewport screenshot, or a zoomed `clip` ({ x, y, width, height, scale }, CSS px). */
  const shot = async (name, clip) => {
    const r = await cdp.send(
      'Page.captureScreenshot',
      clip ? { format: 'png', clip: { scale: 1, ...clip } } : { format: 'png' },
      30000,
    );
    const file = join(outDir, `${name}.png`);
    writeFileSync(file, Buffer.from(r.data, 'base64'));
    notes.push(`shot: ${file}`);
    return file;
  };

  const markers = () => helper('markers()');
  const plot = async () => {
    const svg = await helper('svg()');
    check(svg !== null, 'no <svg> in the card shadow root');
    return {
      left: svg.x + PLOT_MARGINS.left,
      right: svg.x + svg.w - PLOT_MARGINS.right,
      top: svg.y + PLOT_MARGINS.top,
      bottom: svg.y + svg.h - PLOT_MARGINS.bottom,
      svg,
    };
  };

  return {
    evaluate,
    helper,
    load,
    touch,
    tap,
    roll,
    drag,
    shot,
    markers,
    plot,
    state: () => helper('state()'),
    entity: () => helper('entity()'),
    calls: () => helper('calls()'),
    count: (selector) => helper(`count(${JSON.stringify(selector)})`),
    text: (selector) => helper(`text(${JSON.stringify(selector)})`),
    visible: (selector) => helper(`visible(${JSON.stringify(selector)})`),
    value: (selector) => helper(`value(${JSON.stringify(selector)})`),
    scroll: () => helper('scroll()'),
    focusRing: () => helper('focusRing()'),
    box: (selector) => helper(`shadowBox(${JSON.stringify(selector)})`),
    /** Types `text` into the focused element (replaces the selection), like a keyboard would. */
    insertText: (text) => cdp.send('Input.insertText', { text }),
    /** Presses and releases a non-printing key (e.g. Shift) on the focused element. */
    pressKey: async (key, code, keyCode) => {
      const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    },
    note: (line) => notes.push(line),
    pageErrorsSince: (from) => pageErrors.slice(from),
    pageErrorCount: () => pageErrors.length,
  };
}

/** Centre of a marker as a touch point. */
const at = (marker) => ({ x: marker.cx, y: marker.cy });

/**
 * Largest SVG-relative displacement between two marker lists (Infinity when a marker vanished):
 * the "did the curve revert?" measure, immune to layout shifts above the chart.
 */
function markerDrift(before, after) {
  return Math.max(
    ...before.map((m, i) => {
      const next = after[i];
      return next ? Math.hypot(next.rx - m.rx, next.ry - m.ry) : Infinity;
    }),
  );
}

/** The point of the plot farthest from every marker (between the first and last markers). */
function findEmptySpot(markers, plot) {
  const xs = markers.map((m) => m.cx);
  const left = Math.max(plot.left + 8, Math.min(...xs) + 8);
  const right = Math.min(plot.right - 8, Math.max(...xs) - 8);
  let best = null;
  for (let y = plot.top + 12; y <= plot.bottom - 12; y += 4) {
    for (let x = left; x <= right; x += 4) {
      const minDist = Math.min(...markers.map((m) => Math.hypot(m.cx - x, m.cy - y)));
      if (!best || minDist > best.minDist) best = { x, y, minDist };
    }
  }
  return best;
}

/**
 * A touch point `distance` px away from `marker`, inside the SVG and as far as possible from
 * every other marker (so the touch is unambiguous); null when every direction lands inside
 * another 44 px target or outside the SVG.
 */
function offsetTouch(marker, others, svg, distance) {
  let best = null;
  for (const [ux, uy] of OFFSET_DIRECTIONS) {
    const x = marker.cx + ux * distance;
    const y = marker.cy + uy * distance;
    if (x < svg.x + 1 || x > svg.x + svg.w - 1 || y < svg.y + 1 || y > svg.y + svg.h - 1) continue;
    const clearance = Math.min(Infinity, ...others.map((m) => Math.hypot(m.cx - x, m.cy - y)));
    if (!best || clearance > best.clearance) {
      best = { x, y, clearance, dx: ux * distance, dy: uy * distance };
    }
  }
  return best !== null && best.clearance > HIT_RADIUS + 1 ? best : null;
}

/** Point 1 (data-index 1) moved by (+60, +40) px; returns the initial markers and state. */
async function dragPoint1(ctx, dx = 60, dy = 40, options = {}) {
  const before = await ctx.markers();
  check(before.length >= 3, `expected at least 3 point markers, got ${before.length}`);
  const initial = await ctx.state();
  const marker = before.find((m) => m.index === 1) ?? before[1];
  ctx.note(
    `point 1 marker at (${round1(marker.cx)}, ${round1(marker.cy)}) -> drag to (${round1(marker.cx + dx)}, ${round1(marker.cy + dy)})`,
  );
  await ctx.drag(at(marker), { x: marker.cx + dx, y: marker.cy + dy }, options);
  return { before, initial, marker };
}

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------

async function runProbe(ctx) {
  await ctx.load(DEFAULT_QUERY);
  const env = await ctx.helper('env()');
  ctx.note(
    `viewport ${env.innerWidth}x${env.innerHeight} · dpr ${env.dpr} · maxTouchPoints ${env.maxTouchPoints} · pointer coarse ${env.coarse}`,
  );
  check(
    env.innerWidth === DEVICE.width && env.innerHeight === DEVICE.height,
    `device metrics not applied: viewport is ${env.innerWidth}x${env.innerHeight}`,
  );
  check(env.maxTouchPoints >= 1, 'touch emulation not enabled: navigator.maxTouchPoints is 0');

  // A tap on a harness checkbox must toggle it (touch -> pointer events -> click).
  await ctx.helper('watchPointers()');
  const dark = await ctx.helper("lightBox('#dark')");
  check(dark !== null, 'harness checkbox #dark not found');
  const before = await ctx.evaluate("document.getElementById('dark').checked");
  await ctx.tap(at(dark));
  await sleep(150);
  const after = await ctx.evaluate("document.getElementById('dark').checked");
  const log = await ctx.helper('pointerLog()');
  ctx.note(`pointer events from the tap: ${log.join(', ') || 'none'}`);
  check(after !== before, 'a tap on the "Thème sombre" checkbox did not toggle it');
  check(
    log.some((entry) => entry === 'pointerdown:touch'),
    'the tap did not reach the page as a pointerdown of type "touch"',
  );

  // A swipe OUTSIDE the chart must scroll the document (otherwise scenario (d) proves nothing).
  await ctx.helper('makeScrollable()');
  const pre = await ctx.scroll();
  check(pre.scrollable, `could not make the document scrollable (${pre.scrollHeight} px)`);
  // The card header (ha-card light DOM, inside the card's shadow root) is outside the chart.
  const header =
    (await ctx.helper("shadowBox('ha-card h1.card-header')")) ??
    (await ctx.helper("shadowBox('.status')"));
  check(header !== null, 'no card header / status row to swipe on');
  await ctx.drag(
    { x: header.cx, y: header.cy + 10 },
    { x: header.cx, y: Math.max(5, header.cy - 150) },
    { steps: 10, stepDelayMs: 16 },
  );
  await sleep(400);
  const post = await ctx.scroll();
  ctx.note(`swipe on the card header: scrollY ${pre.scrollY} -> ${post.scrollY}`);
  check(
    post.scrollY > 0,
    'a swipe outside the chart did not scroll the page: the no-scroll check (d) would be vacuous',
  );
}

async function runDrag(ctx) {
  await ctx.load(DEFAULT_QUERY);
  const entity = await ctx.entity();
  let tooltip = null;
  let releasedAt = 0;
  const { before, initial, marker } = await dragPoint1(ctx, 60, 40, {
    beforeRelease: async () => {
      tooltip = {
        count: await ctx.count('g.tooltip'),
        visible: await ctx.visible('g.tooltip rect'),
        text: await ctx.text('g.tooltip text'),
        dragging: await ctx.count('g.point.dragging, .point .dragging, .dragging'),
        calls: (await ctx.calls()).length,
      };
      await ctx.shot('a-drag-mid');
      releasedAt = Date.now();
    },
  });
  // drag() returns ~80 ms after touchEnd: the 400 ms debounce must still be pending.
  const callsJustAfter = (await ctx.calls()).length;
  let firstCallMs = null;
  while (Date.now() - releasedAt < 2000) {
    if ((await ctx.calls()).length > 0) {
      firstCallMs = Date.now() - releasedAt;
      break;
    }
    await sleep(20);
  }
  ctx.note(
    `tooltip during the drag: ${tooltip.count > 0 ? `"${tooltip.text}"` : 'absent'} (rect visible ${tooltip.visible}) · .dragging elements: ${tooltip.dragging} · set_value calls mid-drag ${tooltip.calls}, ~80 ms after release ${callsJustAfter}, first call ${firstCallMs ?? 'never'} ms after release`,
  );
  check(tooltip.calls === 0, `a set_value call was made DURING the drag (${tooltip.calls})`);
  check(
    callsJustAfter === 0,
    `a set_value call was made right after the release, before the 400 ms debounce (${callsJustAfter})`,
  );
  check(
    firstCallMs !== null && firstCallMs >= 300,
    `the save did not wait for the ~400 ms debounce (first call ${firstCallMs ?? 'never'} ms after release)`,
  );
  check(tooltip.visible, 'the g.tooltip rect is not visible while dragging');
  check(
    /^\d{2}:\d{2} · \d{1,3} %$/.test(tooltip.text ?? ''),
    `the tooltip text is not "HH:MM · NN %": "${tooltip.text}"`,
  );
  await sleep(SAVE_WAIT_MS);
  const after = await ctx.markers();
  const moved = after.find((m) => m.index === 1) ?? after[1];
  ctx.note(
    `marker 1 moved by (${round1(moved.rx - marker.rx)}, ${round1(moved.ry - marker.ry)}) px inside the SVG`,
  );
  const calls = await ctx.calls();
  ctx.note(`set_value calls: ${calls.length} ${JSON.stringify(calls.map((c) => c.value))}`);
  check(calls.length === 1, `expected exactly one input_text.set_value call, got ${calls.length}`);
  const call = calls[0];
  check(call.entity_id === entity, `set_value targeted ${call.entity_id}, expected ${entity}`);
  check(call.value !== initial, `the saved value equals the initial string: ${call.value}`);
  const a = parseCurve(initial);
  const b = parseCurve(call.value);
  check(b.length >= 2, `the saved value is not a valid curve: ${call.value}`);
  check(b.length === a.length, `point count changed: ${a.length} -> ${b.length}`);
  const p1 = a[1];
  const q1 = b[1];
  ctx.note(`point 1: ${formatPoint(p1)} -> ${formatPoint(q1)}`);
  check(
    q1.time !== p1.time || q1.value !== p1.value,
    `point 1 did not move: ${formatPoint(p1)} -> ${formatPoint(q1)}`,
  );
  check(
    sortKey(q1.time) > sortKey(p1.time) && q1.value < p1.value,
    `point 1 moved the wrong way (expected later and dimmer): ${formatPoint(p1)} -> ${formatPoint(q1)}`,
  );
  check(
    Math.abs(moved.rx - marker.rx) > 3 || Math.abs(moved.ry - marker.ry) > 3,
    'the marker of point 1 did not move on screen after the drag',
  );
  const state = await ctx.state();
  ctx.note(`mock state after the save: ${state}`);
  check(state === call.value, 'the mock did not echo the saved value into the state');
  const chip = await ctx.text('.save');
  ctx.note(`.save chip: ${chip === null ? '(none)' : `"${chip}"`}`);
  check(tooltip.count > 0, 'no g.tooltip rendered while dragging');
  check(before.length === after.length, 'the number of markers changed during a drag');
}

async function runAdd(ctx) {
  await ctx.load(DEFAULT_QUERY);
  const markers = await ctx.markers();
  const initial = await ctx.state();
  const plot = await ctx.plot();
  const spot = findEmptySpot(markers, plot);
  check(spot !== null, 'no candidate spot inside the plot');
  ctx.note(
    `tap at (${round1(spot.x)}, ${round1(spot.y)}), ${round1(spot.minDist)} px from the nearest marker`,
  );
  check(
    spot.minDist > HIT_RADIUS + 6,
    `no empty spot clear of the 44 px hit targets (best ${round1(spot.minDist)} px)`,
  );
  await ctx.tap({ x: spot.x, y: spot.y });
  await sleep(SAVE_WAIT_MS);
  await ctx.shot('b-added');
  const count = await ctx.count('g.point');
  const calls = await ctx.calls();
  ctx.note(`g.point: ${markers.length} -> ${count} · set_value calls: ${calls.length}`);
  const message = await ctx.text('.message');
  if (message) ctx.note(`.message: "${message}"`);
  check(count === markers.length + 1, `expected ${markers.length + 1} point groups, got ${count}`);
  check(calls.length === 1, `expected exactly one input_text.set_value call, got ${calls.length}`);
  const a = parseCurve(initial);
  const b = parseCurve(calls[0].value);
  check(
    b.length === a.length + 1,
    `saved curve has ${b.length} points, expected ${a.length + 1}: ${calls[0].value}`,
  );
  const added = b.find((p) => !a.some((q) => q.time === p.time && q.value === p.value));
  ctx.note(`added point: ${formatPoint(added)} · saved: ${calls[0].value}`);
  check(added !== undefined, 'could not identify the added point in the saved curve');
}

async function runSelect(ctx) {
  await ctx.load(DEFAULT_QUERY);
  const markers = await ctx.markers();
  check(markers.length >= 2, `expected at least 2 point markers, got ${markers.length}`);
  const marker = markers.find((m) => m.index === 1) ?? markers[1];
  const expected = parseCurve(await ctx.state())[1];
  await ctx.tap(at(marker));
  await sleep(300);
  await ctx.shot('c-detail');
  const visible = await ctx.visible('.detail');
  const time = await ctx.value('.detail input[type="time"]');
  const value = await ctx.value('.detail input[type="number"]');
  const selected = await ctx.count('g.point .selected, g.point.selected');
  const focus = await ctx.helper('focus()');
  const ring = await ctx.focusRing();
  ctx.note(
    `.detail visible: ${visible} · time input: ${time ?? '(none)'} · number input: ${value ?? '(none)'} · selected markers: ${selected}`,
  );
  ctx.note(
    `focus after the tap: ${focus.active ?? 'none'} · :focus-visible ${focus.focusVisible} · host [pointer-focus] ${ring.pointerFocus} · hit ring stroke ${ring.stroke} dash ${ring.dash}`,
  );
  check(visible, 'the .detail row is not visible after tapping point 1');
  check(ring.pointerFocus, 'the host has no [pointer-focus] attribute after a touch tap (plan C4)');
  check(!ring.ring, `a keyboard focus ring is painted after a touch tap (dash ${ring.dash})`);
  check(
    time === formatTime(expected.time),
    `time input shows ${time ?? '(none)'}, expected ${formatTime(expected.time)}`,
  );
  check(
    Number(value) === expected.value,
    `number input shows ${value ?? '(none)'}, expected ${expected.value}`,
  );
  const after = await ctx.markers();
  const same = after.find((m) => m.index === 1) ?? after[1];
  check(
    Math.abs(same.rx - marker.rx) < 1 && Math.abs(same.ry - marker.ry) < 1,
    'a tap moved the point',
  );
  await sleep(SAVE_WAIT_MS);
  const calls = await ctx.calls();
  check(calls.length === 0, `a tap must not save anything, got ${calls.length} set_value call(s)`);
}

async function runNoScroll(ctx) {
  await ctx.load(DEFAULT_QUERY);
  await ctx.helper('makeScrollable()');
  const pre = await ctx.scroll();
  check(pre.scrollable, `could not make the document scrollable (${pre.scrollHeight} px)`);
  check(pre.scrollY === 0, `the page starts scrolled (scrollY ${pre.scrollY})`);
  // 1. A mostly vertical drag on a point, sampled while the finger is still down.
  let midDrag = null;
  await dragPoint1(ctx, 8, 90, {
    steps: 10,
    stepDelayMs: 16,
    beforeRelease: async () => {
      midDrag = await ctx.scroll();
    },
  });
  await sleep(200);
  const afterDrag = await ctx.scroll();
  ctx.note(
    `during a vertical drag on point 1: scrollY ${midDrag.scrollY}, main top ${round1(midDrag.mainTop)} · after: scrollY ${afterDrag.scrollY}, main top ${round1(pre.mainTop)} -> ${round1(afterDrag.mainTop)}`,
  );
  check(
    midDrag.scrollY === 0 && Math.abs(midDrag.mainTop - pre.mainTop) < 0.5,
    `the document scrolled WHILE dragging point 1 (scrollY ${midDrag.scrollY}, main top ${round1(midDrag.mainTop)})`,
  );
  check(
    afterDrag.scrollY === 0,
    `the document scrolled during a point drag (scrollY ${afterDrag.scrollY})`,
  );
  check(
    Math.abs(afterDrag.mainTop - pre.mainTop) < 0.5,
    `the harness <main> moved during a point drag (${round1(pre.mainTop)} -> ${round1(afterDrag.mainTop)})`,
  );
  // 2. A vertical swipe on the chart background (not on a point).
  const markers = await ctx.markers();
  const plot = await ctx.plot();
  const spot = findEmptySpot(markers, plot);
  check(spot !== null && spot.minDist > HIT_RADIUS + 6, 'no empty spot on the chart background');
  let midSwipe = null;
  await ctx.drag(
    { x: spot.x, y: spot.y },
    { x: spot.x, y: Math.max(plot.top + 2, spot.y - 60) },
    {
      steps: 10,
      stepDelayMs: 16,
      beforeRelease: async () => {
        midSwipe = await ctx.scroll();
      },
    },
  );
  await sleep(300);
  const afterSwipe = await ctx.scroll();
  ctx.note(
    `during a swipe on the chart background: scrollY ${midSwipe.scrollY} · after: scrollY ${afterSwipe.scrollY}`,
  );
  check(
    midSwipe.scrollY === 0,
    `the document scrolled WHILE swiping on the chart (scrollY ${midSwipe.scrollY})`,
  );
  check(
    afterSwipe.scrollY === 0,
    `the document scrolled during a swipe on the chart (scrollY ${afterSwipe.scrollY})`,
  );
  check(
    Math.abs(afterSwipe.mainTop - pre.mainTop) < 0.5,
    `the harness <main> moved during a swipe on the chart (${round1(pre.mainTop)} -> ${round1(afterSwipe.mainTop)})`,
  );
  await sleep(SAVE_WAIT_MS);
  const calls = await ctx.calls();
  ctx.note(`set_value calls: ${calls.length} (the point drag saves once, the swipe must not)`);
  check(calls.length === 1, `expected exactly one set_value call, got ${calls.length}`);
}

async function runFail(ctx) {
  await ctx.load(`${DEFAULT_QUERY}&fail=1`);
  const { before, initial } = await dragPoint1(ctx);
  await sleep(SAVE_WAIT_MS + 500);
  await ctx.shot('e-error');
  const chip = await ctx.text('.save');
  const calls = await ctx.calls();
  const state = await ctx.state();
  const after = await ctx.markers();
  ctx.note(
    `.save chip: ${chip === null ? '(none)' : `"${chip}"`} · set_value calls: ${calls.length}`,
  );
  check(calls.length === 1, `expected exactly one input_text.set_value call, got ${calls.length}`);
  check(chip !== null, 'no .save chip rendered after the rejected save');
  check(/Erreur/.test(chip), `the .save chip does not contain "Erreur": "${chip}"`);
  check(state === initial, `the mock state changed although the save was rejected: ${state}`);
  check(
    after.length === before.length,
    `marker count changed: ${before.length} -> ${after.length}`,
  );
  const drift = markerDrift(before, after);
  ctx.note(`max marker drift vs. the initial positions (SVG-relative): ${round1(drift)} px`);
  check(
    drift < 1,
    `the curve did not revert after the rejected save (marker drift ${round1(drift)} px)`,
  );
}

async function runNoEcho(ctx) {
  await ctx.load(`${DEFAULT_QUERY}&noecho=1`);
  const { before, initial } = await dragPoint1(ctx);
  await sleep(SAVE_WAIT_MS);
  const saving = await ctx.text('.save');
  ctx.note(`.save chip 1 s after the drag: ${saving === null ? '(none)' : `"${saving}"`}`);
  await sleep(ECHO_TIMEOUT_WAIT_MS - SAVE_WAIT_MS);
  await ctx.shot('f-noecho');
  const chip = await ctx.text('.save');
  const calls = await ctx.calls();
  const state = await ctx.state();
  const after = await ctx.markers();
  ctx.note(
    `.save chip after the echo timeout: ${chip === null ? '(none)' : `"${chip}"`} · set_value calls: ${calls.length}`,
  );
  check(calls.length === 1, `expected exactly one input_text.set_value call, got ${calls.length}`);
  check(
    chip !== null && /refusée|Erreur/.test(chip),
    `the .save chip does not report the refusal: "${chip}"`,
  );
  check(state === initial, `the mock state changed although nothing was echoed: ${state}`);
  const drift = markerDrift(before, after);
  ctx.note(`max marker drift vs. the initial positions (SVG-relative): ${round1(drift)} px`);
  check(
    drift < 1,
    `the curve did not revert after the echo timeout (marker drift ${round1(drift)} px)`,
  );
}

async function runHitZone(ctx) {
  await ctx.load(DEFAULT_QUERY);
  const svg = await ctx.helper('svg()');
  const hits = await ctx.helper('hits()');
  ctx.note(
    `hit targets: ${hits.map((h) => `#${h.index} r=${h.r} (${round1(h.w)}x${round1(h.h)} px)`).join(', ')}`,
  );
  check(
    hits.length > 0 && hits.every((h) => h.r === HIT_RADIUS && Math.abs(h.w - 2 * HIT_RADIUS) < 1),
    `hit targets are not ${2 * HIT_RADIUS} px circles: ${JSON.stringify(hits)}`,
  );
  const markers = await ctx.markers();
  const curve = parseCurve(await ctx.state());
  let tested = 0;
  for (const marker of markers) {
    const others = markers.filter((m) => m !== marker);
    const spot = offsetTouch(marker, others, svg, OFFSET_PX);
    const expected = curve[marker.index];
    if (spot === null) {
      ctx.note(
        `point ${marker.index} (${formatPoint(expected)}): skipped, every ${OFFSET_PX} px offset lands inside another target or outside the SVG`,
      );
      continue;
    }
    await ctx.tap({ x: spot.x, y: spot.y });
    await sleep(150);
    const selected = await ctx.helper('selected()');
    const time = await ctx.value('.detail input[type="time"]');
    const count = await ctx.count('g.point');
    ctx.note(
      `point ${marker.index} (${formatPoint(expected)}): touch (${round1(spot.dx)}, ${round1(spot.dy)}) px off centre, ${round1(spot.clearance)} px from the nearest other marker -> selected ${selected ?? 'none'}, detail time ${time ?? '(none)'}`,
    );
    check(
      count === markers.length,
      `the off-centre tap added a point (${markers.length} -> ${count})`,
    );
    check(
      selected === marker.index,
      `point ${marker.index} was not selected by a touch ${OFFSET_PX} px off its centre (selected: ${selected ?? 'none'})`,
    );
    check(
      time === formatTime(expected.time),
      `detail row shows ${time ?? '(none)'}, expected ${formatTime(expected.time)}`,
    );
    tested++;
  }
  check(tested >= 2, `only ${tested} marker(s) could be touched unambiguously`);
  await ctx.shot('g-offset-tap');
  await sleep(SAVE_WAIT_MS);
  const tapCalls = await ctx.calls();
  check(tapCalls.length === 0, `off-centre taps must not save anything, got ${tapCalls.length}`);

  // A drag that starts 15 px off the marker still drags that point (down by 50 px).
  const marker = markers.find((m) => m.index === 1) ?? markers[1];
  const spot = offsetTouch(
    marker,
    markers.filter((m) => m !== marker),
    svg,
    OFFSET_PX,
  );
  check(spot !== null, `no unambiguous ${OFFSET_PX} px offset around point 1`);
  const initial = await ctx.state();
  await ctx.drag({ x: spot.x, y: spot.y }, { x: spot.x, y: spot.y + 50 });
  await sleep(SAVE_WAIT_MS);
  const calls = await ctx.calls();
  const after = await ctx.markers();
  ctx.note(
    `drag from (${round1(spot.dx)}, ${round1(spot.dy)}) px off point 1: set_value calls ${calls.length} ${JSON.stringify(calls.map((c) => c.value))}`,
  );
  check(calls.length === 1, `expected exactly one set_value call, got ${calls.length}`);
  check(
    after.length === markers.length,
    `marker count changed: ${markers.length} -> ${after.length}`,
  );
  const p1 = parseCurve(initial)[1];
  const q1 = parseCurve(calls[0].value)[1];
  ctx.note(`point 1: ${formatPoint(p1)} -> ${formatPoint(q1)}`);
  // Reported, not checked: the finger moved straight down (x unchanged), so any time change
  // comes from the point jumping under the finger (the card keeps the grab offset since the M3
  // repair: the time should not move).
  const shift = sortKey(q1.time) - sortKey(p1.time);
  ctx.note(
    `finger x unchanged, grabbed (${round1(spot.dx)}, ${round1(spot.dy)}) px off centre: time shifted by ${shift} min (grab offset ${shift === 0 ? 'preserved' : 'NOT preserved'})`,
  );
  check(
    q1.value < p1.value,
    `point 1 did not get dimmer from an off-centre drag: ${formatPoint(p1)} -> ${formatPoint(q1)}`,
  );
}

/** Touch tap slop of the card (plan B3: 8 px Chebyshev for touch / pen, 3 px for a mouse). */
const TOUCH_SLOP_PX = 8;

/**
 * Tap tolerance: a finger that rolls a little between touchstart and touchend is still a tap.
 * Rolls of 2, 5 and 7 px (Chebyshev, below the 8 px touch slop) must select point 1 without
 * moving or saving it; a 12 px move must drag it (so the tap checks are not vacuous). The 8 px
 * boundary outcome is only reported.
 */
async function runSlop(ctx) {
  const outcomes = [];
  for (const px of [2, 5, 7, 8, 12]) {
    await ctx.load(DEFAULT_QUERY);
    const before = await ctx.markers();
    const marker = before.find((m) => m.index === 1) ?? before[1];
    await ctx.roll(at(marker), px, px);
    await sleep(SAVE_WAIT_MS);
    const after = await ctx.markers();
    const moved = after.find((m) => m.index === 1) ?? after[1];
    const calls = await ctx.calls();
    const selected = await ctx.helper('selected()');
    const detail = await ctx.visible('.detail');
    const drift = Math.hypot(moved.rx - marker.rx, moved.ry - marker.ry);
    outcomes.push({ px, calls: calls.length, drift, selected, detail });
    ctx.note(
      `(${px}, ${px}) px roll during a tap on point 1: ${calls.length} set_value call(s), marker drift ${round1(drift)} px, selected ${selected ?? 'none'}, .detail ${detail ? 'visible' : 'hidden'}${calls[0] ? ` -> ${calls[0].value}` : ''}`,
    );
  }
  for (const o of outcomes.filter((x) => x.px < TOUCH_SLOP_PX)) {
    check(
      o.calls === 0 && o.drift < 1,
      `a ${o.px} px finger roll (inside the ${TOUCH_SLOP_PX} px touch slop) was treated as a drag (${o.calls} save(s), drift ${round1(o.drift)} px)`,
    );
    check(
      o.selected === 1 && o.detail,
      `a ${o.px} px finger roll did not select point 1 as a tap (selected ${o.selected ?? 'none'}, detail ${o.detail})`,
    );
  }
  const far = outcomes.find((x) => x.px === 12);
  check(
    far.calls === 1 && far.drift > 3,
    `a 12 px move past the ${TOUCH_SLOP_PX} px slop did not drag point 1 (${far.calls} save(s), drift ${round1(far.drift)} px)`,
  );
}

/**
 * Focus modality (plan C4): a touch tap focuses the point (keyboard nudges work next) but must
 * not paint the dashed keyboard ring; the host carries [pointer-focus]. A key press switches to
 * the keyboard modality (the ring appears: proves the check is not vacuous) and the next touch
 * tap hides it again. Zoomed screenshots of the marker for each state.
 */
async function runFocusRing(ctx) {
  await ctx.load(DEFAULT_QUERY);
  const markers = await ctx.markers();
  const m1 = markers.find((m) => m.index === 1) ?? markers[1];
  const m2 = markers.find((m) => m.index === 2) ?? markers[2];
  const clipAround = (m) => ({ x: m.cx - 40, y: m.cy - 40, width: 80, height: 80, scale: 2 });
  const describe = (r) =>
    `focus g[${r.group ?? '-'}] · :focus-visible ${r.focusVisible} · [pointer-focus] ${r.pointerFocus} · hit stroke ${r.stroke} dash ${r.dash}`;

  await ctx.tap(at(m1));
  await sleep(200);
  const touch1 = await ctx.focusRing();
  await ctx.shot('n-focus-touch', clipAround(m1));
  ctx.note(`after a touch tap on point 1: ${describe(touch1)}`);

  await ctx.pressKey('Shift', 'ShiftLeft', 16);
  await sleep(150);
  const keyboard = await ctx.focusRing();
  await ctx.shot('n-focus-keyboard', clipAround(m1));
  ctx.note(`after pressing Shift: ${describe(keyboard)}`);

  await ctx.tap(at(m2));
  await sleep(200);
  const touch2 = await ctx.focusRing();
  await ctx.shot('n-focus-touch-again', clipAround(m2));
  ctx.note(`after a touch tap on point 2: ${describe(touch2)}`);

  check(touch1.group === 1, `the tap did not focus point 1 (focus on g[${touch1.group}])`);
  check(touch1.pointerFocus, 'the host has no [pointer-focus] after a touch tap');
  check(!touch1.ring, `a dashed focus ring is painted after a touch tap (dash ${touch1.dash})`);
  check(!keyboard.pointerFocus, 'a key press did not remove [pointer-focus] from the host');
  check(
    keyboard.ring,
    `no keyboard focus ring after a key press (dash ${keyboard.dash}): the "no ring" checks prove nothing`,
  );
  check(touch2.group === 2, `the tap did not focus point 2 (focus on g[${touch2.group}])`);
  check(
    touch2.pointerFocus && !touch2.ring,
    `the ring stayed after a touch tap following the keyboard (${describe(touch2)})`,
  );
  await sleep(SAVE_WAIT_MS);
  const calls = await ctx.calls();
  check(calls.length === 0, `taps and Shift must not save anything, got ${calls.length}`);
}

/** Closes the detail row (deselects) without a touch, so the next probe starts clean. */
const CLOSE_DETAIL =
  "document.querySelector('time-curve-card').shadowRoot.querySelector('.detail button.close')?.click(); true";

/**
 * Hit targets of the markers on the plot edges. The default curve starts at 100 %, whose marker
 * sits 14 px below the SVG top (plot margin): the upper part of its 44 px target lies outside the
 * SVG box, where the browser only hit-tests it when the SVG lets its content overflow. Same for
 * a point on the window end (14 px right margin). A touch 15 px off the centre in the outward
 * direction must still select the point; a sweep above the top marker measures the real reach.
 */
async function runEdges(ctx) {
  await ctx.load(`${DEFAULT_QUERY}&curve=17:00@100;21:00@70;08:00@10`);
  const svg = await ctx.helper('svg()');
  const markers = await ctx.markers();
  const curve = parseCurve(await ctx.state());
  check(markers.length === 3, `expected 3 markers, got ${markers.length}`);
  const top = markers.find((m) => curve[m.index]?.value === 100);
  const right = markers.find((m) => curve[m.index]?.time === 8 * 60);
  check(top !== undefined && right !== undefined, 'missing the 100 % / window-end markers');
  const overflow = await ctx.evaluate(
    "getComputedStyle(document.querySelector('time-curve-card').shadowRoot.querySelector('svg')).overflow",
  );
  ctx.note(
    `top marker ${round1(top.cy - svg.y)} px below the SVG top edge · right marker ${round1(svg.x + svg.w - right.cx)} px left of the SVG right edge · svg overflow: ${overflow}`,
  );
  const probe = async (marker, dx, dy, label) => {
    await ctx.tap({ x: marker.cx + dx, y: marker.cy + dy });
    await sleep(150);
    const selected = await ctx.helper('selected()');
    const count = await ctx.count('g.point');
    const ok = selected === marker.index && count === markers.length;
    ctx.note(
      `${label}: touch (${round1(dx)}, ${round1(dy)}) px off point ${marker.index} -> selected ${selected ?? 'none'}${count === markers.length ? '' : `, g.point ${markers.length} -> ${count}`} · ${ok ? 'hit' : 'MISS'}`,
    );
    await ctx.evaluate(CLOSE_DETAIL);
    await sleep(100);
    return ok;
  };
  const results = [
    await probe(top, -OFFSET_PX, 0, 'inward (left of the top marker)'),
    await probe(top, 0, -OFFSET_PX, 'outward (above the top marker)'),
    await probe(right, 0, OFFSET_PX, 'inward (below the right marker)'),
    await probe(right, OFFSET_PX, 0, 'outward (right of the right marker)'),
  ];
  const reach = [];
  for (const dy of [10, 14, 16, 20, 22]) {
    if (await probe(top, 0, -dy, `sweep ${dy} px above the top marker`)) reach.push(dy);
  }
  ctx.note(
    `touches above the 100 % marker that still select it: ${reach.join(', ') || 'none'} px (hit radius ${HIT_RADIUS} px)`,
  );
  await ctx.shot('i-edges');
  await sleep(SAVE_WAIT_MS);
  const calls = await ctx.calls();
  check(calls.length === 0, `edge taps must not save anything, got ${calls.length}`);
  // 20 of the 22 px radius must reach (1 px of slack for device-pixel snapping at dpr 2).
  const reached = Math.max(0, ...reach);
  check(
    results.every(Boolean) && reached >= HIT_RADIUS - 2,
    `the 44 px target of an edge marker is cut by the SVG box (svg overflow: ${overflow}): ` +
      `outward ${OFFSET_PX} px touches ${results[1] && results[3] ? 'hit' : 'miss'}, ` +
      `the target reaches ${reached} px above the 100 % marker instead of ${HIT_RADIUS}`,
  );
}

/** The drag tooltip of a point near the top of the chart sits below the marker, inside the SVG. */
async function runTooltipTop(ctx) {
  await ctx.load(DEFAULT_QUERY);
  const svg = await ctx.helper('svg()');
  const markers = await ctx.markers();
  const marker = markers.find((m) => m.index === 0) ?? markers[0];
  let mid = null;
  await ctx.drag(
    at(marker),
    { x: marker.cx + 20, y: marker.cy },
    {
      beforeRelease: async () => {
        mid = {
          box: await ctx.box('g.tooltip rect'),
          text: await ctx.text('g.tooltip text'),
          marker: (await ctx.markers()).find((m) => m.index === 0),
        };
        await ctx.shot('j-tooltip-top');
      },
    },
  );
  await sleep(SAVE_WAIT_MS);
  check(mid.box !== null, 'no g.tooltip rect while dragging point 0');
  ctx.note(
    `tooltip "${mid.text}": box y ${round1(mid.box.y - svg.y)}..${round1(mid.box.y + mid.box.h - svg.y)} px, x ${round1(mid.box.x - svg.x)}..${round1(mid.box.x + mid.box.w - svg.x)} px in the SVG · marker at y ${round1(mid.marker.cy - svg.y)} px`,
  );
  check(
    mid.box.y > mid.marker.cy,
    'the tooltip of a point near the top is not placed below the marker',
  );
  check(
    mid.box.x >= svg.x &&
      mid.box.x + mid.box.w <= svg.x + svg.w &&
      mid.box.y >= svg.y &&
      mid.box.y + mid.box.h <= svg.y + svg.h,
    'the tooltip leaves the SVG box',
  );
  const calls = await ctx.calls();
  check(calls.length === 1, `expected exactly one set_value call, got ${calls.length}`);
}

/**
 * A finger that leaves the chart while dragging (below the card, left of the plot): the point
 * follows but stays clamped (1 %, one step after its previous neighbour), the page does not
 * scroll and the drag still ends with exactly one save.
 */
async function runDragFar(ctx) {
  await ctx.load(DEFAULT_QUERY);
  await ctx.helper('makeScrollable()');
  const svg = await ctx.helper('svg()');
  const before = await ctx.markers();
  const initial = await ctx.state();
  const marker = before.find((m) => m.index === 1) ?? before[1];
  const to = { x: Math.max(2, svg.x - 30), y: Math.min(DEVICE.height - 4, svg.y + svg.h + 150) };
  let mid = null;
  await ctx.drag(at(marker), to, {
    steps: 12,
    stepDelayMs: 25,
    beforeRelease: async () => {
      mid = {
        marker: (await ctx.markers()).find((m) => m.index === 1),
        tooltip: await ctx.text('g.tooltip text'),
      };
      await ctx.shot('k-drag-far');
    },
  });
  await sleep(SAVE_WAIT_MS);
  const scroll = await ctx.scroll();
  const calls = await ctx.calls();
  ctx.note(
    `finger released ${round1(to.y - svg.y - svg.h)} px below and ${round1(svg.x - to.x)} px left of the SVG · mid-drag tooltip "${mid.tooltip ?? '(none)'}" · marker 1 at (${round1(mid.marker.rx)}, ${round1(mid.marker.ry)}) in the SVG`,
  );
  ctx.note(
    `set_value calls: ${calls.length} ${JSON.stringify(calls.map((c) => c.value))} · scrollY ${scroll.scrollY}`,
  );
  check(
    scroll.scrollY === 0,
    `the page scrolled while dragging outside the chart (scrollY ${scroll.scrollY})`,
  );
  check(calls.length === 1, `expected exactly one set_value call, got ${calls.length}`);
  const a = parseCurve(initial);
  const b = parseCurve(calls[0].value);
  // The harness configures snap_minutes: 5 (dev/main.ts).
  const expectedTime = a[0].time + 5;
  ctx.note(
    `point 1: ${formatPoint(a[1])} -> ${formatPoint(b[1])} (expected ${formatTime(expectedTime)}@1)`,
  );
  check(b[1].value === 1, `value not clamped to 1 %: ${formatPoint(b[1])}`);
  check(
    b[1].time === expectedTime,
    `time not clamped one step after point 0: ${formatPoint(b[1])}`,
  );
  check(
    mid.marker.rx >= 0 && mid.marker.rx <= svg.w && mid.marker.ry >= 0 && mid.marker.ry <= svg.h,
    'the dragged marker was drawn outside the SVG',
  );
}

/**
 * A finger that rests on a point for a while before moving (a hesitant user): the press must
 * not be cancelled by the browser's long-press gesture, and the drag must still persist once.
 */
async function runLongPress(ctx) {
  await ctx.load(DEFAULT_QUERY);
  await ctx.helper('watchPointers()');
  const before = await ctx.markers();
  const initial = await ctx.state();
  const marker = before.find((m) => m.index === 1) ?? before[1];
  await ctx.touch('touchStart', [at(marker)]);
  await sleep(900);
  const held = { selected: await ctx.helper('selected()'), tooltip: await ctx.count('g.tooltip') };
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    await ctx.touch('touchMove', [
      { x: marker.cx + (40 * i) / steps, y: marker.cy + (30 * i) / steps },
    ]);
    await sleep(30);
  }
  const tooltip = await ctx.text('g.tooltip text');
  // Reported, not checked: how much of the live "now" label the drag tooltip covers.
  const tipBox = await ctx.box('g.tooltip rect');
  const nowBox = await ctx.box('.now-label');
  if (tipBox && nowBox) {
    const w = Math.max(
      0,
      Math.min(tipBox.x + tipBox.w, nowBox.x + nowBox.w) - Math.max(tipBox.x, nowBox.x),
    );
    const h = Math.max(
      0,
      Math.min(tipBox.y + tipBox.h, nowBox.y + nowBox.h) - Math.max(tipBox.y, nowBox.y),
    );
    const share = nowBox.w * nowBox.h > 0 ? (w * h) / (nowBox.w * nowBox.h) : 0;
    ctx.note(
      `drag tooltip covers ${Math.round(share * 100)} % of the now label "${await ctx.text('.now-label')}" (${round1(w)}x${round1(h)} px overlap)`,
    );
  }
  await ctx.shot('l-long-press');
  await ctx.touch('touchEnd', []);
  await sleep(SAVE_WAIT_MS);
  const log = await ctx.helper('pointerLog()');
  const calls = await ctx.calls();
  const after = await ctx.markers();
  const moved = after.find((m) => m.index === 1) ?? after[1];
  ctx.note(`pointer events: ${log.join(', ')}`);
  ctx.note(
    `after a 900 ms hold: selected ${held.selected ?? 'none'}, tooltip ${held.tooltip > 0 ? 'shown' : 'absent'} · while moving: "${tooltip ?? '(none)'}"`,
  );
  ctx.note(
    `set_value calls: ${calls.length} ${JSON.stringify(calls.map((c) => c.value))} · marker 1 moved by (${round1(moved.rx - marker.rx)}, ${round1(moved.ry - marker.ry)}) px`,
  );
  check(
    !log.includes('pointercancel:touch'),
    'the long press cancelled the pointer (pointercancel)',
  );
  check(calls.length === 1, `expected exactly one set_value call, got ${calls.length}`);
  check(calls[0].value !== initial, 'the saved value equals the initial string');
  const a = parseCurve(initial);
  const b = parseCurve(calls[0].value);
  check(
    sortKey(b[1].time) > sortKey(a[1].time) && b[1].value < a[1].value,
    `point 1 did not move as dragged: ${formatPoint(a[1])} -> ${formatPoint(b[1])}`,
  );
}

/**
 * The detail row driven by touch: "Supprimer" removes the selected point and saves once; a
 * value typed into the number input commits on the change event (focus leaves it) and "Fermer"
 * closes the row without touching the curve.
 */
async function runDetail(ctx) {
  await ctx.load(DEFAULT_QUERY);
  const markers = await ctx.markers();
  const initial = await ctx.state();
  const marker = markers.find((m) => m.index === 1) ?? markers[1];
  await ctx.tap(at(marker));
  await sleep(200);
  const remove = await ctx.box('.detail button.delete');
  check(remove !== null, 'no .detail button.delete after tapping point 1');
  await ctx.tap(at(remove));
  await sleep(SAVE_WAIT_MS);
  await ctx.shot('m-detail-delete');
  const count = await ctx.count('g.point');
  const calls = await ctx.calls();
  const detailVisible = await ctx.visible('.detail');
  ctx.note(
    `Supprimer: g.point ${markers.length} -> ${count} · set_value calls ${calls.length} ${JSON.stringify(calls.map((c) => c.value))} · .detail visible ${detailVisible}`,
  );
  check(count === markers.length - 1, `expected ${markers.length - 1} point groups, got ${count}`);
  check(calls.length === 1, `expected exactly one set_value call, got ${calls.length}`);
  const a = parseCurve(initial);
  const b = parseCurve(calls[0].value);
  check(
    b.length === a.length - 1 && !b.some((p) => p.time === a[1].time),
    `point 1 (${formatPoint(a[1])}) is still in the saved curve: ${calls[0].value}`,
  );
  check(!detailVisible, 'the detail row is still visible after Supprimer');

  await ctx.load(DEFAULT_QUERY);
  const markers2 = await ctx.markers();
  const marker2 = markers2.find((m) => m.index === 1) ?? markers2[1];
  await ctx.tap(at(marker2));
  await sleep(200);
  const number = await ctx.box('.detail input[type="number"]');
  check(number !== null, 'no number input in the detail row');
  await ctx.tap(at(number));
  await sleep(150);
  const focus = await ctx.helper('focus()');
  ctx.note(`after tapping the number input: focus on ${focus.active ?? 'none'}`);
  check(
    focus.active === 'input',
    `a tap on the number input did not focus it (focus: ${focus.active})`,
  );
  await ctx.evaluate(
    "document.querySelector('time-curve-card').shadowRoot.querySelector('.detail input[type=\"number\"]').select(); true",
  );
  await ctx.insertText('55');
  await sleep(100);
  const typed = await ctx.value('.detail input[type="number"]');
  const close = await ctx.box('.detail button.close');
  check(close !== null, 'no .detail button.close');
  await ctx.tap(at(close));
  await sleep(SAVE_WAIT_MS);
  const calls2 = await ctx.calls();
  const visible2 = await ctx.visible('.detail');
  ctx.note(
    `typed "${typed}" then tapped Fermer: set_value calls ${calls2.length} ${JSON.stringify(calls2.map((c) => c.value))} · .detail visible ${visible2}`,
  );
  check(typed === '55', `the number input shows "${typed}" after typing 55`);
  check(calls2.length === 1, `expected exactly one set_value call, got ${calls2.length}`);
  const q = parseCurve(calls2[0].value)[1];
  check(
    q.time === a[1].time && q.value === 55,
    `the typed value did not commit to point 1: ${formatPoint(a[1])} -> ${formatPoint(q)}`,
  );
  check(!visible2, 'the detail row is still visible after Fermer');
}

const SCENARIOS = [
  {
    id: 'probe',
    name: 'touch plumbing: viewport, touch emulation, taps reach the page, swipes scroll',
    run: runProbe,
  },
  {
    id: 'drag',
    name: '(a) touch-drag point 1 by (+60, +40) px persists exactly one set_value',
    run: runDrag,
  },
  { id: 'add', name: '(b) a tap on the chart background adds a point', run: runAdd },
  { id: 'select', name: '(c) a tap on a point shows the detail row', run: runSelect },
  {
    id: 'noscroll',
    name: '(d) a drag or a swipe on the chart does not scroll the page',
    run: runNoScroll,
  },
  {
    id: 'fail',
    name: '(e) ?fail=1: a rejected save shows "Erreur" and the curve reverts',
    run: runFail,
  },
  {
    id: 'noecho',
    name: '(f) ?noecho=1: a save that is never echoed times out and reverts (slow, --all)',
    run: runNoEcho,
    optional: true,
  },
  {
    id: 'hitzone',
    name: `(g) a touch ${OFFSET_PX} px off a marker centre still selects / drags that point (44 px targets)`,
    run: runHitZone,
  },
  {
    id: 'slop',
    name: '(h) 8 px touch slop: 2 / 5 / 7 px finger rolls stay taps, a 12 px move drags',
    run: runSlop,
  },
  {
    id: 'focusring',
    name: '(n) no dashed keyboard focus ring after a touch tap ([pointer-focus]), back on a key press',
    run: runFocusRing,
  },
  {
    id: 'edges',
    name: `(i) a touch ${OFFSET_PX} px outward of a marker on the plot's top / right edge still selects it`,
    run: runEdges,
  },
  {
    id: 'tooltip',
    name: '(j) the drag tooltip of a point at 100 % sits below the marker, inside the SVG',
    run: runTooltipTop,
  },
  {
    id: 'dragfar',
    name: '(k) a drag that leaves the chart clamps the point, does not scroll, saves once',
    run: runDragFar,
  },
  {
    id: 'longpress',
    name: '(l) a 900 ms hold before dragging is not cancelled by the long-press gesture',
    run: runLongPress,
  },
  {
    id: 'detail',
    name: '(m) detail row by touch: Supprimer deletes and saves, a typed value commits, Fermer closes',
    run: runDetail,
  },
];

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.list) {
    for (const s of SCENARIOS) console.log(`${s.id.padEnd(10)} ${s.name}`);
    return 0;
  }
  const selected = SCENARIOS.filter((s) =>
    opts.only ? opts.only.includes(s.id) : opts.all || !s.optional,
  );
  if (opts.only) {
    const unknown = opts.only.filter((id) => !SCENARIOS.some((s) => s.id === id));
    if (unknown.length > 0) throw new Error(`unknown scenario id(s): ${unknown.join(', ')}`);
  }
  const browser = findBrowser();
  const outDir = resolve(root, opts.out);
  mkdirSync(outDir, { recursive: true });
  const profileDir = join(tmpdir(), `tcc-e2e-${process.pid}`);
  const base = `http://127.0.0.1:${opts.port}/`;
  console.log(
    `e2e-touch: Vite ${base} · CDP ${opts.cdpPort} · ${DEVICE.width}x${DEVICE.height}@${DEVICE.deviceScaleFactor}x · out ${outDir}`,
  );

  const vite = startVite(opts.port);
  let edge = null;
  let cdp = null;
  const pageErrors = [];
  let failures = 0;
  let infraError = null;
  cleanup = async () => {
    cdp?.close();
    await stopProcess(edge);
    await stopProcess(vite.child);
  };
  try {
    await waitForServer(base);
    edge = launchBrowser(browser, opts.cdpPort, profileDir);
    const wsUrl = await waitForPageTarget(opts.cdpPort);
    cdp = await Cdp.connect(wsUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    cdp.on('Runtime.exceptionThrown', (p) => {
      pageErrors.push(`exception: ${describeException(p.exceptionDetails)}`);
    });
    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type !== 'error' && p.type !== 'warning') return;
      const text = (p.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
      pageErrors.push(`console.${p.type}: ${text}`);
    });
    cdp.on('Log.entryAdded', (p) => {
      if (p.entry?.level === 'error') pageErrors.push(`log: ${p.entry.text} ${p.entry.url ?? ''}`);
    });
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: DEVICE.width,
      height: DEVICE.height,
      deviceScaleFactor: DEVICE.deviceScaleFactor,
      mobile: true,
      screenWidth: DEVICE.width,
      screenHeight: DEVICE.height,
    });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });

    // Warm-up load: lets Vite transform the modules (and re-optimise deps if it must) before
    // the scenarios start timing things.
    {
      const notes = [];
      const warm = makeContext({ cdp, base, outDir, notes, pageErrors });
      try {
        await warm.load(DEFAULT_QUERY);
        await sleep(1500);
      } catch (e) {
        console.log(
          `warm-up load failed (scenarios will report it): ${e instanceof Error ? e.message : e}`,
        );
      }
    }

    for (const scenario of selected) {
      const notes = [];
      const ctx = makeContext({ cdp, base, outDir, notes, pageErrors });
      const errorsBefore = pageErrors.length;
      let reason = null;
      let crashed = false;
      const started = Date.now();
      try {
        await scenario.run(ctx);
      } catch (e) {
        reason = e instanceof Error ? e.message : String(e);
        crashed = !(e instanceof CheckError);
      }
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      const pass = reason === null;
      if (!pass) failures++;
      console.log(
        `${pass ? 'PASS' : 'FAIL'}  ${scenario.id.padEnd(9)} ${scenario.name}  [${seconds}s]`,
      );
      if (reason !== null) console.log(`      ! ${crashed ? '(error) ' : ''}${reason}`);
      for (const line of notes) console.log(`      · ${line}`);
      for (const line of pageErrors.slice(errorsBefore)) console.log(`      ~ page: ${line}`);
    }
  } catch (e) {
    infraError = e instanceof Error ? e.message : String(e);
  } finally {
    await cleanup();
    cleanup = () => Promise.resolve();
    for (let attempt = 0; attempt < 5 && existsSync(profileDir); attempt++) {
      try {
        rmSync(profileDir, { recursive: true, force: true });
      } catch {
        await sleep(300);
      }
    }
  }
  if (infraError !== null) {
    console.error(`e2e-touch: tooling failure: ${infraError}`);
    console.error(`--- vite log (tail) ---\n${vite.log().slice(-2000)}`);
    return 2;
  }
  const total = selected.length;
  console.log(
    `${total - failures} passed, ${failures} failed (${total} scenario${total === 1 ? '' : 's'})`,
  );
  if (pageErrors.length === 0) console.log('page errors: none');
  return failures === 0 ? 0 : 1;
}

/** Kills the browser and Vite; replaced by main() once they are started. */
let cleanup = () => Promise.resolve();
process.on('SIGINT', () => {
  cleanup().finally(() => process.exit(130));
});

try {
  process.exitCode = await main();
} catch (e) {
  console.error(`e2e-touch: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 2;
}
