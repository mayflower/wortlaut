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

type Provider = 'google_meet' | 'webex' | 'teams' | 'zoom';

interface LiveConfig {
  apiUrl: string;
  apiToken: string;
  providers: Provider[];
  urls: Record<Provider, string>;
  hostStorageState: Record<Provider, string>;
  guestStorageState: Record<Provider, string>;
  speakerCount: number;
  speakerAName: string;
  speakerBName: string;
  speakerCName: string;
  speakerDName: string;
  speakerLocales: [string, string];
  joinTimeoutSeconds: number;
  lobbyHoldSeconds: number;
  requireLobbyHold: boolean;
  testChatOptOut: boolean;
  requireChatOptOut: boolean;
  testKeyframes: boolean;
  testVideoDisplay: boolean;
  requireVideoDisplay: boolean;
  videoOnly: boolean;
  processingTimeoutSeconds: number;
  requireSpeakerBinding: boolean;
  headed: boolean;
}

interface ExportedKeyframe {
  id: string;
  offset_seconds: number;
  presenter: string;
  participant_id: string | null;
  provider_source_id: string;
  width: number;
  height: number;
  byte_size: number;
  sha256: string;
  image_path: string;
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

function redactMeetingUrl(raw: string): string {
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    for (const key of ['pwd', 'zak', 'token', 'passcode']) {
      if (parsed.searchParams.has(key)) {
        parsed.searchParams.set(key, '<REDACTED>');
      }
    }
    return parsed.toString();
  } catch {
    return raw.replace(/([?&](?:pwd|zak|token|passcode)=)[^&\s]+/gi, '$1<REDACTED>');
  }
}

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

/**
 * Webex stores its OAuth supertoken in `https://web.webex.com` localStorage under two separate
 * Redux-persist keys (`webex-web-meeting-bounded` for embedded `/meeting` iframes and
 * `webex-web-client-bounded` for the `https://web.webex.com/meetings` host dashboard), while
 * `meet*.webex.com` site cookies (`wbx`) expire after ~24h. Syncing the fresher `Credentials`
 * between both keys lets the test host start its Personal Room via `https://web.webex.com/meetings`
 * without requiring daily cookie refreshes.
 */
async function syncWebexHostStateFile(statePath: string): Promise<boolean> {
  if (!(await fileExists(statePath))) return false;
  try {
    const raw = JSON.parse(await readFile(statePath, 'utf8'));
    const origins: Array<{origin: string; localStorage?: Array<{name: string; value: string}>}> = Array.isArray(
      raw?.origins,
    )
      ? raw.origins
      : [];
    const webexOrigin = origins.find(o => o?.origin === 'https://web.webex.com');
    if (!webexOrigin || !Array.isArray(webexOrigin.localStorage)) return false;

    const parseStore = (key: string): Record<string, any> | null => {
      const entry = webexOrigin.localStorage?.find(item => item?.name === key);
      if (!entry?.value) return null;
      try {
        const parsed = JSON.parse(entry.value);
        return parsed && typeof parsed === 'object' ? parsed : null;
      } catch {
        return null;
      }
    };
    const tokenExpiry = (store: Record<string, any> | null): number => {
      const st = store?.Credentials?.['@']?.supertoken;
      if (!st || typeof st !== 'object' || !st.access_token) return 0;
      const exp = Number(st.refresh_token_expires || st.expires || 0);
      return Number.isFinite(exp) ? exp : 0;
    };

    const meetingStore = parseStore('webex-web-meeting-bounded');
    const clientStore = parseStore('webex-web-client-bounded');
    const meetingExp = tokenExpiry(meetingStore);
    const clientExp = tokenExpiry(clientStore);
    const bestExp = Math.max(meetingExp, clientExp);
    if (bestExp <= Date.now()) return false;

    const bestCreds = (meetingExp >= clientExp ? meetingStore : clientStore)?.Credentials;
    if (!bestCreds) return false;

    let changed = false;
    for (const key of ['webex-web-meeting-bounded', 'webex-web-client-bounded']) {
      const existing = webexOrigin.localStorage.find(item => item?.name === key);
      const parsed = parseStore(key) ?? {};
      if (tokenExpiry(parsed) < bestExp) {
        parsed.Credentials = bestCreds;
        const serialized = JSON.stringify(parsed);
        if (existing) {
          existing.value = serialized;
        } else {
          webexOrigin.localStorage.push({name: key, value: serialized});
        }
        changed = true;
      }
    }

    if (changed) {
      await writeFile(statePath, JSON.stringify(raw, null, 2), 'utf8');
      await chmod(statePath, 0o600).catch(() => {});
    }
    return true;
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

  if (
    (apiUrl.includes('wortlaut.data.mayflower.tech') ||
      apiUrl.includes('wortlaut.data.mayflower.zone')) &&
    await fileExists(prodTokenPath)
  ) {
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
  const apiUrl = (env.WORTLAUT_LIVE_API_URL || 'https://wortlaut.data.mayflower.tech').replace(/\/+$/, '');
  const apiToken = await resolveApiToken(apiUrl, env);

  const rawProviders = (env.PROVIDER || env.WORTLAUT_LIVE_PROVIDERS || 'google_meet,webex,teams,zoom')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const validProviders: Provider[] = [];
  for (const p of rawProviders) {
    if (p === 'google_meet' || p === 'webex' || p === 'teams' || p === 'zoom') {
      validProviders.push(p);
    } else {
      throw new Error(`Unbekannter Provider "${p}". Erlaubt sind: google_meet, webex, teams, zoom`);
    }
  }

  const rawLocales = (env.WORTLAUT_LIVE_SPEAKER_LOCALES || 'de-DE,en-US')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const speakerLocales: [string, string] = [
    rawLocales[0] || 'de-DE',
    rawLocales[1] || rawLocales[0] || 'en-US',
  ];

  const resolveOptionalPath = (p?: string) => (p ? resolve(ROOT_DIR, p) : '');

  return {
    apiUrl,
    apiToken,
    providers: validProviders,
    urls: {
      google_meet: env.WORTLAUT_LIVE_MEET_URL || '',
      webex: env.WORTLAUT_LIVE_WEBEX_URL || '',
      teams: env.WORTLAUT_LIVE_TEAMS_URL || '',
      zoom: env.WORTLAUT_LIVE_ZOOM_URL || '',
    },
    hostStorageState: {
      google_meet: resolveOptionalPath(env.WORTLAUT_LIVE_MEET_HOST_STORAGE_STATE || '.dev/google_meet-host-state.json'),
      webex: resolveOptionalPath(env.WORTLAUT_LIVE_WEBEX_HOST_STORAGE_STATE || '.dev/webex-host-state.json'),
      teams: resolveOptionalPath(env.WORTLAUT_LIVE_TEAMS_HOST_STORAGE_STATE || '.dev/teams-host-state.json'),
      zoom: resolveOptionalPath(env.WORTLAUT_LIVE_ZOOM_HOST_STORAGE_STATE || '.dev/zoom-host-state.json'),
    },
    guestStorageState: {
      google_meet: resolveOptionalPath(env.WORTLAUT_LIVE_MEET_GUEST_STORAGE_STATE),
      webex: '',
      teams: '',
      zoom: resolveOptionalPath(env.WORTLAUT_LIVE_ZOOM_GUEST_STORAGE_STATE),
    },
    speakerCount:
      (env.WORTLAUT_LIVE_VIDEO_ONLY || 'false').toLowerCase() === 'true'
        ? 1
        : Math.max(2, Number(env.WORTLAUT_LIVE_SPEAKER_COUNT || 2)),
    speakerAName: env.WORTLAUT_LIVE_SPEAKER_A_NAME || 'Alice Test',
    speakerBName: env.WORTLAUT_LIVE_SPEAKER_B_NAME || 'Bob Test',
    speakerCName: env.WORTLAUT_LIVE_SPEAKER_C_NAME || 'Clara Test',
    speakerDName: env.WORTLAUT_LIVE_SPEAKER_D_NAME || 'David Late',
    speakerLocales,
    joinTimeoutSeconds: Number(env.WORTLAUT_LIVE_JOIN_TIMEOUT_SECONDS || 120),
    lobbyHoldSeconds: Number(env.WORTLAUT_LIVE_LOBBY_HOLD_SECONDS ?? 12),
    requireLobbyHold: (env.WORTLAUT_LIVE_REQUIRE_LOBBY || 'false').toLowerCase() === 'true',
    testChatOptOut: (env.WORTLAUT_LIVE_TEST_CHAT_OPTOUT || 'true').toLowerCase() !== 'false',
    requireChatOptOut: (env.WORTLAUT_LIVE_REQUIRE_CHAT_OPTOUT || 'false').toLowerCase() === 'true',
    testKeyframes: (env.WORTLAUT_LIVE_TEST_KEYFRAMES || 'true').toLowerCase() !== 'false',
    testVideoDisplay: (env.WORTLAUT_LIVE_TEST_VIDEO_DISPLAY || 'true').toLowerCase() !== 'false',
    requireVideoDisplay: (env.WORTLAUT_LIVE_REQUIRE_VIDEO_DISPLAY || 'false').toLowerCase() === 'true',
    videoOnly: (env.WORTLAUT_LIVE_VIDEO_ONLY || 'false').toLowerCase() === 'true',
    processingTimeoutSeconds: Number(env.WORTLAUT_LIVE_PROCESSING_TIMEOUT_SECONDS || 90),
    requireSpeakerBinding: (env.WORTLAUT_LIVE_REQUIRE_SPEAKER_BINDING || 'true').toLowerCase() !== 'false',
    headed: (env.WORTLAUT_LIVE_HEADED || 'false').toLowerCase() === 'true',
  };
}

/**
 * Starts a sandboxed Chromium process with synthetic media flags and a WAV file
 * fed directly into Chromium's C++ fake audio capture device.
 */
async function launchSpeakerBrowser(
  wavFilePath: string,
  locale = 'de-DE',
  headed = false,
  forceXvfb = false,
): Promise<Browser> {
  if (!headed && !forceXvfb) {
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
    if (forceXvfb || !env.DISPLAY) {
      delete env.WAYLAND_DISPLAY;
    }
    if (process.platform === 'linux' && (forceXvfb || !env.DISPLAY)) {
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
      __wortlautShareActive?: boolean;
      __wortlautShareSlideIndex?: number;
      __wortlautSetShareSlide?: (idx: number) => void;
      __wortlautSwapMeetShareToSlides?: () => Promise<number>;
      __wortlautStopShareStream?: () => void;
    };
    const pcs = new Set<RTCPeerConnection>();
    g.__wortlautPeerConnections = pcs;
    g.__wortlautMicGateOpen = true;
    const isTeams = () =>
      typeof location !== 'undefined' &&
      (location.hostname.includes('teams.microsoft.com') || location.hostname.includes('live.com'));
    const isWebex = () => typeof location !== 'undefined' && location.hostname === 'web.webex.com';
    const isZoom = () =>
      typeof location !== 'undefined' &&
      (location.hostname === 'zoom.us' || location.hostname.endsWith('.zoom.us'));

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
        if ((isTeams() || isZoom()) && stream.getAudioTracks().length > 0) {
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

    let activeShareStream: MediaStream | undefined;
    let nativeShareStream: MediaStream | undefined;
    if (navigator.mediaDevices) {
      const origGetDisplayMedia = navigator.mediaDevices.getDisplayMedia?.bind(navigator.mediaDevices);
      let shareTimer: ReturnType<typeof setInterval> | undefined;
      g.__wortlautShareActive = false;
      g.__wortlautShareSlideIndex = 0;

      const renderSlide = (ctx2d: CanvasRenderingContext2D, idx: number, w = 1280, h = 720) => {
        ctx2d.save();
        ctx2d.scale(w / 1280, h / 720);
        if (idx === 0) {
          ctx2d.fillStyle = '#0f172a';
          ctx2d.fillRect(0, 0, 1280, 720);
          ctx2d.fillStyle = '#38bdf8';
          ctx2d.fillRect(80, 70, 1120, 90);
          ctx2d.fillStyle = '#f8fafc';
          ctx2d.font = 'bold 48px sans-serif';
          ctx2d.fillText('SLIDE 1: SYSTEM ARCHITECTURE', 110, 132);
          ctx2d.fillStyle = '#1e293b';
          ctx2d.fillRect(80, 210, 520, 420);
          ctx2d.fillRect(680, 210, 520, 420);
          ctx2d.fillStyle = '#e2e8f0';
          ctx2d.font = '32px sans-serif';
          ctx2d.fillText('WebRTC Receiver Isolation', 120, 320);
          ctx2d.fillText('Pre-Mix Speaker Streams', 720, 320);
        } else {
          ctx2d.fillStyle = '#f8fafc';
          ctx2d.fillRect(0, 0, 1280, 720);
          ctx2d.fillStyle = '#059669';
          ctx2d.fillRect(0, 0, 1280, 140);
          ctx2d.fillStyle = '#ffffff';
          ctx2d.font = 'bold 52px sans-serif';
          ctx2d.fillText('SLIDE 2: DEPLOYMENT METRICS', 90, 92);
          ctx2d.fillStyle = '#0f172a';
          for (let r = 0; r < 4; r++) {
            ctx2d.fillRect(90, 200 + r * 115, 1100, 75);
          }
        }
        ctx2d.restore();
      };

      g.__wortlautSetShareSlide = (idx: number) => {
        g.__wortlautShareSlideIndex = idx;
      };
      g.__wortlautSwapMeetShareToSlides = async () => {
        const nativeShareVt = nativeShareStream?.getVideoTracks()[0];
        const slideVt = activeShareStream?.getVideoTracks()[0];
        if (!slideVt) return 0;
        let swapped = 0;
        for (const pc of pcs) {
          try {
            for (const sender of pc.getSenders()) {
              if (
                sender.track &&
                sender.track.kind === 'video' &&
                sender.track !== slideVt &&
                sender.track.id !== slideVt.id &&
                (sender.track.id === nativeShareVt?.id ||
                  (Boolean(nativeShareVt?.label) && sender.track.label === nativeShareVt?.label) ||
                  sender.track.getSettings?.().displaySurface !== undefined)
              ) {
                await sender.replaceTrack(slideVt);
                swapped += 1;
              }
            }
          } catch {
            // ignore closed pc
          }
        }
        return swapped;
      };
      g.__wortlautStopShareStream = () => {
        if (shareTimer !== undefined) {
          clearInterval(shareTimer);
          shareTimer = undefined;
        }
        if (activeShareStream) {
          for (const t of activeShareStream.getTracks()) {
            try {
              t.stop();
              t.dispatchEvent(new Event('ended'));
            } catch {
              // ignore
            }
          }
          activeShareStream = undefined;
        }
        if (nativeShareStream) {
          for (const t of nativeShareStream.getTracks()) {
            try {
              t.stop();
              t.dispatchEvent(new Event('ended'));
            } catch {
              // ignore
            }
          }
          nativeShareStream = undefined;
        }
        g.__wortlautShareActive = false;
      };

      navigator.mediaDevices.getDisplayMedia = async (opts?: DisplayMediaStreamOptions) => {
        g.__wortlautStopShareStream?.();
        let targetW = 1280;
        let targetH = 720;
        if (
          typeof location !== 'undefined' &&
          (location.hostname === 'meet.google.com' || isTeams()) &&
          origGetDisplayMedia
        ) {
          try {
            nativeShareStream = await origGetDisplayMedia(opts);
            const nativeSettings = nativeShareStream.getVideoTracks()[0]?.getSettings?.();
            if (nativeSettings?.width && nativeSettings?.height) {
              targetW = nativeSettings.width;
              targetH = nativeSettings.height;
            }
          } catch {
            nativeShareStream = undefined;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx2d = canvas.getContext('2d');
        if (ctx2d) renderSlide(ctx2d, g.__wortlautShareSlideIndex ?? 0, targetW, targetH);

        const TrackGenCtor = (window as unknown as {MediaStreamTrackGenerator?: new (init: {kind: 'video'}) => MediaStreamTrack & {writable: WritableStream<unknown>}}).MediaStreamTrackGenerator;
        const VideoFrameCtor = (window as unknown as {VideoFrame?: new (source: HTMLCanvasElement, init: {timestamp: number}) => {close: () => void}}).VideoFrame;
        let stream: MediaStream;
        if (!isZoom() && typeof TrackGenCtor === 'function' && typeof VideoFrameCtor === 'function') {
          const gen = new TrackGenCtor({kind: 'video'});
          const writer = gen.writable.getWriter();
          const pushFrame = () => {
            if (ctx2d) renderSlide(ctx2d, g.__wortlautShareSlideIndex ?? 0, targetW, targetH);
            try {
              const vf = new VideoFrameCtor(canvas, {timestamp: Math.round(performance.now() * 1000)});
              void writer.write(vf).catch(() => {});
              vf.close();
            } catch {
              // ignore frame after close
            }
          };
          pushFrame();
          shareTimer = setInterval(pushFrame, 100);
          stream = new MediaStream([gen]);
        } else {
          shareTimer = setInterval(() => {
            if (ctx2d) renderSlide(ctx2d, g.__wortlautShareSlideIndex ?? 0, targetW, targetH);
          }, 100);
          stream = canvas.captureStream(10);
        }
        for (const vt of stream.getVideoTracks()) {
          try {
            Object.defineProperty(vt, 'contentHint', {value: 'detail', configurable: true});
            if (isZoom()) {
              const origSettings = vt.getSettings.bind(vt);
              vt.getSettings = () => ({
                ...origSettings(),
                width: targetW,
                height: targetH,
                frameRate: 10,
                displaySurface: 'monitor',
                cursor: 'always',
              }) as MediaTrackSettings;
            }
          } catch {
            // ignore
          }
        }
        activeShareStream = stream;
        g.__wortlautShareActive = true;
        return nativeShareStream ?? stream;
      };
    }

    const syncSenders = () => {
      let count = 0;
      const open = g.__wortlautMicGateOpen !== false;
      if ((isTeams() || isWebex() || isZoom()) && g.__wortlautLastGumTrack) {
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

async function readOutboundAudioStats(page: Page): Promise<{packetsSent: number; bytesSent: number; audioLevel: number}> {
  return page
    .evaluate(async () => {
      let packetsSent = 0;
      let bytesSent = 0;
      let audioLevel = 0;
      const pcs = (window as unknown as {__wortlautPeerConnections?: Set<RTCPeerConnection>}).__wortlautPeerConnections;
      for (const pc of pcs ?? []) {
        try {
          const stats = await pc.getStats();
          stats.forEach((v: Record<string, any>) => {
            if (v.type === 'outbound-rtp' && v.kind === 'audio') {
              packetsSent += Number(v.packetsSent || 0);
              bytesSent += Number(v.bytesSent || 0);
            }
            if (v.type === 'media-source' && v.kind === 'audio' && typeof v.audioLevel === 'number') {
              audioLevel = Math.max(audioLevel, v.audioLevel);
            }
          });
        } catch {
          // ignore closed pc
        }
      }
      return {packetsSent, bytesSent, audioLevel: Math.round(audioLevel * 1000) / 1000};
    })
    .catch(() => ({packetsSent: 0, bytesSent: 0, audioLevel: 0}));
}

async function setSpeakerTransmitting(page: Page, open: boolean): Promise<void> {
  for (const target of page.frames()) {
    try {
      await target.evaluate(isOpen => {
        const fn = (window as unknown as {__wortlautSetMicGate?: (o: boolean) => number}).__wortlautSetMicGate;
        if (fn) fn(isOpen);
      }, open);
      if (open && /^https:\/\/web\.webex\.com\/(?:meetings?|guest-join-meeting)(?:[?#]|$)/.test(target.url())) {
        const unmuteInCall = target.getByRole('button', {
          name: /^Unmute|^(?:Your )?microphone is currently muted|^(?:Ihr )?Mikrofon.*stummgeschaltet|^Stummschaltung aufheben/i,
        });
        if (await unmuteInCall.first().isVisible().catch(() => false)) {
          await unmuteInCall.first().evaluate(el => (el as HTMLElement).click()).catch(() => {});
        }
      }
      if (open && target.url().startsWith('https://meet.google.com/')) {
        const meetUnmute = target
          .getByRole('button', {
            name: /^(Turn on microphone|Mikrofon einschalten|Mikrofon aktivieren)(?: \(.*\))?$/i,
          })
          .or(
            target.locator(
              'button[data-is-muted="true"][aria-label*="Mikrofon" i], button[data-is-muted="true"][aria-label*="microphone" i]',
            ),
          );
        if (await meetUnmute.first().isVisible().catch(() => false)) {
          await page.keyboard.press('Escape').catch(() => {});
          const clicked = await meetUnmute.first().click({timeout: 2000}).then(() => true).catch(() => false);
          if (!clicked || (await meetUnmute.first().isVisible().catch(() => false))) {
            await page.keyboard.press('Control+d').catch(() => {});
          }
          // Re-apply sender track gate in case Meet replaced the audio track on unmute
          await delay(250);
          await target.evaluate(isOpen => {
            const fn = (window as unknown as {__wortlautSetMicGate?: (o: boolean) => number}).__wortlautSetMicGate;
            if (fn) fn(isOpen);
          }, open);
        }
      }
      if (open && /(?:^|\.)zoom\.us$/.test(new URL(target.url() || 'about:blank').hostname)) {
        const zoomUnmute = target.locator(
          'button[aria-label*="unmute my microphone" i], button[aria-label*="Audio-Stummschaltung aufheben" i], button[aria-label*="Stummschaltung aufheben" i]',
        );
        if (await zoomUnmute.first().isVisible().catch(() => false)) {
          await zoomUnmute.first().click({timeout: 2000}).catch(() => {});
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

async function leaveAndCloseBrowser(browser?: Browser): Promise<void> {
  if (!browser) return;
  try {
    for (const ctx of browser.contexts()) {
      for (const page of ctx.pages()) {
        for (const frame of page.frames()) {
          if (frame.url().includes('preload=true')) continue;
          const leaveBtn = frame.locator(
            'button[aria-label*="Anruf verlassen" i], button[aria-label*="Leave call" i], button[aria-label*="Besprechung verlassen" i], button[aria-label*="Leave meeting" i], button[aria-label*="Verlassen" i], button.footer-button-base__button[aria-label*="Leave" i], .footer__leave-btn, button#hangup-button',
          ).or(
            frame.getByRole('button', {
              name: /^(Leave|Leave Meeting|Leave meeting|Verlassen|Meeting verlassen|Meeting verlassen oder Meeting für alle beenden)(?: \(.*\))?$/i,
            }),
          );
          if (await leaveBtn.first().isVisible().catch(() => false)) {
            await leaveBtn.first().click({timeout: 2000, force: true}).catch(() =>
              leaveBtn.first().evaluate(el => (el as HTMLElement).click()).catch(() => {}),
            );
            await delay(300);
            const confirmBtn = frame.locator(
              'button.leave-meeting-options__btn--danger, button.leave-meeting-options__btn',
            ).or(
              frame.getByRole('button', {
                name: /^(End meeting for all|End meeting|Meeting für alle beenden|Meeting beenden|Leave Meeting|Leave meeting|Meeting verlassen)$/i,
              }),
            );
            if (await confirmBtn.first().isVisible().catch(() => false)) {
              await confirmBtn.first().click({timeout: 2000, force: true}).catch(() =>
                confirmBtn.first().evaluate(el => (el as HTMLElement).click()).catch(() => {}),
              );
            }
            await delay(500);
            break;
          }
        }
      }
    }
  } catch {
    // ignore teardown navigation errors
  }
  await browser.close().catch(() => {});
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
async function saveJoinDiagnostic(page: Page, provider: Provider, tag: string): Promise<string> {
  const out = resolve(ROOT_DIR, `.dev/live-e2e-${provider}-${tag}.png`);
  try {
    await mkdir(dirname(out), {recursive: true});
    await page.screenshot({path: out, timeout: 10000, animations: 'disabled'});
  } catch (err) {
    return `(screenshot unavailable: ${err instanceof Error ? err.message.slice(0, 80) : String(err)})`;
  }
  return out;
}

async function joinRoomAsSpeaker(
  page: Page,
  provider: Provider,
  meetingUrl: string,
  displayName: string,
  timeoutSec: number,
  evictExistingSession = false,
  useWebexHostDashboard = false,
): Promise<void> {
  const hardTimeoutMs = (timeoutSec + 20) * 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      joinRoomAsSpeakerInner(
        page,
        provider,
        meetingUrl,
        displayName,
        timeoutSec,
        evictExistingSession,
        useWebexHostDashboard,
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `Hard-Timeout (${Math.round(hardTimeoutMs / 1000)}s) beim Beitritt von "${displayName}" zu ${provider} (url=${redactMeetingUrl(page.url())})`,
            ),
          );
        }, hardTimeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function joinRoomAsSpeakerInner(
  page: Page,
  provider: Provider,
  meetingUrl: string,
  displayName: string,
  timeoutSec: number,
  evictExistingSession = false,
  useWebexHostDashboard = false,
): Promise<void> {
  let initialUrl = meetingUrl;
  if (
    provider === 'webex' &&
    useWebexHostDashboard &&
    /^https:\/\/[^/]+\.webex\.com\/meet\//i.test(meetingUrl)
  ) {
    initialUrl = 'https://web.webex.com/meetings';
  } else if (provider === 'zoom') {
    try {
      const parsed = new URL(meetingUrl);
      const joinMatch = parsed.pathname.match(/^\/[js]\/([0-9]{9,11})\/?$/);
      if (joinMatch) {
        parsed.pathname = `/wc/${joinMatch[1]}/join`;
        initialUrl = parsed.toString();
      }
    } catch {
      // keep original meetingUrl
    }
  }
  await page.goto(initialUrl, {waitUntil: 'domcontentloaded', timeout: 45000});
  const deadline = Date.now() + timeoutSec * 1000;

    if (provider === 'google_meet') {
    const enterMillis = Date.now();
    const meetWaitingRe =
      /Please wait until a meeting host brings you into the call|invited to the call by the (?:meeting )?organizer|Asking to be let in|You[’']ll join the call when someone lets you|Someone in the call (?:will|can) let you in|Waiting (?:for the host|to be let in)|Host hasn[’']t joined yet|Messages from the organizer|Chat is unavailable|Um Teilnahme (?:gebeten|bitten)|Teilnahme wird angefragt|(?:Sie|Du)\s+(?:können|kannst|nehmen|nimmst)\s+teil(?:nehmen)?,\s*sobald|Jemand.*(?:(?:lässt|lassen)\s+(?:Sie|dich).*(?:ein|teilnehmen)|kann\s+(?:Sie|dich).*einlassen)|Bitte warten(?:\s+Sie)?,\s*bis.*(?:einlässt|eingeladen)|vom Organisator.*eingeladen|Nachrichten vom Organisator|Chat nicht verfügbar|noch nicht eingelassen/i;
    while (Date.now() < deadline) {
      if (/^https:\/\/accounts\.google\.com\//i.test(page.url())) {
        const shot = await saveJoinDiagnostic(page, 'google_meet', 'auth-required');
        throw new Error(
          `Google Meet Host-Session abgelaufen (Redirect auf accounts.google.com). Bitte "PROVIDER=google_meet make test-live-login" ausführen (Screenshot: ${shot}).`,
        );
      }
      // Check if already in call (NOT in knocking lobby, which also renders a Leave button!)
      const leaveCss = page.locator(
        'button[aria-label*="Anruf verlassen" i], button[aria-label*="Leave call" i], button[aria-label*="Besprechung verlassen" i], button[aria-label*="Leave meeting" i]',
      );
      const inCallToolbar = page
        .locator('button[data-panel-id="1"], button[data-panel-id="2"]:not([aria-label*="Organisator" i]):not([aria-label*="organizer" i]):not([aria-label*="Host" i]):not([aria-label*="Gastgeber" i])')
        .or(
          page.getByRole('button', {
            name: /^(?:People|Participants|Show everyone|Alle anzeigen|Teilnehmer|Personen|Chat with everyone|Mit allen chatten|In-call messages|Nachrichten im Anruf|Raise hand|Hand heben)(?:\b|\s|\d|$)/i,
          }),
        );
      const waitingVisible = await page.getByText(meetWaitingRe).first().isVisible().catch(() => false);
      if (
        !waitingVisible &&
        (await leaveCss.first().isVisible().catch(() => false)) &&
        (await inCallToolbar.first().isVisible().catch(() => false))
      ) {
        await page.keyboard.press('Escape').catch(() => {});
        const inCallUnmute = page
          .getByRole('button', {
            name: /^(Turn on microphone|Mikrofon einschalten|Mikrofon aktivieren)(?: \(.*\))?$/i,
          })
          .or(
            page.locator(
              'button[data-is-muted="true"][aria-label*="Mikrofon" i], button[data-is-muted="true"][aria-label*="microphone" i]',
            ),
          );
        if (await inCallUnmute.first().isVisible().catch(() => false)) {
          const clicked = await inCallUnmute.first().click({timeout: 3000}).then(() => true).catch(() => false);
          if (!clicked || (await inCallUnmute.first().isVisible().catch(() => false))) {
            await page.keyboard.press('Control+d').catch(() => {});
          }
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
        if (evictExistingSession) {
          await switchHereBtn.first().click({timeout: 5000}).catch(() => {});
          await delay(3000);
          continue;
        }
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
    const shot = await saveJoinDiagnostic(page, 'google_meet', 'join-timeout');
    const preview = (await page.locator('body').innerText({timeout: 2000}).catch(() => ''))
      .replace(/\s+/g, ' ')
      .slice(0, 220);
    throw new Error(
      `Timeout beim Beitritt von "${displayName}" zu Google Meet (${meetingUrl}, url=${redactMeetingUrl(page.url())}, screenshot=${shot}, text="${preview}")`,
    );
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
        .filter(f => /^https:\/\/web\.webex\.com\/(?:meetings?|guest-join-meeting)(?:[?#]|$)/.test(f.url()));
      const frame = matchingFrames[matchingFrames.length - 1] || page.mainFrame();

      const snap = await frame.locator('body').ariaSnapshot().catch(() => '');
      const waitingInLobby = webexWaitingRe.test(snap);
      const stillConnecting = /Verbindung wird hergestellt|Connecting|Audio wird verbunden/i.test(snap);
      if (waitingInLobby) {
        sawWaitingInLobby = true;
      }

      const joinBtn = frame
        .locator('#join-button')
        .or(
          frame.getByRole('button', {
            name: /^(?:Join meeting(?:\s|$)|Meeting\b.*beitreten|Start meeting(?:\s|$)|Meeting\b.*starten)/i,
          }),
        );
      const joinVisible = await joinBtn.first().isVisible().catch(() => false);

      const inCallControls = frame.getByRole('button', {
        name: /^(Leave meeting|Leave|End meeting|Meeting verlassen|Meeting beenden|Meeting verlassen oder Meeting für alle beenden|Verlassen|Teilnehmerbereich.*|Participants.*|Chat anzeigen|Show chat)(?:\s|$)/i,
      });
      if (
        !joinVisible &&
        !waitingInLobby &&
        !stillConnecting &&
        (await inCallControls.first().isVisible().catch(() => false))
      ) {
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

      if (!page.url().startsWith('https://web.webex.com/')) {
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
      }

      if (frame !== page.mainFrame() || page.url().startsWith('https://web.webex.com/meetings')) {
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

      if (!joinVisible && page.url().startsWith('https://web.webex.com/meetings')) {
        const dashboardStartBtn = page.getByRole('button', {
          name: /^(Starten|Start|Start a meeting)$/i,
        });
        if (await dashboardStartBtn.first().isVisible().catch(() => false)) {
          await dashboardStartBtn
            .first()
            .click({timeout: 3000})
            .catch(() => dashboardStartBtn.first().evaluate(el => (el as HTMLElement).click()).catch(() => {}));
          await delay(2500);
          continue;
        }
      }

      if (joinVisible) {
        const nameInput = frame.getByRole('textbox', {name: /^(Name|Your name|Ihr Name)$/i});
        if (await nameInput.first().isVisible().catch(() => false)) {
          await nameInput.first().fill(displayName, {timeout: 2000}).catch(() => {});
          await delay(300);
        }
        const stopVideo = frame.getByRole('button', {
          name: /^Stop video|^Video beenden|^Sending video is currently enabled|^(?:Senden von )?Video.*aktiviert/i,
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

  if (provider === 'zoom') {
    const zoomWaitingRe =
      /Please wait, the meeting host will let you in soon|Waiting for the host to start|Waiting Room|Host has joined\. We've let them know you're here|Bitte warten Sie, der Host lässt Sie in Kürze ein|Warten auf den Beginn des Meetings|Warteraum/i;
    const zoomBlockedRe =
      /automated bots aren['’]t allowed|verify you are human|sign in to join|anmelden, um (?:dem meeting )?beizutreten/i;
    let joinClicked = false;
    while (Date.now() < deadline) {
      const bodyText = await page.locator('body').innerText({timeout: 3000}).catch(() => '');
      const hasCaptchaChallenge = await page
        .locator('iframe[title*="recaptcha challenge" i], iframe[src*="hcaptcha.com/captcha" i], iframe[src*="arkoselabs" i]')
        .first()
        .isVisible()
        .catch(() => false);
      if (hasCaptchaChallenge || zoomBlockedRe.test(bodyText)) {
        const shot = await saveJoinDiagnostic(page, 'zoom', 'join-blocked');
        throw new Error(
          `Zoom blockiert den automatisierten Beitritt für "${displayName}" (CAPTCHA/Anmeldepflicht; Screenshot: ${shot}).`,
        );
      }
      const leaveVisible = await page
        .getByRole('button', {name: /^(Leave|Leave Meeting|Leave meeting|Verlassen|Meeting verlassen)(?: \(.*\))?$/i})
        .first()
        .isVisible()
        .catch(() => false);
      if (joinClicked && leaveVisible && !zoomWaitingRe.test(bodyText)) {
        const joinAudio = page
          .locator(
            'button.join-audio-by-voip__join-btn, button[aria-label*="Join Audio by Computer" i], button[aria-label*="Per Computeraudio teilnehmen" i]',
          )
          .or(
            page.getByRole('button', {
              name: /^(Join Audio by Computer|Join Audio|Per Computeraudio teilnehmen|Computeraudio beitreten)$/i,
            }),
          );
        await clickIfVisible(joinAudio);
        const unmuteBtn = page.locator(
          'button[aria-label*="unmute my microphone" i], button[aria-label*="Audio-Stummschaltung aufheben" i], button[aria-label*="Stummschaltung aufheben" i]',
        );
        await clickIfVisible(unmuteBtn);
        return;
      }

      const dismiss = page
        .locator('#onetrust-accept-btn-handler')
        .or(page.getByRole('button', {name: /^(Accept Cookies|Agree|I Agree|Got it|OK|Verstanden|Zustimmen|Akzeptieren)$/i}));
      await clickIfVisible(dismiss);

      const launchWeb = page.locator('#wc-footer a, a[href*="/wc/"]').or(
        page.getByRole('link', {name: /Join from your browser|Join from browser|Im Browser beitreten|Über Browser teilnehmen/i}),
      );
      if (!page.url().includes('/wc/') && (await clickIfVisible(launchWeb))) {
        await delay(1000);
        continue;
      }

      if (zoomWaitingRe.test(bodyText)) {
        await delay(1000);
        continue;
      }

      const nameInput = page
        .locator('#input-for-name, #inputname, input[name="inputname"]')
        .or(page.getByRole('textbox', {name: /^(Your Name|Name|Ihr Name|Geben Sie Ihren Namen ein)$/i}));
      if (await nameInput.first().isVisible().catch(() => false)) {
        await nameInput.first().fill(displayName, {timeout: 3000}).catch(() => {});
      }

      const joinBtn = page
        .locator('button.preview-join-button:not([disabled]), #joinBtn:not([disabled])')
        .or(page.getByRole('button', {name: /^(Join|Beitreten|Teilnehmen)$/i}));
      if (await joinBtn.first().isVisible().catch(() => false)) {
        await joinBtn.first().click({timeout: 3000}).catch(() => {});
        joinClicked = true;
        await delay(1500);
        continue;
      }
      await delay(1000);
    }
    const shot = await saveJoinDiagnostic(page, 'zoom', 'join-timeout');
    const preview = (await page.locator('body').innerText({timeout: 2000}).catch(() => ''))
      .replace(/\s+/g, ' ')
      .slice(0, 220);
    throw new Error(
      `Timeout beim Beitritt von "${displayName}" zu Zoom (${redactMeetingUrl(meetingUrl)}, url=${redactMeetingUrl(page.url())}, screenshot=${shot}, text="${preview}")`,
    );
  }
}

/**
 * Non-destructively checks whether the Host page currently displays a knocking /
 * waiting-room admission prompt without clicking Admit.
 */
async function hasPendingLobbyPrompt(page: Page, provider: Provider): Promise<boolean> {
  const admitRe =
    /\b(Admit|Admit all|Let in|Zulassen|Alle zulassen|Einlassen|Hereinlassen|Alle hereinlassen|View lobby|Wartebereich anzeigen|Gast\s+wartet|Gäste\s+warten|guests?\s+waiting)\b/i;
  const denyRe = /\b(Deny|Reject|Ablehnen|Nicht zulassen|Ignorieren|Untertitel|caption)\b/i;
  try {
    if (provider === 'teams') {
      const teamsPrompt = page.locator(
        '[data-tid="lobby-popup-view-lobby-btn"], button[aria-label*="Admit" i], button[aria-label*="Zulassen" i], button[aria-label*="Einlassen" i], button[data-tid*="admit" i]:not([data-tid="admit-suspected-cancel-button"])',
      );
      return await teamsPrompt.first().isVisible().catch(() => false);
    }
    if (provider === 'webex') {
      const matchingFrames = page
        .frames()
        .filter(f => /^https:\/\/web\.webex\.com\/(?:meetings?|guest-join-meeting)(?:[?#]|$)/.test(f.url()));
      const frame = matchingFrames[matchingFrames.length - 1];
      if (!frame) return false;
      return await frame
        .getByRole('button', {name: /^(Admit|Admit all|Hereinlassen|Alle hereinlassen|Einlassen|Zulassen|Einblenden|Show)$/i})
        .first()
        .isVisible()
        .catch(() => false);
    }
    for (const target of [page, ...page.frames()]) {
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
        if (!denyRe.test(label)) return true;
      }
    }
  } catch {
    // ignore transient DOM updates
  }
  return false;
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
            .filter(f => /^https:\/\/web\.webex\.com\/(?:meetings?|guest-join-meeting)(?:[?#]|$)/.test(f.url()));
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
              name: /^(?:Teilnehmerbereich öffnen|Teilnehmer anzeigen|Open participants|Show participants)(?:\b|\s|$)/i,
            }).and(frame.locator(':not([aria-expanded="true"]):not([aria-pressed="true"])'));
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

        if (provider === 'zoom') {
          const admitZoomBtn = page.getByRole('button', {
            name: /^(Admit|Admit all|Zulassen|Alle zulassen|Einlassen)$/i,
          });
          if (await admitZoomBtn.first().isVisible().catch(() => false)) {
            console.log(`      [Lobby-Watcher] Lasse Teilnehmer aus Zoom-Warteraum zu...`);
            await admitZoomBtn.first().click({timeout: 2000}).catch(() => {});
            await delay(500);
            continue;
          }
          const rosterBtn = page
            .locator('button[aria-label*="Participants" i], button[aria-label*="Teilnehmer" i], .footer-button__participants-icon')
            .first();
          const rosterPanel = page.locator('.participants-section-container, #participants-list');
          if (!(await rosterPanel.first().isVisible().catch(() => false)) && (await rosterBtn.isVisible().catch(() => false))) {
            await rosterBtn.click({timeout: 2000}).catch(() => {});
            await delay(500);
            continue;
          }
        }

        const targets: (Page | Frame)[] = [page, ...page.frames()];
        let clickedAdmit = false;
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
            console.log(`      [Lobby-Watcher] Klicke Einlass-Button (${label.trim().replace(/\s+/g, ' ').slice(0, 50)})...`);
            await btn.click({timeout: 2000, force: true}).catch(() => {});
            clickedAdmit = true;
          }
        }
        if (!clickedAdmit && provider === 'google_meet') {
          const dialogOk = page
            .locator('[role="dialog"] button, [role="dialog"] [role="button"]')
            .filter({hasText: /^(OK|Got it|Verstanden)$/i})
            .first();
          if (await dialogOk.isVisible().catch(() => false)) {
            await dialogOk.click({timeout: 1500, force: true}).catch(() => {});
          }
          const waitingPill = page
            .locator('button, [role="button"]')
            .filter({hasText: /\b(?:Gast\s+wartet|Gäste\s+warten|guests?\s+waiting|person_add)\b/i})
            .first();
          if (await waitingPill.isVisible().catch(() => false)) {
            console.log(`      [Lobby-Watcher] Öffne Google-Meet-Warteraum über Gast-wartet-Pill...`);
            await waitingPill.click({timeout: 2000, force: true}).catch(() => {});
            await delay(500);
            continue;
          }
          const peopleToggle = page
            .locator('button[data-panel-id="1"]')
            .or(
              page.getByRole('button', {
                name: /^(?:People|Participants|Show everyone|Alle anzeigen|Teilnehmer|Personen)(?:\b|\s|\d|$)/i,
              }),
            )
            .and(page.locator(':not([aria-expanded="true"]):not([aria-pressed="true"])'))
            .first();
          if (await peopleToggle.isVisible().catch(() => false)) {
            console.log(`      [Lobby-Watcher] Öffne Google-Meet-Teilnehmerleiste für Warteraum-Einlass...`);
            await peopleToggle.click({timeout: 2000, force: true}).catch(() => {});
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
    webex: 'https://web.webex.com/meetings',
    teams: config.urls.teams || 'https://teams.microsoft.com/',
    zoom: config.urls.zoom || 'https://zoom.us/signin',
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
    if (provider === 'webex') {
      await syncWebexHostStateFile(outPath);
    }
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
  let res: Response | undefined;
  let lastFetchErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await fetch(`${config.apiUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      break;
    } catch (err) {
      lastFetchErr = err;
      if (attempt < 2 && (method === 'GET' || Boolean(extraHeaders?.['Idempotency-Key']))) {
        await delay(500 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
  if (!res) throw lastFetchErr;
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

/**
 * Sends a live in-call chat message (e.g. "no") from a participant browser across
 * Google Meet, Microsoft Teams, Webex, or Zoom (DE + EN locales).
 */
async function sendMeetingChatMessage(page: Page, provider: Provider, message: string): Promise<boolean> {
  try {
    if (provider === 'google_meet') {
      await page.keyboard.press('Escape').catch(() => {});
      const chatInput = page
        .getByRole('textbox', {name: /Send a message|Nachricht.*senden/i})
        .or(
          page.locator(
            'textarea[aria-label*="message" i], textarea[aria-label*="Nachricht" i], ' +
              '[contenteditable="true"][aria-label*="message" i], [contenteditable="true"][aria-label*="Nachricht" i]',
          ),
        );
      if (!(await chatInput.first().isVisible().catch(() => false))) {
        const toggle = page
          .locator('button[data-panel-id="2"]:not([aria-expanded="true"]):not([aria-pressed="true"])')
          .or(page.getByRole('button', {name: /^(Chat with everyone|Chat|Mit allen chatten|Nachrichten im Anruf)$/i}));
        if (await toggle.first().isVisible().catch(() => false)) {
          const clicked = await toggle.first().click({timeout: 1500}).then(() => true).catch(() => false);
          if (!clicked) {
            await toggle.first().evaluate((el: HTMLElement) => el.click()).catch(() => {});
          }
          await chatInput.first().waitFor({state: 'visible', timeout: 3000}).catch(() => {});
        }
      }
      if (await chatInput.first().isVisible().catch(() => false)) {
        await chatInput.first().fill(message, {timeout: 3000});
        const sendBtn = page.getByRole('button', {name: /^(Send a message|Send|Nachricht senden|Senden)$/i});
        if (await sendBtn.first().isVisible().catch(() => false)) {
          const sent = await sendBtn.first().click({timeout: 1500}).then(() => true).catch(() => false);
          if (!sent) {
            await sendBtn.first().evaluate((el: HTMLElement) => el.click()).catch(() => {});
          }
        } else {
          await chatInput.first().press('Enter').catch(() => {});
        }
        return true;
      }
      return false;
    }

    if (provider === 'teams') {
      const chatBox = page
        .locator('[data-tid="ckeditor"], div[role="textbox"][contenteditable="true"]')
        .or(page.getByRole('textbox', {name: /Type a message|Nachricht eingeben|Neue Nachricht/i}));
      if (!(await chatBox.first().isVisible().catch(() => false))) {
        const toggle = page
          .locator('#chat-button')
          .or(page.getByRole('button', {name: /^(Chat|Show conversation|Unterhaltung anzeigen)$/i}));
        if (await toggle.first().isVisible().catch(() => false)) {
          await toggle.first().click({timeout: 3000}).catch(() => {});
          await delay(1000);
        }
      }
      if (await chatBox.first().isVisible().catch(() => false)) {
        await chatBox.first().click({timeout: 2000}).catch(() => {});
        await chatBox.first().fill(message, {timeout: 3000}).catch(async () => {
          await page.keyboard.type(message);
        });
        const sendBtn = page
          .locator('button[data-tid="newMessageCommands-send"]')
          .or(page.getByRole('button', {name: /^(Send|Senden)$/i}));
        if (await sendBtn.first().isVisible().catch(() => false)) {
          await sendBtn.first().click({timeout: 3000}).catch(() => {});
        } else {
          await page.keyboard.press('Enter').catch(() => {});
        }
        return true;
      }
      return false;
    }

    if (provider === 'webex') {
      const matchingFrames = page
        .frames()
        .filter(f => /^https:\/\/web\.webex\.com\/(?:meetings?|guest-join-meeting)(?:[?#]|$)/.test(f.url()));
      const frame = matchingFrames[matchingFrames.length - 1] || page.mainFrame();
      const chatInput = frame
        .getByRole('textbox', {name: /message|Nachricht|Chat/i})
        .or(frame.locator('textarea, div[role="textbox"][contenteditable="true"]'));
      if (!(await chatInput.first().isVisible().catch(() => false))) {
        const toggle = frame
          .getByRole('button', {
            name: /^(?:Chat|Show chat|Open chat|Chat öffnen|Chat anzeigen|Chatbereich öffnen)(?:\b|\s|$)/i,
          })
          .and(frame.locator(':not([aria-expanded="true"]):not([aria-pressed="true"])'));
        if (await toggle.first().isVisible().catch(() => false)) {
          await toggle.first().evaluate(el => (el as HTMLElement).click()).catch(() => {});
          await chatInput.first().waitFor({state: 'visible', timeout: 2500}).catch(() => {});
        }
      }
      if (await chatInput.first().isVisible().catch(() => false)) {
        await chatInput.first().fill(message, {timeout: 3000}).catch(async () => {
          await chatInput.first().click({timeout: 2000}).catch(() => {});
          await page.keyboard.type(message);
        });
        await chatInput.first().press('Enter').catch(() => {});
        return true;
      }
      return false;
    }

    if (provider === 'zoom') {
      const chatInput = page
        .locator('.chat-box__chat-textarea, textarea[placeholder*="message" i], textarea[placeholder*="Nachricht" i]')
        .or(page.getByRole('textbox', {name: /Type message|Nachricht eingeben|Chat/i}));
      if (!(await chatInput.first().isVisible().catch(() => false))) {
        const toggle = page
          .locator('button[aria-label*="open the chat" i], button[aria-label*="Chat" i], .footer-button__chat-icon')
          .first();
        if (await toggle.isVisible().catch(() => false)) {
          await toggle.click({timeout: 3000}).catch(() => {});
          await delay(800);
        }
      }
      if (await chatInput.first().isVisible().catch(() => false)) {
        await chatInput.first().fill(message, {timeout: 3000});
        await chatInput.first().press('Enter').catch(() => {});
        return true;
      }
      return false;
    }
  } catch {
    return false;
  }
  return false;
}

async function setParticipantCamera(page: Page, provider: Provider, enabled: boolean): Promise<boolean> {
  try {
    if (provider === 'zoom') {
      const btn = enabled
        ? page
            .locator(
              'button.send-video-container__btn[aria-label*="Start Video" i], button[aria-label^="Start Video" i], button[aria-label^="Video starten" i]',
            )
            .or(page.getByRole('button', {name: /^(Start Video|Video starten)(?: \(.*\))?$/i}))
        : page
            .locator(
              'button.send-video-container__btn[aria-label*="Stop Video" i], button[aria-label^="Stop Video" i], button[aria-label^="Video beenden" i]',
            )
            .or(page.getByRole('button', {name: /^(Stop Video|Video beenden|Video stoppen)(?: \(.*\))?$/i}));
      if (await btn.first().isVisible().catch(() => false)) {
        await btn.first().click({timeout: 3000}).catch(() => {});
        return true;
      }
      return false;
    }
    if (provider === 'google_meet') {
      const btn = enabled
        ? page.getByRole('button', {name: /^(Turn on camera|Kamera einschalten|Kamera aktivieren)(?: \(.*\))?$/i})
        : page.getByRole('button', {name: /^(Turn off camera|Kamera ausschalten|Kamera deaktivieren)(?: \(.*\))?$/i});
      if (await btn.first().isVisible().catch(() => false)) {
        await btn.first().click({timeout: 3000}).catch(() => {});
        return true;
      }
      return false;
    }
    if (provider === 'teams') {
      const btn = page.locator('#video-button').or(
        page.getByRole('button', {
          name: enabled
            ? /^(Turn camera on|Camera off|Kamera einschalten)(?: \(.*\))?$/i
            : /^(Turn camera off|Camera on|Kamera ausschalten)(?: \(.*\))?$/i,
        }),
      );
      if (await btn.first().isVisible().catch(() => false)) {
        await btn.first().click({timeout: 3000}).catch(() => {});
        return true;
      }
      return false;
    }
    if (provider === 'webex') {
      const matchingFrames = page
        .frames()
        .filter(f => /^https:\/\/web\.webex\.com\/(?:meetings?|guest-join-meeting)(?:[?#]|$)/.test(f.url()));
      const frame = matchingFrames[matchingFrames.length - 1];
      if (!frame) return false;
      const btn = frame.getByRole('button', {
        name: enabled ? /^Start video|^Video starten/i : /^Stop video|^Video beenden|^Video stoppen/i,
      });
      if (await btn.first().isVisible().catch(() => false)) {
        await btn.first().click({timeout: 3000}).catch(() => {});
        return true;
      }
      return false;
    }
  } catch {
    return false;
  }
  return false;
}

async function isSyntheticShareActive(page: Page): Promise<boolean> {
  for (const frame of [page.mainFrame(), ...page.frames()]) {
    try {
      const active = await frame.evaluate(
        () => Boolean((window as unknown as {__wortlautShareActive?: boolean}).__wortlautShareActive),
      );
      if (active) return true;
    } catch {
      // ignore cross-origin frames
    }
  }
  return false;
}

async function setSyntheticShareSlide(page: Page, slideIdx: number): Promise<void> {
  for (const frame of [page.mainFrame(), ...page.frames()]) {
    try {
      await frame.evaluate(idx => {
        (window as unknown as {__wortlautSetShareSlide?: (n: number) => void}).__wortlautSetShareSlide?.(idx);
      }, slideIdx);
    } catch {
      // ignore
    }
  }
}

async function stopSyntheticScreenShare(page: Page, provider: Provider): Promise<void> {
  for (const frame of [page.mainFrame(), ...page.frames()]) {
    try {
      await frame.evaluate(() => {
        (window as unknown as {__wortlautStopShareStream?: () => void}).__wortlautStopShareStream?.();
      });
    } catch {
      // ignore
    }
  }
  if (provider === 'zoom') {
    const stopBtn = page
      .locator('button[aria-label*="Stop Share" i], button[aria-label*="Freigabe beenden" i], button[aria-label*="Stoppen" i]')
      .or(page.getByRole('button', {name: /^(Stop Share|Freigabe beenden|Freigabe stoppen)$/i}));
    await clickIfVisible(stopBtn);
  } else if (provider === 'google_meet') {
    const stopBtn = page
      .locator('button[aria-label*="Präsentation beenden" i], button[aria-label*="Stop presenting" i], button[aria-label*="Stop sharing" i]')
      .or(page.locator('button').filter({hasText: /(Präsentation beenden|Stop presenting|Stop sharing)/i}));
    await clickIfVisible(stopBtn);
  } else if (provider === 'teams') {
    const stopBtn = page
      .locator('button[aria-label*="Teilen beenden" i], button[aria-label*="Stop sharing" i], button[aria-label*="Stop presenting" i]')
      .or(page.getByRole('button', {name: /^(Stop sharing|Stop presenting|Teilen beenden|Freigabe beenden)(?: \(.*\))?$/i}));
    await clickIfVisible(stopBtn);
  }
}

async function startSyntheticScreenShare(page: Page, provider: Provider): Promise<boolean> {
  await setSyntheticShareSlide(page, 0);
  try {
    if (provider === 'zoom') {
      await page.mouse.move(640, 680).catch(() => {});
      await delay(300);
      const shareBtn = page
        .locator(
          'button[aria-label*="Share Screen" i], button[aria-label*="Bildschirm freigeben" i], .footer-button__share-icon',
        )
        .or(page.getByRole('button', {name: /^(Share Screen|Share|Bildschirm freigeben)(?: \(.*\))?$/i}));
      if (await shareBtn.first().isVisible().catch(() => false)) {
        await shareBtn.first().click({timeout: 3000}).catch(() => {});
        await delay(1500);
        if (await isSyntheticShareActive(page)) return true;
        // Zoom Web Client may show a secondary "Share" / "Screen" modal button
        const modalShare = page
          .locator('.share-option-modal button, [role="dialog"] button')
          .filter({hasText: /^(Share|Share Screen|Screen|Freigeben|Bildschirm)$/i});
        if (await modalShare.first().isVisible().catch(() => false)) {
          await modalShare.first().click({timeout: 3000}).catch(() => {});
          await delay(1500);
        }
        return await isSyntheticShareActive(page);
      }
      return false;
    }
    if (provider === 'google_meet') {
      const okBtn = page.locator('button').filter({hasText: /^(OK|Ok|Verstanden|Got it|Schließen|Dismiss)$/i});
      if (await okBtn.first().isVisible().catch(() => false)) {
        await okBtn.first().click({timeout: 1500}).catch(() => {});
        await delay(300);
      }
      await page.keyboard.press('Escape').catch(() => {});
      const presentBtn = page
        .locator(
          'button[aria-label*="Bildschirm teilen" i], button[aria-label*="Share screen" i], ' +
            'button[aria-label*="Present now" i], button[aria-label*="Jetzt präsentieren" i]',
        )
        .or(
          page.getByRole('button', {
            name: /Present now|Share screen|Jetzt präsentieren|Bildschirm teilen/i,
          }),
        );
      if (await presentBtn.first().isVisible().catch(() => false)) {
        await presentBtn.first().click({timeout: 3000}).catch(() =>
          presentBtn.first().evaluate((el) => (el as HTMLElement).click()),
        );
        await delay(1000);
        if (!(await isSyntheticShareActive(page))) {
          const entireScreen = page.getByRole('menuitem', {
            name: /Your entire screen|Entire screen|A window|Gesamter Bildschirm|Ein Fenster/i,
          });
          if (await entireScreen.first().isVisible().catch(() => false)) {
            await entireScreen.first().click({timeout: 3000}).catch(() => {});
            await delay(1500);
          }
        }
        if (await isSyntheticShareActive(page)) {
          const shareAnyway = page.locator('button').filter({
            hasText:
              /Bildschirmübertragung trotzdem starten|Trotzdem teilen|Share screen anyway|Present anyway|Share anyway/i,
          });
          for (let w = 0; w < 10; w++) {
            if (await shareAnyway.first().isVisible().catch(() => false)) {
              await shareAnyway.first().click({timeout: 3000}).catch(() =>
                shareAnyway.first().evaluate((el) => (el as HTMLElement).click()),
              );
              break;
            }
            await delay(500);
          }
          await delay(2000);
          await page.evaluate(() => {
            return (window as unknown as {__wortlautSwapMeetShareToSlides?: () => Promise<number>})
              .__wortlautSwapMeetShareToSlides?.();
          });
          return true;
        }
      }
      return false;
    }
    if (provider === 'teams') {
      const shareBtn = page
        .locator('#screenshare-button, #share-button, button[data-tid="share-screen-button"]')
        .or(page.getByRole('button', {name: /^(Share|Teilen|Inhalt teilen)(?: \(.*\))?$/i}));
      if (await shareBtn.first().isVisible().catch(() => false)) {
        await shareBtn.first().click({timeout: 3000}).catch(() => {});
        await delay(1500);
        if (!(await isSyntheticShareActive(page))) {
          const screenOpt = page
            .locator('[data-tid*="share-screen"], button, [role="menuitem"]')
            .filter({hasText: /Screen, window, or tab|Screen|Window|Bildschirm|Fenster/i});
          if (await screenOpt.first().isVisible().catch(() => false)) {
            await screenOpt.first().click({timeout: 3000}).catch(() => {});
            await delay(1500);
          }
        }
        if (await isSyntheticShareActive(page)) {
          await delay(2000);
          await page.evaluate(() => {
            return (window as unknown as {__wortlautSwapMeetShareToSlides?: () => Promise<number>})
              .__wortlautSwapMeetShareToSlides?.();
          });
          return true;
        }
        return false;
      }
      return false;
    }
    if (provider === 'webex') {
      const matchingFrames = page
        .frames()
        .filter(f => /^https:\/\/web\.webex\.com\/(?:meetings?|guest-join-meeting)(?:[?#]|$)/.test(f.url()));
      const frame = matchingFrames[matchingFrames.length - 1];
      if (!frame) return false;
      const shareBtn = frame.getByRole('button', {name: /^(Share|Share content|Teilen|Inhalte teilen)/i});
      if (await shareBtn.first().isVisible().catch(() => false)) {
        await shareBtn.first().click({timeout: 3000}).catch(() => {});
        await delay(1500);
        if (await isSyntheticShareActive(page)) return true;
        const shareScreenOpt = frame.getByRole('button', {name: /Share screen|Screen|Bildschirm teilen|Bildschirm/i});
        if (await shareScreenOpt.first().isVisible().catch(() => false)) {
          await shareScreenOpt.first().click({timeout: 3000}).catch(() => {});
          await delay(1500);
        }
        return await isSyntheticShareActive(page);
      }
      return false;
    }
  } catch {
    return false;
  }
  return false;
}

interface BotVideoDisplayObservation {
  receivingVideo: boolean;
  inboundVideoFramesDecoded: number;
  inboundVideoPacketsReceived: number;
  inboundVideoBytesReceived: number;
  inboundFrameWidth: number;
  inboundFrameHeight: number;
  decodedVideoElements: number;
  maxVideoWidth: number;
  maxVideoHeight: number;
  videoNonBlackRatio: number;
  zoomOrCanvasVideoSurfaces: number;
  botTileDomVisible: boolean;
  compositorNonBlackRatio: number;
  compositorSlateAccentRatio: number;
  stageSignature: number[];
  screenshotPath: string | null;
}

function countLumaSignatureChanges(a: number[], b: number[], threshold = 10): number {
  const len = Math.min(a.length, b.length);
  let changed = 0;
  for (let i = 0; i < len; i++) {
    if (Math.abs(a[i] - b[i]) >= threshold) changed += 1;
  }
  return changed;
}

async function ensureParticipantGalleryView(page: Page, provider: Provider): Promise<void> {
  if (provider !== 'zoom') return;
  try {
    const galleryAlready = await page
      .locator('.gallery-video-container, .multi-speaker-Mode')
      .first()
      .isVisible()
      .catch(() => false);
    if (galleryAlready) return;
    const viewBtn = page
      .locator(
        'button.full-screen-widget__button, button[aria-label*="View" i], button[aria-label*="Ansicht" i]',
      )
      .or(page.getByRole('button', {name: /^(View|Ansicht)(?: \(.*\))?$/i}))
      .first();
    if (!(await viewBtn.isVisible().catch(() => false))) return;
    await viewBtn.click({timeout: 2000}).catch(() => {});
    await delay(300);
    const galleryItem = page
      .getByRole('menuitem', {name: /Gallery|Galerie/i})
      .or(page.locator('a, li, button').filter({hasText: /^(Gallery View|Gallery|Galerieansicht|Galerie)$/i}))
      .first();
    if (await galleryItem.isVisible().catch(() => false)) {
      await galleryItem.click({timeout: 2000}).catch(() => {});
      await delay(600);
    } else {
      await page.keyboard.press('Escape').catch(() => {});
    }
  } catch {
    // non-critical best-effort layout switch
  }
}

async function inspectBotVideoDisplay(
  page: Page,
  provider: Provider,
  screenshotPath?: string,
): Promise<BotVideoDisplayObservation> {
  if (provider === 'zoom') {
    await ensureParticipantGalleryView(page, provider);
  }

  let targetFrame: Page | Frame = page;
  if (provider === 'webex') {
    const matching = page
      .frames()
      .filter(f => /^https:\/\/web\.webex\.com\/(?:meetings?|guest-join-meeting)(?:[?#]|$)/.test(f.url()));
    if (matching.length > 0) targetFrame = matching[matching.length - 1];
  }

  const inPage = await targetFrame
    .evaluate(async (prov: string) => {
      let inboundVideoFramesDecoded = 0;
      let inboundVideoPacketsReceived = 0;
      let inboundVideoBytesReceived = 0;
      let inboundFrameWidth = 0;
      let inboundFrameHeight = 0;

      const pcs = (window as unknown as {__wortlautPeerConnections?: Set<RTCPeerConnection>}).__wortlautPeerConnections;
      for (const pc of pcs ?? []) {
        try {
          const stats = await pc.getStats();
          stats.forEach((v: Record<string, any>) => {
            if (v.type === 'inbound-rtp' && v.kind === 'video') {
              inboundVideoFramesDecoded += Number(v.framesDecoded || 0);
              inboundVideoPacketsReceived += Number(v.packetsReceived || 0);
              inboundVideoBytesReceived += Number(v.bytesReceived || 0);
              inboundFrameWidth = Math.max(inboundFrameWidth, Number(v.frameWidth || 0));
              inboundFrameHeight = Math.max(inboundFrameHeight, Number(v.frameHeight || 0));
            }
          });
        } catch {
          // ignore closed peer connections
        }
      }

      let decodedVideoElements = 0;
      let maxVideoWidth = 0;
      let maxVideoHeight = 0;
      let videoNonBlackRatio = 0;
      let bestVideoSignature: number[] = [];

      const videos = Array.from(document.querySelectorAll('video'));
      for (const vid of videos) {
        if (vid.readyState < 2 || vid.videoWidth < 64 || vid.videoHeight < 36) continue;
        const rect = vid.getBoundingClientRect();
        if (rect.width < 40 || rect.height < 30) continue;
        // Exclude local self-preview tiles when identifiable
        if (
          vid.closest('[data-self-name]:not([data-participant-id]), [data-tid*="local-video"], [data-tid*="self-video"]')
        ) {
          continue;
        }
        decodedVideoElements += 1;
        if (vid.videoWidth >= maxVideoWidth) {
          maxVideoWidth = vid.videoWidth;
          maxVideoHeight = Math.max(maxVideoHeight, vid.videoHeight);
        }
        try {
          const c = document.createElement('canvas');
          c.width = 64;
          c.height = 36;
          const ctx = c.getContext('2d', {willReadFrequently: true});
          if (ctx) {
            ctx.drawImage(vid, 0, 0, 64, 36);
            const data = ctx.getImageData(0, 0, 64, 36).data;
            let nonBlack = 0;
            const sig: number[] = [];
            for (let y = 0; y < 36; y += 2) {
              for (let x = 0; x < 64; x += 2) {
                const idx = (y * 64 + x) * 4;
                const luma = Math.round(0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2]);
                if (luma > 10) nonBlack += 1;
                sig.push(luma);
              }
            }
            const ratio = nonBlack / sig.length;
            if (ratio >= videoNonBlackRatio) {
              videoNonBlackRatio = Math.round(ratio * 1000) / 1000;
              bestVideoSignature = sig;
            }
          }
        } catch {
          // ignore tainted media surface
        }
      }

      let zoomOrCanvasVideoSurfaces = 0;
      const surfaceEls = Array.from(
        document.querySelectorAll(
          'canvas:not(#wortlaut-share-canvas), video-player, [data-tid*="video-tile"] canvas',
        ),
      );
      for (const el of surfaceEls) {
        const r = el.getBoundingClientRect();
        if (r.width >= 120 && r.height >= 68) {
          zoomOrCanvasVideoSurfaces += 1;
        }
      }

      const bodyText = (document.body?.innerText ?? '').toLowerCase();
      const hasAriaBot =
        Boolean(document.querySelector('[aria-label*="wortlaut" i], [title*="wortlaut" i]')) ||
        bodyText.includes('wortlaut');
      const botTileDomVisible =
        hasAriaBot ||
        (prov !== 'zoom' && decodedVideoElements > 0);

      return {
        inboundVideoFramesDecoded,
        inboundVideoPacketsReceived,
        inboundVideoBytesReceived,
        inboundFrameWidth,
        inboundFrameHeight,
        decodedVideoElements,
        maxVideoWidth,
        maxVideoHeight,
        videoNonBlackRatio,
        zoomOrCanvasVideoSurfaces,
        botTileDomVisible,
        bestVideoSignature,
      };
    }, provider)
    .catch(() => ({
      inboundVideoFramesDecoded: 0,
      inboundVideoPacketsReceived: 0,
      inboundVideoBytesReceived: 0,
      inboundFrameWidth: 0,
      inboundFrameHeight: 0,
      decodedVideoElements: 0,
      maxVideoWidth: 0,
      maxVideoHeight: 0,
      videoNonBlackRatio: 0,
      zoomOrCanvasVideoSurfaces: 0,
      botTileDomVisible: false,
      bestVideoSignature: [] as number[],
    }));

  // Capture GPU-composited PNG screenshot so WebRTC <video>, WebGL <canvas>, and Zoom <video-player>
  // WebCodecs surfaces are all measured directly from Chromium's Viz compositor!
  let compositorNonBlackRatio = 0;
  let compositorSlateAccentRatio = 0;
  let compositorSignature: number[] = [];
  let savedShot: string | null = null;

  try {
    const pngBuf = await page.screenshot({type: 'png'});
    if (screenshotPath) {
      await mkdir(dirname(screenshotPath), {recursive: true});
      await writeFile(screenshotPath, pngBuf, {mode: 0o600});
      await chmod(screenshotPath, 0o600).catch(() => {});
      savedShot = screenshotPath;
    }
    const b64 = pngBuf.toString('base64');
    const compStats = await page
      .evaluate(async (dataB64: string) => {
        const img = new Image();
        img.src = `data:image/png;base64,${dataB64}`;
        await new Promise<void>((res, rej) => {
          img.onload = () => res();
          img.onerror = () => rej(new Error('png decode failed'));
        });
        const c = document.createElement('canvas');
        c.width = 64;
        c.height = 36;
        const ctx = c.getContext('2d', {willReadFrequently: true})!;
        // Crop central stage region (15%..85% width, 12%..82% height) excluding toolbars
        ctx.drawImage(
          img,
          Math.floor(img.width * 0.15),
          Math.floor(img.height * 0.12),
          Math.floor(img.width * 0.7),
          Math.floor(img.height * 0.7),
          0,
          0,
          64,
          36,
        );
        const data = ctx.getImageData(0, 0, 64, 36).data;
        let nonBlack = 0;
        let slateAccent = 0;
        const sig: number[] = [];
        for (let y = 0; y < 36; y += 2) {
          for (let x = 0; x < 64; x += 2) {
            const idx = (y * 64 + x) * 4;
            const r = data[idx];
            const g = data[idx + 1];
            const b = data[idx + 2];
            const luma = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
            if (luma > 14) nonBlack += 1;
            // wortlaut slate/blue/emerald palette (#0f172a / #1e293b / #3b82f6 / #34d399) has b > r + 8 or g > r + 12
            if ((b >= r + 10 && b >= 32) || (g >= r + 14 && g >= 60)) {
              slateAccent += 1;
            }
            sig.push(luma);
          }
        }
        return {
          nonBlackRatio: Math.round((nonBlack / sig.length) * 1000) / 1000,
          slateAccentRatio: Math.round((slateAccent / sig.length) * 1000) / 1000,
          sig,
        };
      }, b64)
      .catch(() => null);
    if (compStats) {
      compositorNonBlackRatio = compStats.nonBlackRatio;
      compositorSlateAccentRatio = compStats.slateAccentRatio;
      compositorSignature = compStats.sig;
    }
  } catch {
    // ignore transient screenshot errors
  }

  const stageSignature =
    inPage.bestVideoSignature.length > 0 ? inPage.bestVideoSignature : compositorSignature;

  const hasWebRtcVideo =
    (inPage.inboundVideoFramesDecoded > 0 && inPage.inboundVideoBytesReceived > 1000) ||
    (inPage.decodedVideoElements > 0 && inPage.videoNonBlackRatio > 0.05);

  const hasZoomCanvasVideo =
    provider === 'zoom' &&
    inPage.zoomOrCanvasVideoSurfaces > 0 &&
    inPage.botTileDomVisible &&
    compositorNonBlackRatio > 0.08 &&
    compositorSlateAccentRatio > 0.02;

  return {
    receivingVideo: hasWebRtcVideo || hasZoomCanvasVideo,
    inboundVideoFramesDecoded: inPage.inboundVideoFramesDecoded,
    inboundVideoPacketsReceived: inPage.inboundVideoPacketsReceived,
    inboundVideoBytesReceived: inPage.inboundVideoBytesReceived,
    inboundFrameWidth: inPage.inboundFrameWidth,
    inboundFrameHeight: inPage.inboundFrameHeight,
    decodedVideoElements: inPage.decodedVideoElements,
    maxVideoWidth: inPage.maxVideoWidth,
    maxVideoHeight: inPage.maxVideoHeight,
    videoNonBlackRatio: inPage.videoNonBlackRatio,
    zoomOrCanvasVideoSurfaces: inPage.zoomOrCanvasVideoSurfaces,
    botTileDomVisible: inPage.botTileDomVisible,
    compositorNonBlackRatio,
    compositorSlateAccentRatio,
    stageSignature,
    screenshotPath: savedShot,
  };
}

async function waitForBotVideoDisplay(
  observers: Page[],
  provider: Provider,
  timeoutMs: number,
  screenshotPath?: string,
): Promise<{observerIndex: number; obs: BotVideoDisplayObservation}> {
  const deadline = Date.now() + timeoutMs;
  let lastObs: BotVideoDisplayObservation | undefined;
  let bestIdx = 0;
  while (true) {
    for (let i = 0; i < observers.length; i++) {
      const saveNow = Date.now() + 1500 >= deadline ? screenshotPath : undefined;
      const obs = await inspectBotVideoDisplay(observers[i], provider, saveNow);
      lastObs = obs;
      bestIdx = i;
      if (obs.receivingVideo) {
        const finalObs = screenshotPath && !obs.screenshotPath
          ? await inspectBotVideoDisplay(observers[i], provider, screenshotPath)
          : obs;
        return {observerIndex: i, obs: finalObs};
      }
    }
    if (Date.now() >= deadline) break;
    await delay(1500);
  }
  return {
    observerIndex: bestIdx,
    obs: lastObs ?? (await inspectBotVideoDisplay(observers[0], provider, screenshotPath)),
  };
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
  console.log(`[LIVE-E2E] Meeting-URL: ${redactMeetingUrl(meetingUrl)}`);
  console.log(`[LIVE-E2E] wortlaut-API: ${config.apiUrl} (Sprecher: ${config.speakerCount}, ChatOptOut: ${config.testChatOptOut})`);
  console.log(`======================================================================`);

  const wavDir = await mkdtemp(join(tmpdir(), 'wortlaut-live-wav-'));
  const wavPathA = join(wavDir, 'speaker-a.wav');
  const wavPathB = join(wavDir, 'speaker-b.wav');
  const durationA = await createLoopedSpeakerWav('german-a.wav', wavPathA);
  const durationB = await createLoopedSpeakerWav('german-b.wav', wavPathB);

  let browserHost: Browser | undefined;
  let browserA: Browser | undefined;
  let browserB: Browser | undefined;
  let browserC: Browser | undefined;
  let browserD: Browser | undefined;
  let stopLobbyWatcher: (() => void) | undefined;
  let recordingId: string | undefined;

  try {
    // 1. Launch synthetic Speaker A (Host / First Speaker) & optional Speaker B/C
    const [localeA, localeB] = config.speakerLocales;
    console.log(
      `[1/6] Starte Browser für "${config.speakerAName}" (${localeA})` +
        (config.speakerCount >= 2 ? ` und "${config.speakerBName}" (${localeB})` : ' (Video-Display-Modus)') +
        (config.speakerCount >= 3 ? ` + "${config.speakerCName}"` : '') +
        (config.speakerCount >= 4 ? ` (+ Late-Joiner "${config.speakerDName}" während aktivem Call)` : '') +
        `...`,
    );
    const forceXvfb =
      !config.headed &&
      (provider === 'google_meet' || provider === 'zoom') &&
      process.platform === 'linux';
    browserA = await launchSpeakerBrowser(wavPathA, localeA, config.headed, forceXvfb);
    if (config.speakerCount >= 2) {
      browserB = await launchSpeakerBrowser(wavPathB, localeB, config.headed, forceXvfb);
    }
    if (config.speakerCount >= 3) {
      browserC = await launchSpeakerBrowser(wavPathA, localeA, config.headed, forceXvfb);
    }

    const hostStatePath = config.hostStorageState[provider];
    const guestStatePath = config.guestStorageState[provider];
    const hasHostState = await fileExists(hostStatePath);
    const hasGuestState = await fileExists(guestStatePath);
    const hasValidWebexSupertoken =
      provider === 'webex' && hasHostState ? await syncWebexHostStateFile(hostStatePath) : false;

    if (hasHostState) {
      console.log(`      Nutze gespeicherte Host-Session: ${hostStatePath}`);
    }

    const sanitizeStorageState = async (statePath: string) => {
      const raw = JSON.parse(await readFile(statePath, 'utf8'));
      const rawCookies: Array<Record<string, any>> = Array.isArray(raw?.cookies) ? raw.cookies : [];
      const cookies = rawCookies
        .filter(c => {
          if (!c || typeof c.name !== 'string' || typeof c.value !== 'string') return false;
          if (typeof c.domain !== 'string' || !c.domain) return false;
          if (typeof c.partitionKey === 'string' && c.partitionKey.startsWith('chrome-extension://')) return false;
          if (c.sameSite === 'None' && !c.secure) return false;
          return true;
        })
        .map(c => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: typeof c.path === 'string' && c.path ? c.path : '/',
          expires: typeof c.expires === 'number' && Number.isFinite(c.expires) ? c.expires : -1,
          httpOnly: Boolean(c.httpOnly),
          secure: Boolean(c.secure),
          sameSite: (c.sameSite === 'Strict' || c.sameSite === 'Lax' || c.sameSite === 'None'
            ? c.sameSite
            : 'Lax') as 'Strict' | 'Lax' | 'None',
        }));
      return {
        cookies,
        origins: Array.isArray(raw?.origins)
          ? (raw.origins as Array<{origin: string; localStorage: Array<{name: string; value: string}>}>)
          : [],
      };
    };

    const sanitizedHostState = hasHostState ? await sanitizeStorageState(hostStatePath) : undefined;
    const sanitizedGuestState = hasGuestState ? await sanitizeStorageState(guestStatePath) : undefined;

    const useSeparateTeamsHost = provider === 'teams' && hasHostState;
    let pageHost: Page | undefined;
    if (useSeparateTeamsHost) {
      const silentHostWavPath = join(wavDir, 'host-silent.wav');
      const silentPcm = Buffer.alloc(16000 * 2);
      const silentHdr = Buffer.alloc(44);
      silentHdr.write('RIFF', 0, 'ascii');
      silentHdr.writeUInt32LE(36 + silentPcm.byteLength, 4);
      silentHdr.write('WAVE', 8, 'ascii');
      silentHdr.write('fmt ', 12, 'ascii');
      silentHdr.writeUInt32LE(16, 16);
      silentHdr.writeUInt16LE(1, 20);
      silentHdr.writeUInt16LE(1, 22);
      silentHdr.writeUInt32LE(16000, 24);
      silentHdr.writeUInt32LE(32000, 28);
      silentHdr.writeUInt16LE(2, 32);
      silentHdr.writeUInt16LE(16, 34);
      silentHdr.write('data', 36, 'ascii');
      silentHdr.writeUInt32LE(silentPcm.byteLength, 40);
      await writeFile(silentHostWavPath, Buffer.concat([silentHdr, silentPcm]));
      browserHost = await chromium.launch({
        headless: !config.headed,
        args: [
          `--lang=${localeA}`,
          '--autoplay-policy=no-user-gesture-required',
          '--use-fake-ui-for-media-stream',
          '--use-fake-device-for-media-stream',
          `--use-file-for-fake-audio-capture=${silentHostWavPath}`,
        ],
      });
      const ctxHost = await browserHost.newContext({
        locale: localeA,
        permissions: ['microphone', 'camera'],
        ...(sanitizedHostState ? {storageState: sanitizedHostState} : {}),
      });
      await installSenderGate(ctxHost);
      pageHost = await ctxHost.newPage();
    }

    const ctxA = await browserA.newContext({
      locale: localeA,
      permissions: ['microphone', 'camera'],
      ...(sanitizedHostState && !useSeparateTeamsHost ? {storageState: sanitizedHostState} : {}),
    });
    const useHostForGuests = !hasGuestState && hasHostState && provider === 'google_meet';
    const guestStorage = sanitizedGuestState
      ? {storageState: sanitizedGuestState}
      : useHostForGuests && sanitizedHostState
        ? {storageState: sanitizedHostState}
        : {};
    await installSenderGate(ctxA, wavPathA);

    const pageA = await ctxA.newPage();
    let pageB: Page | undefined;
    if (browserB) {
      const ctxB = await browserB.newContext({
        locale: localeB,
        permissions: ['microphone', 'camera'],
        ...guestStorage,
      });
      await installSenderGate(ctxB, wavPathB);
      pageB = await ctxB.newPage();
    }
    let pageC: Page | undefined;
    if (browserC) {
      const ctxC = await browserC.newContext({
        locale: localeA,
        permissions: ['microphone', 'camera'],
        ...guestStorage,
      });
      await installSenderGate(ctxC, wavPathA);
      pageC = await ctxC.newPage();
    }

    if (useSeparateTeamsHost && pageHost) {
      console.log(`      Starte Microsoft Teams Host-Session sowie Teilnehmer parallel...`);
      stopLobbyWatcher = startLobbyAdmitWatcher(pageHost, provider);
      await Promise.all([
        pageHost.goto(meetingUrl, {waitUntil: 'domcontentloaded', timeout: 45000}),
        joinRoomAsSpeaker(pageA, provider, meetingUrl, config.speakerAName, config.joinTimeoutSeconds),
        ...(pageB ? [joinRoomAsSpeaker(pageB, provider, meetingUrl, config.speakerBName, config.joinTimeoutSeconds)] : []),
        ...(pageC ? [joinRoomAsSpeaker(pageC, provider, meetingUrl, config.speakerCName, config.joinTimeoutSeconds)] : []),
      ]);
      await setSpeakerTransmitting(pageHost, false);
      await setSpeakerTransmitting(pageA, false);
      if (pageB) await setSpeakerTransmitting(pageB, false);
      if (pageC) await setSpeakerTransmitting(pageC, false);
      console.log(`      Teilnehmer sind im Raum aktiv.`);
    } else {
      console.log(`      "${config.speakerAName}" tritt dem Raum bei...`);
      await joinRoomAsSpeaker(
        pageA,
        provider,
        meetingUrl,
        config.speakerAName,
        config.joinTimeoutSeconds,
        true,
        hasValidWebexSupertoken,
      );
      if (hasHostState) {
        // Persist rotated session cookies / OAuth refresh tokens (sliding expiration)
        await ctxA.storageState({path: hostStatePath});
        if (provider === 'webex') {
          await syncWebexHostStateFile(hostStatePath);
        }
        await chmod(hostStatePath, 0o600).catch(() => {});
      }
      stopLobbyWatcher = startLobbyAdmitWatcher(pageA, provider);
      await setSpeakerTransmitting(pageA, false);
      console.log(`      "${config.speakerAName}" ist im Raum aktiv (Lobby-Admit-Watcher läuft).`);

      if (pageB) {
        console.log(`      "${config.speakerBName}" tritt dem Raum bei...`);
        await joinRoomAsSpeaker(pageB, provider, meetingUrl, config.speakerBName, config.joinTimeoutSeconds);
        await setSpeakerTransmitting(pageB, false);
        console.log(`      "${config.speakerBName}" ist im Raum aktiv.`);
      }

      if (pageC) {
        console.log(`      "${config.speakerCName}" tritt dem Raum bei...`);
        await joinRoomAsSpeaker(pageC, provider, meetingUrl, config.speakerCName, config.joinTimeoutSeconds);
        await setSpeakerTransmitting(pageC, false);
        console.log(`      "${config.speakerCName}" ist im Raum aktiv.`);
      }
    }

    const admitPage = useSeparateTeamsHost && pageHost ? pageHost : pageA;

    // Pause automatic admission before scheduling wortlaut so we can verify lobby behavior first!
    if (config.lobbyHoldSeconds > 0) {
      stopLobbyWatcher?.();
      stopLobbyWatcher = undefined;
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
        ...(provider === 'teams' ? {guest_name: 'Wortlaut.cloud (Alice Test)'} : {}),
      },
      {'Idempotency-Key': randomUUID()},
    );
    recordingId = created.id;
    console.log(`      Aufnahme angelegt: ID = ${recordingId}`);

    // 2b. Verify waiting_admission hold (no premature 'active' / no silent lobby audio streams)
    let lobbyHoldVerified = false;
    let lobbySignaledParticipants: number | null = null;
    const joinDeadline = Date.now() + config.joinTimeoutSeconds * 1000;
    let activeRecording: any = null;

    if (config.lobbyHoldSeconds > 0) {
      console.log(
        `[2b/6] Prüfe Warteraum-Erkennung vor Host-Einlass (${config.lobbyHoldSeconds}s Haltephase)...`,
      );
      while (Date.now() < joinDeadline) {
        const rec = await apiRequest<any>(config, 'GET', `/v1/recordings/${recordingId}`);
        if (rec.participation === 'waiting_admission') {
          const holdUntil = Date.now() + config.lobbyHoldSeconds * 1000;
          let autoAdmitted = false;
          while (true) {
            const check: any = await apiRequest(config, 'GET', `/v1/recordings/${recordingId}`);
            const diag = check.attempts?.[0]?.diagnostics;
            if (typeof diag?.participant_sources?.total === 'number') {
              lobbySignaledParticipants = diag.participant_sources.total;
            }
            if (check.participation === 'capturing' || check.participation === 'active') {
              await delay(1500);
              const pendingOnHost = await hasPendingLobbyPrompt(admitPage, provider);
              assert.equal(
                pendingOnHost,
                false,
                `Worker meldet participation=${check.participation}, obwohl der Bot auf Host-Seite noch unzugelassen im Warteraum steht (Admit/Zulassen sichtbar)!`,
              );
              if (config.requireLobbyHold) {
                throw new Error(
                  `WORTLAUT_LIVE_REQUIRE_LOBBY=true, aber Bot wechselte ohne Host-Zulassung nach participation=${check.participation}.`,
                );
              }
              console.log(
                `      Kein Warteraum für Bot aktiv (Raum ließ Bot nach kurzem Verbindungsaufbau direkt zu: participation=${check.participation}).`,
              );
              activeRecording = check;
              autoAdmitted = true;
              break;
            }
            assert.equal(
              check.participation,
              'waiting_admission',
              `Worker verließ waiting_admission ohne Host-Zulassung (participation=${check.participation}, failure_reason=${check.failure_reason ?? 'none'})`,
            );
            assert.equal(
              check.audio?.length ?? 0,
              0,
              `Im Warteraum wurden bereits ${check.audio?.length} AudioStreams angelegt (vorgewärmte Transceiver vor RTP-Empfang!)`,
            );
            assert.equal(
              check.ingest?.durable_sample_count ?? 0,
              0,
              `Im Warteraum wurden bereits ${check.ingest?.durable_sample_count} Audio-Samples hochgeladen!`,
            );
            assert.equal(
              diag?.streams ?? 0,
              0,
              `Worker-Diagnostik meldet streams=${diag?.streams} im Warteraum!`,
            );
            if (Date.now() >= holdUntil) break;
            await delay(2000);
          }
          if (!autoAdmitted) {
            lobbyHoldVerified = true;
            console.log(
              `      Warteraum-Haltephase bestanden (${config.lobbyHoldSeconds}s stabil in waiting_admission, 0 Streams, 0 Samples` +
                (lobbySignaledParticipants !== null ? `, signaled_participants=${lobbySignaledParticipants}` : '') +
                `).`,
            );
          }
          break;
        }
        if (rec.participation === 'capturing' || rec.participation === 'active') {
          await delay(1500);
          const pendingOnHost = await hasPendingLobbyPrompt(admitPage, provider);
          assert.equal(
            pendingOnHost,
            false,
            `Worker meldet participation=${rec.participation}, obwohl der Bot auf Host-Seite noch unzugelassen im Warteraum steht (Admit/Zulassen sichtbar)!`,
          );
          if (config.requireLobbyHold) {
            throw new Error(
              `WORTLAUT_LIVE_REQUIRE_LOBBY=true, aber Bot erreichte direkt participation=${rec.participation} ohne waiting_admission.`,
            );
          }
          console.log(`      Kein Warteraum aktiv (Raum ließ Bot direkt zu: participation=${rec.participation}).`);
          activeRecording = rec;
          break;
        }
        if (rec.participation === 'failed' || rec.participation === 'cancelled' || rec.participation === 'ended') {
          throw new Error(
            `wortlaut-Bot vor Einlass abgebrochen: participation=${rec.participation}, ` +
              `failure_reason=${rec.failure_reason ?? 'none'}`,
          );
        }
        await delay(2000);
      }
      stopLobbyWatcher = startLobbyAdmitWatcher(admitPage, provider);
    }

    // 3. Wait for wortlaut bot to join and reach participation === 'active'
    if (!activeRecording) {
      console.log(`[3/6] Lasse Bot aus Warteraum zu und warte auf participation=active (max. ${config.joinTimeoutSeconds}s)...`);
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
    }
    if (!activeRecording) {
      // Evidence for a failed admission: what the host actually sees.
      const artifact = resolve(ROOT_DIR, `.dev/live-e2e-${provider}-admit-timeout`);
      await admitPage.screenshot({path: `${artifact}.png`, fullPage: true}).catch(() => {});
      const buttons: string[] = [];
      for (const target of [admitPage, ...admitPage.frames()]) {
        const labels = await target.locator('button, [role="button"]').evaluateAll((els) => els
          .filter((el) => (el as HTMLElement).offsetParent !== null)
          .map((el) => `${el.getAttribute('aria-label') ?? ''} | ${(el as HTMLElement).innerText ?? ''}`
            .replace(/\s+/g, ' ').trim().slice(0, 120))).catch(() => [] as string[]);
        buttons.push(...labels);
      }
      await writeFile(`${artifact}.json`, JSON.stringify({buttons}, null, 2), 'utf8').catch(() => {});
      console.log(`      Host-Ansicht beim Einlass-Timeout gespeichert: ${artifact}.png/.json`);
      throw new Error(`Timeout: wortlaut-Bot hat nach ${config.joinTimeoutSeconds}s nicht den Status 'active' erreicht.`);
    }
    console.log(`      wortlaut-Bot ist im Meeting aktiv (participation=active).`);
    if (config.speakerCount < 4 && provider !== 'teams') {
      stopLobbyWatcher?.();
      stopLobbyWatcher = undefined;
      if (provider === 'google_meet') {
        await pageA.keyboard.press('Escape').catch(() => {});
      }
    }

    // Allow WebRTC receivers and initial 5s capture buffer to stabilize
    await delay(5500);

    // 3b. Check incoming wortlaut live-transcript video tile on participant browser(s) before speech
    const videoObservers = [pageA, ...(pageB ? [pageB] : [])];
    let botVideoInitial: BotVideoDisplayObservation | null = null;
    let botVideoObserverIdx = 0;
    if (config.testVideoDisplay) {
      console.log(`[3b/6] Prüfe Video-Anzeige der wortlaut-Kachel bei den Teilnehmern (${provider})...`);
      const initialShotPath = resolve(ROOT_DIR, `.dev/live-e2e-${provider}-video-initial.png`);
      const initialRes = await waitForBotVideoDisplay(videoObservers, provider, 12000, initialShotPath);
      botVideoObserverIdx = initialRes.observerIndex;
      botVideoInitial = initialRes.obs;
      console.log(
        `      [Video-Initial] receiving=${botVideoInitial.receivingVideo}, ` +
          `framesDecoded=${botVideoInitial.inboundVideoFramesDecoded}, ` +
          `bytes=${botVideoInitial.inboundVideoBytesReceived}, ` +
          `video=${botVideoInitial.maxVideoWidth}x${botVideoInitial.maxVideoHeight} (n=${botVideoInitial.decodedVideoElements}), ` +
          `surfaces=${botVideoInitial.zoomOrCanvasVideoSurfaces}, ` +
          `compositorNonBlack=${botVideoInitial.compositorNonBlackRatio}`,
      );
    }

    // 4. Execute deterministic speech choreography (Solo A -> optional Solo B -> C / Late-Joiner D / Overlap)
    console.log(`[4/6] Spiele Referenz-Sprachbeiträge über getrennte Teilnehmer-Streams ein...`);
    console.log(`      -> Turn 1: "${config.speakerAName}" spricht (german-a.wav)...`);
    await setSpeakerTransmitting(pageA, true);
    if (pageB) await setSpeakerTransmitting(pageB, false);
    if (pageC) await setSpeakerTransmitting(pageC, false);
    await delay(Math.ceil(((config.videoOnly ? durationA * 1.5 : durationA * 2) + 1.6) * 1000));
    const statsA = await readOutboundAudioStats(pageA);
    console.log(`         [RTP-A] packetsSent=${statsA.packetsSent}, bytesSent=${statsA.bytesSent}, audioLevel=${statsA.audioLevel}`);
    await setSpeakerTransmitting(pageA, false);
    await delay(3000);

    let pageD: Page | undefined;
    let lateJoinerVerified = false;
    if (pageB && !config.videoOnly) {
      console.log(`      -> Turn 2: "${config.speakerBName}" spricht (german-b.wav)...`);
      await setSpeakerTransmitting(pageA, false);
      await setSpeakerTransmitting(pageB, true);
      await delay(Math.ceil((durationB * 2 + 1.6) * 1000));
      const statsB = await readOutboundAudioStats(pageB);
      console.log(`         [RTP-B] packetsSent=${statsB.packetsSent}, bytesSent=${statsB.bytesSent}, audioLevel=${statsB.audioLevel}`);
      await setSpeakerTransmitting(pageB, false);
      await delay(3000);

      if (pageC) {
        console.log(`      -> Turn 3: "${config.speakerCName}" spricht (SFU Loudest-N Transceiver-Wechsel)...`);
        await setSpeakerTransmitting(pageC, true);
        await delay(Math.ceil((durationA * 1.5 + 1.2) * 1000));
        await setSpeakerTransmitting(pageC, false);
        await delay(2500);
      }

      if (config.speakerCount >= 4) {
        console.log(`      -> Late-Joiner: "${config.speakerDName}" tritt während laufender Aufnahme bei...`);
        browserD = await launchSpeakerBrowser(wavPathB, localeB, config.headed);
        const ctxD = await browserD.newContext({
          locale: localeB,
          permissions: ['microphone', 'camera'],
          ...guestStorage,
        });
        await installSenderGate(ctxD, wavPathB);
        pageD = await ctxD.newPage();
        await joinRoomAsSpeaker(pageD, provider, meetingUrl, config.speakerDName, config.joinTimeoutSeconds);
        await setSpeakerTransmitting(pageD, false);
        await delay(2500);
        console.log(`      -> Turn 4: Late-Joiner "${config.speakerDName}" spricht (german-b.wav)...`);
        await setSpeakerTransmitting(pageD, true);
        await delay(Math.ceil((durationB * 2 + 1.6) * 1000));
        await setSpeakerTransmitting(pageD, false);
        await delay(3000);
        lateJoinerVerified = true;
      } else if (provider === 'teams' || provider === 'webex') {
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
        if (pageHost) await setSpeakerTransmitting(pageHost, false);
        await setSpeakerTransmitting(pageA, false);
        await setSpeakerTransmitting(pageB, false);
      }
    }

    // 4b & 4c. Camera exclusion + Screen-Share Slide-Change Keyframe verification (when supported by server)
    let keyframesServerSupported = false;
    let cameraExclusionVerified: boolean | null = null;
    let screenShareStarted = false;
    if (config.testKeyframes) {
      const midRec = await apiRequest<any>(config, 'GET', `/v1/recordings/${recordingId}`);
      const midKfDiag = midRec?.attempts?.[0]?.diagnostics?.keyframes;
      keyframesServerSupported = Boolean(midKfDiag && midKfDiag.capability !== 'disabled');
      if (keyframesServerSupported) {
        console.log(`[4b/6] Prüfe Kamera-Ausschluss ("${config.speakerAName}" aktiviert Kamera ohne Screen-Share)...`);
        const camEnabled = await setParticipantCamera(pageA, provider, true);
        if (camEnabled) {
          await delay(4500);
          await setParticipantCamera(pageA, provider, false);
        } else {
          await delay(2000);
        }
        const preShareTx = await apiRequest<{keyframes?: ExportedKeyframe[]}>(
          config,
          'GET',
          `/v1/recordings/${recordingId}/transcript`,
        );
        const preShareKfCount = preShareTx.keyframes?.length ?? 0;
        assert.equal(
          preShareKfCount,
          0,
          `Kamera-Ausschluss verletzt: ${preShareKfCount} Keyframe(s) vor Screen-Share erfasst!`,
        );
        cameraExclusionVerified = true;
        console.log(`      Kamera-Ausschluss bestanden (0 Keyframes bei aktiver Teilnehmerkamera).`);

        console.log(`[4c/6] Starte synthetische Bildschirmfreigabe durch "${config.speakerAName}" (Slide 1 -> Slide 2)...`);
        screenShareStarted = await startSyntheticScreenShare(pageA, provider);
        if (screenShareStarted) {
          await delay(5500);
          await setSyntheticShareSlide(pageA, 1);
          await delay(6500);
          await stopSyntheticScreenShare(pageA, provider);
          await delay(2000);
          console.log(`      Bildschirmfreigabe abgeschlossen (2 Folien präsentiert).`);
        } else {
          console.log(`      [Hinweis] Bildschirmfreigabe konnte im ${provider}-Gast-UI nicht automatisch gestartet werden.`);
        }
      }
    }

    // 5. Verify live streaming transcript segments while the meeting is still active (BEFORE any chat opt-out!)
    console.log(`[5/6] Prüfe Echtzeit-Streaming-Transkription während laufendem Meeting...`);
    let liveStreamedSegments: TranscriptSegment[] = [];
    let liveStreamedKeyframes: ExportedKeyframe[] = [];
    const streamCheckDeadline = Date.now() + 35000;
    while (Date.now() < streamCheckDeadline) {
      const transcript = await apiRequest<{segments: TranscriptSegment[]; keyframes?: ExportedKeyframe[]}>(
        config,
        'GET',
        `/v1/recordings/${recordingId}/transcript`,
      );
      if (transcript.keyframes && transcript.keyframes.length > 0) {
        liveStreamedKeyframes = transcript.keyframes;
      }
      if (transcript.segments && transcript.segments.length > 0) {
        liveStreamedSegments = transcript.segments;
        const hasLiveA = liveStreamedSegments.some(s => /getrennten.*Audioquellen|Audioquellen|prüfen die getrenn/i.test(s.text));
        const hasLiveB = liveStreamedSegments.some(s => /zweite Teilnehmer|gleichen Zeit/i.test(s.text));
        const speechReady = config.videoOnly || config.speakerCount < 2 ? hasLiveA : hasLiveA && hasLiveB;
        const kfReady = !(keyframesServerSupported && screenShareStarted) || liveStreamedKeyframes.length >= 1;
        if (speechReady && kfReady) break;
      }
      await delay(2000);
    }
    let liveKeyframesVerified = false;
    if (keyframesServerSupported && screenShareStarted && liveStreamedKeyframes.length >= 1) {
      const liveKf = liveStreamedKeyframes[0];
      assert.ok(liveKf.presenter && liveKf.presenter.length > 0, 'Live-Keyframe hat keinen gebundenen Presenter');
      const unauthPngRes = await fetch(`${config.apiUrl}${liveKf.image_path}?token=${encodeURIComponent(config.apiToken)}`);
      assert.equal(unauthPngRes.status, 401, 'Keyframe-PNG akzeptierte unzulässiges ?token= Query-Secret');
      const authPngRes = await fetch(`${config.apiUrl}${liveKf.image_path}`, {
        headers: {Authorization: `Bearer ${config.apiToken}`},
      });
      assert.equal(authPngRes.status, 200, `Live-Keyframe-PNG-Abruf schlug fehl (HTTP ${authPngRes.status})`);
      const pngBytes = Buffer.from(await authPngRes.arrayBuffer());
      assert.equal(pngBytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'Ungültige PNG-Signatur');
      liveKeyframesVerified = true;
    }
    const liveStreamingVerified = liveStreamedSegments.length > 0;
    const liveSegmentsA = liveStreamedSegments.filter(s => /getrennten.*Audioquellen|Audioquellen|prüfen die getrenn/i.test(s.text));
    const liveSegmentsB = liveStreamedSegments.filter(s => /zweite Teilnehmer|gleichen Zeit/i.test(s.text));
    const liveSpeakersA = new Set(liveSegmentsA.map(s => s.speaker_id).filter(Boolean));
    const liveSpeakersB = new Set(liveSegmentsB.map(s => s.speaker_id).filter(Boolean));
    const liveStreamsA = new Set(liveSegmentsA.map(s => s.stream_id));
    const liveStreamsB = new Set(liveSegmentsB.map(s => s.stream_id));
    const liveDisjointSpeakers =
      liveSpeakersA.size > 0 && liveSpeakersB.size > 0 && [...liveSpeakersA].every(id => !liveSpeakersB.has(id));
    const liveDisjointStreams =
      liveStreamsA.size > 0 && liveStreamsB.size > 0 && [...liveStreamsA].every(id => !liveStreamsB.has(id));
    const liveAllBound =
      liveStreamedSegments.length > 0 && liveStreamedSegments.every(s => !s.attribution_unknown && Boolean(s.speaker_id));
    console.log(
      `      Live-Segmente während aktivem Termin empfangen: ${liveStreamedSegments.length} ` +
        `(liveA=${liveSegmentsA.length}, liveB=${liveSegmentsB.length}, liveDisjointSpeakers=${liveDisjointSpeakers})`,
    );

    // 5a. Verify that live transcript segments propagate onto wortlaut's incoming video tile
    let botVideoLive: BotVideoDisplayObservation | null = null;
    let botVideoDisplayVerified: boolean | null = null;
    let botVideoLiveUpdateVerified: boolean | null = null;
    let botVideoChangedCells = 0;
    if (config.testVideoDisplay) {
      // Allow one 3s worker status poll + WebRTC/Canvas frame propagation
      await delay(3800);
      const liveShotPath = resolve(ROOT_DIR, `.dev/live-e2e-${provider}-video-live.png`);
      const targetObserver = videoObservers[botVideoObserverIdx] ?? pageA;
      botVideoLive = await inspectBotVideoDisplay(targetObserver, provider, liveShotPath);
      if (!botVideoLive.receivingVideo && videoObservers.length > 1) {
        const retryRes = await waitForBotVideoDisplay(videoObservers, provider, 5000, liveShotPath);
        botVideoLive = retryRes.obs;
      }
      botVideoChangedCells =
        botVideoInitial && botVideoLive
          ? countLumaSignatureChanges(botVideoInitial.stageSignature, botVideoLive.stageSignature)
          : 0;
      const framesAdvanced =
        Boolean(botVideoInitial && botVideoLive) &&
        (botVideoLive!.inboundVideoFramesDecoded > botVideoInitial!.inboundVideoFramesDecoded ||
          botVideoLive!.inboundVideoBytesReceived > botVideoInitial!.inboundVideoBytesReceived);
      botVideoDisplayVerified = Boolean(botVideoInitial?.receivingVideo || botVideoLive?.receivingVideo);
      botVideoLiveUpdateVerified = Boolean(
        botVideoDisplayVerified && (framesAdvanced || botVideoChangedCells >= 4),
      );
      console.log(
        `[5a/6] [Video-Live-Update] verified=${botVideoDisplayVerified}, liveUpdated=${botVideoLiveUpdateVerified}, ` +
          `framesDecoded=${botVideoLive.inboundVideoFramesDecoded}, changedCells=${botVideoChangedCells}, ` +
          `screenshot=${botVideoLive.screenshotPath ?? 'none'}`,
      );
      if (config.requireVideoDisplay) {
        assert.equal(
          botVideoDisplayVerified,
          true,
          `wortlaut-Video-Kachel wurde bei den Teilnehmern auf ${provider} nicht empfangen/angezeigt! Siehe ${liveShotPath}`,
        );
        if (liveStreamingVerified) {
          assert.equal(
            botVideoLiveUpdateVerified,
            true,
            `wortlaut-Video-Kachel hat sich nach Live-Transkript auf ${provider} nicht aktualisiert (changedCells=${botVideoChangedCells})!`,
          );
        }
      }
    }

    // 5b. Test real In-Call Chat Opt-Out ("no") and subsequent audio zeroing + GDPR retroactive purge
    let chatOptOutSent = false;
    let optOutSpeakerName: string | null = null;
    if (config.testChatOptOut && (pageC || pageB)) {
      const optOutPage = (pageC ?? pageB)!;
      optOutSpeakerName = pageC ? config.speakerCName : config.speakerBName;
      console.log(`[5b/6] Prüfe echten In-Call-Chat-Widerspruch ("no") durch "${optOutSpeakerName}"...`);
      chatOptOutSent = await sendMeetingChatMessage(optOutPage, provider, 'no');
      if (!chatOptOutSent && config.requireChatOptOut) {
        throw new Error(`Chat-Opt-Out konnte im ${provider}-UI von "${optOutSpeakerName}" nicht gesendet werden.`);
      }
      if (chatOptOutSent) {
        await delay(5000);
        console.log(`      Chat-Opt-Out ("no") gesendet; spiele Nach-Widerspruchs-Sprache zur Nullungsprüfung ein...`);
        await setSpeakerTransmitting(optOutPage, true);
        await delay(Math.ceil((durationB + 1.0) * 1000));
        await setSpeakerTransmitting(optOutPage, false);
        await delay(4000);
      } else {
        console.log(`      [Hinweis] Kein zugängliches Gast-Chatfeld für "${optOutSpeakerName}" in diesem Raum sichtbar.`);
        optOutSpeakerName = null;
      }
    }

    // 6. Stop recording and wait for finalization
    console.log(`[6/6] Beende Aufnahme und warte auf Abschluss der Verarbeitung...`);
    await apiRequest(config, 'POST', `/v1/recordings/${recordingId}/cancel`);
    stopLobbyWatcher?.();
    await Promise.all([
      leaveAndCloseBrowser(browserHost),
      leaveAndCloseBrowser(browserA),
      leaveAndCloseBrowser(browserB),
      leaveAndCloseBrowser(browserC),
      leaveAndCloseBrowser(browserD),
    ]);
    browserHost = undefined;
    browserA = undefined;
    browserB = undefined;
    browserC = undefined;
    browserD = undefined;

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
      keyframes?: ExportedKeyframe[];
      quality: {has_audio_gaps: boolean; has_unknown_attribution: boolean};
    }>(config, 'GET', `/v1/recordings/${recordingId}/exports/json`);
    const exportedTxt = await apiRequest<string>(config, 'GET', `/v1/recordings/${recordingId}/exports/txt`);
    const exportedVtt = await apiRequest<string>(config, 'GET', `/v1/recordings/${recordingId}/exports/vtt`);

    const exportedKeyframes = exportedJson.keyframes ?? [];
    const optedOutDiagEarly: string[] = finalRecording.attempts?.[0]?.diagnostics?.participant_sources?.opted_out ?? [];
    const sharedAccountOptedOutEarly = useHostForGuests && chatOptOutSent && optedOutDiagEarly.length > 0;
    let keyframesVerified: boolean | null = null;
    if (keyframesServerSupported && screenShareStarted) {
      if (sharedAccountOptedOutEarly) {
        assert.ok(
          liveStreamedKeyframes.length >= 1 && liveKeyframesVerified,
          `Screen-Share war aktiv, aber vor Chat-Opt-Out wurden 0 Keyframes erfasst (diagnostics=${JSON.stringify(finalRecording.attempts?.[0]?.diagnostics?.keyframes)})`,
        );
        assert.equal(
          exportedKeyframes.length,
          0,
          'Trotz Account-weitem Chat-Opt-Out blieben Screen-Share-Keyframes im finalen Export erhalten!',
        );
        keyframesVerified = true;
      } else {
        assert.ok(
          exportedKeyframes.length >= 1,
          `Screen-Share war aktiv, aber 0 Keyframes erfasst (diagnostics=${JSON.stringify(finalRecording.attempts?.[0]?.diagnostics?.keyframes)})`,
        );
        const firstKf = exportedKeyframes[0];
        assert.ok(firstKf.presenter && firstKf.presenter.length > 0, 'Keyframe hat keinen gebundenen Presenter');
        const unauthPngRes = await fetch(`${config.apiUrl}${firstKf.image_path}?token=${encodeURIComponent(config.apiToken)}`);
        assert.equal(unauthPngRes.status, 401, 'Keyframe-PNG akzeptierte unzulässiges ?token= Query-Secret');
        const authPngRes = await fetch(`${config.apiUrl}${firstKf.image_path}`, {
          headers: {Authorization: `Bearer ${config.apiToken}`},
        });
        assert.equal(authPngRes.status, 200, `Keyframe-PNG-Abruf schlug fehl (HTTP ${authPngRes.status})`);
        const pngBytes = Buffer.from(await authPngRes.arrayBuffer());
        assert.equal(pngBytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'Ungültige PNG-Signatur');
        keyframesVerified = true;
      }
    }

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

    const optedOutDiag: string[] = finalRecording.attempts?.[0]?.diagnostics?.participant_sources?.opted_out ?? [];
    const sharedAccountOptedOut = useHostForGuests && chatOptOutSent;
    const speakerBOptedOut = chatOptOutSent && optOutSpeakerName === config.speakerBName;
    const chatOptOutDetected = chatOptOutSent ? optedOutDiag.length > 0 : null;
    const chatOptOutPurged = chatOptOutSent && optOutSpeakerName
      ? (sharedAccountOptedOut
          ? segments.length === 0
          : speakerBOptedOut
            ? segmentsB.length === 0
            : !segments.some(s => (s.speaker_name ?? s.participant_name) === optOutSpeakerName))
      : null;
    const chatOptOutVerified = chatOptOutSent ? Boolean(chatOptOutDetected && chatOptOutPurged) : null;

    const effectiveDisjointStreams = (speakerBOptedOut || sharedAccountOptedOut)
      ? (liveDisjointStreams || liveDisjointSpeakers)
      : multiStreamCapture;
    const effectiveDisjointSpeakers = (speakerBOptedOut || sharedAccountOptedOut)
      ? liveDisjointSpeakers
      : disjointSpeakers;
    const effectiveAttributionVerified = sharedAccountOptedOut
      ? Boolean(effectiveDisjointStreams && liveDisjointSpeakers && liveAllBound && chatOptOutVerified)
      : speakerBOptedOut
        ? Boolean(effectiveDisjointStreams && liveDisjointSpeakers && liveAllBound && allBound && chatOptOutVerified)
        : Boolean(multiStreamCapture && disjointSpeakers && allBound && distinctSpeakers.size >= 2);

    const report = {
      timestamp: new Date().toISOString(),
      provider,
      recording_id: recordingId,
      meeting_url: redactMeetingUrl(meetingUrl),
      speaker_count: config.speakerCount,
      speaker_locales: config.speakerLocales,
      lobby_hold_verified: lobbyHoldVerified,
      lobby_hold_seconds: config.lobbyHoldSeconds,
      lobby_signaled_participants: lobbySignaledParticipants,
      late_joiner_verified: lateJoinerVerified,
      participation_verified: true,
      bot_video_display_verified: botVideoDisplayVerified,
      bot_video_live_update_verified: botVideoLiveUpdateVerified,
      bot_video_changed_cells: botVideoChangedCells,
      bot_video_initial: botVideoInitial
        ? {
            receiving_video: botVideoInitial.receivingVideo,
            frames_decoded: botVideoInitial.inboundVideoFramesDecoded,
            bytes_received: botVideoInitial.inboundVideoBytesReceived,
            video_width: botVideoInitial.maxVideoWidth || botVideoInitial.inboundFrameWidth,
            video_height: botVideoInitial.maxVideoHeight || botVideoInitial.inboundFrameHeight,
            surfaces: botVideoInitial.zoomOrCanvasVideoSurfaces,
            compositor_non_black_ratio: botVideoInitial.compositorNonBlackRatio,
            screenshot: botVideoInitial.screenshotPath,
          }
        : null,
      bot_video_live: botVideoLive
        ? {
            receiving_video: botVideoLive.receivingVideo,
            frames_decoded: botVideoLive.inboundVideoFramesDecoded,
            bytes_received: botVideoLive.inboundVideoBytesReceived,
            video_width: botVideoLive.maxVideoWidth || botVideoLive.inboundFrameWidth,
            video_height: botVideoLive.maxVideoHeight || botVideoLive.inboundFrameHeight,
            surfaces: botVideoLive.zoomOrCanvasVideoSurfaces,
            compositor_non_black_ratio: botVideoLive.compositorNonBlackRatio,
            screenshot: botVideoLive.screenshotPath,
          }
        : null,
      live_streaming_verified: liveStreamingVerified,
      live_disjoint_speakers: liveDisjointSpeakers,
      camera_exclusion_verified: cameraExclusionVerified,
      screen_share_started: screenShareStarted,
      live_keyframe_count: liveStreamedKeyframes.length,
      keyframe_count: exportedKeyframes.length,
      keyframes_verified: keyframesVerified,
      chat_opt_out_sent: chatOptOutSent,
      chat_opt_out_speaker: optOutSpeakerName,
      chat_opt_out_diagnostics: optedOutDiag,
      chat_opt_out_verified: chatOptOutVerified,
      processing_status: finalRecording.processing,
      segment_count: segments.length,
      distinct_stream_count: distinctStreams.size,
      distinct_speaker_ids: [...distinctSpeakers],
      distinct_speaker_names: [...distinctSpeakerNames],
      phrase_a_matched: sharedAccountOptedOut ? liveSegmentsA.length > 0 : segmentsA.length > 0,
      phrase_b_matched: (speakerBOptedOut || sharedAccountOptedOut) ? liveSegmentsB.length > 0 : segmentsB.length > 0,
      phrase_b_purged_after_opt_out: (speakerBOptedOut || sharedAccountOptedOut) ? segmentsB.length === 0 : undefined,
      disjoint_streams_for_a_and_b: effectiveDisjointStreams,
      disjoint_speakers_for_a_and_b: effectiveDisjointSpeakers,
      speaker_attribution_verified: effectiveAttributionVerified,
      exports_verified: (sharedAccountOptedOut ? typeof exportedTxt === 'string' : exportedTxt.length > 0) &&
        exportedVtt.startsWith('WEBVTT'),
      segments,
    };

    await mkdir(resolve(ROOT_DIR, '.dev'), {recursive: true});
    const reportPath = resolve(ROOT_DIR, `.dev/live-e2e-${provider}-result.json`);
    await writeFile(reportPath, JSON.stringify(report, null, 2), {encoding: 'utf8', mode: 0o600});
    await chmod(reportPath, 0o600).catch(() => {});
    console.log(`\n[ERGEBNIS ${provider.toUpperCase()}] Report gespeichert in: ${reportPath}`);
    console.log(`  - Segmente gesamt (final):     ${report.segment_count}`);
    console.log(`  - Getrennte Audio-Streams:     ${report.distinct_stream_count}`);
    console.log(`  - Erkannte Sprecher-IDs:       ${report.distinct_speaker_ids.join(', ') || '(keine)'}`);
    console.log(`  - Erkannte Sprecher-Namen:     ${report.distinct_speaker_names.join(', ') || '(keine)'}`);
    console.log(`  - Satz A erkannt (Alice):      ${report.phrase_a_matched}`);
    if (config.speakerCount >= 2 && !config.videoOnly) {
      console.log(`  - Satz B erkannt (Bob):        ${report.phrase_b_matched}`);
    }
    if (config.testVideoDisplay) {
      console.log(
        `  - Bot-Video-Kachel sichtbar:   ${report.bot_video_display_verified} ` +
          `(liveUpdate=${report.bot_video_live_update_verified}, changedCells=${report.bot_video_changed_cells})`,
      );
    }
    if (keyframesServerSupported) {
      console.log(`  - Kamera-Ausschluss:           ${report.camera_exclusion_verified}`);
      console.log(`  - Screen-Share-Keyframes:      ${report.keyframe_count} (verified=${report.keyframes_verified})`);
    }
    if (chatOptOutSent) {
      console.log(`  - Chat-Opt-Out verifiziert:    ${report.chat_opt_out_verified} (opted_out=${optedOutDiag.join(', ')})`);
    }
    if (config.speakerCount >= 2 && !config.videoOnly) {
      console.log(`  - Getrennte Kanäle A vs. B:    ${report.disjoint_streams_for_a_and_b}`);
      console.log(`  - Getrennte Sprecher A vs. B:  ${report.disjoint_speakers_for_a_and_b}`);
      console.log(`  - Sprecherbindung verifiziert: ${report.speaker_attribution_verified}`);
    }

    if (sharedAccountOptedOut) {
      assert.ok(liveStreamedSegments.length > 0, 'Keine Live-Segmente vor dem Chat-Opt-Out empfangen');
      assert.equal(report.segment_count, 0, 'Trotz Account-weitem Chat-Opt-Out blieben Segmente im finalen Export erhalten');
    } else {
      assert.ok(report.segment_count > 0, 'Keine Transkript-Segmente erzeugt');
    }
    assert.ok(report.phrase_a_matched, 'Referenzsatz A ("getrennten Audioquellen") wurde im Transkript nicht gefunden');
    if (config.speakerCount >= 2 && !config.videoOnly) {
      assert.ok(report.phrase_b_matched, 'Referenzsatz B ("zweite Teilnehmer") wurde im Transkript nicht gefunden');
    }
    assert.ok(report.exports_verified, 'TXT/VTT-Exporte unvollständig');
    if (chatOptOutSent) {
      assert.equal(
        report.chat_opt_out_verified,
        true,
        `In-Call-Chat-Widerspruch ("no") wurde nicht vollständig durchgesetzt (opted_out=${JSON.stringify(optedOutDiag)}, segmentsB=${segmentsB.length})`,
      );
    }
    if (config.speakerCount >= 4 && pageD) {
      assert.ok(
        distinctSpeakerNames.has(config.speakerDName) || distinctSpeakers.size >= (chatOptOutSent ? 3 : 4),
        `Late-Joiner "${config.speakerDName}" wurde nicht als eigener Sprecher gebunden (speakers=${[...distinctSpeakerNames].join(', ')})`,
      );
    }

    if (config.requireSpeakerBinding && config.speakerCount >= 2 && !config.videoOnly) {
      assert.ok(
        report.disjoint_streams_for_a_and_b,
        `Sprecher A und B wurden nicht auf getrennten Audio-Streams empfangen (distinct_stream_count=${report.distinct_stream_count})`,
      );
      assert.ok(
        report.speaker_attribution_verified,
        `Sprecherbindung unvollständig (attribution_unknown=true oder < 2 gebundene speaker_id). Siehe ${reportPath}`,
      );
    }

    return report;
  } finally {
    stopLobbyWatcher?.();
    if (recordingId) {
      await apiRequest(config, 'POST', `/v1/recordings/${recordingId}/cancel`).catch(() => {});
    }
    await Promise.all([
      leaveAndCloseBrowser(browserHost),
      leaveAndCloseBrowser(browserA),
      leaveAndCloseBrowser(browserB),
      leaveAndCloseBrowser(browserC),
      leaveAndCloseBrowser(browserD),
    ]);
    await rm(wavDir, {recursive: true, force: true}).catch(() => {});
  }
}

async function runCanaryCheck(config: LiveConfig): Promise<void> {
  const startedAt = Date.now();
  console.log(`\n[CANARY] Prüfe Cluster-Endpunkte auf ${config.apiUrl}...`);
  const liveHealth = await apiRequest<{status: string}>(config, 'GET', '/health/live');
  assert.ok(liveHealth.status === 'ok' || liveHealth.status === 'live', `/health/live meldet ${JSON.stringify(liveHealth)}`);
  const readyHealth = await apiRequest<{status: string}>(config, 'GET', '/health/ready');
  assert.ok(readyHealth.status === 'ready' || readyHealth.status === 'ok', `/health/ready meldet ${JSON.stringify(readyHealth)}`);
  console.log(`      /health/live=${liveHealth.status}, /health/ready=${readyHealth.status}`);

  const configuredProviders = config.providers.filter(p => Boolean(config.urls[p]));
  if (configuredProviders.length === 0) {
    throw new Error('Canary benötigt mindestens eine konfigurierte Meeting-URL in .env.live.');
  }
  const canaryProvider = configuredProviders[0];
  const e2eReport = await runProviderLiveTest(canaryProvider, config);
  const canarySummary = {
    timestamp: new Date().toISOString(),
    api_url: config.apiUrl,
    provider: canaryProvider,
    duration_seconds: Math.round((Date.now() - startedAt) / 100) / 10,
    health_live: liveHealth.status,
    health_ready: readyHealth.status,
    recording_id: e2eReport.recording_id,
    lobby_hold_verified: e2eReport.lobby_hold_verified,
    live_streaming_verified: e2eReport.live_streaming_verified,
    chat_opt_out_verified: e2eReport.chat_opt_out_verified,
    speaker_attribution_verified: e2eReport.speaker_attribution_verified,
    exports_verified: e2eReport.exports_verified,
    status: 'passed',
  };
  await mkdir(resolve(ROOT_DIR, '.dev'), {recursive: true});
  const canaryPath = resolve(ROOT_DIR, '.dev/canary-result.json');
  await writeFile(canaryPath, JSON.stringify(canarySummary, null, 2), 'utf8');
  console.log(`\n[CANARY BESTANDEN] Zusammenfassung gespeichert in: ${canaryPath}`);
}

async function main() {
  const args = process.argv.slice(2);
  const config = await loadConfig();
  if (args.includes('--four-speakers')) {
    config.speakerCount = Math.max(4, config.speakerCount);
  }
  if (args.includes('--video-only')) {
    config.videoOnly = true;
    config.speakerCount = 1;
    config.lobbyHoldSeconds = config.requireLobbyHold ? config.lobbyHoldSeconds : 0;
    config.testChatOptOut = false;
    config.requireChatOptOut = false;
    config.requireSpeakerBinding = false;
    config.testVideoDisplay = true;
    config.requireVideoDisplay = true;
  }
  if (args.includes('--require-video-display')) {
    config.testVideoDisplay = true;
    config.requireVideoDisplay = true;
  }
  if (args.includes('--chat-optout')) {
    config.testChatOptOut = true;
    config.requireChatOptOut = true;
  }
  if (args.includes('--no-chat-optout')) {
    config.testChatOptOut = false;
    config.requireChatOptOut = false;
  }

  const loginIdx = args.indexOf('--save-host-session');
  if (loginIdx !== -1) {
    const provider = (args[loginIdx + 1] || process.env.PROVIDER || 'google_meet') as Provider;
    if (!['google_meet', 'webex', 'teams', 'zoom'].includes(provider)) {
      throw new Error(`Ungültiger Provider "${provider}". Erlaubt: google_meet, webex, teams, zoom`);
    }
    await saveHostSessionInteractive(provider, config);
    return;
  }

  if (!config.apiToken) {
    throw new Error(
      'Kein API-Token gefunden. Bitte trage WORTLAUT_LIVE_API_TOKEN in .env.live ein oder führe `make setup` aus.',
    );
  }

  if (args.includes('--canary')) {
    await runCanaryCheck(config);
    return;
  }

  const configuredProviders = config.providers.filter(p => Boolean(config.urls[p]));
  if (configuredProviders.length === 0) {
    console.error(
      '\n[HINWEIS] Es ist noch keine Meeting-URL in `.env.live` eingetragen.\n' +
        'Bitte öffne `/data/wortlaut/.env.live` und trage mindestens eine URL ein:\n' +
        '  - WORTLAUT_LIVE_MEET_URL=https://meet.google.com/...\n' +
        '  - WORTLAUT_LIVE_WEBEX_URL=https://...webex.com/meet/...\n' +
        '  - WORTLAUT_LIVE_TEAMS_URL=https://teams.microsoft.com/l/meetup-join/...\n' +
        '  - WORTLAUT_LIVE_ZOOM_URL=https://zoom.us/j/...\n',
    );
    process.exitCode = 1;
    return;
  }

  for (const provider of configuredProviders) {
    await runProviderLiveTest(provider, config);
  }
}

await main();
