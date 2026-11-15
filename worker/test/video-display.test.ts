import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {existsSync} from 'node:fs';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {chromium, type Browser, type Frame, type Page} from 'playwright';
import {build} from 'vite';
import {MeetBrowser, type MeetBootstrap} from '../runtime/meet';
import {TeamsBrowser, type TeamsBootstrap} from '../runtime/teams-browser';
import {installVideoTile} from '../runtime/video-tile';
import {WebexBrowser, type WebexBrowserBootstrap} from '../runtime/webex-browser';
import {ZoomBrowser, type ZoomBootstrap} from '../runtime/zoom-browser';

const {WebSocketServer} = createRequire(import.meta.url)('ws');

/**
 * Shared browser-side helper script injected into each controlled provider fixture.
 * Simulates what a real conference SFU + remote participant browser does when the
 * provider web client calls getUserMedia({video}) for wortlaut's virtual camera:
 *  1. Acquires a prejoin preview stream and stops it on join (testing clone isolation).
 *  2. Acquires the in-call stream and sends its video track over a real loopback
 *     RTCPeerConnection to a decoded remote <video id="remote-bot-video"> (and for Zoom,
 *     also paints a .gallery-video-container <canvas> just like Zoom's WebCodecs/WASM view).
 *  3. Mounts both wortlaut's own self-preview tile and a remote participant ("Alice") in DOM
 *     to verify self-tile exclusion from dom_participants and ScreenShareKeyframeSampler.
 */
const LOOPBACK_RECEIVER_HELPER = `
window.__videoFixture = {
  previewTrackState: 'uninitialized',
  callTrackState: 'uninitialized',
  audioRejected: false,
  senderPc: null,
  receiverPc: null,
  remoteVideo: null,
  zoomGalleryCanvas: null,
  rafId: 0,
  async startVirtualCamera(mode) {
    if (this.callTrack && this.callTrack.readyState === 'live' && this.receiverPc) {
      return;
    }
    try {
      await navigator.mediaDevices.getUserMedia({audio: true});
    } catch (err) {
      this.audioRejected = err && err.name === 'NotFoundError';
    }
    const previewStream = await navigator.mediaDevices.getUserMedia({video: true});
    const previewTrack = previewStream.getVideoTracks()[0];
    const callStream = await navigator.mediaDevices.getUserMedia({video: {width: 1280, height: 720}});
    const callTrack = callStream.getVideoTracks()[0];
    // Stopping the prejoin preview track must leave the in-call clone live!
    previewTrack.stop();
    this.previewTrackState = previewTrack.readyState;
    this.callTrackState = callTrack.readyState;
    this.callTrack = callTrack;

    if (this.senderPc) this.senderPc.close();
    if (this.receiverPc) this.receiverPc.close();

    const sender = new RTCPeerConnection({iceServers: []});
    const receiver = new RTCPeerConnection({iceServers: []});
    this.senderPc = sender;
    this.receiverPc = receiver;
    sender.onicecandidate = (ev) => { if (ev.candidate) void receiver.addIceCandidate(ev.candidate); };
    receiver.onicecandidate = (ev) => { if (ev.candidate) void sender.addIceCandidate(ev.candidate); };

    const remoteVideo = document.createElement('video');
    remoteVideo.id = 'remote-bot-video';
    remoteVideo.muted = true;
    remoteVideo.autoplay = true;
    remoteVideo.playsInline = true;
    remoteVideo.style.cssText = 'position:fixed;right:0;bottom:0;width:320px;height:180px;opacity:0.01;pointer-events:none';
    document.body.append(remoteVideo);
    this.remoteVideo = remoteVideo;

    receiver.ontrack = (ev) => {
      remoteVideo.srcObject = ev.streams[0] || new MediaStream([ev.track]);
      void remoteVideo.play().catch(() => {});
    };

    sender.addTrack(callTrack, callStream);
    const offer = await sender.createOffer();
    await sender.setLocalDescription(offer);
    await receiver.setRemoteDescription(offer);
    const answer = await receiver.createAnswer();
    await receiver.setLocalDescription(answer);
    await sender.setRemoteDescription(answer);

    // Mount self-preview tile in DOM (must be excluded from dom_participants and keyframes!)
    let selfTile = document.getElementById('wortlaut-self-tile');
    if (!selfTile) {
      selfTile = document.createElement('div');
      selfTile.id = 'wortlaut-self-tile';
      selfTile.setAttribute('data-tid', 'video-tile');
      selfTile.setAttribute('data-participant-id', 'self-wortlaut-tile');
      const selfVid = document.createElement('video');
      selfVid.muted = true;
      selfVid.autoplay = true;
      selfVid.playsInline = true;
      selfVid.srcObject = callStream;
      selfTile.append(selfVid);
      document.body.append(selfTile);
      void selfVid.play().catch(() => {});
    }

    if (mode === 'zoom') {
      const wrap = document.createElement('div');
      wrap.className = 'gallery-video-container';
      const item = document.createElement('div');
      item.className = 'video-avatar__avatar';
      item.setAttribute('aria-label', 'wortlaut zoom tile');
      const zCanvas = document.createElement('canvas');
      zCanvas.id = 'zoom-gallery-canvas';
      zCanvas.width = 640;
      zCanvas.height = 360;
      item.append(zCanvas);
      wrap.append(item);
      document.body.append(wrap);
      this.zoomGalleryCanvas = zCanvas;
      const zCtx = zCanvas.getContext('2d');
      const pump = () => {
        if (remoteVideo.readyState >= 2 && remoteVideo.videoWidth > 0 && zCtx) {
          zCtx.drawImage(remoteVideo, 0, 0, 640, 360);
        }
        this.rafId = requestAnimationFrame(pump);
      };
      this.rafId = requestAnimationFrame(pump);
    }
  },
  async cleanup() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    if (this.senderPc) this.senderPc.close();
    if (this.receiverPc) this.receiverPc.close();
  }
};
`;

async function readDecodedReceiverMetrics(target: Page | Frame) {
  return target.evaluate(async () => {
    const fx = (window as unknown as Record<string, any>).__videoFixture;
    const vid = fx?.remoteVideo as HTMLVideoElement | null;
    if (!vid) throw new Error('remoteVideo missing');

    const deadline = Date.now() + 8000;
    while ((vid.readyState < 2 || vid.videoWidth === 0) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    let framesDecoded = 0;
    let bytesReceived = 0;
    if (fx.receiverPc) {
      const stats = await (fx.receiverPc as RTCPeerConnection).getStats();
      stats.forEach((report: Record<string, any>) => {
        if (report.type === 'inbound-rtp' && report.kind === 'video') {
          framesDecoded += Number(report.framesDecoded || 0);
          bytesReceived += Number(report.bytesReceived || 0);
        }
      });
    }

    const probe = document.createElement('canvas');
    probe.width = 320;
    probe.height = 180;
    const ctx = probe.getContext('2d', {willReadFrequently: true})!;
    ctx.drawImage(vid, 0, 0, 320, 180);
    const rgba = ctx.getImageData(0, 0, 320, 180).data;

    let nonBlackPixels = 0;
    let brightPixels = 0;
    let lowerTranscriptInk = 0;
    // Sample transcript body region (y: 44..160, x: 16..304 in 320x180 scaled coords)
    const bodySignature: number[] = [];
    for (let y = 0; y < 180; y += 2) {
      for (let x = 0; x < 320; x += 2) {
        const idx = (y * 320 + x) * 4;
        const luma = Math.round(0.299 * rgba[idx] + 0.587 * rgba[idx + 1] + 0.114 * rgba[idx + 2]);
        if (x % 4 === 0 && y % 4 === 0) {
          if (luma > 8) nonBlackPixels += 1;
          if (luma > 90) brightPixels += 1;
          if (y >= 44 && y <= 160 && x >= 16 && x <= 304) {
            bodySignature.push(luma);
          }
        }
        if (y >= 132 && y <= 162 && x >= 24 && x <= 220 && luma > 85) {
          lowerTranscriptInk += 1;
        }
      }
    }

    let zoomCanvasNonBlack = 0;
    if (fx.zoomGalleryCanvas) {
      const zc = fx.zoomGalleryCanvas as HTMLCanvasElement;
      const zData = zc.getContext('2d')!.getImageData(0, 0, zc.width, zc.height).data;
      for (let i = 0; i < zData.length; i += 64) {
        if (zData[i] > 8 || zData[i + 1] > 8 || zData[i + 2] > 8) zoomCanvasNonBlack += 1;
      }
    }

    const snap = window.wortlautVideoTile?.getSnapshot() ?? null;
    return {
      videoWidth: vid.videoWidth,
      videoHeight: vid.videoHeight,
      framesDecoded,
      bytesReceived,
      nonBlackPixels,
      brightPixels,
      lowerTranscriptInk,
      bodySignature,
      zoomCanvasNonBlack,
      previewTrackState: fx.previewTrackState,
      callTrackState: fx.callTrack?.readyState ?? fx.callTrackState,
      audioRejected: fx.audioRejected,
      snap,
    };
  });
}

function countChangedSamples(a: number[], b: number[], threshold = 18): number {
  const len = Math.min(a.length, b.length);
  let diff = 0;
  for (let i = 0; i < len; i++) {
    if (Math.abs(a[i] - b[i]) >= threshold) diff += 1;
  }
  return diff;
}

test('video tile trust gating & localization across Google Meet, Microsoft Teams, Cisco Webex, and Zoom', async () => {
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  try {
    // 1. Untrusted / SSO / preload origins must NEVER receive wortlautVideoTile or virtual camera
    const untrustedCases: Array<{
      provider: 'google_meet' | 'teams' | 'webex' | 'zoom';
      meetingUrl: string;
      visitUrl: string;
    }> = [
      {
        provider: 'google_meet',
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
        visitUrl: 'https://accounts.google.com/v3/signin',
      },
      {
        provider: 'teams',
        meetingUrl: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0',
        visitUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      },
      {
        provider: 'webex',
        meetingUrl: 'https://acme.webex.com/meet/demo',
        visitUrl: 'https://web.webex.com/guest-join-meeting?preload=true',
      },
      {
        provider: 'zoom',
        meetingUrl: 'https://us02web.zoom.us/j/3722611153',
        visitUrl: 'https://sso.example.com/zoom/login',
      },
    ];

    for (const c of untrustedCases) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.route('**/*', (route) =>
        route.fulfill({contentType: 'text/html', body: '<!doctype html><html><body>untrusted</body></html>'}),
      );
      await installVideoTile(page, c.provider, c.meetingUrl, {
        locale: 'de-DE',
        invitedBy: 'Dr. Host',
        meetingTitle: 'Architektur-Board',
      });
      await page.goto(c.visitUrl);
      const check = await page.evaluate(async () => {
        const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
        return {
          hasTile: Boolean(window.wortlautVideoTile),
          hasVirtualLabel: devices.some((d) => d.label === 'wortlaut Live-Protokoll'),
        };
      });
      assert.equal(check.hasTile, false, `Expected no video tile on untrusted ${c.provider} URL ${c.visitUrl}`);
      assert.equal(check.hasVirtualLabel, false, `Expected no virtual camera on untrusted ${c.provider} URL`);
      await ctx.close();
    }

    // 2. Verify English ('en-US') and German ('de-DE') rendering on trusted Teams live.com & Zoom subdomains
    for (const localeCase of [
      {
        provider: 'teams' as const,
        url: 'https://teams.live.com/v2/',
        locale: 'en-US',
        expectedText: 'Alice: English live transcript line.',
      },
      {
        provider: 'zoom' as const,
        url: 'https://us02web.zoom.us/wc/3722611153/join',
        locale: 'de-DE',
        expectedText: 'Alice: Deutsche Live-Protokollzeile.',
      },
    ]) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.route('**/*', (route) =>
        route.fulfill({contentType: 'text/html', body: '<!doctype html><html><body>trusted</body></html>'}),
      );
      const update = await installVideoTile(page, localeCase.provider, localeCase.url, {
        locale: localeCase.locale,
        invitedBy: 'Johann',
        meetingTitle: 'Sprint Sync',
      });
      await page.goto(localeCase.url);
      const perm = await page.evaluate(async () => {
        const status = await navigator.permissions.query({name: 'camera' as PermissionName});
        return status.state;
      });
      assert.equal(perm, 'granted');
      await update({
        participation: 'capturing',
        segments: [
          {
            speaker: 'Alice',
            text: localeCase.locale === 'en-US' ? 'English live transcript line.' : 'Deutsche Live-Protokollzeile.',
            start: 12,
          },
        ],
      });
      const snap = await page.evaluate(() => window.wortlautVideoTile?.getSnapshot());
      assert.equal(snap?.participation, 'capturing');
      assert.equal(snap?.segmentCount, 1);
      assert.equal(snap?.lastRenderedText, localeCase.expectedText);
      await page.evaluate(() => window.wortlautVideoTile?.stop());
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
});

test('all 4 provider drivers display live transcript video to remote receivers while excluding self-tiles & self-keyframes', async () => {
  const workerRoot = fileURLToPath(new URL('..', import.meta.url));
  if (!existsSync(fileURLToPath(new URL('../dist/meet/capture.js', import.meta.url)))) {
    await build({
      root: workerRoot,
      configFile: fileURLToPath(new URL('../vite.meet.config.ts', import.meta.url)),
      logLevel: 'silent',
    });
  }
  const meetAssets = new URL('../dist/meet/', import.meta.url);

  const uploadedKeyframes: Array<{attemptId: string; bytes: number}> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const part of req) chunks.push(part as Buffer);
    if (req.method === 'POST' && req.url?.endsWith('/keyframes')) {
      uploadedKeyframes.push({attemptId: req.url, bytes: Buffer.concat(chunks).byteLength});
      res.writeHead(201, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({id: randomUUID(), sequence: 0, duplicate: false}));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const sockets = new WebSocketServer({server});
  sockets.on('connection', (socket: any) =>
    socket.on('message', (data: Buffer, binary: boolean) => {
      const metadata = binary
        ? JSON.parse(data.subarray(4, 4 + data.readUInt32BE(0)).toString())
        : JSON.parse(data.toString());
      if (metadata.type === 'auth') {
        socket.send(JSON.stringify({type: 'ready'}));
        return;
      }
      const id = metadata.id ?? `${metadata.attempt_id}/${metadata.stream_id}/${metadata.epoch}/${metadata.sequence}`;
      socket.send(JSON.stringify({type: 'ack', id}));
    }),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const apiUrl = `http://127.0.0.1:${(server.address() as {port: number}).port}`;

  const activeStops: Array<() => Promise<unknown>> = [];
  let browser: Browser | undefined;

  try {
    browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      args: ['--autoplay-policy=no-user-gesture-required'],
    });
    // =========================================================================
    // 1. GOOGLE MEET (MeetBrowser)
    // =========================================================================
    {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const meetUrl = 'https://meet.google.com/vid-tile-met';
      await page.route('https://meet.google.com/**', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html><body>
            <label>Your name<input type="text" id="meet-name"></label>
            <button id="mic-btn" aria-label="Turn off microphone">Mic</button>
            <button id="cam-btn" aria-label="Turn on camera">Cam</button>
            <button id="join-btn">Ask to join</button>
            <p id="lobby-msg"></p>
            <script>
              ${LOOPBACK_RECEIVER_HELPER}
              document.getElementById('mic-btn').onclick = function() {
                this.setAttribute('aria-label', 'Turn on microphone');
              };
              document.getElementById('cam-btn').onclick = function() {
                this.setAttribute('aria-label', 'Turn off camera');
                void window.__videoFixture.startVirtualCamera('google_meet');
              };
              document.getElementById('join-btn').onclick = function() {
                this.remove();
                document.getElementById('meet-name').remove();
                document.getElementById('lobby-msg').textContent = 'Asking to be let in...';
              };
              window.admitMeet = function() {
                document.getElementById('lobby-msg').textContent = '';
                // Simulate Meet resetting camera to OFF on admission so in-call camera recovery is exercised too!
                document.getElementById('cam-btn').setAttribute('aria-label', 'Turn on camera');
                const leave = document.createElement('button');
                leave.setAttribute('aria-label', 'Leave call');
                leave.onclick = () => leave.remove();
                const people = document.createElement('button');
                people.setAttribute('aria-label', 'People');
                people.setAttribute('aria-expanded', 'false');
                const remoteAlice = document.createElement('div');
                remoteAlice.setAttribute('data-participant-id', 'spaces/meet/devices/alice');
                remoteAlice.setAttribute('data-self-name', 'wortlaut');
                const nameSpan = document.createElement('span');
                nameSpan.textContent = 'Alice Meet';
                remoteAlice.append(nameSpan);
                document.body.append(leave, people, remoteAlice);
              };
            </script>
          </body></html>`,
        }),
      );

      const bootstrap: MeetBootstrap = {
        provider: 'google_meet',
        meeting_id: randomUUID(),
        attempt_id: randomUUID(),
        meeting_url: meetUrl,
        deadline: new Date(Date.now() + 60000).toISOString(),
        lobby_timeout_seconds: 30,
        enable_keyframes: true,
        invited_by: 'alice@example.org',
        invited_by_name: 'Alice Meet',
        meeting_title: 'Meet Video Review',
        default_locale: 'de-DE',
        meet: {display_name: 'wortlaut', locale: 'en-US', auth_mode: 'guest'},
      };

      const meet = new MeetBrowser(page, bootstrap, apiUrl, 'secret', randomUUID(), meetAssets);
      activeStops.push(() => meet.stop('cancelled'));
      await meet.prepare();
      await page.goto(meetUrl);
      await meet.join();

      assert.equal((await meet.inspect()).participation, 'waiting_admission');
      await meet.updateVideoTile({participation: 'waiting_admission'});
      const beforeSegments = await readDecodedReceiverMetrics(page);
      assert.equal(beforeSegments.videoWidth, 1280);
      assert.equal(beforeSegments.videoHeight, 720);
      assert.ok(beforeSegments.framesDecoded > 0, 'Expected decoded WebRTC video frames on Meet receiver');
      assert.ok(beforeSegments.nonBlackPixels > 200);
      assert.ok(beforeSegments.brightPixels > 20);
      assert.equal(beforeSegments.lowerTranscriptInk, 0);
      assert.equal(beforeSegments.audioRejected, true);
      assert.equal(beforeSegments.previewTrackState, 'ended');
      assert.equal(beforeSegments.callTrackState, 'live');

      await page.evaluate(() => (window as any).admitMeet());
      const inCallState = await meet.inspect();
      assert.equal(inCallState.participation, 'capturing');
      // Verify MeetBrowser re-enabled camera in-call after admission reset it!
      assert.equal(await page.locator('#cam-btn').getAttribute('aria-label'), 'Turn off camera');

      await meet.updateVideoTile({
        participation: 'capturing',
        segments: [
          {speaker: 'Alice Meet', text: 'Google Meet empfängt das Live-Protokoll als scharfes 720p-Video.', start: 3},
          {speaker: 'Bob Meet', text: 'Zweite Zeile bestätigt sichtbare Pixeländerung im Empfänger.', start: 9},
        ],
      });
      await page.waitForTimeout(450);
      const afterSegments = await readDecodedReceiverMetrics(page);
      assert.ok(afterSegments.framesDecoded > beforeSegments.framesDecoded);
      assert.equal(
        afterSegments.snap?.lastRenderedText,
        'Bob Meet: Zweite Zeile bestätigt sichtbare Pixeländerung im Empfänger.',
      );
      assert.ok(
        countChangedSamples(beforeSegments.bodySignature, afterSegments.bodySignature) >= 8,
        'Expected decoded remote Meet video pixels to visibly change when transcript segments arrive',
      );
      assert.ok(afterSegments.lowerTranscriptInk >= 10, 'Expected decoded Meet transcript lines in lower tile viewport');

      // Wait >1.0s so keyframe sampler evaluates at least one 1s tick: self video tile must emit 0 keyframes!
      await page.waitForTimeout(1050);
      const afterTicks = await meet.inspect();
      assert.equal(afterTicks.keyframes?.emitted ?? 0, 0, 'Self video tile must never emit keyframes on Meet');
      assert.equal(afterTicks.participant_sources.dom_participants ?? 1, 1);

      await meet.stop('normal');
      assert.equal(await page.evaluate(() => window.wortlautVideoTile?.getSnapshot().activeTracks), 0);
      await page.evaluate(() => (window as any).__videoFixture.cleanup());
      await ctx.close();
    }

    // =========================================================================
    // 2. MICROSOFT TEAMS (TeamsBrowser)
    // =========================================================================
    {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const teamsUrl = 'https://teams.microsoft.com/meet/2233445566?p=vidtest';
      await page.route('https://teams.microsoft.com/**', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html><body>
            <label>Ihr Name<input data-tid="prejoin-display-name-input" id="teams-name"></label>
            <label><input type="radio" name="audio" value="computer" checked>Computeraudio</label>
            <button id="microphone-button" aria-label="Mikrofon stummschalten">Mic</button>
            <button id="video-button" aria-label="Kamera einschalten">Cam</button>
            <button id="join-btn" data-tid="prejoin-join-button">Jetzt teilnehmen</button>
            <p id="waiting"></p>
            <script>
              ${LOOPBACK_RECEIVER_HELPER}
              document.getElementById('microphone-button').onclick = function() {
                this.setAttribute('aria-label', 'Stummschaltung aufheben');
              };
              document.getElementById('video-button').onclick = function() {
                this.setAttribute('aria-label', 'Kamera ausschalten');
                void window.__videoFixture.startVirtualCamera('teams');
              };
              document.getElementById('join-btn').onclick = function() {
                this.remove();
                document.getElementById('waiting').textContent = '';
                const leave = document.createElement('button');
                leave.textContent = 'Verlassen';
                leave.onclick = () => leave.remove();
                const rosterBtn = document.createElement('button');
                rosterBtn.id = 'roster-button';
                rosterBtn.textContent = 'Teilnehmer';
                rosterBtn.setAttribute('aria-expanded', 'false');
                const aliceTile = document.createElement('div');
                aliceTile.setAttribute('data-tid', 'video-tile');
                aliceTile.setAttribute('data-participant-id', 'teams-alice-1');
                const aliceName = document.createElement('span');
                aliceName.setAttribute('data-tid', 'video-tile-name');
                aliceName.textContent = 'Alice Teams';
                aliceTile.append(aliceName);
                document.body.append(leave, rosterBtn, aliceTile);
              };
            </script>
          </body></html>`,
        }),
      );

      const bootstrap: TeamsBootstrap = {
        provider: 'teams',
        meeting_id: randomUUID(),
        attempt_id: randomUUID(),
        meeting_url: teamsUrl,
        deadline: new Date(Date.now() + 60000).toISOString(),
        lobby_timeout_seconds: 30,
        enable_keyframes: true,
        invited_by: 'alice@contoso.com',
        invited_by_name: 'Alice Teams',
        meeting_title: 'Teams Video Review',
        default_locale: 'de-DE',
        teams: {display_name: 'wortlaut', locale: 'de-DE'},
      };

      const teams = new TeamsBrowser(page, bootstrap, apiUrl, 'secret', randomUUID(), meetAssets);
      activeStops.push(() => teams.stop('cancelled'));
      await teams.prepare();
      await page.goto(teamsUrl);
      await teams.join();

      const state1 = await teams.inspect();
      assert.equal(state1.participation, 'capturing');
      assert.equal(state1.reason, '');
      assert.equal(await page.locator('#microphone-button').getAttribute('aria-label'), 'Stummschaltung aufheben');
      assert.equal(await page.locator('#video-button').getAttribute('aria-label'), 'Kamera ausschalten');

      await teams.updateVideoTile({participation: 'capturing', segments: []});
      const beforeSegments = await readDecodedReceiverMetrics(page);
      assert.equal(beforeSegments.videoWidth, 1280);
      assert.equal(beforeSegments.videoHeight, 720);
      assert.ok(beforeSegments.framesDecoded > 0);
      assert.equal(beforeSegments.lowerTranscriptInk, 0);
      assert.equal(beforeSegments.audioRejected, true);

      await teams.updateVideoTile({
        participation: 'capturing',
        segments: [
          {speaker: 'Alice Teams', text: 'Microsoft Teams zeigt die Live-Transkription im Video-Feed.', start: 6},
        ],
      });
      await page.waitForTimeout(450);
      const afterSegments = await readDecodedReceiverMetrics(page);
      assert.ok(
        countChangedSamples(beforeSegments.bodySignature, afterSegments.bodySignature) >= 6,
        'Expected decoded remote Teams video pixels to update after live_transcript push',
      );
      assert.ok(afterSegments.lowerTranscriptInk >= 10, 'Expected decoded Teams transcript lines in lower tile viewport');

      await page.waitForTimeout(1050);
      const afterTicks = await teams.inspect();
      assert.equal(afterTicks.keyframes?.emitted ?? 0, 0, 'Self video tile must never emit keyframes on Teams');
      assert.equal(afterTicks.participant_sources.dom_participants, 1);

      await teams.stop('normal');
      assert.equal(await page.evaluate(() => window.wortlautVideoTile?.getSnapshot().activeTracks), 0);
      await page.evaluate(() => (window as any).__videoFixture.cleanup());
      await ctx.close();
    }

    // =========================================================================
    // 3. CISCO WEBEX (WebexBrowser cross-origin iframe forwarding via resolveFrame)
    // =========================================================================
    {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const webexUrl = 'https://acme.webex.com/meet/vidtest';
      await page.route('https://acme.webex.com/**', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html><body>
            <iframe id="preload-frame" src="https://web.webex.com/guest-join-meeting?preload=true"></iframe>
            <iframe id="active-frame" src="https://web.webex.com/guest-join-meeting"></iframe>
          </body></html>`,
        }),
      );
      await page.route('https://web.webex.com/**', (route) => {
        if (route.request().url().includes('preload=true')) {
          return route.fulfill({contentType: 'text/html', body: '<!doctype html><html><body>preload</body></html>'});
        }
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html><body>
            <label>Your name<input id="webex-name"></label>
            <button id="webex-mic">Your microphone is currently unmuted</button>
            <button id="webex-video">Sending video is currently disabled</button>
            <button id="webex-join">Join meeting</button>
            <p id="webex-lobby"></p>
            <script>
              ${LOOPBACK_RECEIVER_HELPER}
              document.getElementById('webex-mic').onclick = function() {
                this.textContent = 'Your microphone is currently muted';
              };
              document.getElementById('webex-video').onclick = function() {
                this.textContent = 'Sending video is currently enabled';
                void window.__videoFixture.startVirtualCamera('webex');
              };
              document.getElementById('webex-join').onclick = function() {
                this.remove();
                const leave = document.createElement('button');
                leave.textContent = 'Leave meeting';
                leave.onclick = () => leave.remove();
                const aliceItem = document.createElement('div');
                aliceItem.setAttribute('role', 'listitem');
                aliceItem.setAttribute('data-participant-id', 'webex-alice-1');
                aliceItem.setAttribute('aria-label', 'Alice Webex');
                document.body.append(leave, aliceItem);
              };
            </script>
          </body></html>`,
        });
      });

      const bootstrap: WebexBrowserBootstrap = {
        provider: 'webex',
        meeting_id: randomUUID(),
        attempt_id: randomUUID(),
        meeting_url: webexUrl,
        deadline: new Date(Date.now() + 60000).toISOString(),
        lobby_timeout_seconds: 30,
        enable_keyframes: true,
        invited_by: 'alice@cisco.example',
        invited_by_name: 'Alice Webex',
        meeting_title: 'Webex Video Review',
        default_locale: 'en-US',
        webex_browser: {display_name: 'wortlaut'},
      };

      const webex = new WebexBrowser(page, bootstrap, apiUrl, 'secret', randomUUID(), meetAssets);
      activeStops.push(() => webex.stop('cancelled'));
      await webex.prepare();
      await page.goto(webexUrl);
      await webex.join();

      // Verify top-level host AND ?preload=true iframe did NOT get wortlautVideoTile, while active iframe DID!
      const preloadFrame = page.frames().find((f) => f.url().includes('preload=true'))!;
      const activeFrame = page.frames().find(
        (f) => f.url() === 'https://web.webex.com/guest-join-meeting',
      )!;
      assert.equal(await page.evaluate(() => Boolean(window.wortlautVideoTile)), false);
      assert.equal(await preloadFrame.evaluate(() => Boolean(window.wortlautVideoTile)), false);
      assert.equal(await activeFrame.evaluate(() => Boolean(window.wortlautVideoTile)), true);

      const state1 = await webex.inspect();
      assert.equal(state1.participation, 'capturing');
      assert.equal(state1.reason, '');

      await webex.updateVideoTile({participation: 'capturing', segments: []});
      const beforeSegments = await readDecodedReceiverMetrics(activeFrame);
      assert.equal(beforeSegments.videoWidth, 1280);
      assert.equal(beforeSegments.videoHeight, 720);
      assert.ok(beforeSegments.framesDecoded > 0);
      assert.equal(beforeSegments.lowerTranscriptInk, 0);
      assert.equal(beforeSegments.audioRejected, true);

      await webex.updateVideoTile({
        participation: 'capturing',
        segments: [
          {speaker: 'Alice Webex', text: 'Webex forwards live transcript updates into the meeting iframe.', start: 8},
        ],
      });
      await page.waitForTimeout(450);
      const afterSegments = await readDecodedReceiverMetrics(activeFrame);
      assert.equal(
        afterSegments.snap?.lastRenderedText,
        'Alice Webex: Webex forwards live transcript updates into the meeting iframe.',
      );
      assert.ok(
        countChangedSamples(beforeSegments.bodySignature, afterSegments.bodySignature) >= 6,
        'Expected decoded remote Webex video pixels to update inside cross-origin meeting iframe',
      );
      assert.ok(afterSegments.lowerTranscriptInk >= 10, 'Expected decoded Webex transcript lines in lower tile viewport');

      await page.waitForTimeout(1050);
      const afterTicks = await webex.inspect();
      assert.equal(afterTicks.keyframes?.emitted ?? 0, 0, 'Self video tile must never emit keyframes on Webex');

      await webex.stop('normal');
      assert.equal(await activeFrame.evaluate(() => window.wortlautVideoTile?.getSnapshot().activeTracks), 0);
      await activeFrame.evaluate(() => (window as any).__videoFixture.cleanup());
      await ctx.close();
    }

    // =========================================================================
    // 4. ZOOM (ZoomBrowser prejoin + in-call Start Video + <canvas> gallery tile)
    // =========================================================================
    {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const zoomUrl = 'https://us02web.zoom.us/wc/3722611153/join?pwd=fixture-passcode';
      await page.route('https://us02web.zoom.us/**', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html><body>
            <label>Your Name<input id="input-for-name"></label>
            <button id="preview-audio-control-button" aria-label="Mute">Mute</button>
            <button id="preview-video-control-button" aria-label="Start Video">Start Video</button>
            <button id="joinBtn" class="preview-join-button">Join</button>
            <script>
              ${LOOPBACK_RECEIVER_HELPER}
              window.__zoomPreviewVideoClicked = false;
              window.__zoomInCallVideoClicked = false;
              document.getElementById('preview-audio-control-button').onclick = function() {
                this.setAttribute('aria-label', 'Unmute');
              };
              document.getElementById('preview-video-control-button').onclick = function() {
                window.__zoomPreviewVideoClicked = true;
                this.setAttribute('aria-label', 'Stop Video');
              };
              document.getElementById('joinBtn').onclick = function() {
                this.remove();
                const leave = document.createElement('button');
                leave.className = 'footer__leave-btn';
                leave.textContent = 'Leave';
                leave.onclick = () => leave.remove();
                const participants = document.createElement('button');
                participants.setAttribute('aria-label', 'Participants (2)');
                // Simulate Zoom Web Client requiring in-call Start Video activation as well!
                const inCallVideo = document.createElement('button');
                inCallVideo.id = 'in-call-video-btn';
                inCallVideo.className = 'send-video-container__btn';
                inCallVideo.setAttribute('aria-label', 'Start Video');
                inCallVideo.textContent = 'Start Video';
                inCallVideo.onclick = function() {
                  window.__zoomInCallVideoClicked = true;
                  this.setAttribute('aria-label', 'Stop Video');
                  this.textContent = 'Stop Video';
                  void window.__videoFixture.startVirtualCamera('zoom');
                };
                const rosterList = document.createElement('ul');
                rosterList.id = 'participants-list';
                rosterList.innerHTML = '<li class="participants-li" data-participant-id="zoom-alice-1" aria-label="Alice Zoom"><span class="participants-item__display-name">Alice Zoom</span></li>';
                document.body.append(leave, participants, inCallVideo, rosterList);
              };
            </script>
          </body></html>`,
        }),
      );

      const bootstrap: ZoomBootstrap = {
        provider: 'zoom',
        meeting_id: randomUUID(),
        attempt_id: randomUUID(),
        meeting_url: zoomUrl,
        deadline: new Date(Date.now() + 60000).toISOString(),
        lobby_timeout_seconds: 30,
        enable_keyframes: true,
        invited_by: 'johann@example.org',
        invited_by_name: 'Johann Zoom',
        meeting_title: 'Zoom Video Review',
        default_locale: 'de-DE',
        zoom: {display_name: 'wortlaut', locale: 'de-DE', auth_mode: 'guest'},
      };

      const zoom = new ZoomBrowser(page, bootstrap, apiUrl, 'secret', randomUUID(), meetAssets);
      activeStops.push(() => zoom.stop('cancelled'));
      await zoom.prepare();
      await page.goto(zoomUrl);
      await zoom.join();

      const state1 = await zoom.inspect();
      assert.equal(state1.participation, 'capturing');
      assert.equal(state1.reason, '');
      assert.equal(await page.evaluate(() => (window as any).__zoomPreviewVideoClicked), true);
      assert.equal(await page.evaluate(() => (window as any).__zoomInCallVideoClicked), true);

      await zoom.updateVideoTile({participation: 'capturing', segments: []});
      const beforeSegments = await readDecodedReceiverMetrics(page);
      assert.equal(beforeSegments.videoWidth, 1280);
      assert.equal(beforeSegments.videoHeight, 720);
      assert.ok(beforeSegments.framesDecoded > 0);
      assert.equal(beforeSegments.lowerTranscriptInk, 0);
      assert.ok(beforeSegments.zoomCanvasNonBlack > 50, 'Expected Zoom gallery <canvas> to render non-black bot video');
      assert.equal(beforeSegments.audioRejected, true);

      await zoom.updateVideoTile({
        participation: 'capturing',
        segments: [
          {speaker: 'Alice Zoom', text: 'Zoom Web-Client rendert die wortlaut-Videokachel auf Canvas.', start: 5},
        ],
      });
      await page.waitForTimeout(450);
      const afterSegments = await readDecodedReceiverMetrics(page);
      assert.ok(
        countChangedSamples(beforeSegments.bodySignature, afterSegments.bodySignature) >= 6,
        'Expected decoded Zoom video/canvas pixels to visibly update when transcript segments arrive',
      );
      assert.ok(afterSegments.lowerTranscriptInk >= 10, 'Expected decoded Zoom transcript lines in lower tile viewport');

      // Even with a live gallery <canvas> present in Zoom DOM, sampler must NOT emit keyframes without share banner!
      await page.waitForTimeout(1050);
      const afterTicks = await zoom.inspect();
      assert.equal(afterTicks.keyframes?.emitted ?? 0, 0, 'Zoom gallery/self canvas must never emit keyframes');

      await zoom.stop('normal');
      assert.equal(await page.evaluate(() => window.wortlautVideoTile?.getSnapshot().activeTracks), 0);
      await page.evaluate(() => (window as any).__videoFixture.cleanup());
      await ctx.close();
    }

    assert.equal(uploadedKeyframes.length, 0, 'Zero self-video keyframes may ever be uploaded across all 4 providers');
  } finally {
    await Promise.allSettled(activeStops.map((fn) => fn()));
    await browser?.close();
    for (const client of sockets.clients) {
      client.terminate();
    }
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
