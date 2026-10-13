import {execFile, spawn, type ChildProcess} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium, type Browser, type Locator, type Page} from 'playwright';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';

const displays = new WeakMap<Browser, string>();
const execute = promisify(execFile);
export type MeetInput = {click(locator: Locator): Promise<void>; fill(locator: Locator, text: string): Promise<void>};

export function nativeMeetInput(page: Page): MeetInput {
  const display = displays.get(page.context().browser()!);
  if (!display) throw new Error('Meet requires an X11 display for native input');
  const run = (...args: string[]) => execute('xdotool', args,
    {env: {...process.env, DISPLAY: display}, timeout: 5000});
  let windowId: string | undefined;
  const click = async (locator: Locator) => {
    await page.bringToFront();
    // Xvfb has no window manager: CDP bringToFront alone does not reliably
    // raise/focus the incognito window above Chromium's initial blank window.
    if (!windowId) {
      const title = await page.title(), marker = `wortlaut-${randomUUID()}`;
      try {
        await page.evaluate(value => { document.title = value; }, marker);
        // Meet may overwrite its document title before X11 observes it.
        // A single visible Chromium window is an unambiguous fallback.
        const found = await run('search', '--sync', '--onlyvisible', '--name', marker)
          .catch(() => run('search', '--onlyvisible', '--class', 'chromium'));
        const ids = found.stdout.trim().split('\n');
        if (ids.length !== 1 || !/^\d+$/.test(ids[0])) throw new Error('Native window is ambiguous');
        windowId = ids[0];
      } finally { await page.evaluate(value => { document.title = value; }, title); }
    }
    await run('windowraise', windowId, 'windowfocus', '--sync', windowId);
    await locator.waitFor({state: 'visible', timeout: 5000});
    await locator.scrollIntoViewIfNeeded({timeout: 5000});
    if (!await locator.isEnabled()) throw new Error('Native input target is disabled');
    if (!await locator.evaluate(element => {
      const box = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    })) throw new Error('Native input target is covered');
    const box = await locator.boundingBox();
    if (!box) throw new Error('Native input target is not visible');
    const origin = await page.evaluate(() => {
      const border = (outerWidth - innerWidth) / 2;
      return {x: screenX + border, y: screenY + outerHeight - innerHeight - border};
    });
    // Keep targets inside the central area, away from rounded edges.
    const random = (min: number, max: number) => min + Math.random() * (max - min);
    const x = Math.round(origin.x + box.x + box.width * random(0.35, 0.65));
    const y = Math.round(origin.y + box.y + box.height * random(0.35, 0.65));
    // Verify the actual X11 pointer event, not just our computed coordinates.
    const probe = await locator.evaluateHandle(element => {
      const state = {hit: false};
      const observe = (event: PointerEvent) => { state.hit = element.contains(event.target as Node); };
      window.addEventListener('pointermove', observe, true);
      return {state, dispose: () => window.removeEventListener('pointermove', observe, true)};
    });
    try {
      const position = (await run('getmouselocation', '--shell')).stdout;
      const fromX = Number(position.match(/^X=(\d+)$/m)?.[1]);
      const fromY = Number(position.match(/^Y=(\d+)$/m)?.[1]);
      if (!Number.isFinite(fromX + fromY)) throw new Error('Native pointer position unavailable');
      const moves: string[] = [];
      const dx = x - fromX, dy = y - fromY, distance = Math.hypot(dx, dy);
      const bend = random(-1, 1) * Math.min(80, distance * 0.2);
      const controlX = (fromX + x) / 2 - dy / Math.max(1, distance) * bend;
      const controlY = (fromY + y) / 2 + dx / Math.max(1, distance) * bend;
      const steps = Math.floor(random(16, 27));
      const duration = random(0.35, 0.75);
      const pauseStep = Math.floor(steps * random(0.55, 0.8));
      for (let step = 1; step <= steps; step++) {
        const t = (1 - Math.cos(Math.PI * step / steps)) / 2, u = 1 - t;
        moves.push('mousemove',
          String(Math.round(u * u * fromX + 2 * u * t * controlX + t * t * x)),
          String(Math.round(u * u * fromY + 2 * u * t * controlY + t * t * y)),
          'sleep', (duration / steps * random(0.7, 1.3)).toFixed(3));
        if (step === pauseStep) moves.push('sleep', random(0.08, 0.22).toFixed(3));
      }
      await run(...moves, 'sleep', random(0.12, 0.32).toFixed(3));
      if (!await probe.evaluate(value => value.state.hit)) throw new Error('Native pointer missed target');
      // Recheck after moving: layout changes must not send a click elsewhere.
      if (!await locator.evaluate((element, point) =>
        element.contains(document.elementFromPoint(point.x, point.y)),
      {x: x - origin.x, y: y - origin.y})) throw new Error('Native input target moved');
      try {
        await run('mousedown', '1', 'sleep', random(0.07, 0.16).toFixed(3));
      } finally { await run('mouseup', '1'); }
    } finally {
      await probe.evaluate(value => value.dispose()).catch(() => {});
      await probe.dispose();
    }
  };
  return {click, fill: async (locator, text) => {
    await click(locator);
    const element = await locator.elementHandle();
    try {
      // X11 completion does not mean Chromium has processed the input events.
      await page.waitForFunction(target => target === document.activeElement, element, {timeout: 2000})
        .catch(() => { throw new Error('Native input target did not receive focus'); });
      await run('key', '--clearmodifiers', 'ctrl+a');
      await run('type', '--clearmodifiers', '--delay', '70', '--', text);
      await page.waitForFunction(({target, text}) => (target as HTMLInputElement)?.value === text,
        {target: element, text}, {timeout: 2000})
        .catch(() => { throw new Error('Native input text was not accepted'); });
    } finally { await element?.dispose(); }
  }};
}

export async function launchBrowser(provider: 'google_meet' | 'webex' | 'teams', locale = 'en-US', webexBrowser = false) {
  if (provider === 'webex' && !webexBrowser) return chromium.launch({headless: true, chromiumSandbox: true,
    args: ['--autoplay-policy=no-user-gesture-required']});

  // Start a regular, sandboxed Chromium process with a fresh anonymous profile.
  // Playwright attaches afterwards; its launch defaults are not applied.
  const profile = await mkdtemp(join(tmpdir(), 'wortlaut-meet-'));
  let display: ChildProcess | undefined;
  let chromiumProcess: ChildProcess | undefined;
  const cleanup = async () => {
    chromiumProcess?.kill(); display?.kill();
    await rm(profile, {recursive: true, force: true, maxRetries: 5, retryDelay: 100}).catch(() => {});
  };
  try {
    const env = {...globalThis.process.env};
    if (globalThis.process.platform === 'linux' && !env.DISPLAY) {
      display = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1280x720x24', '-nolisten', 'tcp'],
        {stdio: ['ignore', 'ignore', 'ignore', 'pipe']});
      const number = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Virtual display startup timed out')), 10000);
        let output = '';
        display!.on('error', (error) => { clearTimeout(timer); reject(error); });
        display!.on('exit', () => { clearTimeout(timer); reject(new Error('Virtual display exited')); });
        display!.stdio[3]!.on('data', (data: Buffer) => {
          output += data.toString();
          if (/^\d+\n$/.test(output)) { clearTimeout(timer); resolve(output.trim()); }
        });
      });
      env.DISPLAY = `:${number}`;
    }
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        server.close((error) => error ? reject(error) : resolve(port));
      });
    });
    chromiumProcess = spawn(chromium.executablePath(), [
      `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
      '--force-device-scale-factor=1', `--lang=${locale}`, '--autoplay-policy=no-user-gesture-required', 'about:blank',
    ], {env, stdio: 'ignore'});
    let startupError: Error | undefined;
    chromiumProcess.on('error', (error) => { startupError = error; });
    const endpoint = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (startupError) throw startupError;
      if (chromiumProcess.exitCode !== null) throw new Error('Chromium exited during startup');
      try {
        const response = await fetch(`${endpoint}/json/version`, {signal: AbortSignal.timeout(500)});
        if (response.ok) { ready = true; break; }
      } catch { /* Chromium has not opened its local endpoint yet. */ }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!ready) throw new Error('Chromium startup timed out');
    const browser = await chromium.connectOverCDP(endpoint);
    if (env.DISPLAY) displays.set(browser, env.DISPLAY);
    browser.once('disconnected', () => { void cleanup(); });
    return browser;
  } catch (error) { await cleanup(); throw error; }
}
