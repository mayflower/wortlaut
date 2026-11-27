import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {build} from 'vite';
import {
  computeExportDimensions,
  computeLumaStddev,
  gridsDiffer,
  LUMA_PIXELS,
  LUMA_W,
  shouldStopForEmptyRoom,
} from '../src/keyframes';
import {KeyframeTransport} from '../runtime/keyframe-transport';
import {installMeetCapture} from '../runtime/meet';

test('pure luma grid filters cursor noise, detects slide changes, and computes bounded dimensions', () => {
  const blank = new Uint8Array(LUMA_PIXELS).fill(20);
  assert.equal(computeLumaStddev(blank), 0);

  const slideA = new Uint8Array(LUMA_PIXELS);
  for (let i = 0; i < LUMA_PIXELS; i++) {
    slideA[i] = i % LUMA_W < 32 ? 30 : 210;
  }
  assert.ok(computeLumaStddev(slideA) >= 4.0);

  // 1-block cursor blink (4x4 pixels) must NOT trigger a candidate slide change.
  const cursorBlink = new Uint8Array(slideA);
  for (let dy = 0; dy < 4; dy++) {
    for (let dx = 0; dx < 4; dx++) {
      cursorBlink[dy * LUMA_W + dx] = 250;
    }
  }
  assert.equal(gridsDiffer(slideA, cursorBlink), false);

  // 8-block diagram box update (>= 6 blocks with delta >= 22) MUST trigger a candidate change.
  const diagramUpdate = new Uint8Array(slideA);
  for (let blockIdx = 0; blockIdx < 8; blockIdx++) {
    const bx = blockIdx * 4;
    for (let dy = 0; dy < 4; dy++) {
      for (let dx = 0; dx < 4; dx++) {
        diagramUpdate[dy * LUMA_W + bx + dx] = 220;
      }
    }
  }
  assert.equal(gridsDiffer(slideA, diagramUpdate), true);

  assert.deepEqual(computeExportDimensions(800, 600), {width: 800, height: 600});
  assert.deepEqual(computeExportDimensions(3840, 2160), {width: 1280, height: 720});
});

test('shouldStopForEmptyRoom treats active presenter-bound screen share as room liveness', () => {
  const silentNoShare = shouldStopForEmptyRoom({
    nowMs: 1000,
    emptySinceMs: undefined,
    configuredTimeoutSeconds: 60,
    currentDomParticipants: 2,
    maxDomParticipants: 2,
    streams: 1,
    activeSamples: 0,
    lastActiveSamples: 0,
    rtpAdvanced: false,
    activeShare: false,
  });
  assert.equal(silentNoShare.emptySinceMs, 1000);
  assert.equal(silentNoShare.shouldStop, false);

  // Active share resets emptySinceMs during a silent diagram walkthrough.
  const silentWithShare = shouldStopForEmptyRoom({
    nowMs: 500_000,
    emptySinceMs: 1000,
    configuredTimeoutSeconds: 60,
    currentDomParticipants: 2,
    maxDomParticipants: 2,
    streams: 1,
    activeSamples: 0,
    lastActiveSamples: 0,
    rtpAdvanced: false,
    activeShare: true,
  });
  assert.equal(silentWithShare.emptySinceMs, undefined);
  assert.equal(silentWithShare.shouldStop, false);

  // If the room actually empties (currentDomParticipants === 0 after >= 1), stop after 15s even if stale flag.
  const emptiedStart = shouldStopForEmptyRoom({
    nowMs: 10_000,
    emptySinceMs: undefined,
    configuredTimeoutSeconds: 300,
    currentDomParticipants: 0,
    maxDomParticipants: 2,
    streams: 0,
    activeSamples: 0,
    lastActiveSamples: 0,
    rtpAdvanced: false,
    activeShare: true,
  });
  assert.equal(emptiedStart.emptySinceMs, 10_000);
  const emptiedExpired = shouldStopForEmptyRoom({
    nowMs: 26_000,
    emptySinceMs: emptiedStart.emptySinceMs,
    configuredTimeoutSeconds: 300,
    currentDomParticipants: 0,
    maxDomParticipants: 2,
    streams: 0,
    activeSamples: 0,
    lastActiveSamples: 0,
    rtpAdvanced: false,
    activeShare: true,
  });
  assert.equal(emptiedExpired.shouldStop, true);
  // Off-the-record pause (#pause) resets emptySinceMs while participants remain in the room,
  // even when audio samples are zeroed and no screen share is active.
  const pausedWithParticipants = shouldStopForEmptyRoom({
    nowMs: 600_000,
    emptySinceMs: 1000,
    configuredTimeoutSeconds: 60,
    currentDomParticipants: 2,
    maxDomParticipants: 2,
    streams: 1,
    activeSamples: 0,
    lastActiveSamples: 0,
    rtpAdvanced: false,
    activeShare: false,
    paused: true,
  });
  assert.equal(pausedWithParticipants.emptySinceMs, undefined);
  assert.equal(pausedWithParticipants.shouldStop, false);

  // If everyone leaves while paused (currentDomParticipants === 0 after >= 1), still stop cleanly after 15s!
  const pausedDomEmptied = shouldStopForEmptyRoom({
    nowMs: 26_000,
    emptySinceMs: 10_000,
    configuredTimeoutSeconds: 300,
    currentDomParticipants: 0,
    maxDomParticipants: 2,
    streams: 0,
    activeSamples: 0,
    lastActiveSamples: 0,
    rtpAdvanced: false,
    activeShare: false,
    paused: true,
  });
  assert.equal(pausedDomEmptied.shouldStop, true);
});

test('KeyframeTransport retries 503, halts without retry on 409 limit, and bounds queue size', async () => {
  let mode: 'retry_503' | 'limit_409' | 'optout_409' | 'slow' = 'retry_503';
  let calls = 0;
  let lastHeaders: Record<string, string | string[] | undefined> = {};
  let releaseSlow: (() => void) | null = null;
  let notifySlowArrived: (() => void) | null = null;

  const server = createServer(async (req, res) => {
    calls += 1;
    lastHeaders = req.headers;
    const chunks: Buffer[] = [];
    for await (const part of req) chunks.push(part as Buffer);

    if (mode === 'slow') {
      await new Promise<void>((resolve) => {
        releaseSlow = resolve;
        notifySlowArrived?.();
      });
      res.writeHead(201, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({id: randomUUID(), sequence: 0, duplicate: false}));
      return;
    }

    if (mode === 'retry_503' && calls === 1) {
      res.writeHead(503, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({detail: 'temporary_unavailable'}));
      return;
    }
    if (mode === 'limit_409') {
      res.writeHead(409, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({detail: 'keyframe_limit_reached'}));
      return;
    }
    if (mode === 'optout_409') {
      res.writeHead(409, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({detail: 'presenter_opted_out'}));
      return;
    }
    res.writeHead(201, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({id: randomUUID(), sequence: 0, duplicate: false}));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as {port: number}).port;
  const apiUrl = `http://127.0.0.1:${port}`;
  const attemptId = randomUUID();
  const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  const baseMeta = {
    sequence: 0,
    provider_source_id: 'google_meet:m1:video_receiver:1',
    participant_id: 'spaces/m1/devices/1',
    participant_name: 'Alice',
    captured_at: '2026-11-14T12:00:00.000Z',
    width: 640,
    height: 360,
    sha256: createHash('sha256').update(pngBytes).digest('hex'),
  };

  try {
    // 1. 503 retries and succeeds
    let haltedCalls = 0;
    const t1 = new KeyframeTransport(apiUrl, attemptId, 'secret-cred', 'worker-1', {
      retryDelaysMs: [20, 40],
      onHalted: () => {
        haltedCalls += 1;
      },
    });
    t1.enqueue(baseMeta, pngBytes);
    assert.equal(await t1.drain(2000), true);
    assert.equal(calls, 2);
    assert.equal(t1.stats().uploaded, 1);
    assert.equal(haltedCalls, 0);
    assert.equal(lastHeaders.authorization, 'Bearer secret-cred');
    assert.equal(lastHeaders['x-worker-id'], 'worker-1');
    const decodedHeader = JSON.parse(
      Buffer.from(String(lastHeaders['x-wortlaut-keyframe']), 'base64url').toString('utf8'),
    );
    assert.equal(decodedHeader.participant_id, 'spaces/m1/devices/1');

    // 2. 409 presenter_opted_out increments dropped_opted_out without retry
    calls = 0;
    mode = 'optout_409';
    const t2 = new KeyframeTransport(apiUrl, attemptId, 'secret-cred', 'worker-1', {
      retryDelaysMs: [20, 40],
    });
    t2.enqueue({...baseMeta, sequence: 1}, pngBytes);
    assert.equal(await t2.drain(2000), true);
    assert.equal(calls, 1);
    assert.equal(t2.stats().dropped_opted_out, 1);
    assert.equal(t2.stats().halted, false);

    // 3. Queue overflow increments dropped_queue_full, and 409 keyframe_limit_reached halts without retry
    calls = 0;
    mode = 'slow';
    const slowArrived = new Promise<void>((resolve) => {
      notifySlowArrived = resolve;
    });
    const t3 = new KeyframeTransport(apiUrl, attemptId, 'secret-cred', 'worker-1', {
      maxQueueSize: 3,
      retryDelaysMs: [20, 40],
      onHalted: () => {
        haltedCalls += 1;
      },
    });
    // First item enters uploadOne immediately; next 3 fill queue; 5th overflows.
    for (let i = 0; i < 5; i++) {
      t3.enqueue({...baseMeta, sequence: i}, pngBytes);
    }
    assert.equal(t3.stats().dropped_queue_full, 1);
    await slowArrived;
    mode = 'limit_409';
    (releaseSlow as (() => void) | null)?.();
    assert.equal(await t3.drain(2000), true);
    // Item 0 completed (201), item 1 hit 409 keyframe_limit_reached -> halted & cleared items 2 & 3!
    assert.equal(calls, 2);
    assert.equal(t3.stats().uploaded, 1);
    assert.equal(t3.stats().halted, true);
    assert.equal(haltedCalls, 1);
  } finally {
    (releaseSlow as (() => void) | null)?.();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('browser sampler: settle window, 1.5s transient rejection, 5s cooldown, and 4K downscale with zero audio clock interruptions', async () => {
  const workerRoot = fileURLToPath(new URL('..', import.meta.url));
  await build({
    root: workerRoot,
    configFile: fileURLToPath(new URL('../vite.meet.config.ts', import.meta.url)),
    logLevel: 'silent',
  });

  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const meetAssets = new URL('../dist/meet/', import.meta.url);

    // 1. Test Google Meet WebRTC camera exclusion, virtual video exclusion, positive slides admission,
    //    4K (3840x2160) downscaling to 1280x720, and AudioCapture clock stability.
    const meetId = randomUUID();
    const meetAttemptId = randomUUID();
    const meetUrl = 'https://meet.google.com/abc-defg-hij';
    const capturedKeyframes: {metadata: Record<string, unknown>; png: Buffer}[] = [];

    await page.route('https://meet.google.com/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><html><body><div id="stage"></div></body></html>',
      });
    });

    const initMeet = await installMeetCapture(
      page,
      {meeting_id: meetId, attempt_id: meetAttemptId, meeting_url: meetUrl, enable_keyframes: true},
      {
        begin: () => {},
        bind: () => {},
        end: () => {},
        gap: () => {},
        chunk: () => {},
        keyframe: (metadata, png) => {
          capturedKeyframes.push({metadata, png: Buffer.from(png)});
        },
        error: () => {},
      },
      meetAssets,
      'google_meet',
    );

    await page.goto(meetUrl);
    await initMeet();

    const clockResult = await page.evaluate(async () => {
      // Set up a real loopback WebRTC connection with:
      //  - 1 audio track (so AudioCapture is actively running)
      //  - 1 participant camera video track (NO a=content:slides, attached to regular tile)
      //  - 1 wortlaut virtual video track (__wortlautVirtualVideo = true)
      const sender = new RTCPeerConnection({iceServers: []});
      const receiver = new RTCPeerConnection({iceServers: []});
      sender.onicecandidate = (e) => {
        if (e.candidate) void receiver.addIceCandidate(e.candidate);
      };
      receiver.onicecandidate = (e) => {
        if (e.candidate) void sender.addIceCandidate(e.candidate);
      };

      const audioCtx = new AudioContext({sampleRate: 48000});
      const osc = audioCtx.createOscillator();
      osc.frequency.value = 440;
      const dest = audioCtx.createMediaStreamDestination();
      osc.connect(dest);
      osc.start();
      sender.addTrack(dest.stream.getAudioTracks()[0], dest.stream);

      const camCanvas = document.createElement('canvas');
      camCanvas.width = 640;
      camCanvas.height = 360;
      const camCtx = camCanvas.getContext('2d')!;
      const drawCam = () => {
        camCtx.fillStyle = '#1e293b';
        camCtx.fillRect(0, 0, 640, 360);
        camCtx.fillStyle = '#f8fafc';
        camCtx.fillRect(80, 40, 480, 280);
      };
      drawCam();
      const camStream = camCanvas.captureStream(10);
      const keepCamPushing = setInterval(drawCam, 150);
      sender.addTrack(camStream.getVideoTracks()[0], camStream);

      const receivedVideoTracks: {track: MediaStreamTrack; stream: MediaStream}[] = [];
      receiver.ontrack = (ev) => {
        if (ev.track.kind === 'audio') {
          const a = document.createElement('audio');
          a.autoplay = true;
          a.srcObject = ev.streams[0] ?? new MediaStream([ev.track]);
          document.body.append(a);
        } else if (ev.track.kind === 'video') {
          receivedVideoTracks.push({
            track: ev.track,
            stream: ev.streams[0] ?? new MediaStream([ev.track]),
          });
        }
      };

      const offer = await sender.createOffer();
      await sender.setLocalDescription(offer);
      await receiver.setRemoteDescription(offer);
      const answer = await receiver.createAnswer();
      await receiver.setLocalDescription(answer);
      await sender.setRemoteDescription(answer);

      while (receivedVideoTracks.length < 1) {
        await new Promise((r) => setTimeout(r, 50));
      }

      // Attach camera track to a standard participant tile (NOT screencast)
      const camTile = document.createElement('div');
      camTile.setAttribute('data-participant-id', 'spaces/meet/devices/alice');
      camTile.setAttribute('data-participant-name', 'Alice');
      const camVideo = document.createElement('video');
      camVideo.autoplay = true;
      camVideo.muted = true;
      camVideo.srcObject = receivedVideoTracks[0].stream;
      camTile.append(camVideo);
      document.body.append(camTile);
      void camVideo.play().catch(() => {});

      // Wait 3.3s across >= 3 sampler ticks: camera track MUST emit 0 keyframes and increment dropped_unverified!
      await new Promise((r) => setTimeout(r, 3300));
      const afterCameraInspect = window.wortlautMeet.inspect();

      // Now add a 4K (3840x2160) screencast track negotiated with a=content:slides!
      const slideCanvas = document.createElement('canvas');
      slideCanvas.width = 3840;
      slideCanvas.height = 2160;
      const slideCtx = slideCanvas.getContext('2d')!;
      const drawSlide1 = () => {
        slideCtx.fillStyle = '#0f172a';
        slideCtx.fillRect(0, 0, 3840, 2160);
        slideCtx.fillStyle = '#38bdf8';
        slideCtx.fillRect(240, 200, 1600, 900);
        slideCtx.fillStyle = '#f8fafc';
        slideCtx.fillRect(2000, 400, 1500, 1200);
      };
      const drawTransientWindow = () => {
        slideCtx.fillStyle = '#fef2f2';
        slideCtx.fillRect(0, 0, 3840, 2160);
        slideCtx.fillStyle = '#dc2626';
        slideCtx.fillRect(100, 100, 3600, 600);
      };
      const drawSlide2 = () => {
        slideCtx.fillStyle = '#ecfdf5';
        slideCtx.fillRect(0, 0, 3840, 2160);
        slideCtx.fillStyle = '#047857';
        slideCtx.fillRect(300, 300, 3200, 500);
        slideCtx.fillStyle = '#064e3b';
        slideCtx.fillRect(300, 1000, 1400, 800);
      };

      let currentSlideDraw = drawSlide1;
      currentSlideDraw();
      const slideStream = slideCanvas.captureStream(10);
      const keepPushing = setInterval(() => {
        currentSlideDraw();
      }, 150);
      sender.addTrack(slideStream.getVideoTracks()[0], slideStream);

      const offer2 = await sender.createOffer();
      await sender.setLocalDescription(offer2);
      // Inject a=content:slides on the second m=video section in remote SDP!
      const parts = (offer2.sdp ?? '').split('m=video ');
      const sdpWithSlides =
        parts.length >= 3
          ? parts[0] + 'm=video ' + parts[1] + 'm=video ' + parts[2].replace(/\r?\n/, '\r\na=content:slides\r\n')
          : offer2.sdp ?? '';
      await receiver.setRemoteDescription({type: 'offer', sdp: sdpWithSlides});
      const answer2 = await receiver.createAnswer();
      await receiver.setLocalDescription(answer2);
      await sender.setRemoteDescription(answer2);

      while (receivedVideoTracks.length < 2) {
        await new Promise((r) => setTimeout(r, 50));
      }

      // Attach subscribed presentation <video> inside a screencast tile owned by Alice
      const shareTile = document.createElement('div');
      shareTile.setAttribute('data-participant-id', 'spaces/meet/devices/alice');
      shareTile.setAttribute('data-participant-name', 'Alice');
      shareTile.setAttribute('data-is-screencast', 'true');
      const shareVideo = document.createElement('video');
      shareVideo.autoplay = true;
      shareVideo.muted = true;
      shareVideo.srcObject = receivedVideoTracks[1].stream;
      shareTile.append(shareVideo);
      document.body.append(shareTile);
      void shareVideo.play().catch(() => {});
      const waitVideoDeadline = Date.now() + 5000;
      while (shareVideo.videoWidth === 0 && Date.now() < waitVideoDeadline) {
        await new Promise((r) => setTimeout(r, 50));
      }

      const beforeClock = window.wortlautMeet.inspect().audio_clock;

      await new Promise((r) => setTimeout(r, 3800));
      const afterSlide1 = window.wortlautMeet.inspect();

      // Simulate a 1.2s transient window switch (1 tick), then revert to Slide 1: must NOT emit!
      currentSlideDraw = drawTransientWindow;
      currentSlideDraw();
      await new Promise((r) => setTimeout(r, 1200));
      currentSlideDraw = drawSlide1;
      currentSlideDraw();
      await new Promise((r) => setTimeout(r, 2200));
      const afterTransient = window.wortlautMeet.inspect();

      // Switch to Slide 2 and hold steady until both 4-tick subsequent settle AND 5s cooldown complete
      currentSlideDraw = drawSlide2;
      currentSlideDraw();
      await new Promise((r) => setTimeout(r, 5800));
      const afterSlide2 = window.wortlautMeet.inspect();

      // Closing a modal back to already-captured Slide 1 must NOT emit a duplicate board screenshot!
      currentSlideDraw = drawSlide1;
      currentSlideDraw();
      await new Promise((r) => setTimeout(r, 5200));
      const afterReturnSlide1 = window.wortlautMeet.inspect();

      // Google Meet viewport transition regression: a data-requested-participant-id slot pointing to
      // Maria while its inner nameplate still shows Alice must never overwrite Maria's participant_name.
      const mariaTile = document.createElement('div');
      mariaTile.setAttribute('data-participant-id', 'spaces/meet/devices/maria');
      mariaTile.setAttribute('data-participant-name', 'Maren Keller');
      mariaTile.setAttribute('data-ssrc', '537001');
      document.body.append(mariaTile);
      window.wortlautMeet.inspect();

      const viewportSlot = document.createElement('div');
      viewportSlot.setAttribute('data-requested-participant-id', 'spaces/meet/devices/maria');
      const staleLabel = document.createElement('span');
      staleLabel.className = 'notranslate';
      staleLabel.textContent = 'Alice';
      viewportSlot.append(staleLabel);
      document.body.append(viewportSlot);
      const afterViewportFlap = window.wortlautMeet.inspect();
      const mariaEntry = afterViewportFlap.participant_sources.sources.find(
        (s: {participant_id: string}) => s.participant_id === 'spaces/meet/devices/maria',
      );

      clearInterval(keepCamPushing);
      clearInterval(keepPushing);
      await window.wortlautMeet.stop();
      sender.close();
      receiver.close();
      await audioCtx.close();

      return {
        afterCameraInspect: afterCameraInspect.keyframes,
        beforeInterruptions: beforeClock.total_interruptions,
        afterInterruptions: afterReturnSlide1.audio_clock.total_interruptions,
        afterSlide1: afterSlide1.keyframes,
        afterTransient: afterTransient.keyframes,
        afterSlide2: afterSlide2.keyframes,
        afterReturnSlide1: afterReturnSlide1.keyframes,
        mariaNameAfterFlap: mariaEntry?.participant_name ?? null,
      };
    });

    assert.equal(clockResult.afterCameraInspect.emitted, 0);
    assert.ok(clockResult.afterCameraInspect.dropped_unverified >= 1);
    assert.equal(clockResult.afterSlide1.capability, 'active');
    assert.equal(clockResult.afterSlide1.active_share, true);
    assert.equal(clockResult.afterSlide1.emitted, 1);
    assert.equal(clockResult.afterTransient.emitted, 1);
    assert.equal(clockResult.afterSlide2.emitted, 2);
    assert.equal(clockResult.afterReturnSlide1.emitted, 2);
    assert.equal(clockResult.mariaNameAfterFlap, 'Maren Keller');
    assert.equal(clockResult.afterInterruptions, clockResult.beforeInterruptions);

    assert.equal(capturedKeyframes.length, 2);
    for (let i = 0; i < 2; i++) {
      const kf = capturedKeyframes[i];
      assert.equal(kf.metadata.sequence, i);
      assert.equal(kf.metadata.participant_id, 'spaces/meet/devices/alice');
      assert.equal(kf.metadata.participant_name, 'Alice');
      assert.equal(kf.metadata.width, 1280);
      assert.equal(kf.metadata.height, 720);
      // Verify PNG signature + IHDR dimensions + SHA-256
      assert.deepEqual(kf.png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      assert.equal(kf.png.readUInt32BE(16), 1280);
      assert.equal(kf.png.readUInt32BE(20), 720);
      assert.equal(createHash('sha256').update(kf.png).digest('hex'), kf.metadata.sha256);
    }

    // 2. Test Zoom DOM share admission gate:
    //    - bare #sv-active-video canvas -> 0 frames (dropped_unverified > 0)
    //    - duplicate roster name "Alice" -> 0 frames (dropped_unverified increases)
    //    - unique roster participant "Bob" -> emits 1 frame
    //    - "Bob" posts "nein" in chat -> opted out, emits 0 further frames (dropped_opted_out > 0)
    const zoomPage = await context.newPage();
    const zoomMeetingId = randomUUID();
    const zoomAttemptId = randomUUID();
    const zoomUrl = 'https://us05web.zoom.us/wc/123456789/join';
    const zoomKeyframes: {metadata: Record<string, unknown>; png: Buffer}[] = [];

    await zoomPage.route('https://us05web.zoom.us/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><html><body><div id="root"></div></body></html>',
      });
    });

    const initZoom = await installMeetCapture(
      zoomPage,
      {meeting_id: zoomMeetingId, attempt_id: zoomAttemptId, meeting_url: zoomUrl, enable_keyframes: true},
      {
        begin: () => {},
        bind: () => {},
        end: () => {},
        gap: () => {},
        chunk: () => {},
        keyframe: (metadata, png) => {
          zoomKeyframes.push({metadata, png: Buffer.from(png)});
        },
        error: () => {},
      },
      meetAssets,
      'zoom',
    );

    await zoomPage.goto(zoomUrl);
    await initZoom();

    const zoomRes = await zoomPage.evaluate(async () => {
      const root = document.getElementById('root')!;
      // Populate roster with two "Alice" entries (duplicate name) and one unique "Bob" entry
      root.innerHTML = `
        <ul id="participants-list">
          <li class="participants-li" data-participants-row="1" data-participant-id="zoom-alice-1" aria-label="Alice">
            <span class="participants-item__display-name">Alice</span>
          </li>
          <li class="participants-li" data-participants-row="2" data-participant-id="zoom-alice-2" aria-label="Alice">
            <span class="participants-item__display-name">Alice</span>
          </li>
          <li class="participants-li" data-participants-row="3" data-participant-id="zoom-bob-1" aria-label="Bob">
            <span class="participants-item__display-name">Bob</span>
          </li>
        </ul>
        <div id="sv-active-video"><canvas id="speaker-cam" width="640" height="360"></canvas></div>
      `;
      const speakerCam = document.getElementById('speaker-cam') as HTMLCanvasElement;
      const sctx = speakerCam.getContext('2d')!;
      sctx.fillStyle = '#1d4ed8';
      sctx.fillRect(0, 0, 640, 360);
      sctx.fillStyle = '#ffffff';
      sctx.fillRect(100, 60, 440, 240);

      // Wait 3.2s: bare #sv-active-video canvas must NEVER be admitted!
      await new Promise((r) => setTimeout(r, 3200));
      const afterBareSpeaker = window.wortlautMeet.inspect().keyframes;

      // Now mount .sharing-layout-container with banner "You are viewing Alice's screen" (ambiguous!)
      const shareWrap = document.createElement('div');
      shareWrap.className = 'sharing-layout-container';
      shareWrap.innerHTML = `
        <div class="share-info-banner">You are viewing Alice's screen</div>
        <canvas id="sharee-container-canvas" width="960" height="540"></canvas>
      `;
      root.append(shareWrap);
      const shareCanvas = document.getElementById('sharee-container-canvas') as HTMLCanvasElement;
      const shCtx = shareCanvas.getContext('2d')!;
      shCtx.fillStyle = '#111827';
      shCtx.fillRect(0, 0, 960, 540);
      shCtx.fillStyle = '#fbbf24';
      shCtx.fillRect(80, 80, 800, 380);

      await new Promise((r) => setTimeout(r, 3200));
      const afterDuplicateAlice = window.wortlautMeet.inspect().keyframes;

      // Switch banner to unique roster presenter "Bob" -> should settle & emit 1 keyframe!
      shareWrap.querySelector('.share-info-banner')!.textContent = "You are viewing Bob's screen";
      await new Promise((r) => setTimeout(r, 3500));
      const afterUniqueBob = window.wortlautMeet.inspect().keyframes;

      // Bob posts "nein" in chat -> opted out! Change slide and wait: 0 new frames, dropped_opted_out increments!
      const chatMsg = document.createElement('div');
      chatMsg.className = 'chat-item__container';
      chatMsg.setAttribute('data-sender-id', 'zoom-bob-1');
      chatMsg.setAttribute('data-sender-name', 'Bob');
      chatMsg.setAttribute('data-message-text', 'nein');
      root.append(chatMsg);
      shCtx.fillStyle = '#f43f5e';
      shCtx.fillRect(0, 0, 960, 270);
      await new Promise((r) => setTimeout(r, 2500));
      const afterBobOptOut = window.wortlautMeet.inspect().keyframes;

      await window.wortlautMeet.stop();
      return {afterBareSpeaker, afterDuplicateAlice, afterUniqueBob, afterBobOptOut};
    });

    assert.equal(zoomRes.afterBareSpeaker.emitted, 0);
    assert.ok(zoomRes.afterBareSpeaker.dropped_unverified >= 1);
    assert.equal(zoomRes.afterDuplicateAlice.emitted, 0);
    assert.ok(
      zoomRes.afterDuplicateAlice.dropped_unverified > zoomRes.afterBareSpeaker.dropped_unverified,
    );
    assert.equal(zoomRes.afterUniqueBob.emitted, 1);
    assert.equal(zoomRes.afterBobOptOut.emitted, 1);
    assert.ok(zoomRes.afterBobOptOut.dropped_opted_out >= 1);

    assert.equal(zoomKeyframes.length, 1);
    assert.equal(zoomKeyframes[0].metadata.participant_id, 'zoom-bob-1');
    assert.equal(zoomKeyframes[0].metadata.participant_name, 'Bob');
    assert.equal(zoomKeyframes[0].metadata.width, 960);
    assert.equal(zoomKeyframes[0].metadata.height, 540);
  } finally {
    await browser.close();
  }
});
