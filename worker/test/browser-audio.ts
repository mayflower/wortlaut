import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright';
import {preview} from 'vite';
import {audioFrame} from '../src/chunks';
import {audioReceiver, replaceGuestToken} from '../src/webex';

const receiver = spawn('uv', ['run', '--directory', '../services/meeting',
  'python', '../../worker/test/receiver.py'], {stdio: ['ignore', 'ignore', 'pipe']});
let receiverLog = '';
receiver.stderr.on('data', (data) => { receiverLog = (receiverLog + data).slice(-4000); });
const server = await preview({preview: {host: '127.0.0.1', port: 34605, strictPort: true}});
const browser = await chromium.launch({headless: true, chromiumSandbox: true,
  args: ['--autoplay-policy=no-user-gesture-required']});
let socket: WebSocket | undefined;
try {
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try { ready = (await fetch('http://127.0.0.1:34606/docs')).ok; } catch { /* starting */ }
    if (ready || receiver.exitCode !== null) break;
    await delay(250);
  }
  assert.ok(ready && receiver.exitCode === null, receiverLog);
  socket = new WebSocket('ws://127.0.0.1:34606/audio');
  await once(socket, 'open');
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => { pageErrors.push(error.message); });
  await page.goto('http://127.0.0.1:34605/sdk/');
  const results = await page.evaluate(() => window.wortlautAudioTest(0.5));
  assert.equal(results.length, 2);
  const identities = results.map((result) => result.parts[0].metadata.stream_id);
  assert.notEqual(identities[0], identities[1]);
  const measurements = [];
  for (const result of results) {
    assert.equal(result.duplicates, 0);
    assert.equal(result.begins, 1);
    assert.equal(result.ends, 1);
    assert.equal(result.parts.length, 1);
    assert.ok(result.samples >= 7000 && result.samples <= 10000, `samples=${result.samples}`);
    const {metadata} = result.parts[0];
    const pcm = Buffer.concat(result.parts.map((part) => Buffer.from(part.pcm)));
    const crossings: number[] = []; let peak = 0, negativeLobe = false;
    for (let i = 202; i < pcm.length - 2; i += 2) {
      const value = pcm.readInt16LE(i); peak = Math.max(peak, Math.abs(value));
      // Count full-amplitude tone cycles, excluding quantized filter ringing
      // around zero at startup and temporary MediaStream underruns.
      if (value < -3000) negativeLobe = true;
      if (negativeLobe && value > 3000) { crossings.push(i / 2); negativeLobe = false; }
    }
    const steady = crossings.slice(20, -20);
    const maxCycleSamples = (16000 / result.frequency) * 1.5;
    const validCycles = steady.slice(1).map((pos, idx) => pos - steady[idx]).filter((span) => span <= maxCycleSamples);
    assert.ok(validCycles.length >= 80, `validCycles=${validCycles.length}`);
    const frequency = 16000 * validCycles.length / validCycles.reduce((sum, span) => sum + span, 0);
    assert.ok(Math.abs(frequency - result.frequency) < 2, `frequency=${frequency}`);
    assert.ok(peak > 30000 && peak <= 32768);
    assert.equal(metadata.speaker_id, `fixture:${result.frequency}`);
    for (const part of result.parts) {
      const reply: Promise<any[]> = once(socket, 'message');
      socket.send(audioFrame(part.metadata, new Uint8Array(part.pcm)));
      const [event] = await reply;
      assert.deepEqual(JSON.parse(event.data), {type: 'ack', sequence: part.metadata.sequence});
    }
    measurements.push({frequency, samples: result.samples, peak,
      wav: `.dev/audio/receiver/${metadata.stream_id}-${metadata.epoch}.wav`});
  }
  const closed = once(socket, 'close'); socket.close(); await closed;
  // The receiver closes WAV writers on WebSocket disconnect.
  for (let i = 0; i < results.length; i++) {
    const wav: Buffer = await readFile(`../${measurements[i].wav}`);
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt32LE(24), 16000);
    assert.equal(wav.readUInt16LE(34), 16);
    assert.equal(wav.readUInt32LE(40), results[i].samples * 2);
    assert.deepEqual(wav.subarray(44), Buffer.from(results[i].parts[0].pcm));
  }
  // Execute the production replacement against the actual pinned UMD SDK.
  // External requests are aborted: fixture credentials never reach Webex.
  await page.route('https://**', (route) => route.abort());
  const credentials = await page.evaluate(async (replacement) => {
    const replace = new Function(`return (${replacement})`)();
    const client = window.Webex.init({credentials: {access_token: 'fixture-access-old'},
      config: {logger: {level: 'silent'}}});
    const sdkCredentials = client.credentials as any;
    const before = (await sdkCredentials.getUserToken()).access_token;
    sdkCredentials.userTokens.add({access_token: 'fixture-cached-old', scope: 'fixture:read'});
    const cachedBefore = sdkCredentials.userTokens.length;
    replace(client, {access_token: 'fixture-access-new'});
    const after = (await sdkCredentials.getUserToken()).access_token;
    return {before, after, cachedBefore, cachedAfter: sdkCredentials.userTokens.length,
      canRefresh: sdkCredentials.canRefresh, canAuthorize: sdkCredentials.canAuthorize};
  }, replaceGuestToken.toString());
  assert.deepEqual(credentials, {before: 'fixture-access-old', after: 'fixture-access-new',
    cachedBefore: 1, cachedAfter: 0, canRefresh: false, canAuthorize: true});
  // Load the actual installed media-core, not a hand-built transceiver map.
  // The SDK's RemoteMedia wrapper is represented by its documented slot getter;
  // receiver creation, slot mapping and native RTCPeerConnection are real.
  const mediaCore = await readFile('node_modules/@webex/internal-media-core/dist/esm/index.js', 'utf8');
  await page.route('**/fixture-media-core.js', (route) => route.fulfill({
    contentType: 'application/javascript', body: mediaCore}));
  // tsx preserves callback names via __name when serializing this test and
  // the production lookup. Supply that transpiler helper in the browser.
  await page.evaluate("globalThis.__name = (target, value) => Object.defineProperty(target, 'name', {value, configurable: true})");
  const receiverCheck = await page.evaluate(async (lookup) => {
    const getReceiver = new Function(`return (${lookup})`)();
    const moduleUrl = '/sdk/fixture-media-core.js';
    const core = await import(moduleUrl);
    const silent = () => {};
    core.setLogger({info: silent, debug: silent, warn: silent, error: silent, trace: silent});
    // Match plugin-meetings/src/media/index.ts's Chromium configuration.
    const connection = new core.MultistreamRoapMediaConnection({iceServers: [],
      enableInboundAudioLevelMonitoring: true}, 'fixture');
    try {
      const main = await connection.createReceiveSlot(core.MediaType.AudioMain);
      const share = await connection.createReceiveSlot(core.MediaType.AudioSlides);
      const meeting = {mediaProperties: {webrtcMediaConnection: connection}};
      const media = (slot: unknown) => ({getUnderlyingReceiveSlot: () => ({wcmeReceiveSlot: slot})});
      const receiver = getReceiver(meeting, media(main), 'speaker');
      const shareReceiver = getReceiver(meeting, media(share), 'share_audio');
      const pc = (connection as any).multistreamConnection.pc.getUnderlyingRTCPeerConnection();
      return {main: receiver?.track === main.stream.getAudioTracks()[0],
        share: shareReceiver?.track === share.stream.getAudioTracks()[0],
        distinct: receiver !== shareReceiver, native: pc.getReceivers().includes(receiver),
        wrongKind: getReceiver(meeting, media(share), 'speaker') === undefined,
        wrongSlot: getReceiver(meeting, media({}), 'speaker') === undefined,
        missingConnection: getReceiver({}, media(main), 'speaker') === undefined};
    } finally { connection.close(); }
  }, audioReceiver.toString());
  assert.deepEqual(receiverCheck, {main: true, share: true, distinct: true, native: true,
    wrongKind: true, wrongSlot: true, missingConnection: true});
  // Exercise the production SDK page with controlled provider events and real
  // AudioWorklet PCM. This proves our lifecycle/parameters, not Webex identity.
  for (const [providerReason, expectedReason] of [
    ['MEETING_INACTIVE_TERMINATING', 'normal'], ['SELF_REMOVED', 'removed'],
  ]) {
    const lifecyclePage = await browser.newPage();
    lifecyclePage.on('pageerror', (error) => { pageErrors.push(error.message); });
    const frames: {type?: string; id?: string; stream_id: string; epoch: string;
      speaker_id?: string | null; attribution_unknown?: boolean; sample_count?: number}[] = [];
    await lifecyclePage.route('https://**', (route) => route.abort());
    await lifecyclePage.routeWebSocket(/\/v1\/attempts\/[^/]+\/audio/, (connection) => {
      connection.onMessage((message) => {
        let metadata;
        if (typeof message === 'string') metadata = JSON.parse(message);
        else {
          const bytes = Buffer.from(message);
          metadata = JSON.parse(bytes.subarray(4, 4 + bytes.readUInt32BE(0)).toString());
        }
        if (metadata.type === 'auth') { connection.send(JSON.stringify({type: 'ready'})); return; }
        frames.push(metadata);
        const id = metadata.id ?? `${metadata.attempt_id}/${metadata.stream_id}/${metadata.epoch}/${metadata.sequence}`;
        connection.send(JSON.stringify({type: 'ack', id}));
      });
    });
    await lifecyclePage.goto('http://127.0.0.1:34605/sdk/');
    await lifecyclePage.evaluate("globalThis.__name = (target, value) => Object.defineProperty(target, 'name', {value, configurable: true})");
    await lifecyclePage.evaluate(async ({meetingId, attemptId, lobby}) => {
      const events = new Map<string, Set<(...args: any[]) => void>>();
      const mediaEvents = new Map<string, Set<(...args: any[]) => void>>();
      const on = (event: string, listener: (...args: any[]) => void) => {
        if (!events.has(event)) events.set(event, new Set());
        events.get(event)!.add(listener);
      };
      const off = (event: string, listener: (...args: any[]) => void) => events.get(event)?.delete(listener);
      const emit = (event: string, data?: unknown) => {
        for (const listener of events.get(event) ?? []) listener(data);
      };
      const producer = new AudioContext();
      const oscillator = producer.createOscillator();
      const destination = producer.createMediaStreamDestination(); oscillator.connect(destination);
      oscillator.start(); await producer.resume();
      const media = {id: 'fixture-slot', csi: 10, memberId: 'alice', sourceState: 'live',
        stream: destination.stream,
        on: (event: string, listener: (...args: any[]) => void) => {
          if (!mediaEvents.has(event)) mediaEvents.set(event, new Set());
          mediaEvents.get(event)!.add(listener);
        },
        off: (event: string, listener: (...args: any[]) => void) => mediaEvents.get(event)?.delete(listener)};
      let leaves = 0, unregisters = 0;
      const meeting = {id: 'fixture-meeting', on,
        leave: async () => { leaves++; throw new Error('Provider already destroyed meeting'); },
        joinWithMedia: async (options: any) => {
          if (!options.joinOptions?.enableMultistream) return {multistreamEnabled: false};
          if (options.mediaOptions.additionalMediaOptions.sendAudio ||
              options.mediaOptions.additionalMediaOptions.sendVideo) throw new Error('Sending media');
          if (lobby) emit('meeting:self:lobbyWaiting');
          emit('media:remoteAudio:created', {getRemoteMedia: () => [media]});
          return {multistreamEnabled: true};
        }};
      window.Webex = {init: () => ({meetings: {on, off,
        register: async () => {}, unregister: async () => { unregisters++; },
        create: async () => meeting}})} as any;
      (window as any).providerFixture = {emit, media, producer,
        counts: () => ({leaves, unregisters}),
        change: () => {
          media.csi = 20; media.memberId = 'bob';
          for (const listener of mediaEvents.get('sourceUpdate') ?? []) listener({csi: 20, memberId: 'bob'});
        },
        repeat: () => {
          for (const listener of mediaEvents.get('sourceUpdate') ?? []) listener({csi: 20, memberId: 'bob'});
        }};
      await window.wortlaut.start({bootstrap: {meeting_id: meetingId, attempt_id: attemptId,
        meeting_url: 'https://fixture.webex.com/meet/test', deadline: new Date(Date.now() + 60000).toISOString(),
        guest: {access_token: 'fixture-only', expires_in: 3600}}, credential: 'fixture-only', worker_id: 'fixture'});
    }, {meetingId: randomUUID(), attemptId: randomUUID(), lobby: providerReason === 'SELF_REMOVED'});
    assert.equal((await lifecyclePage.evaluate(() => window.wortlaut.state)).participation,
      providerReason === 'SELF_REMOVED' ? 'waiting_admission' : 'capturing');
    if (providerReason === 'SELF_REMOVED') {
      await lifecyclePage.evaluate(() => (window as any).providerFixture.emit('media:ready'));
      assert.equal((await lifecyclePage.evaluate(() => window.wortlaut.state)).participation, 'waiting_admission');
      await lifecyclePage.evaluate(() => (window as any).providerFixture.emit('meeting:self:guestAdmitted'));
      assert.equal((await lifecyclePage.evaluate(() => window.wortlaut.state)).participation, 'capturing');
    }
    // Fixed durations intentionally produce short synthetic capture sections.
    await delay(200);
    await lifecyclePage.evaluate(async () => {
      const fixture = (window as any).providerFixture;
      fixture.emit('meeting:removed', {meetingId: 'another-meeting', reason: 'SELF_REMOVED'});
      if (window.wortlaut.state.stopped) throw new Error('Stopped for another meeting');
      fixture.change(); await window.wortlaut.inspectReceivers();
    });
    await delay(200);
    await lifecyclePage.evaluate(async (reason) => {
      const fixture = (window as any).providerFixture;
      fixture.repeat(); await window.wortlaut.inspectReceivers();
      fixture.emit('meeting:removed', {meetingId: 'fixture-meeting', reason});
    }, providerReason);
    await lifecyclePage.waitForFunction(() => window.wortlaut.state.stopped);
    const final = await lifecyclePage.evaluate(async () => {
      const fixture = (window as any).providerFixture;
      await fixture.producer.close();
      return {state: window.wortlaut.state, ...fixture.counts()};
    });
    assert.equal(final.state.reason, expectedReason);
    assert.equal(final.state.participation, 'ended');
    assert.equal(final.state.drained, true);
    assert.equal(final.leaves, 0);
    assert.equal(final.unregisters, 1);
    assert.equal(frames.filter((frame) => frame.type === 'begin').length, 2);
    assert.equal(frames.filter((frame) => frame.type === 'end').length, 2);
    const chunks = frames.filter((frame) => frame.sample_count);
    assert.equal(chunks.length, 2);
    assert.notEqual(chunks[0].epoch, chunks[1].epoch);
    assert.notEqual(chunks[0].stream_id, chunks[1].stream_id);
    assert.ok(chunks.every((chunk) => chunk.speaker_id === null && chunk.attribution_unknown === true));
    await lifecyclePage.close();
  }
  const restarted = await page.evaluate(() => window.wortlautAudioTest(0.15, true));
  for (const source of restarted) {
    assert.equal(source.begins, 2);
    assert.equal(source.ends, 2);
    assert.equal(source.parts.length, 2);
    const [before, after] = source.parts.map((part) => part.metadata);
    assert.notEqual(before.stream_id, after.stream_id);
    assert.notEqual(before.epoch, after.epoch);
    assert.equal(before.start_sample, 0);
    assert.equal(after.start_sample, 0);
    assert.ok(after.monotonic_origin_ms > before.monotonic_origin_ms);
  }
  const missing = await page.evaluate(async () => {
    const Native = window.AudioContext;
    let context!: AudioContext;
    const links: {source: MediaStreamAudioSourceNode; node: AudioNode}[] = [];
    window.AudioContext = new Proxy(Native, {construct(target, args, newTarget) {
      const created = Reflect.construct(target, args, newTarget) as AudioContext;
      if (!args.length) {
        context = created;
        const create = created.createMediaStreamSource.bind(created);
        created.createMediaStreamSource = (stream) => {
          const source = create(stream), connect = source.connect.bind(source);
          source.connect = ((node: AudioNode) => { links.push({source, node}); return connect(node); }) as typeof source.connect;
          return source;
        };
      }
      return created;
    }});
    try {
      const capturing = window.wortlautAudioTest(1.2);
      while (links.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
      await new Promise((resolve) => setTimeout(resolve, 250));
      const start = context.currentTime;
      for (const {source} of links) source.disconnect();
      await new Promise((resolve) => setTimeout(resolve, 320));
      const end = context.currentTime;
      for (const {source, node} of links) {
        (AudioNode.prototype.connect as (node: AudioNode) => AudioNode).call(source, node);
      }
      return {sources: await capturing, missing_samples: (end - start) * 16000};
    } finally { window.AudioContext = Native; }
  });
  for (const source of missing.sources) {
    assert.equal(source.gaps.length, 1);
    const gap = source.gaps[0] as {start_sample: number; sample_count: number; sequence: number; final: boolean};
    assert.equal(gap.final, true);
    assert.ok(Math.abs(gap.sample_count - missing.missing_samples) < 256,
      `gap=${gap.sample_count}, render_clock=${missing.missing_samples}`);
    assert.equal(source.parts.length, 2);
    const [before, after] = source.parts.map((part) => part.metadata);
    assert.equal(before.start_sample + before.sample_count, gap.start_sample);
    assert.equal(after.start_sample, gap.start_sample + gap.sample_count);
    assert.equal(after.sequence, gap.sequence + 1);
    assert.equal(source.final_sample, source.samples + gap.sample_count);
    assert.equal(source.audio_clock!.total_interruptions, 0);
  }
  const interrupted = await page.evaluate(async () => {
    const Native = window.AudioContext;
    let context!: AudioContext;
    let delayResume = false;
    window.AudioContext = new Proxy(Native, {construct(target, args, newTarget) {
      const created = Reflect.construct(target, args, newTarget) as AudioContext;
      if (!args.length) {
        context = created;
        const resume = created.resume.bind(created);
        created.resume = async () => {
          if (delayResume) {
            delayResume = false;
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          return resume();
        };
      }
      return created;
    }});
    try {
      const capturing = window.wortlautAudioTest(1.5);
      while (!context) await new Promise((resolve) => setTimeout(resolve, 5));
      await new Promise((resolve) => setTimeout(resolve, 300));
      delayResume = true;
      await context.suspend();
      return await capturing;
    } finally { window.AudioContext = Native; }
  });
  for (const source of interrupted) {
    assert.equal(source.begins, 2);
    assert.equal(source.ends, 2);
    assert.equal(source.parts.length, 2);
    const [before, after] = source.parts.map((part) => part.metadata);
    assert.notEqual(before.epoch, after.epoch);
    assert.equal(after.start_sample, 0);
    assert.ok(after.monotonic_origin_ms - (before.monotonic_origin_ms + before.sample_count / 16) > 450);
    assert.equal(after.session_monotonic_origin_ms, before.session_monotonic_origin_ms);
    assert.equal(after.session_utc_origin, before.session_utc_origin);
    assert.equal(source.audio_clock!.total_interruptions, 1);
    const interval = source.audio_clock!.interruptions[0];
    assert.equal(interval.reason, 'suspended');
    assert.ok(Date.parse(interval.observed_end_utc!) - Date.parse(interval.observed_start_utc) >= 450);
  }
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({sources: measurements, sdk_guest_replacement: true,
    sdk_native_receivers: receiverCheck, capture_reattach: true,
    provider_end_and_source_change: true, empty_worklet_input: true,
    suspended_audio_clock: true, kind: 'synthetic_browser_audio'}));
} finally {
  socket?.close();
  await browser.close(); await server.close();
  if (receiver.exitCode === null) {
    const exited = once(receiver, 'exit'); receiver.kill('SIGTERM'); await exited;
  }
}
