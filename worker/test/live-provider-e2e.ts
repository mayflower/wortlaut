import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {createInterface} from 'node:readline/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {chromium, type Browser, type BrowserContext, type Frame, type Locator, type Page} from 'playwright';

type Provider = 'google_meet' | 'webex' | 'teams';

interface LiveConfig {
  apiUrl: string;
  apiToken: string;
  providers: Provider[];
  urls: Record<Provider, string>;
  hostStorageState: Record<Provider, string>;
  guestStorageState: Record<Provider, string>;
  speakerAName: string;
  speakerBName: string;
  joinTimeoutSeconds: number;
  processingTimeoutSeconds: number;
  requireSpeakerBinding: boolean;
  headed: boolean;
}

interface TranscriptSegment {
  id: string;
  stream_id: string;
  epoch: string;
  speaker_id: string | null;
  speaker_name?: string | null;
  participant_name?: string | null;
  attribution_unknown: boolean;
  start: number;
  end: number;
  text: string;
}

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function parseDotEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

async function fileExists(path: string): Promise<boolean> {
  if (!path) return false;
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function loadEnvFiles(): Promise<Record<string, string>> {
  const merged: Record<string, string> = {};
  for (const rel of ['.env.live', '.dev/live-test.env']) {
    const full = resolve(ROOT_DIR, rel);
    if (await fileExists(full)) {
      Object.assign(merged, parseDotEnv(await readFile(full, 'utf8')));
    }
  }
  for (const [key, val] of Object.entries(process.env)) {
    if (typeof val === 'string' && val.length > 0) merged[key] = val;
  }
  return merged;
}

async function resolveApiToken(apiUrl: string, env: Record<string, string>): Promise<string> {
  if (env.WORTLAUT_LIVE_API_TOKEN) return env.WORTLAUT_LIVE_API_TOKEN;
  if (env.WORTLAUT_API_TOKEN) return env.WORTLAUT_API_TOKEN;

  const prodTokenPath = resolve(ROOT_DIR, '.dev/data-operator-token.txt');
  const runtimeEnvPath = resolve(ROOT_DIR, '.dev/runtime.env');

  if (apiUrl.includes('wortlaut.data.mayflower.zone') && await fileExists(prodTokenPath)) {
    return (await readFile(prodTokenPath, 'utf8')).trim();
  }
  if (await fileExists(runtimeEnvPath)) {
    const runtime = parseDotEnv(await readFile(runtimeEnvPath, 'utf8'));
    if (runtime.WORTLAUT_API_TOKEN) return runtime.WORTLAUT_API_TOKEN;
  }
  if (await fileExists(prodTokenPath)) {
    return (await readFile(prodTokenPath, 'utf8')).trim();
  }
  return '';
}

async function loadConfig(): Promise<LiveConfig> {
  const env = await loadEnvFiles();
  const apiUrl = (env.WORTLAUT_LIVE_API_URL || 'https://wortlaut.data.mayflower.zone').replace(/\/+$/, '');
  const apiToken = await resolveApiToken(apiUrl, env);

  const rawProviders = (env.PROVIDER || env.WORTLAUT_LIVE_PROVIDERS || 'google_meet,webex,teams')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const validProviders: Provider[] = [];
  for (const p of rawProviders) {
    if (p === 'google_meet' || p === 'webex' || p === 'teams') {
      validProviders.push(p);
    } else {
      throw new Error(`Unbekannter Provider "${p}". Erlaubt sind: google_meet, webex, teams`);
    }
  }

  const resolveOptionalPath = (p?: string) => (p ? resolve(ROOT_DIR, p) : '');

  return {
    apiUrl,
    apiToken,
    providers: validProviders,
    urls: {
      google_meet: env.WORTLAUT_LIVE_MEET_URL || '',
      webex: env.WORTLAUT_LIVE_WEBEX_URL || '',
      teams: env.WORTLAUT_LIVE_TEAMS_URL || '',
    },
    hostStorageState: {
      google_meet: resolveOptionalPath(env.WORTLAUT_LIVE_MEET_HOST_STORAGE_STATE || '.dev/google_meet-host-state.json'),
      webex: resolveOptionalPath(env.WORTLAUT_LIVE_WEBEX_HOST_STORAGE_STATE || '.dev/webex-host-state.json'),
      teams: resolveOptionalPath(env.WORTLAUT_LIVE_TEAMS_HOST_STORAGE_STATE || '.dev/teams-host-state.json'),
    },
    guestStorageState: {
      google_meet: resolveOptionalPath(env.WORTLAUT_LIVE_MEET_GUEST_STORAGE_STATE),
      webex: '',
      teams: '',
    },
    speakerAName: env.WORTLAUT_LIVE_SPEAKER_A_NAME || 'Alice Test',
    speakerBName: env.WORTLAUT_LIVE_SPEAKER_B_NAME || 'Bob Test',
    joinTimeoutSeconds: Number(env.WORTLAUT_LIVE_JOIN_TIMEOUT_SECONDS || 120),
    processingTimeoutSeconds: Number(env.WORTLAUT_LIVE_PROCESSING_TIMEOUT_SECONDS || 90),
    requireSpeakerBinding: (env.WORTLAUT_LIVE_REQUIRE_SPEAKER_BINDING || 'true').toLowerCase() !== 'false',
    headed: (env.WORTLAUT_LIVE_HEADED || 'false').toLowerCase() === 'true',
  };
}

/**
 * Starts a sandboxed Chromium process with synthetic media flags and a WAV file
 * fed directly into Chromium's C++ fake audio capture device.
 */
async function launchSpeakerBrowser(wavFilePath: string, locale = 'de-DE', headed = false): Promise<Browser> {
  if (!headed) {
    return await chromium.launch({
      headless: true,
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--force-device-scale-factor=1',
        `--lang=${locale}`,
        '--autoplay-policy=no-user-gesture-required',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        `--use-file-for-fake-audio-capture=${wavFilePath}`,
      ],
    });
  }
  const profile = await mkdtemp(join(tmpdir(), 'wortlaut-live-speaker-'));
  let display: ChildProcess | undefined;
  let chromiumProcess: ChildProcess | undefined;
  const cleanup = async () => {
    chromiumProcess?.kill();
    display?.kill();
    await rm(profile, {recursive: true, force: true, maxRetries: 5, retryDelay: 100}).catch(() => {});
  };
  try {
    const env = {...process.env};
    if (process.platform === 'linux' && !env.DISPLAY) {
      display = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1280x720x24', '-nolisten', 'tcp'], {
        stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
      });
      const number = await new Promise<string>((resolveDisplay, rejectDisplay) => {
        const timer = setTimeout(() => rejectDisplay(new Error('Xvfb startup timed out')), 10000);
        let output = '';
        display!.on('error', err => { clearTimeout(timer); rejectDisplay(err); });
        display!.on('exit', () => { clearTimeout(timer); rejectDisplay(new Error('Xvfb exited')); });
        display!.stdio[3]!.on('data', (data: Buffer) => {
          output += data.toString();
          if (/^\d+\n$/.test(output)) {
            clearTimeout(timer);
            resolveDisplay(output.trim());
          }
        });
      });
      env.DISPLAY = `:${number}`;
    }

    const port = await new Promise<number>((resolvePort, rejectPort) => {
      const srv = createServer();
      srv.on('error', rejectPort);
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        const p = typeof addr === 'object' && addr ? addr.port : 0;
        srv.close(err => (err ? rejectPort(err) : resolvePort(p)));
      });
    });

    chromiumProcess = spawn(
      chromium.executablePath(),
      [
        `--remote-debugging-port=${port}`,
        '--remote-debugging-address=127.0.0.1',
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--force-device-scale-factor=1',
        `--lang=${locale}`,
        '--autoplay-policy=no-user-gesture-required',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        `--use-file-for-fake-audio-capture=${wavFilePath}`,
        'about:blank',
      ],
      {env, stdio: 'ignore'},
    );

    let startupError: Error | undefined;
    chromiumProcess.on('error', err => { startupError = err; });
    const endpoint = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (startupError) throw startupError;
      if (chromiumProcess.exitCode !== null) throw new Error('Chromium exited during startup');
      try {
        const res = await fetch(`${endpoint}/json/version`, {signal: AbortSignal.timeout(500)});
        if (res.ok) {
          ready = true;
          break;
        }
      } catch {
        // waiting for CDP
      }
      await delay(250);
    }
    if (!ready) throw new Error('Chromium CDP startup timed out');
    const browser = await chromium.connectOverCDP(endpoint);
    browser.once('disconnected', () => { void cleanup(); });
    return browser;
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/**
 * Tracks all RTCPeerConnections in the speaker browser so we can deterministically
 * gate outbound audio transmission (mute/unmute at the RTP sender track level)
 * without touching native getUserMedia or pre-join device checks.
 */
async function installSenderGate(context: BrowserContext, wavPath?: string): Promise<void> {
  const wavBase64 = wavPath ? (await readFile(wavPath)).toString('base64') : '';
  // tsx/esbuild injects __name() into serialized functions; define it in every document.
  await context.addInitScript(
    "globalThis.__name = (target, value) => Object.defineProperty(target, 'name', {value, configurable: true});",
  );
  await context.addInitScript((b64: string) => {
    const g = window as unknown as {
      __wortlautPeerConnections?: Set<RTCPeerConnection>;
      __wortlautMicGateOpen?: boolean;
      __wortlautSetMicGate?: (open: boolean) => number;
      __wortlautLastGumTrack?: MediaStreamTrack;
    };
    const pcs = new Set<RTCPeerConnection>();
    g.__wortlautPeerConnections = pcs;
    g.__wortlautMicGateOpen = true;
    const isTeams = () =>
      typeof location !== 'undefined' &&
      (location.hostname.includes('teams.microsoft.com') || location.hostname.includes('live.com'));
    const isWebex = () => typeof location !== 'undefined' && location.hostname === 'web.webex.com';

    const webexGrants: {
      actx: AudioContext;
      gain: GainNode;
      buf: AudioBuffer;
      src?: AudioBufferSourceNode;
      track: MediaStreamTrack;
      restart: () => void;
    }[] = [];

    const audioDests: {ctx: AudioContext; dest: MediaStreamAudioDestinationNode}[] = [];
    if (typeof AudioContext === 'function' && AudioContext.prototype.createMediaStreamDestination) {
      const origCreateDest = AudioContext.prototype.createMediaStreamDestination;
      AudioContext.prototype.createMediaStreamDestination = function (this: AudioContext) {
        const dest = origCreateDest.call(this);
        if (isTeams()) {
          audioDests.push({ctx: this, dest});
          if (g.__wortlautLastGumTrack && g.__wortlautLastGumTrack.readyState === 'live') {
            try {
              this.createMediaStreamSource(new MediaStream([g.__wortlautLastGumTrack])).connect(dest);
            } catch {
              // ignore
            }
          }
        }
        return dest;
      };
    }

    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      const origGum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async constraints => {
        if (isWebex() && b64) {
          const tracks: MediaStreamTrack[] = [];
          const wantAudio = typeof constraints === 'object' && constraints !== null ? Boolean(constraints.audio) : true;
          const wantVideo = typeof constraints === 'object' && constraints !== null ? Boolean(constraints.video) : false;
          if (wantAudio) {
            const bin = atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const actx = new AudioContext();
            void actx.resume().catch(() => {});
            const audioBuf = await actx.decodeAudioData(bytes.buffer.slice(0));
            const gain = actx.createGain();
            const open = g.__wortlautMicGateOpen !== false;
            gain.gain.value = open ? 1 : 0;
            const dest = actx.createMediaStreamDestination();
            gain.connect(dest);
            const entry = {
              actx,
              gain,
              buf: audioBuf,
              src: undefined as AudioBufferSourceNode | undefined,
              track: dest.stream.getAudioTracks()[0],
              restart() {
                try {
                  this.src?.stop();
                  this.src?.disconnect();
                } catch {
                  // ignore
                }
                const next = this.actx.createBufferSource();
                next.buffer = this.buf;
                next.loop = true;
                next.connect(this.gain);
                next.start(0);
                this.src = next;
              },
            };
            entry.restart();
            entry.track.enabled = open;
            webexGrants.push(entry);
            g.__wortlautLastGumTrack = entry.track;
            tracks.push(entry.track);
          }
          if (wantVideo) {
            const canvas = document.createElement('canvas');
            canvas.width = 640;
            canvas.height = 360;
            tracks.push(...canvas.captureStream(5).getVideoTracks());
          }
          return new MediaStream(tracks);
        }
        const stream = await origGum(constraints);
        if (isTeams() && stream.getAudioTracks().length > 0) {
          const track = stream.getAudioTracks()[0];
          g.__wortlautLastGumTrack = track;
          track.enabled = g.__wortlautMicGateOpen !== false;
          for (const item of audioDests) {
            try {
              void item.ctx.resume().catch(() => {});
              item.ctx.createMediaStreamSource(new MediaStream([track])).connect(item.dest);
            } catch {
              // ignore
            }
          }
        }
        return stream;
      };
    }

    const syncSenders = () => {
      let count = 0;
      const open = g.__wortlautMicGateOpen !== false;
      if ((isTeams() || isWebex()) && g.__wortlautLastGumTrack) {
        g.__wortlautLastGumTrack.enabled = open;
      }
      for (const wg of webexGrants) {
        void wg.actx.resume().catch(() => {});
        wg.gain.gain.value = open ? 1 : 0;
        wg.track.enabled = open;
      }
      for (const pc of pcs) {
        try {
          for (const sender of pc.getSenders()) {
            if (sender.track && sender.track.kind === 'audio') {
              if (
                isTeams() &&
                sender.track.label === 'MediaStreamAudioDestinationNode' &&
                g.__wortlautLastGumTrack &&
                g.__wortlautLastGumTrack.readyState === 'live' &&
                sender.track.id !== g.__wortlautLastGumTrack.id
              ) {
                void sender.replaceTrack(g.__wortlautLastGumTrack).catch(() => {});
              }
              sender.track.enabled = open;
              count++;
            }
          }
        } catch {
          // ignore closed pc
        }
      }
      return count;
    };

    g.__wortlautSetMicGate = (open: boolean) => {
      const wasOpen = g.__wortlautMicGateOpen !== false;
      g.__wortlautMicGateOpen = open;
      if (open && !wasOpen) {
        for (const wg of webexGrants) {
          wg.restart();
        }
      }
      return syncSenders();
    };

    if (typeof window.RTCPeerConnection === 'function') {
      const NativePC = window.RTCPeerConnection;
      window.RTCPeerConnection = new Proxy(NativePC, {
        construct(target, args, newTarget) {
          const pc = Reflect.construct(target, args, newTarget) as RTCPeerConnection;
          pcs.add(pc);
          pc.addEventListener('connectionstatechange', () => {
            if (pc.connectionState === 'closed') pcs.delete(pc);
            else syncSenders();
          });
          setInterval(syncSenders, 250);
          return pc;
        },
      });
    }
  });
}

async function setSpeakerTransmitting(page: Page, open: boolean): Promise<void> {
  for (const target of [page, ...page.frames()]) {
    try {
      await target.evaluate(isOpen => {
        const fn = (window as unknown as {__wortlautSetMicGate?: (o: boolean) => number}).__wortlautSetMicGate;
        if (fn) fn(isOpen);
      }, open);
      if (open && /^https:\/\/web\.webex\.com\/(?:meeting|guest-join-meeting)(?:[?#]|$)/.test(target.url())) {
        const unmuteInCall = target.getByRole('button', {
          name: /^Unmute|^(?:Your )?microphone is currently muted|^(?:Ihr )?Mikrofon.*stummgeschaltet|^Stummschaltung aufheben/i,
        });
        if (await unmuteInCall.first().isVisible().catch(() => false)) {
          await unmuteInCall.first().evaluate(el => (el as HTMLElement).click()).catch(() => {});
        }
      }
    } catch {
      // ignore cross-origin frames without init script
    }
  }
}

/**
 * Builds a padded WAV file with a short 0.8s pause between utterances so that
 * when Chromium loops `--use-file-for-fake-audio-capture`, sentences have natural
 * VAD boundaries.
 */
async function createLoopedSpeakerWav(fixtureFilename: string, outPath: string): Promise<number> {
  const fullPath = resolve(ROOT_DIR, 'worker/test/fixtures', fixtureFilename);
  const wav = await readFile(fullPath);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF', `Invalid WAV header in ${fixtureFilename}`);
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE', `Invalid WAVE format in ${fixtureFilename}`);
  let fmtChunk: Buffer | undefined;
  let pcmData: Buffer | undefined;
  let offset = 12;
  while (offset + 8 <= wav.byteLength) {
    const chunkId = wav.toString('ascii', offset, offset + 4);
    const chunkLen = wav.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = Math.min(wav.byteLength, chunkStart + chunkLen);
    if (chunkId === 'fmt ') {
      fmtChunk = wav.subarray(chunkStart, chunkEnd);
    } else if (chunkId === 'data') {
      pcmData = wav.subarray(chunkStart, chunkEnd);
    }
    offset = chunkStart + chunkLen + (chunkLen % 2);
  }
  assert.ok(fmtChunk && fmtChunk.byteLength >= 16, `Missing fmt chunk in ${fixtureFilename}`);
  assert.ok(pcmData && pcmData.byteLength > 0, `Missing data chunk in ${fixtureFilename}`);
  const sampleRate = fmtChunk.readUInt32LE(4);
  const channels = fmtChunk.readUInt16LE(2);
  const bitsPerSample = fmtChunk.readUInt16LE(14);
  const bytesPerSample = (channels * bitsPerSample) / 8;
  const silence08s = Buffer.alloc(Math.floor(sampleRate * 0.8) * bytesPerSample);
  const body = Buffer.concat([pcmData, silence08s]);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + body.byteLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  fmtChunk.subarray(0, 16).copy(header, 20);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(body.byteLength, 40);
  await writeFile(outPath, Buffer.concat([header, body]));
  return pcmData.byteLength / bytesPerSample / sampleRate;
}

async function clickIfVisible(locator: Locator): Promise<boolean> {
  try {
    if (await locator.first().isVisible()) {
      await locator.first().click({timeout: 3000});
      return true;
    }
  } catch {
    // element disappeared
  }
  return false;
}

/**
 * Joins a real Google Meet, Webex, or Microsoft Teams room as an active speaker
 * with microphone ON and camera OFF.
 */
async function joinRoomAsSpeaker(page: Page, provider: Provider, meetingUrl: string, displayName: string, timeoutSec: number): Promise<void> {
  await page.goto(meetingUrl, {waitUntil: 'domcontentloaded', timeout: 45000});
  const deadline = Date.now() + timeoutSec * 1000;

    if (provider === 'google_meet') {
    const enterMillis = Date.now();
    while (Date.now() < deadline) {
      // Check if already in call via CSS attribute selector (immune to aria-modal="true" Gemini overlays)
      const leaveCss = page.locator(
        'button[aria-label*="Anruf verlassen" i], button[aria-label*="Leave call" i], button[aria-label*="Besprechung verlassen" i], button[aria-label*="Leave meeting" i]',
      );
      if (await leaveCss.first().isVisible().catch(() => false)) {
        await page.keyboard.press('Escape').catch(() => {});
        const inCallUnmute = page.locator(
          'button[data-is-muted="true"][aria-label*="Mikrofon" i], button[data-is-muted="true"][aria-label*="microphone" i], button[aria-label*="Mikrofon aktivieren" i], button[aria-label*="Turn on microphone" i]',
        );
        if (await inCallUnmute.first().isVisible().catch(() => false)) {
          await inCallUnmute.first().click({timeout: 3000}).catch(() => {});
        }
        return;
      }

      // Dismiss optional coachmarks or camera-only dialogs (never dismiss microphone for active speakers!)
      const dismiss = page.getByRole('button', {
        name: /^(OK|Got it|Verstanden|Continue without camera|Ohne Kamera fortfahren)$/i,
      });
      await clickIfVisible(dismiss);

      const nameInput = page.locator('input[type="text"]:not([aria-hidden="true"])');
      const hasNameInput = await nameInput.first().isVisible().catch(() => false);

      // Wait until Meet finishes initial room lookup ("Andere Anrufteilnehmer werden gesucht…")
      if (!hasNameInput) {
        const stillLoading = await page
          .getByText(/Andere Anrufteilnehmer werden gesucht|Looking for others/i)
          .first()
          .isVisible()
          .catch(() => false);
        if (stillLoading) {
          await delay(1000);
          continue;
        }
      }

      if (hasNameInput) {
        const current = await nameInput.first().inputValue().catch(() => '');
        if (current !== displayName) {
          await nameInput.first().fill(displayName).catch(() => {});
        }
      }

      const micOn = page.getByRole('button', {
        name: /^(Turn on microphone|Mikrofon einschalten|Mikrofon aktivieren)(?: \(.*\))?$/i,
      });
      await clickIfVisible(micOn);

      // Wait up to 10s for fake audio capture device initialization on prejoin so RTCRtpSender has a live audio track
      const hasMicDevice = await page
        .locator('button[aria-label*="Mikrofon:" i], button[aria-label*="Microphone:" i]')
        .first()
        .isVisible()
        .catch(() => false);
      if (!hasMicDevice && Date.now() - enterMillis < 10000) {
        await delay(1000);
        continue;
      }

      const joinHereTooRe = /(Auch von hier teilnehmen|Join here too)/i;
      const joinHereTooBtn = page
        .locator('button, [role="button"], [role="menuitem"]')
        .filter({hasText: joinHereTooRe});
      if (await joinHereTooBtn.first().isVisible().catch(() => false)) {
        await joinHereTooBtn.first().click({timeout: 5000}).catch(() => {});
        await delay(3000);
        continue;
      }

      const switchHereBtn = page
        .locator('button, [role="button"]')
        .filter({hasText: /(Switch here|Auf dieses Gerät wechseln)/i});
      if (await switchHereBtn.first().isVisible().catch(() => false)) {
        const otherWaysBtn = page.getByRole('button', {
          name: /(Weitere Möglichkeiten zur Teilnahme|Other ways to join)/i,
        });
        await clickIfVisible(otherWaysBtn);
        await delay(500);
        if (await joinHereTooBtn.first().isVisible().catch(() => false)) {
          await joinHereTooBtn.first().click({timeout: 5000}).catch(() => {});
          await delay(3000);
          continue;
        }
      }

      const joinRe = /(Join now|Ask to join|Jetzt teilnehmen|Teilnahme erbitten|Um Teilnahme bitten|Hier teilnehmen)/i;
      const joinBtn = page.locator('button, [role="button"]').filter({hasText: joinRe});
      if (await joinBtn.first().isVisible().catch(() => false)) {
        await joinBtn.first().click({timeout: 5000}).catch(() => {});
        await delay(3000);
        continue;
      }
      await delay(1000);
    }
    throw new Error(`Timeout beim Beitritt von "${displayName}" zu Google Meet (${meetingUrl})`);
  }

  if (provider === 'teams') {
    let browserClicked = false;
    let joinClicked = false;
    let isGuestJoin = false;
    const teamsWaitingRe =
      /Someone will let you in shortly|You[’']re in the lobby|Waiting.*(?:admit|let you in)|Please wait until someone admits|Jemand wird Sie.*einlassen|Sie (?:befinden sich|sind) im Wartebereich|Warten.*(?:Zulassung|eingelassen)/i;
    while (Date.now() < deadline) {
      const bodyText = await page.locator('body').innerText().catch(() => '');
      const inCallControls = page.locator('#roster-button, #raisehands-button, #callingButtons-showMoreBtn');
      if (
        joinClicked &&
        (await inCallControls.first().isVisible().catch(() => false)) &&
        !teamsWaitingRe.test(bodyText)
      ) {
        console.log(`      [${displayName}] Erfolgreich im Teams-Raum!`);
        return;
      }

      if (!browserClicked && !page.url().includes('lightExperience=true')) {
        const browserBtn = page
          .getByRole('button', {
            name: /^(Continue on this browser|Join on the web instead|In diesem Browser fortfahren|Stattdessen im Web teilnehmen)$/i,
          })
          .or(
            page.getByRole('link', {
              name: /^(Continue on this browser|Join on the web instead|In diesem Browser fortfahren|Stattdessen im Web teilnehmen)$/i,
            }),
          );
        if (await clickIfVisible(browserBtn)) {
          browserClicked = true;
          await delay(1000);
          continue;
        }
      }

      if (joinClicked && !(await page.locator('button[data-tid="prejoin-join-button"]').first().isVisible().catch(() => false))) {
        await delay(1000);
        continue;
      }

      const nameInput = page.locator('input[data-tid="prejoin-display-name-input"]');
      if (await nameInput.first().isVisible().catch(() => false)) {
        isGuestJoin = true;
        await nameInput.first().fill(displayName).catch(() => {});
        await delay(300);
        if ((await nameInput.first().inputValue().catch(() => '')) !== displayName) {
          await delay(500);
          continue;
        }
      }

      const joinBtn = page
        .locator('button[data-tid="prejoin-join-button"]:not([disabled])')
        .or(page.getByRole('button', {name: /^(Join now|Jetzt teilnehmen)$/i}));

      if (await joinBtn.first().isVisible().catch(() => false)) {
        await joinBtn.first().click({timeout: 5000}).catch(() => {});
        joinClicked = true;
        await delay(1000);
        continue;
      }
      await delay(1000);
    }
    throw new Error(`Timeout beim Beitritt von "${displayName}" zu Microsoft Teams (${meetingUrl})`);
  }

  if (provider === 'webex') {
    const webexWaitingRe =
      /waiting for (?:the )?host|host.*(?:let you in|admit)|wait.*lobby|in the lobby|Lobby des Meetings|bis der Host Sie einlässt|Warten.*(?:Gastgeber|Host)/i;
    let sawWaitingInLobby = false;
    while (Date.now() < deadline) {
      const matchingFrames = page
        .frames()
        .filter(f => /^https:\/\/web\.webex\.com\/(?:meeting|guest-join-meeting)(?:[?#]|$)/.test(f.url()));
      const frame = matchingFrames[matchingFrames.length - 1] || page.mainFrame();

      const snap = await frame.locator('body').ariaSnapshot().catch(() => '');
      const waitingInLobby = webexWaitingRe.test(snap);
      const stillConnecting = /Verbindung wird hergestellt|Connecting|Audio wird verbunden/i.test(snap);
      if (waitingInLobby) {
        sawWaitingInLobby = true;
      }

      const inCallControls = frame.getByRole('button', {
        name: /^(Leave meeting|Leave|End meeting|Meeting verlassen|Meeting beenden|Meeting verlassen oder Meeting für alle beenden|Verlassen|Teilnehmerbereich.*|Participants.*|Chat anzeigen|Show chat)(?:\s|$)/i,
      });
      if (!waitingInLobby && !stillConnecting && (await inCallControls.first().isVisible().catch(() => false))) {
        if (sawWaitingInLobby) {
          await delay(4000);
        }
        const unmuteInCall = frame.getByRole('button', {
          name: /^Unmute|^(?:Your )?microphone is currently muted|^(?:Ihr )?Mikrofon.*stummgeschaltet|^Stummschaltung aufheben/i,
        });
        if (await unmuteInCall.first().isVisible().catch(() => false)) {
          await unmuteInCall.first().evaluate(el => (el as HTMLElement).click()).catch(() => {});
        }
        return;
      }

      if (waitingInLobby || stillConnecting) {
        await delay(1000);
        continue;
      }

      const startHostBtn = page
        .locator('#broadcom-center-right, #push_download_join_by_browser')
        .or(
          page.getByRole('button', {
            name: /^(Start meeting|Meeting starten|Join from (?:this|your) browser|Join from browser|Über diesen Browser beitreten|Im Browser beitreten)$/i,
          }),
        );
      if (await startHostBtn.first().isVisible().catch(() => false)) {
        await startHostBtn.first().evaluate(el => (el as HTMLElement).click()).catch(() => {});
        await delay(1500);
        continue;
      }

      if (frame !== page.mainFrame()) {
        for (const cookieLabel of [
          /^(Reject|Ablehnen|Alles klar|OK)$/i,
          /^(Continue without camera|Ohne Kamera fortfahren)$/i,
        ]) {
          const cookieBtn = frame.getByRole('button', {name: cookieLabel});
          if (await cookieBtn.first().isVisible().catch(() => false)) {
            await cookieBtn.first().evaluate(el => (el as HTMLElement).click()).catch(() => {});
            await delay(500);
          }
        }
      }

      const joinBtn = frame
        .locator('#join-button')
        .or(
          frame.getByRole('button', {
            name: /^(?:Join meeting(?:\s|$)|Meeting\b.*beitreten|Start meeting(?:\s|$)|Meeting\b.*starten)/i,
          }),
        );
      if (await joinBtn.first().isVisible().catch(() => false)) {
        const nameInput = frame.getByRole('textbox', {name: /^(Name|Your name|Ihr Name)$/i});
        if (await nameInput.first().isVisible().catch(() => false)) {
          await nameInput.first().fill(displayName, {timeout: 2000}).catch(() => {});
          await delay(300);
        }
        const stopVideo = frame.getByRole('button', {
          name: /^Stop video|^Sending video is currently enabled|^(?:Senden von )?Video.*aktiviert/i,
        });
        if (await stopVideo.first().isVisible().catch(() => false)) {
          await stopVideo.first().evaluate(el => (el as HTMLElement).click()).catch(() => {});
        }
        const unmuteMic = frame.getByRole('button', {
          name: /^Unmute|^(?:Your )?microphone is currently muted|^(?:Ihr )?Mikrofon.*stummgeschaltet|^Stummschaltung aufheben/i,
        });
        if (await unmuteMic.first().isVisible().catch(() => false)) {
          await unmuteMic.first().evaluate(el => (el as HTMLElement).click()).catch(() => {});
        }
        const isDisabled = await joinBtn
          .first()
          .evaluate(el => el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true')
          .catch(() => true);
        if (!isDisabled) {
          await joinBtn
            .first()
            .click({timeout: 3000})
            .catch(() => joinBtn.first().evaluate(el => (el as HTMLElement).click()).catch(() => {}));
          await delay(2500);
          continue;
        }
      }
      await delay(1000);
    }
    throw new Error(`Timeout beim Beitritt von "${displayName}" zu Webex (${meetingUrl})`);
  }
}

/**
 * Background loop on Speaker A (Host) that automatically clicks "Admit / Zulassen"
 * whenever Speaker B or the wortlaut bot enters the waiting lobby.
 */
function startLobbyAdmitWatcher(page: Page, provider?: Provider): () => void {
  let active = true;
  const admitRe = /\b(Admit|Admit all|Let in|Zulassen|Alle zulassen|Einlassen|Hereinlassen|Alle hereinlassen|View lobby|Wartebereich anzeigen|Ansehen)\b/i;
  const denyRe = /\b(Deny|Reject|Ablehnen|Nicht zulassen|Ignorieren|Untertitel|caption)\b/i;
  void (async () => {
    while (active) {
      try {
        if (provider === 'webex') {
          const matchingFrames = page
            .frames()
            .filter(f => /^https:\/\/web\.webex\.com\/(?:meeting|guest-join-meeting)(?:[?#]|$)/.test(f.url()));
          const frame = matchingFrames[matchingFrames.length - 1];
          if (frame) {
            const admitBtn = frame.getByRole('button', {
              name: /^(Admit|Admit all|Hereinlassen|Alle hereinlassen|Einlassen|Zulassen)$/i,
            });
            if (await admitBtn.first().isVisible().catch(() => false)) {
              console.log(`      [Lobby-Watcher] Lasse Teilnehmer aus Webex-Lobby zu...`);
              await admitBtn.first().evaluate(el => (el as HTMLElement).click()).catch(() => {});
              await delay(500);
              continue;
            }
            const showLobbyBtn = frame.getByRole('button', {name: /^(Einblenden|Show)$/i});
            if (await showLobbyBtn.first().isVisible().catch(() => false)) {
              await showLobbyBtn.first().evaluate(el => (el as HTMLElement).click()).catch(() => {});
              await delay(500);
              continue;
            }
            const openParticipantsBtn = frame.getByRole('button', {
              name: /^(Teilnehmerbereich öffnen|Teilnehmer anzeigen|Open participants|Show participants)$/i,
            });
            if (await openParticipantsBtn.first().isVisible().catch(() => false)) {
              await openParticipantsBtn.first().evaluate(el => (el as HTMLElement).click()).catch(() => {});
              await delay(500);
              continue;
            }
          }
          await delay(750);
          continue;
        }

        if (provider === 'teams') {
          const confirmSuspected = page.locator('[data-tid="admit-suspected-admit-button"]');
          if (await confirmSuspected.first().isVisible().catch(() => false)) {
            console.log(`      [Lobby-Watcher] Bestätige JoinShield-Dialog (admit-suspected-admit-button)...`);
            await confirmSuspected.first().click({timeout: 2000}).catch(() => {});
            await delay(500);
            continue;
          }
          const admitLobbyBtn = page.locator(
            'button[aria-label*="Admit" i], button[aria-label*="Zulassen" i], button[aria-label*="Einlassen" i], button[data-tid*="admit" i]:not([data-tid="admit-suspected-cancel-button"])',
          );
          if (await admitLobbyBtn.first().isVisible().catch(() => false)) {
            console.log(`      [Lobby-Watcher] Lasse Teilnehmer aus Lobby zu (Admit)...`);
            await admitLobbyBtn.first().click({timeout: 2000}).catch(() => {});
            await delay(500);
            continue;
          }
          const viewLobbyBtn = page.locator('[data-tid="lobby-popup-view-lobby-btn"]');
          if (await viewLobbyBtn.first().isVisible().catch(() => false)) {
            console.log(`      [Lobby-Watcher] Öffne Wartebereich (View Lobby)...`);
            await viewLobbyBtn.first().click({timeout: 2000}).catch(() => {});
            await delay(500);
            continue;
          }
          const rosterBtn = page.locator('#roster-button:not([disabled])[aria-expanded="false"]');
          if (await rosterBtn.first().isVisible().catch(() => false)) {
            console.log(`      [Lobby-Watcher] Öffne Teilnehmerliste (#roster-button)...`);
            await rosterBtn.first().click({timeout: 2000}).catch(() => {});
            await delay(500);
            continue;
          }
          const rejoinBtn = page
            .getByRole('button', {name: /^(Rejoin|Erneut teilnehmen)$/i})
            .or(page.locator('button[data-tid="prejoin-join-button"]:not([disabled])'));
          if (await rejoinBtn.first().isVisible().catch(() => false)) {
            console.log(`      [Lobby-Watcher] Verbinde Teams-Host erneut (Rejoin/Join)...`);
            await rejoinBtn.first().click({timeout: 2000}).catch(() => {});
            await delay(1000);
            continue;
          }
          await delay(750);
          continue;
        }

        const targets: (Page | Frame)[] = [page, ...page.frames()];
        for (const target of targets) {
          const buttons = target
            .getByRole('button', {name: admitRe})
            .or(target.locator('button, [role="button"]').filter({hasText: admitRe}));
          const count = await buttons.count().catch(() => 0);
          for (let i = 0; i < count; i++) {
            const btn = buttons.nth(i);
            if (!(await btn.isVisible().catch(() => false))) continue;
            const label =
              ((await btn.getAttribute('aria-label').catch(() => '')) || '') +
              ' ' +
              ((await btn.innerText().catch(() => '')) || '');
            if (denyRe.test(label)) continue;
            await btn.click({timeout: 2000, force: true}).catch(() => {});
          }
        }
      } catch {
        // ignore transient navigation errors
      }
      await delay(750);
    }
  })();
  return () => {
    active = false;
  };
}

/**
 * Interactive helper mode: opens a visible Chromium window so the user can log in
 * as the meeting host once, then saves the Playwright storageState to .dev/<provider>-host-state.json.
 */
async function saveHostSessionInteractive(provider: Provider, config: LiveConfig): Promise<void> {
  const defaultLoginUrls: Record<Provider, string> = {
    google_meet: config.urls.google_meet || 'https://meet.google.com/',
    webex: config.urls.webex || 'https://web.webex.com/',
    teams: config.urls.teams || 'https://teams.microsoft.com/',
  };
  const outPath = config.hostStorageState[provider];
  await mkdir(dirname(outPath), {recursive: true});

  console.log(`\n[Host-Login] Starte sichtbaren Browser für Provider "${provider}"...`);
  console.log(`[Host-Login] Ziel-URL: ${defaultLoginUrls[provider]}`);
  const browser = await chromium.launch({headless: false, chromiumSandbox: true});
  try {
    const context = await browser.newContext({locale: 'de-DE'});
    const page = await context.newPage();
    await page.goto(defaultLoginUrls[provider]);
    const rl = createInterface({input: process.stdin, output: process.stdout});
    await rl.question(
      '\n>>> Bitte melde dich im geöffneten Browserfenster mit dem Host-Konto an.\n' +
        '>>> Drücke anschließend HIER im Terminal [ENTER], um die Sitzung zu speichern... ',
    );
    rl.close();
    await context.storageState({path: outPath});
    await chmod(outPath, 0o600);
    console.log(`[Host-Login] Gespeichert unter: ${outPath} (chmod 600)\n`);
  } finally {
    await browser.close();
  }
}

async function apiRequest<T = any>(
  config: LiveConfig,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiToken}`,
    ...extraHeaders,
  };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${config.apiUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${method} ${path} fehlgeschlagen (HTTP ${res.status}): ${text}`);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    return (await res.json()) as T;
  }
  return (await res.text()) as unknown as T;
}

async function runProviderLiveTest(provider: Provider, config: LiveConfig) {
  const meetingUrl = config.urls[provider];
  if (!meetingUrl) {
    throw new Error(
      `Keine Meeting-URL für Provider "${provider}" konfiguriert. ` +
        `Bitte trage die URL in .env.live ein (WORTLAUT_LIVE_${provider === 'google_meet' ? 'MEET' : provider.toUpperCase()}_URL).`,
    );
  }

  console.log(`\n======================================================================`);
  console.log(`[LIVE-E2E] Starte echten Provider-Test: ${provider.toUpperCase()}`);
  console.log(`[LIVE-E2E] Meeting-URL: ${meetingUrl}`);
  console.log(`[LIVE-E2E] wortlaut-API: ${config.apiUrl}`);
  console.log(`======================================================================`);

  const wavDir = await mkdtemp(join(tmpdir(), 'wortlaut-live-wav-'));
  const wavPathA = join(wavDir, 'speaker-a.wav');
  const wavPathB = join(wavDir, 'speaker-b.wav');
  const durationA = await createLoopedSpeakerWav('german-a.wav', wavPathA);
  const durationB = await createLoopedSpeakerWav('german-b.wav', wavPathB);

  let browserHost: Browser | undefined;
  let browserA: Browser | undefined;
  let browserB: Browser | undefined;
  let stopLobbyWatcher: (() => void) | undefined;
  let recordingId: string | undefined;

  try {
    // 1. Launch synthetic Speaker A (Host / First Speaker) & Speaker B (Second Speaker)
    console.log(`[1/6] Starte Browser für "${config.speakerAName}" und "${config.speakerBName}"...`);
    browserA = await launchSpeakerBrowser(wavPathA, 'de-DE', config.headed);
    browserB = await launchSpeakerBrowser(wavPathB, 'de-DE', config.headed);

    const hostStatePath = config.hostStorageState[provider];
    const guestStatePath = config.guestStorageState[provider];
    const hasHostState = await fileExists(hostStatePath);
    const hasGuestState = await fileExists(guestStatePath);

    if (hasHostState) {
      console.log(`      Nutze gespeicherte Host-Session: ${hostStatePath}`);
    }

    const useSeparateTeamsHost = provider === 'teams' && hasHostState;
    let pageHost: Page | undefined;
    if (useSeparateTeamsHost) {
      browserHost = await chromium.launch({
        headless: !config.headed,
        args: [
          '--autoplay-policy=no-user-gesture-required',
          '--use-fake-ui-for-media-stream',
          '--use-fake-device-for-media-stream',
          `--use-file-for-fake-audio-capture=${wavPathA}`,
        ],
      });
      const ctxHost = await browserHost.newContext({
        locale: 'de-DE',
        permissions: ['microphone', 'camera'],
        storageState: hostStatePath,
      });
      pageHost = await ctxHost.newPage();
    }

    const ctxA = await browserA.newContext({
      locale: 'de-DE',
      permissions: ['microphone', 'camera'],
      ...(hasHostState && !useSeparateTeamsHost ? {storageState: hostStatePath} : {}),
    });
    const useHostForB = !hasGuestState && hasHostState && provider === 'google_meet';
    const ctxB = await browserB.newContext({
      locale: 'de-DE',
      permissions: ['microphone', 'camera'],
      ...(hasGuestState ? {storageState: guestStatePath} : useHostForB ? {storageState: hostStatePath} : {}),
    });

    await installSenderGate(ctxA, wavPathA);
    await installSenderGate(ctxB, wavPathB);

    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    if (useSeparateTeamsHost && pageHost) {
      console.log(`      Starte Microsoft Teams Host-Session sowie "${config.speakerAName}" und "${config.speakerBName}" parallel...`);
      stopLobbyWatcher = startLobbyAdmitWatcher(pageHost, provider);
      await Promise.all([
        pageHost.goto(meetingUrl, {waitUntil: 'domcontentloaded', timeout: 45000}),
        joinRoomAsSpeaker(pageA, provider, meetingUrl, config.speakerAName, config.joinTimeoutSeconds),
        joinRoomAsSpeaker(pageB, provider, meetingUrl, config.speakerBName, config.joinTimeoutSeconds),
      ]);
      await setSpeakerTransmitting(pageA, false);
      await setSpeakerTransmitting(pageB, false);
      console.log(`      "${config.speakerAName}" und "${config.speakerBName}" sind im Raum aktiv.`);
    } else {
      console.log(`      "${config.speakerAName}" tritt dem Raum bei...`);
      await joinRoomAsSpeaker(pageA, provider, meetingUrl, config.speakerAName, config.joinTimeoutSeconds);
      if (hasHostState) {
        // Persist rotated session cookies / OAuth refresh tokens (sliding expiration)
        await ctxA.storageState({path: hostStatePath});
        await chmod(hostStatePath, 0o600).catch(() => {});
      }
      stopLobbyWatcher = startLobbyAdmitWatcher(pageA, provider);
      await setSpeakerTransmitting(pageA, false);
      console.log(`      "${config.speakerAName}" ist im Raum aktiv (Lobby-Admit-Watcher läuft).`);

      console.log(`      "${config.speakerBName}" tritt dem Raum bei...`);
      await joinRoomAsSpeaker(pageB, provider, meetingUrl, config.speakerBName, config.joinTimeoutSeconds);
      await setSpeakerTransmitting(pageB, false);
      console.log(`      "${config.speakerBName}" ist im Raum aktiv.`);
    }

    // 2. Schedule immediate recording on wortlaut API
    const now = Date.now();
    const startsAt = new Date(now - 5000).toISOString();
    const endsAt = new Date(now + 5 * 60 * 1000).toISOString();
    console.log(`[2/6] Plane Aufnahme über wortlaut-API (POST /v1/recordings)...`);
    const created = await apiRequest<{id: string; participation: string}>(
      config,
      'POST',
      '/v1/recordings',
      {
        provider,
        meeting_url: meetingUrl,
        starts_at: startsAt,
        ends_at: endsAt,
      },
      {'Idempotency-Key': randomUUID()},
    );
    recordingId = created.id;
    console.log(`      Aufnahme angelegt: ID = ${recordingId}`);

    // 3. Wait for wortlaut bot to join and reach participation === 'active'
    console.log(`[3/6] Warte auf Raumbeitritt des wortlaut-Bots (max. ${config.joinTimeoutSeconds}s)...`);
    const joinDeadline = Date.now() + config.joinTimeoutSeconds * 1000;
    let activeRecording: any = null;
    while (Date.now() < joinDeadline) {
      const rec = await apiRequest<any>(config, 'GET', `/v1/recordings/${recordingId}`);
      if (rec.participation === 'capturing' || rec.participation === 'active') {
        activeRecording = rec;
        break;
      }
      if (rec.participation === 'failed' || rec.participation === 'cancelled' || rec.participation === 'ended') {
        throw new Error(
          `wortlaut-Bot konnte nicht aktiv teilnehmen: participation=${rec.participation}, ` +
            `failure_reason=${rec.failure_reason ?? 'none'}`,
        );
      }
      await delay(2000);
    }
    if (!activeRecording) {
      throw new Error(`Timeout: wortlaut-Bot hat nach ${config.joinTimeoutSeconds}s nicht den Status 'active' erreicht.`);
    }
    console.log(`      wortlaut-Bot ist im Meeting aktiv (participation=active).`);

    // Allow WebRTC receivers and initial 5s capture buffer to stabilize
    await delay(5500);

    // 4. Execute deterministic speech choreography (Solo A -> Solo B -> Overlapping A+B)
    console.log(`[4/6] Spiele Referenz-Sprachbeiträge über getrennte Teilnehmer-Streams ein...`);
    console.log(`      -> Turn 1: "${config.speakerAName}" spricht (german-a.wav)...`);
    await setSpeakerTransmitting(pageA, true);
    await setSpeakerTransmitting(pageB, false);
    await delay(Math.ceil((durationA * 2 + 1.6) * 1000));
    await setSpeakerTransmitting(pageA, false);
    await delay(3000);

    console.log(`      -> Turn 2: "${config.speakerBName}" spricht (german-b.wav)...`);
    await setSpeakerTransmitting(pageA, false);
    await setSpeakerTransmitting(pageB, true);
    await delay(Math.ceil((durationB * 2 + 1.6) * 1000));
    await setSpeakerTransmitting(pageB, false);
    await delay(3000);

    if (provider === 'teams' || provider === 'webex') {
      console.log(`      -> Turn 3: "${config.speakerAName}" spricht erneut (Sprecherwechsel zurück auf A)...`);
      await setSpeakerTransmitting(pageA, true);
      await setSpeakerTransmitting(pageB, false);
      await delay(Math.ceil((durationA + 1.0) * 1000));
      await setSpeakerTransmitting(pageA, false);
    } else {
      console.log(`      -> Turn 3: Überlappendes Sprechen (${config.speakerAName} + ${config.speakerBName} gleichzeitig)...`);
      await setSpeakerTransmitting(pageA, true);
      await setSpeakerTransmitting(pageB, true);
      await delay(Math.ceil((Math.max(durationA, durationB) + 1.0) * 1000));
      await setSpeakerTransmitting(pageA, false);
      await setSpeakerTransmitting(pageB, false);
    }

    // 5. Verify live streaming transcript segments while the meeting is still active
    console.log(`[5/6] Prüfe Echtzeit-Streaming-Transkription während laufendem Meeting...`);
    let liveStreamedSegments: TranscriptSegment[] = [];
    const streamCheckDeadline = Date.now() + 25000;
    while (Date.now() < streamCheckDeadline) {
      const transcript = await apiRequest<{segments: TranscriptSegment[]}>(
        config,
        'GET',
        `/v1/recordings/${recordingId}/transcript`,
      );
      if (transcript.segments && transcript.segments.length > 0) {
        liveStreamedSegments = transcript.segments;
        break;
      }
      await delay(2000);
    }
    const liveStreamingVerified = liveStreamedSegments.length > 0;
    console.log(
      `      Live-Segmente während aktivem Termin empfangen: ${liveStreamedSegments.length} (liveStreamingVerified=${liveStreamingVerified})`,
    );

    // 6. Stop recording and wait for finalization
    console.log(`[6/6] Beende Aufnahme und warte auf Abschluss der Verarbeitung...`);
    await apiRequest(config, 'POST', `/v1/recordings/${recordingId}/cancel`);
    stopLobbyWatcher?.();
    await browserHost?.close().catch(() => {});
    await browserA.close().catch(() => {});
    await browserB.close().catch(() => {});
    browserHost = undefined;
    browserA = undefined;
    browserB = undefined;

    const procDeadline = Date.now() + config.processingTimeoutSeconds * 1000;
    let finalRecording: any = null;
    while (Date.now() < procDeadline) {
      const rec = await apiRequest<any>(config, 'GET', `/v1/recordings/${recordingId}`);
      if (rec.processing === 'completed' || rec.processing === 'failed') {
        finalRecording = rec;
        break;
      }
      await delay(2000);
    }
    if (!finalRecording) {
      throw new Error(`Timeout beim Warten auf processing=completed für Recording ${recordingId}`);
    }
    assert.equal(
      finalRecording.processing,
      'completed',
      `Verarbeitung fehlgeschlagen: processing_error=${finalRecording.processing_error}`,
    );

    const exportedJson = await apiRequest<{
      processing: string;
      segments: TranscriptSegment[];
      quality: {has_audio_gaps: boolean; has_unknown_attribution: boolean};
    }>(config, 'GET', `/v1/recordings/${recordingId}/exports/json`);
    const exportedTxt = await apiRequest<string>(config, 'GET', `/v1/recordings/${recordingId}/exports/txt`);
    const exportedVtt = await apiRequest<string>(config, 'GET', `/v1/recordings/${recordingId}/exports/vtt`);

    const segments = exportedJson.segments || [];
    const distinctStreams = new Set(segments.map(s => s.stream_id));
    const distinctSpeakers = new Set(segments.map(s => s.speaker_id).filter(Boolean));
    const distinctSpeakerNames = new Set(segments.map(s => s.speaker_name ?? s.participant_name).filter(Boolean));

    const segmentsA = segments.filter(s => /getrennten.*Audioquellen|Audioquellen|prüfen die getrenn/i.test(s.text));
    const segmentsB = segments.filter(s => /zweite Teilnehmer|gleichen Zeit/i.test(s.text));
    const streamsA = new Set(segmentsA.map(s => s.stream_id));
    const streamsB = new Set(segmentsB.map(s => s.stream_id));
    const speakersA = new Set(segmentsA.map(s => s.speaker_id).filter(Boolean));
    const speakersB = new Set(segmentsB.map(s => s.speaker_id).filter(Boolean));
    const disjointStreams =
      streamsA.size > 0 && streamsB.size > 0 && [...streamsA].every(streamId => !streamsB.has(streamId));
    const disjointSpeakers =
      speakersA.size > 0 && speakersB.size > 0 && [...speakersA].every(speakerId => !speakersB.has(speakerId));
    const multiStreamCapture = disjointStreams || distinctStreams.size >= 2 || disjointSpeakers;
    const allBound =
      segments.length > 0 && segments.every(s => !s.attribution_unknown && Boolean(s.speaker_id));

    const report = {
      timestamp: new Date().toISOString(),
      provider,
      recording_id: recordingId,
      meeting_url: meetingUrl,
      participation_verified: true,
      live_streaming_verified: liveStreamingVerified,
      processing_status: finalRecording.processing,
      segment_count: segments.length,
      distinct_stream_count: distinctStreams.size,
      distinct_speaker_ids: [...distinctSpeakers],
      distinct_speaker_names: [...distinctSpeakerNames],
      phrase_a_matched: segmentsA.length > 0,
      phrase_b_matched: segmentsB.length > 0,
      disjoint_streams_for_a_and_b: multiStreamCapture,
      disjoint_speakers_for_a_and_b: disjointSpeakers,
      speaker_attribution_verified: multiStreamCapture && disjointSpeakers && allBound && distinctSpeakers.size >= 2,
      exports_verified: exportedTxt.length > 0 && exportedVtt.startsWith('WEBVTT'),
      segments,
    };

    await mkdir(resolve(ROOT_DIR, '.dev'), {recursive: true});
    const reportPath = resolve(ROOT_DIR, `.dev/live-e2e-${provider}-result.json`);
    await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
    console.log(`\n[ERGEBNIS ${provider.toUpperCase()}] Report gespeichert in: ${reportPath}`);
    console.log(`  - Segmente gesamt:             ${report.segment_count}`);
    console.log(`  - Getrennte Audio-Streams:     ${report.distinct_stream_count}`);
    console.log(`  - Erkannte Sprecher-IDs:       ${report.distinct_speaker_ids.join(', ') || '(keine)'}`);
    console.log(`  - Erkannte Sprecher-Namen:     ${report.distinct_speaker_names.join(', ') || '(keine)'}`);
    console.log(`  - Satz A erkannt (Alice):      ${report.phrase_a_matched}`);
    console.log(`  - Satz B erkannt (Bob):        ${report.phrase_b_matched}`);
    console.log(`  - Getrennte Kanäle A vs. B:    ${report.disjoint_streams_for_a_and_b}`);
    console.log(`  - Getrennte Sprecher A vs. B:  ${report.disjoint_speakers_for_a_and_b}`);
    console.log(`  - Sprecherbindung verifiziert: ${report.speaker_attribution_verified}`);

    assert.ok(report.segment_count > 0, 'Keine Transkript-Segmente erzeugt');
    assert.ok(report.phrase_a_matched, 'Referenzsatz A ("getrennten Audioquellen") wurde im Transkript nicht gefunden');
    assert.ok(report.phrase_b_matched, 'Referenzsatz B ("zweite Teilnehmer") wurde im Transkript nicht gefunden');
    assert.ok(report.exports_verified, 'TXT/VTT-Exporte unvollständig');

    if (config.requireSpeakerBinding) {
      assert.ok(
        report.disjoint_streams_for_a_and_b,
        `Sprecher A und B wurden nicht auf getrennten Audio-Streams empfangen (distinct_stream_count=${report.distinct_stream_count})`,
      );
      assert.ok(
        report.speaker_attribution_verified,
        `Sprecherbindung unvollständig (attribution_unknown=true oder < 2 gebundene speaker_id). Siehe ${reportPath}`,
      );
    }
  } finally {
    stopLobbyWatcher?.();
    await browserHost?.close().catch(() => {});
    await browserA?.close().catch(() => {});
    await browserB?.close().catch(() => {});
    await rm(wavDir, {recursive: true, force: true}).catch(() => {});
  }
}

async function main() {
  const args = process.argv.slice(2);
  const config = await loadConfig();

  const loginIdx = args.indexOf('--save-host-session');
  if (loginIdx !== -1) {
    const provider = (args[loginIdx + 1] || process.env.PROVIDER || 'google_meet') as Provider;
    if (!['google_meet', 'webex', 'teams'].includes(provider)) {
      throw new Error(`Ungültiger Provider "${provider}". Erlaubt: google_meet, webex, teams`);
    }
    await saveHostSessionInteractive(provider, config);
    return;
  }

  if (!config.apiToken) {
    throw new Error(
      'Kein API-Token gefunden. Bitte trage WORTLAUT_LIVE_API_TOKEN in .env.live ein oder führe `make setup` aus.',
    );
  }

  const configuredProviders = config.providers.filter(p => Boolean(config.urls[p]));
  if (configuredProviders.length === 0) {
    console.error(
      '\n[HINWEIS] Es ist noch keine Meeting-URL in `.env.live` eingetragen.\n' +
        'Bitte öffne `/data/wortlaut/.env.live` und trage mindestens eine URL ein:\n' +
        '  - WORTLAUT_LIVE_MEET_URL=https://meet.google.com/...\n' +
        '  - WORTLAUT_LIVE_WEBEX_URL=https://...webex.com/meet/...\n' +
        '  - WORTLAUT_LIVE_TEAMS_URL=https://teams.microsoft.com/l/meetup-join/...\n',
    );
    process.exitCode = 1;
    return;
  }

  for (const provider of configuredProviders) {
    await runProviderLiveTest(provider, config);
  }
}

await main();
