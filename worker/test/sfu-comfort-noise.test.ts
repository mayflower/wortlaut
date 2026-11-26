import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {build} from 'vite';
import {installMeetCapture} from '../runtime/meet';

test('shared SFU receiver ignores silent comfort-noise CSRCs during speech and pauses while switching fast on voiced speech', async () => {
  const workerRoot = fileURLToPath(new URL('..', import.meta.url));
  if (!existsSync(fileURLToPath(new URL('../dist/meet/capture.js', import.meta.url)))) {
    await build({
      root: workerRoot,
      configFile: fileURLToPath(new URL('../vite.meet.config.ts', import.meta.url)),
      logLevel: 'silent',
    });
  }
  const meetAssets = new URL('../dist/meet/', import.meta.url);

  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    const meetId = randomUUID();
    const attemptId = randomUUID();
    const meetUrl = 'https://meet.google.com/sfu-cnoise-tst';

    const binds: Array<Record<string, unknown>> = [];
    const chunks: Array<Record<string, unknown>> = [];

    await page.route('https://meet.google.com/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><html><body><div id="stage"></div></body></html>',
      });
    });

    const initMeet = await installMeetCapture(
      page,
      {
        meeting_id: meetId,
        attempt_id: attemptId,
        meeting_url: meetUrl,
        enable_keyframes: false,
        bot_display_name: 'wortlaut',
      },
      {
        begin: (m) => {
          binds.push(m as unknown as Record<string, unknown>);
        },
        bind: (m) => {
          binds.push(m as unknown as Record<string, unknown>);
        },
        end: () => {},
        gap: () => {},
        chunk: (m) => {
          chunks.push(m as unknown as Record<string, unknown>);
        },
        error: () => {},
      },
      meetAssets,
      'google_meet',
    );

    await page.goto(meetUrl);
    await initMeet();

    await page.evaluate(async () => {
      const sender = new RTCPeerConnection({iceServers: []});
      const receiverPc = new RTCPeerConnection({iceServers: []});
      sender.onicecandidate = (e) => {
        if (e.candidate) void receiverPc.addIceCandidate(e.candidate);
      };
      receiverPc.onicecandidate = (e) => {
        if (e.candidate) void sender.addIceCandidate(e.candidate);
      };

      const dc = sender.createDataChannel('collections');
      const ac = new AudioContext();
      const osc = ac.createOscillator();
      osc.frequency.value = 260;
      const gain = ac.createGain();
      gain.gain.value = 0.25;
      const dest = ac.createMediaStreamDestination();
      osc.connect(gain);
      gain.connect(dest);
      osc.start();
      sender.addTrack(dest.stream.getAudioTracks()[0], dest.stream);

      await sender.setLocalDescription(await sender.createOffer());
      await receiverPc.setRemoteDescription(sender.localDescription!);
      await receiverPc.setLocalDescription(await receiverPc.createAnswer());
      await sender.setRemoteDescription(receiverPc.localDescription!);
      await ac.resume();

      await new Promise<void>((resolve) => {
        if (dc.readyState === 'open') resolve();
        else dc.addEventListener('open', () => resolve(), {once: true});
      });

      const rcv = receiverPc.getReceivers().find((r) => r.track?.kind === 'audio')!;
      let csrcState: {csi: number; offsetMs: number; audioLevel: number}[] = [
        {csi: 8101, offsetMs: 12, audioLevel: 0.09},
        {csi: 8102, offsetMs: 0, audioLevel: 0.0002},
      ];
      rcv.getContributingSources = () => {
        const now = performance.now();
        return csrcState.map((c) => ({
          source: c.csi,
          timestamp: now - c.offsetMs,
          rtpTimestamp: 0,
          audioLevel: c.audioLevel,
        }));
      };

      dc.send(
        JSON.stringify({
          participants: [
            {participant_id: 'spaces/r/devices/christian', participant_name: 'Dr. Clara Weber', audio_csis: [8101]},
            {participant_id: 'spaces/r/devices/maria', participant_name: 'Maria Haubner', audio_csis: [8102]},
            {participant_id: 'spaces/r/devices/andreas', participant_name: 'Andreas Haberberger', audio_csis: [8103]},
          ],
        }),
      );

      Object.assign(window, {
        __enterSilentComfortNoisePause: () => {
          csrcState = [
            {csi: 8101, offsetMs: 400, audioLevel: 0.0},
            {csi: 8102, offsetMs: 0, audioLevel: 0.0002},
          ];
        },
        __switchToAndreasVoiced: () => {
          csrcState = [
            {csi: 8102, offsetMs: 4, audioLevel: 0.0002},
            {csi: 8103, offsetMs: 0, audioLevel: 0.11},
          ];
        },
      });
    });

    await page.waitForFunction(
      () =>
        (window.wortlautMeet.inspect().receiver_sources as Array<Record<string, unknown>>).some(
          (r) => r.signaled_participant_id === 'spaces/r/devices/christian',
        ),
      undefined,
      {timeout: 10000},
    );
    await page.waitForTimeout(450);

    // Enter pause where only Maria's silent comfort-noise CSRC (0.0002) is arriving
    await page.evaluate(() => (window as unknown as {__enterSilentComfortNoisePause: () => void}).__enterSilentComfortNoisePause());
    await page.waitForTimeout(600);

    const duringPause = await page.evaluate(() => window.wortlautMeet.inspect().receiver_sources);
    assert.equal(duringPause[0]?.signaled_participant_id, 'spaces/r/devices/christian');

    // Andreas starts speaking (0.11) while Maria's comfort noise (0.0002) continues -> immediate switch!
    await page.evaluate(() => (window as unknown as {__switchToAndreasVoiced: () => void}).__switchToAndreasVoiced());
    await page.waitForFunction(
      () =>
        (window.wortlautMeet.inspect().receiver_sources as Array<Record<string, unknown>>).some(
          (r) => r.signaled_participant_id === 'spaces/r/devices/andreas',
        ),
      undefined,
      {timeout: 5000},
    );
    await page.waitForTimeout(450);
    await page.evaluate(() => window.wortlautMeet.stop());

    assert.equal(
      binds.filter((b) => b.speaker_id === 'spaces/r/devices/maria').length,
      0,
      'Silent comfort-noise CSRC must emit zero bind events for Maria',
    );
    assert.equal(
      chunks.filter((c) => c.speaker_id === 'spaces/r/devices/maria').length,
      0,
      'Silent comfort-noise CSRC must emit zero PCM chunks attributed to Maria',
    );
    assert.ok(chunks.some((c) => c.speaker_id === 'spaces/r/devices/christian'));
    assert.ok(chunks.some((c) => c.speaker_id === 'spaces/r/devices/andreas'));
  } finally {
    await browser.close();
  }
});
