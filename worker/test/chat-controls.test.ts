import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {build} from 'vite';
import {readSystemScreenText, visibleSystemText, visibleSystemTextMatch} from '../runtime/browser';
import {installMeetCapture, MeetBrowser} from '../runtime/meet';
import {installVideoTile} from '../runtime/video-tile';

function maxAbsPcmSample(buf: Buffer): number {
  let max = 0;
  for (let i = 0; i + 1 < buf.byteLength; i += 2) {
    const sample = Math.abs(buf.readInt16LE(i));
    if (sample > max) max = sample;
  }
  return max;
}

test('in-call #pause / #resume chat commands zero PCM audio, block slides, and drive live audio activity on video tile', async () => {
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
    const meetUrl = 'https://meet.google.com/chat-ctrl-tst';
    const chatIntro =
      'wortlaut zeichnet dieses Treffen auf. Chat-Befehle: "no" / "opt out" | #pause / #resume. Info: https://wortlaut.example/privacy';

    const chunks: Array<{
      sequence: number;
      startSample: number;
      sampleCount: number;
      pcm: Buffer;
    }> = [];
    const gaps: Array<Record<string, unknown>> = [];
    const keyframes: Array<{metadata: Record<string, unknown>; png: Buffer}> = [];

    await page.route('https://meet.google.com/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><html><body><div id="stage"></div></body></html>',
      });
    });

    await installVideoTile(page, 'google_meet', meetUrl, {
      locale: 'de-DE',
      invitedBy: 'Dr. Host',
      meetingTitle: 'Architektur-Entscheidung',
    });

    const initMeet = await installMeetCapture(
      page,
      {
        meeting_id: meetId,
        attempt_id: attemptId,
        meeting_url: meetUrl,
        enable_keyframes: true,
        chat_intro: chatIntro,
        bot_display_name: 'wortlaut',
      },
      {
        begin: () => {},
        bind: () => {},
        end: () => {},
        gap: (metadata) => {
          gaps.push(metadata as unknown as Record<string, unknown>);
        },
        chunk: (metadata, pcm) => {
          chunks.push({
            sequence: metadata.sequence,
            startSample: metadata.start_sample,
            sampleCount: metadata.sample_count,
            pcm: Buffer.from(pcm),
          });
        },
        keyframe: (metadata, png) => {
          keyframes.push({metadata, png: Buffer.from(png)});
        },
        error: () => {},
      },
      meetAssets,
      'google_meet',
    );

    await page.goto(meetUrl);
    await initMeet();

    // Start live 440 Hz WebRTC audio + presenter screen-share video + JSON data channel + DOM roster
    await page.evaluate(
      async ({intro}) => {
        window.wortlautVideoTile?.update({participation: 'capturing', segments: []});

        // Mount remote participant Alice + wortlaut's own chat_intro bubble (must NOT self-trigger!)
        const aliceTile = document.createElement('div');
        aliceTile.setAttribute('data-participant-id', 'spaces/room/devices/alice');
        aliceTile.setAttribute('data-participant-name', 'Alice Lead');
        const aliceName = document.createElement('span');
        aliceName.textContent = 'Alice Lead';
        aliceTile.append(aliceName);

        const selfIntroMsg = document.createElement('div');
        selfIntroMsg.setAttribute('data-sender-name', 'wortlaut');
        selfIntroMsg.setAttribute('data-message-text', intro);

        const selfEchoCommand = document.createElement('div');
        selfEchoCommand.setAttribute('data-sender-name', 'You');
        selfEchoCommand.setAttribute('data-message-text', '#pause');

        document.body.append(aliceTile, selfIntroMsg, selfEchoCommand);

        const sender = new RTCPeerConnection({iceServers: []});
        const receiver = new RTCPeerConnection({iceServers: []});
        const dc = sender.createDataChannel('chat');
        (window as unknown as Record<string, unknown>).__chatDc = dc;
        (window as unknown as Record<string, unknown>).__senderPc = sender;
        (window as unknown as Record<string, unknown>).__receiverPc = receiver;

        sender.onicecandidate = (e) => {
          if (e.candidate) void receiver.addIceCandidate(e.candidate);
        };
        receiver.onicecandidate = (e) => {
          if (e.candidate) void sender.addIceCandidate(e.candidate);
        };

        const audioCtx = new AudioContext({sampleRate: 48000});
        await audioCtx.resume();
        (window as unknown as Record<string, unknown>).__audioCtx = audioCtx;
        const osc = audioCtx.createOscillator();
        osc.frequency.value = 440;
        const gain = audioCtx.createGain();
        gain.gain.value = 0.5;
        const dest = audioCtx.createMediaStreamDestination();
        osc.connect(gain);
        gain.connect(dest);
        osc.start();
        sender.addTrack(dest.stream.getAudioTracks()[0], dest.stream);

        // Screen-share video track bound via presenter banner
        const slideCanvas = document.createElement('canvas');
        slideCanvas.width = 1280;
        slideCanvas.height = 720;
        const sctx = slideCanvas.getContext('2d')!;
        let slideNo = 1;
        const paintSlide = (no: number) => {
          slideNo = no;
          if (no === 1) {
            sctx.fillStyle = '#0f172a';
            sctx.fillRect(0, 0, 1280, 720);
            sctx.fillStyle = '#38bdf8';
            sctx.fillRect(100, 80, 520, 420);
          } else if (no === 2) {
            sctx.fillStyle = '#fef3c7';
            sctx.fillRect(0, 0, 1280, 720);
            sctx.fillStyle = '#b45309';
            sctx.fillRect(140, 120, 900, 460);
          } else {
            sctx.fillStyle = '#ecfdf5';
            sctx.fillRect(0, 0, 1280, 720);
            sctx.fillStyle = '#047857';
            sctx.fillRect(80, 100, 1080, 260);
            sctx.fillStyle = '#064e3b';
            sctx.fillRect(80, 400, 620, 240);
          }
        };
        paintSlide(1);
        (window as unknown as Record<string, unknown>).__paintSlide = paintSlide;
        const slideInterval = setInterval(() => paintSlide(slideNo), 150);
        (window as unknown as Record<string, unknown>).__slideInterval = slideInterval;
        const slideStream = slideCanvas.captureStream(10);
        sender.addTrack(slideStream.getVideoTracks()[0], slideStream);

        receiver.ontrack = (ev) => {
          if (ev.track.kind === 'audio') {
            const a = document.createElement('audio');
            a.autoplay = true;
            a.srcObject = ev.streams[0] ?? new MediaStream([ev.track]);
            document.body.append(a);
          } else if (ev.track.kind === 'video') {
            const shareWrap = document.createElement('div');
            shareWrap.setAttribute('data-participant-id', 'spaces/room/devices/alice');
            shareWrap.setAttribute('data-participant-name', 'Alice Lead');
            shareWrap.setAttribute('data-is-screencast', 'true');
            const v = document.createElement('video');
            v.autoplay = true;
            v.muted = true;
            v.playsInline = true;
            v.srcObject = ev.streams[0] ?? new MediaStream([ev.track]);
            shareWrap.append(v);
            document.body.append(shareWrap);
            void v.play().catch(() => {});
          }
        };

        const offer = await sender.createOffer();
        await sender.setLocalDescription(offer);
        // Mark video m-line with a=content:slides so Google Meet slide detector admits it
        const sdpWithSlides = offer.sdp!.replace(/m=video ([^\r\n]+\r\n)/, 'm=video $1a=content:slides\r\n');
        await receiver.setRemoteDescription({type: 'offer', sdp: sdpWithSlides});
        const answer = await receiver.createAnswer();
        await receiver.setLocalDescription(answer);
        await sender.setRemoteDescription(answer);
        await new Promise<void>((resolve) => {
          if (dc.readyState === 'open') resolve();
          else dc.onopen = () => resolve();
        });
      },
      {intro: chatIntro},
    );

    // Wait for first 5s audio chunk + settled slide 1 keyframe before pausing
    const prePauseDeadline = Date.now() + 9000;
    while ((chunks.length < 1 || keyframes.length < 1) && Date.now() < prePauseDeadline) {
      await page.waitForTimeout(200);
    }
    assert.ok(chunks.length >= 1, 'Expected at least 1 audio chunk before #pause');
    assert.ok(maxAbsPcmSample(chunks[0].pcm) > 3000, 'Expected audible 440Hz sine wave before #pause');
    assert.equal(keyframes.length, 1, 'Expected 1 screen-share keyframe before #pause');

    const preState = await page.evaluate(() => ({
      meet: window.wortlautMeet.inspect(),
      tile: window.wortlautVideoTile!.getSnapshot(),
    }));
    // Self chat_intro & self "You: #pause" must NOT have paused or opted out!
    assert.equal(preState.meet.participant_sources.paused ?? false, false);
    assert.equal(preState.meet.participant_sources.opted_out ?? undefined, undefined);
    assert.equal(preState.tile.paused, false);
    assert.equal(preState.tile.audioActive, true, 'Expected live PCM capture to mark video tile audioActive=true');
    assert.ok((preState.tile.audioLevel ?? 0) > 0, 'Expected non-zero live audioLevel on video tile');

    // 1. Participant Alice sends "#pause" via DOM chat bubble
    await page.evaluate(() => {
      const pauseBubble = document.createElement('div');
      pauseBubble.setAttribute('data-sender-name', 'Alice Lead');
      pauseBubble.setAttribute('data-message-text', '#pause');
      document.body.append(pauseBubble);

      // Change slide to Slide 2 while paused — sampler must NOT emit while paused!
      (window as unknown as {__paintSlide: (n: number) => void}).__paintSlide(2);
    });

    const pausedState = await page.evaluate(() => ({
      meet: window.wortlautMeet.inspect(),
      tile: window.wortlautVideoTile!.getSnapshot(),
    }));
    assert.equal(pausedState.meet.participant_sources.paused, true);
    assert.equal(pausedState.meet.participant_sources.pause_windows?.length, 1);
    assert.equal(pausedState.meet.participant_sources.pause_windows?.[0]?.ended_at, null);
    assert.equal(pausedState.meet.participant_sources.pause_windows?.[0]?.by, 'Alice Lead');
    // Instant syncVideoTileFromChat updated wortlautVideoTile immediately without waiting for main.ts poll!
    assert.equal(pausedState.tile.paused, true);
    assert.equal(pausedState.tile.audioActive, false, 'Expected #pause to suppress audioActive immediately');
    assert.ok(pausedState.tile.lastRenderedText.startsWith('OFF THE RECORD'));

    // Wait through one full 5-second chunk window that starts & finishes ENTIRELY inside the pause!
    const chunksAtPauseStart = chunks.length;
    const waitPausedChunksDeadline = Date.now() + 12000;
    while (chunks.length < chunksAtPauseStart + 2 && Date.now() < waitPausedChunksDeadline) {
      await page.waitForTimeout(200);
    }
    assert.ok(
      chunks.length >= chunksAtPauseStart + 2,
      'Expected continuous zeroed PCM chunks to keep sample clock advancing without gaps during #pause',
    );
    // Chunk chunksAtPauseStart may contain pre-pause tail + zeroed tail; chunk chunksAtPauseStart + 1 was captured 100% while paused!
    const fullyPausedChunk = chunks[chunksAtPauseStart + 1];
    assert.equal(
      maxAbsPcmSample(fullyPausedChunk.pcm),
      0,
      'Chunk captured entirely during #pause must contain strictly zeroed PCM samples',
    );
    assert.equal(
      keyframes.length,
      1,
      'ScreenShareKeyframeSampler must emit ZERO slides while #pause is active',
    );

    // Re-inspecting while historic #pause DOM bubble is still in DOM must stay idempotent
    // and then sending "#weiter" must resume even though the older "#pause" bubble remains in DOM!
    await page.evaluate(() => {
      const resumeBubble = document.createElement('div');
      resumeBubble.setAttribute('data-sender-name', 'Bob Ops');
      resumeBubble.setAttribute('data-message-text', '#weiter');
      document.body.append(resumeBubble);
      (window as unknown as {__paintSlide: (n: number) => void}).__paintSlide(3);
    });

    const resumedState = await page.evaluate(() => ({
      meet: window.wortlautMeet.inspect(),
      tile: window.wortlautVideoTile!.getSnapshot(),
    }));
    assert.equal(resumedState.meet.participant_sources.paused ?? false, false);
    assert.equal(resumedState.meet.participant_sources.pause_windows?.length, 1);
    assert.ok(
      typeof resumedState.meet.participant_sources.pause_windows?.[0]?.ended_at === 'string',
      'Expected #weiter to close pause_windows[0].ended_at',
    );
    assert.equal(resumedState.tile.paused, false);
    assert.ok(
      resumedState.tile.lastRenderedText.startsWith('Ton wird aufgezeichnet') ||
        resumedState.tile.lastRenderedText.startsWith('Hört zu'),
      `Unexpected post-resume tile status text: ${resumedState.tile.lastRenderedText}`,
    );

    // Wait for post-resume audio chunk + resumed slide keyframe
    const chunksAtResume = chunks.length;
    const postResumeDeadline = Date.now() + 9000;
    while (
      (chunks.length < chunksAtResume + 2 || keyframes.length < 2) &&
      Date.now() < postResumeDeadline
    ) {
      await page.waitForTimeout(200);
    }
    const resumedChunk = chunks[chunks.length - 1];
    assert.ok(
      maxAbsPcmSample(resumedChunk.pcm) > 3000,
      'Expected audible 440Hz sine wave to resume immediately after #weiter',
    );
    assert.ok(keyframes.length >= 2, 'Expected screen-share slide capture to resume after #weiter');

    await page.evaluate(async () => {
      clearInterval((window as unknown as {__slideInterval: number}).__slideInterval);
      await window.wortlautMeet.stop();
      window.wortlautVideoTile?.stop();
      ((window as unknown as {__senderPc: RTCPeerConnection}).__senderPc).close();
      ((window as unknown as {__receiverPc: RTCPeerConnection}).__receiverPc).close();
      await ((window as unknown as {__audioCtx: AudioContext}).__audioCtx).close();
    });

    // Verify strict sample contiguity from sample 0 across pre-pause -> paused -> resumed -> final flush (ZERO gaps!)
    assert.equal(gaps.length, 0, 'Pause/resume must produce zero audio clock gaps');
    let expectedSample = 0;
    for (let i = 0; i < chunks.length; i++) {
      assert.equal(chunks[i].sequence, i);
      assert.equal(chunks[i].startSample, expectedSample);
      expectedSample += chunks[i].sampleCount;
    }

    await context.close();
  } finally {
    await browser.close();
  }
});

test('provider-specific chat DOM & gzipped protobuf commands across Meet, Teams, Webex, and Zoom with alias, false-positive, opt-out, and stop-while-paused guards', async () => {
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

  const noopSink = {
    begin: () => {},
    bind: () => {},
    end: () => {},
    gap: () => {},
    chunk: () => {},
    keyframe: () => {},
    error: () => {},
  };

  try {
    // =========================================================================
    // 1. GOOGLE MEET: 2026 chat panel ([data-message-id]), toast ([data-key^="notification-"]),
    //    gzipped protobuf wire frames, negative false-positive guards, opt-out guard, & stop-while-paused
    // =========================================================================
    {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const url = 'https://meet.google.com/proto-edge-case';
      await page.route('https://meet.google.com/**', (r) =>
        r.fulfill({contentType: 'text/html', body: '<!doctype html><html><body></body></html>'}),
      );
      const init = await installMeetCapture(
        page,
        {
          meeting_id: randomUUID(),
          attempt_id: randomUUID(),
          meeting_url: url,
          enable_keyframes: true,
          bot_display_name: 'Notizen Alpha',
        },
        noopSink,
        meetAssets,
        'google_meet',
      );
      await page.goto(url);
      await init();

      // Natural conversation mentioning "pause", "resume", and custom bot_display_name MUST NOT trigger!
      await page.evaluate(() => {
        const cases = [
          {sender: 'Clara Host', text: 'Let us take a 5 minute pause before Q&A'},
          {sender: 'Clara Host', text: 'Can we resume on slide 4 tomorrow?'},
          {sender: 'Clara Host', text: '#paused for coffee'},
          {sender: 'Notizen Alpha', text: '#pause'},
        ];
        for (const c of cases) {
          const el = document.createElement('div');
          el.setAttribute('data-sender-name', c.sender);
          el.setAttribute('data-message-text', c.text);
          document.body.append(el);
        }
      });

      const afterNegatives = await page.evaluate(() => window.wortlautMeet.inspect());
      assert.equal(afterNegatives.participant_sources.paused ?? false, false);
      assert.equal(afterNegatives.participant_sources.pause_windows ?? undefined, undefined);

      // Gzipped protobuf data-channel frame carrying participant ID + sibling name + "@wortlaut pause"
      await page.evaluate(async () => {
        const offerer = new RTCPeerConnection({iceServers: []});
        const answerer = new RTCPeerConnection({iceServers: []});
        const dc = offerer.createDataChannel('collections');
        (window as unknown as Record<string, unknown>).__protoDc = dc;
        (window as unknown as Record<string, unknown>).__pcs = [offerer, answerer];
        offerer.onicecandidate = (e) => {
          if (e.candidate) void answerer.addIceCandidate(e.candidate);
        };
        answerer.onicecandidate = (e) => {
          if (e.candidate) void offerer.addIceCandidate(e.candidate);
        };
        await offerer.setLocalDescription(await offerer.createOffer());
        await answerer.setRemoteDescription(offerer.localDescription!);
        await answerer.setLocalDescription(await answerer.createAnswer());
        await offerer.setRemoteDescription(answerer.localDescription!);
        await new Promise<void>((resolve) => {
          if (dc.readyState === 'open') resolve();
          else dc.onopen = () => resolve();
        });

        const encodeVarint = (n: number): number[] => {
          const out: number[] = [];
          let v = n >>> 0;
          while (v >= 0x80) {
            out.push((v & 0x7f) | 0x80);
            v >>>= 7;
          }
          out.push(v);
          return out;
        };
        const encodeBytes = (fieldNo: number, payload: Uint8Array): Uint8Array => {
          const tag = encodeVarint((fieldNo << 3) | 2);
          const len = encodeVarint(payload.byteLength);
          const res = new Uint8Array(tag.length + len.length + payload.byteLength);
          res.set(tag, 0);
          res.set(len, tag.length);
          res.set(payload, tag.length + len.length);
          return res;
        };
        const sendGzipProto = async (fields: string[]) => {
          const enc = new TextEncoder();
          const encodedFields = fields.map((s, idx) => encodeBytes(idx + 1, enc.encode(s)));
          const total = encodedFields.reduce((acc, b) => acc + b.byteLength, 0);
          const msg = new Uint8Array(total);
          let off = 0;
          for (const b of encodedFields) {
            msg.set(b, off);
            off += b.byteLength;
          }
          const cs = new CompressionStream('gzip');
          const writer = cs.writable.getWriter();
          void writer.write(msg);
          void writer.close();
          dc.send(await new Response(cs.readable).arrayBuffer());
        };

        await sendGzipProto(['spaces/meet/devices/clara', 'Clara Host', '@wortlaut pause']);
      });

      await page.waitForFunction(
        () => window.wortlautMeet.inspect().participant_sources.paused === true,
        undefined,
        {timeout: 5000},
      );
      const afterProto = await page.evaluate(() => window.wortlautMeet.inspect());
      assert.equal(afterProto.participant_sources.paused, true);
      assert.equal(afterProto.participant_sources.pause_windows?.length, 1);
      assert.equal(afterProto.participant_sources.pause_windows?.[0]?.by, 'Clara Host');

      // Resume via 2026 Google Meet toast ([data-key^="notification-"]), opt out Dave,
      // then re-pause via 2026 Meet chat bubble ([data-message-id]) and call stop() while paused!
      const stoppedSources = await page.evaluate(async () => {
        const toast = document.createElement('div');
        toast.setAttribute('data-key', 'notification-resume-1');
        const pair = document.createElement('div');
        const s = document.createElement('div');
        s.textContent = 'Clara Host';
        const m = document.createElement('div');
        m.textContent = '/resume';
        pair.append(s, m);
        toast.append(pair);
        document.body.append(toast);
        window.wortlautMeet.inspect();

        const daveOpt = document.createElement('div');
        daveOpt.setAttribute('data-sender-name', 'Dave Guest');
        daveOpt.setAttribute('data-message-text', 'opt out');
        document.body.append(daveOpt);
        window.wortlautMeet.inspect();

        // Second pause cycle via 2026 Meet chat group ([data-message-id])
        const group = document.createElement('div');
        const header = document.createElement('div');
        const senderSpan = document.createElement('span');
        senderSpan.textContent = 'Clara Host';
        const timeSpan = document.createElement('span');
        timeSpan.textContent = '13:30';
        header.append(senderSpan, timeSpan);
        const wrap = document.createElement('div');
        const bubble = document.createElement('div');
        bubble.setAttribute('data-message-id', 'spaces/meet/messages/pause-2');
        const body = document.createElement('div');
        body.setAttribute('jsname', 'dTKtvb');
        body.textContent = '!pause';
        bubble.append(body);
        wrap.append(bubble);
        group.append(header, wrap);
        document.body.append(group);

        const mid = structuredClone(window.wortlautMeet.inspect().participant_sources);
        await window.wortlautMeet.stop();
        const afterStop = structuredClone(window.wortlautMeet.inspect().participant_sources);
        for (const pc of (window as unknown as {__pcs: RTCPeerConnection[]}).__pcs) pc.close();
        return {mid, afterStop};
      });

      assert.equal(stoppedSources.mid.paused, true);
      assert.equal(stoppedSources.mid.pause_windows?.length, 2);
      assert.ok(typeof stoppedSources.mid.pause_windows?.[0]?.ended_at === 'string');
      assert.equal(stoppedSources.mid.pause_windows?.[1]?.ended_at, null);
      assert.deepEqual(stoppedSources.mid.opted_out, ['Dave Guest']);
      // stop() must close open pause_windows[1].ended_at and clear paused!
      assert.equal(stoppedSources.afterStop.paused ?? false, false);
      assert.ok(
        typeof stoppedSources.afterStop.pause_windows?.[1]?.ended_at === 'string',
        'Expected stop() to close open pause window ended_at',
      );
      await ctx.close();
    }

    // =========================================================================
    // 2. MICROSOFT TEAMS, CISCO WEBEX & ZOOM provider chat DOM structures
    // =========================================================================
    const providerCases: Array<{
      provider: 'teams' | 'webex' | 'zoom';
      url: string;
      injectChat: () => void;
    }> = [
      {
        provider: 'teams',
        url: 'https://teams.microsoft.com/v2/',
        injectChat: () => {
          const mkTeamsMsg = (author: string, text: string) => {
            const wrap = document.createElement('div');
            const auth = document.createElement('span');
            auth.setAttribute('data-tid', 'message-author-name');
            auth.textContent = author;
            const body = document.createElement('div');
            body.setAttribute('data-tid', 'chat-pane-message');
            body.textContent = text;
            wrap.append(auth, body);
            document.body.append(wrap);
          };
          mkTeamsMsg('Elena Teams', '#off-the-record');
        },
      },
      {
        provider: 'webex',
        url: 'https://web.webex.com/meeting',
        injectChat: () => {
          const mkWebexMsg = (author: string, text: string, senderId?: string) => {
            const item = document.createElement('div');
            item.className = 'chat-message-wrapper';
            item.setAttribute('data-sender-name', author);
            if (senderId) item.setAttribute('data-sender-id', senderId);
            const body = document.createElement('div');
            body.className = 'chat-message-text';
            body.textContent = text;
            item.append(body);
            document.body.append(item);
          };
          mkWebexMsg('Notizen Webex', '#pause');
          mkWebexMsg('Marco Webex', '#pausieren', 'webex-user-42');
        },
      },
      {
        provider: 'zoom',
        url: 'https://us02web.zoom.us/wc/99887766/join',
        injectChat: () => {
          const mkZoomMsg = (author: string, text: string) => {
            const item = document.createElement('div');
            item.className = 'chat-item__chat-info';
            const s = document.createElement('span');
            s.className = 'chat-item__sender';
            s.textContent = author;
            const m = document.createElement('div');
            m.className = 'chat-message__text-content';
            m.textContent = text;
            item.append(s, m);
            document.body.append(item);
          };
          mkZoomMsg('Sofia Zoom', '#pause');
          mkZoomMsg('Sofia Zoom', '#on-the-record');
        },
      },
    ];

    for (const pc of providerCases) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.route('**/*', (r) =>
        r.fulfill({contentType: 'text/html', body: '<!doctype html><html><body></body></html>'}),
      );
      if (pc.provider === 'webex') {
        await installVideoTile(page, 'webex', pc.url, {
          locale: 'de-DE',
          invitedBy: null,
          meetingTitle: null,
        });
      }
      const init = await installMeetCapture(
        page,
        {
          meeting_id: randomUUID(),
          attempt_id: randomUUID(),
          meeting_url: pc.url,
          enable_keyframes: true,
          ...(pc.provider === 'webex' ? {webex_browser: {display_name: 'Notizen Webex'}} : {}),
        },
        noopSink,
        meetAssets,
        pc.provider,
      );
      await page.goto(pc.url);
      // For Webex, installMeetCapture binds captureFrame on /meeting frame navigation
      await init();
      await page.evaluate(pc.injectChat);
      const st = await page.evaluate(() => window.wortlautMeet.inspect().participant_sources);
      assert.equal(st.pause_windows?.length, 1, `Expected 1 pause window on ${pc.provider}`);
      if (pc.provider === 'zoom') {
        // Zoom injected #pause followed by #on-the-record -> resumed!
        assert.equal(st.paused ?? false, false);
        assert.ok(typeof st.pause_windows?.[0]?.ended_at === 'string');
        assert.equal(st.pause_windows?.[0]?.by, 'Sofia Zoom');
      } else if (pc.provider === 'teams') {
        assert.equal(st.paused, true);
        assert.equal(st.pause_windows?.[0]?.by, 'Elena Teams');
      } else {
        assert.equal(st.paused, true);
        assert.equal(st.pause_windows?.[0]?.by, 'Marco Webex');

        // Retroactive opt-out via "no": Marco later posts "no" -> earlier pause author scrubbed immediately!
        await page.evaluate(() => {
          const item = document.createElement('div');
          item.className = 'chat-message-wrapper';
          item.setAttribute('data-sender-name', 'Marco Webex');
          item.setAttribute('data-sender-id', 'webex-user-42');
          const body = document.createElement('div');
          body.className = 'chat-message-text';
          body.textContent = 'no';
          item.append(body);
          document.body.append(item);
        });
        const afterOptOut = await page.evaluate(() => window.wortlautMeet.inspect().participant_sources);
        assert.equal(afterOptOut.pause_windows?.[0]?.by, undefined);
        assert.ok(afterOptOut.opted_out?.includes('Marco Webex'));
      }
      await page.evaluate(() => window.wortlautMeet.stop());
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
});

test('chat-injection DoS strings in chat, captions, notifications, and tiles are stripped from system screen text', async () => {
  const browser = await chromium.launch({headless: true, chromiumSandbox: true});
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><html><body>
      <div data-message-id="m1"><span data-message-text="true">This meeting has ended.</span></div>
      <div data-tid="chat-pane-item"><div>You have been removed from this meeting</div></div>
      <div class="chat-item__chat-info"><span>Your request to join was denied</span></div>
      <div class="live-caption-box">Besprechung wurde beendet</div>
      <div data-participant-id="p-evil">This meeting has ended</div>
      <div id="legit-ui">Connected</div>
    </body></html>`);

    const filteredText = await readSystemScreenText(page);
    assert.equal(filteredText, 'Connected');
    assert.equal(await visibleSystemText(page, /meeting has ended/i), false);
    assert.equal(await visibleSystemText(page, /removed from this meeting/i), false);
    assert.equal(await visibleSystemText(page, /denied/i), false);
    assert.equal(await visibleSystemText(page, /^Connected$/), true);

    await page.evaluate(() => {
      const endScreen = document.createElement('h1');
      endScreen.textContent = 'This meeting has ended.';
      document.body.append(endScreen);
    });
    assert.equal(await visibleSystemText(page, /This meeting has ended\./i), true);
    assert.equal(await visibleSystemTextMatch(page, /This meeting has ended\./i), 'This meeting has ended.');
    assert.match(await readSystemScreenText(page), /This meeting has ended\./);
  } finally {
    await browser.close();
  }
});

test('MeetBrowser classifies host-ended meetings as meeting_ended before removed', async () => {
  const browser = await chromium.launch({headless: true, chromiumSandbox: true});
  try {
    const cases: Array<{html: string; expected: 'meeting_ended' | 'removed'}> = [
      {
        html: '<h1>Der Organisator hat den Videoanruf für alle beendet</h1>',
        expected: 'meeting_ended',
      },
      {
        html: '<h1>Your host ended the meeting for everyone</h1>',
        expected: 'meeting_ended',
      },
      {
        html: '<h1>Der Organisator hat den Videoanruf für alle beendet</h1><p>Alle Teilnehmer wurden aus der Besprechung entfernt.</p>',
        expected: 'meeting_ended',
      },
      {
        html: '<h1>Jemand hat Sie aus der Besprechung entfernt</h1>',
        expected: 'removed',
      },
    ];
    for (const tc of cases) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const url = 'https://meet.google.com/end-vs-rem';
      await page.route(url, (route) =>
        route.fulfill({status: 200, contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><body>${tc.html}</body></html>`}),
      );
      await page.goto(url);
      const meet = new MeetBrowser(
        page,
        {
          provider: 'google_meet',
          meeting_id: randomUUID(),
          attempt_id: randomUUID(),
          meeting_url: url,
          deadline: new Date(Date.now() + 60_000).toISOString(),
          lobby_timeout_seconds: 60,
          invited_by: null,
          invited_by_name: null,
          meeting_title: 'End vs Removed',
          default_locale: 'de',
          meet: {display_name: 'wortlaut', locale: 'de-DE', auth_mode: 'guest'},
        },
        'http://127.0.0.1:1',
        'unused-token',
        'worker-test',
      );
      const state = await meet.inspect();
      assert.equal(state.reason, tc.expected, `Expected ${tc.expected} for ${tc.html}`);
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
});
