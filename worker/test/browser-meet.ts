import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {once} from 'node:events';
import {launchBrowser, nativeMeetInput} from '../runtime/browser';
import {TeamsBrowser} from '../runtime/teams-browser';
import {WebexBrowser} from '../runtime/webex-browser';
import {ZoomBrowser} from '../runtime/zoom-browser';
import {MeetBrowser, MeetError, type MeetBootstrap} from '../runtime/meet';

// Existing installed ws dependency; this fixture is never shipped in a worker.
const {WebSocketServer} = createRequire(import.meta.url)('ws');
const server = createServer();
const sockets = new WebSocketServer({server});
const frames: {metadata: Record<string, any>; pcm?: Buffer}[] = [];
let authenticated = 0;
sockets.on('connection', (socket: any) => socket.on('message', (data: Buffer, binary: boolean) => {
  const metadata = binary ? JSON.parse(data.subarray(4, 4 + data.readUInt32BE(0)).toString()) : JSON.parse(data.toString());
  if (metadata.type === 'auth') {
    assert.equal(metadata.credential, 'fixture-node-secret');
    authenticated++; socket.send(JSON.stringify({type: 'ready'})); return;
  }
  frames.push({metadata, ...(binary ? {pcm: data.subarray(4 + data.readUInt32BE(0))} : {})});
  const id = metadata.id ?? `${metadata.attempt_id}/${metadata.stream_id}/${metadata.epoch}/${metadata.sequence}`;
  socket.send(JSON.stringify({type: 'ack', id}));
}));
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const address = server.address() as {port: number};
const browser = await launchBrowser('google_meet');
const assets = new URL('../dist/meet/', import.meta.url);
const bootstrap: MeetBootstrap = {provider: 'google_meet', meeting_id: randomUUID(), attempt_id: randomUUID(),
  meeting_url: 'https://meet.google.com/abc-defg-hij', deadline: new Date(Date.now() + 60000).toISOString(),
  lobby_timeout_seconds: 30, invited_by: null, invited_by_name: null, meeting_title: null, default_locale: 'de',
  meet: {display_name: 'wortlaut fixture', locale: 'en-US', auth_mode: 'guest'}};

// The fixture serves its own DOM under the expected origin, with restrictive CSP.
// It proves capture/bridge/lifecycle behavior, never Meet's signaling or identity.
const fixtureScript = `
document.querySelector('#join').onclick = () => {
  document.querySelector('#join').remove(); document.querySelector('input').remove();
  document.querySelector('#waiting').textContent = 'Asking to be let in...';
};
window.admit = async () => {
  document.querySelector('#waiting').textContent = '';
  const tile = document.createElement('div'); tile.dataset.selfName = 'fixture'; document.body.append(tile);
  const producer = new AudioContext({sampleRate: 48000});
  const sender = new RTCPeerConnection({iceServers: []});
  const receiver = new RTCPeerConnection({iceServers: [],
    ...(window.encodedFixtureMode === 'reserved' ? {encodedInsertableStreams: true}
      : window.encodedFixtureMode === 'wasm_sink' ? {forceEncodedAudioInsertableStreams: true} : {})});
  const pcs = [sender, receiver];
  window.fixtureReceiver = receiver;
  const providerUrl = URL.createObjectURL(new Blob([
    'self.onrtctransform = ({transformer}) => transformer.readable.pipeTo(transformer.writable);'
  ], {type: 'application/javascript'}));
  let providerWorker;
  window.installProviderTransforms = () => {
    providerWorker ??= new Worker(providerUrl);
    window.providerTransforms = receiver.getReceivers().map(r => {
      const transform = new RTCRtpScriptTransform(providerWorker);
      r.transform = transform;
      return transform;
    });
  };
  if (window.encodedFixtureMode === 'provider') {
    receiver.addTransceiver('audio', {direction: 'recvonly'});
    receiver.addTransceiver('audio', {direction: 'recvonly'});
    window.installProviderTransforms();
  }
  if (window.encodedFixtureMode === 'reserved') {
    for (let i = 0; i < 2; i++) {
      const {receiver: reserved} = receiver.addTransceiver('audio', {direction: 'recvonly'});
      const streams = reserved.createEncodedStreams();
      streams.readable.pipeTo(streams.writable);
    }
  }
  const sinkWorkers = [];
  if (window.encodedFixtureMode === 'wasm_sink') {
    const sinkWorkerUrl = URL.createObjectURL(new Blob([
      'self.onmessage = async (ev) => { const r = ev.data.readable.getReader(); while (!(await r.read()).done) {} };'
    ], {type: 'application/javascript'}));
    for (let i = 0; i < 2; i++) {
      const {receiver: reserved} = receiver.addTransceiver('audio', {direction: 'recvonly'});
      const streams = reserved.createEncodedStreams();
      const sinkWorker = new Worker(sinkWorkerUrl);
      sinkWorkers.push(sinkWorker);
      sinkWorker.postMessage({readable: streams.readable, writable: streams.writable}, [streams.readable, streams.writable]);
    }
  }
  sender.onicecandidate = e => { if (e.candidate) receiver.addIceCandidate(e.candidate); };
  receiver.onicecandidate = e => { if (e.candidate) sender.addIceCandidate(e.candidate); };
  receiver.ontrack = e => {
    // Prove native events and prototypes still work after installing the hook.
    if (!(e.receiver instanceof RTCRtpReceiver) || !(receiver instanceof RTCPeerConnection)) throw Error('Native RTC changed');
    if (window.encodedFixtureMode !== 'wasm_sink') {
      const audio = document.createElement('audio'); audio.autoplay = true;
      audio.srcObject = new MediaStream([e.track]); document.body.append(audio);
    }
  };
  const nodes = [], tracks = [];
  for (const frequency of [440, 880]) {
    const tone = producer.createOscillator(); tone.frequency.value = frequency;
    const destination = producer.createMediaStreamDestination(); tone.connect(destination);
    tracks.push(destination.stream);
    tone.start(); nodes.push(tone);
  }
  if (['provider', 'reserved', 'wasm_sink'].includes(window.encodedFixtureMode)) {
    // Offer the preconfigured receive transceivers so the test really uses
    // those transforms, rather than creating additional unassociated slots.
    await receiver.setLocalDescription(await receiver.createOffer());
    await sender.setRemoteDescription(receiver.localDescription);
    tracks.forEach(stream => sender.addTrack(stream.getAudioTracks()[0], stream));
    const answer = await sender.createAnswer();
    await sender.setLocalDescription(answer);
    await receiver.setRemoteDescription(window.encodedFixtureMode === 'wasm_sink'
      ? {type: 'answer', sdp: answer.sdp.replace(/a=fmtp:111 (.*)/g, 'a=fmtp:111 extensions=120;$1')}
      : sender.localDescription);
  } else {
    tracks.forEach(stream => sender.addTrack(stream.getAudioTracks()[0], stream));
    await sender.setLocalDescription(await sender.createOffer());
    await receiver.setRemoteDescription(sender.localDescription);
    await receiver.setLocalDescription(await receiver.createAnswer());
    await sender.setRemoteDescription(receiver.localDescription);
  }
  await producer.resume();
  window.finishProducer = async () => {
    nodes.forEach(n => n.stop()); pcs.forEach(pc => pc.close()); await producer.close();
    providerWorker?.terminate(); sinkWorkers.forEach(w => w.terminate()); URL.revokeObjectURL(providerUrl);
  };
};`;
type CaptureLinks = {links: {source: MediaStreamAudioSourceNode; node: AudioNode}[]};
async function preparePage(auth: 'guest' | 'account' = 'guest', german = false, missingInput = false,
  encoded: 'native' | 'provider' | 'reserved' | 'wasm_sink' | 'unsupported' | 'failed' = 'native') {
  const context = await browser.newContext({viewport: null, locale: german ? 'de-DE' : 'en-US', permissions: []});
  await context.addInitScript((mode) => {
    (window as any).encodedFixtureMode = mode;
    (window as any).fixtureWorkers = [];
    if (mode === 'unsupported') Reflect.deleteProperty(window, 'RTCRtpScriptTransform');
    window.Worker = new Proxy(window.Worker, {
      construct(target, args, newTarget) {
        if (mode === 'failed') throw new Error('Fixture denies observer worker');
        const worker = Reflect.construct(target, args, newTarget) as Worker;
        (window as any).fixtureWorkers.push(worker);
        return worker;
      },
    });
  }, encoded);
  if (missingInput) await context.addInitScript(() => {
    const links: CaptureLinks['links'] = [];
    (window as unknown as {captureLinks: CaptureLinks}).captureLinks = {links};
    const Native = window.AudioContext;
    window.AudioContext = new Proxy(Native, {construct(target, args, newTarget) {
      const created = Reflect.construct(target, args, newTarget) as AudioContext;
      if (!args.length) {
        const create = created.createMediaStreamSource.bind(created);
        created.createMediaStreamSource = (stream) => {
          const source = create(stream), connect = source.connect.bind(source);
          source.connect = ((node: AudioNode) => { links.push({source, node}); return connect(node); }) as typeof source.connect;
          return source;
        };
      }
      return created;
    }});
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => { errors.push(error.message); });
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text().slice(0, 300)); });
  page.on('requestfailed', (request) => { errors.push(`${new URL(request.url()).pathname}: ${request.failure()?.errorText}`); });
  await page.route('https://meet.google.com/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/fixture.js') return route.fulfill({contentType: 'application/javascript', body: fixtureScript});
    if (url.pathname !== '/abc-defg-hij') return route.abort();
    return route.fulfill({headers: {'Content-Security-Policy': "default-src 'none'; script-src 'self' blob:; worker-src 'self' blob:; frame-src 'self'; connect-src 'self'"},
      contentType: 'text/html', body: `<input type="text" aria-label="Your name"><button id="join">${german ? 'Jetzt teilnehmen' : 'Ask to join'}</button>
        <button aria-label="${german ? 'Mikrofon einschalten' : 'Turn on microphone'}"></button>
        <button aria-label="${german ? 'Kamera einschalten' : 'Turn on camera'}"></button>
        <button aria-label="${german ? 'Anruf verlassen' : 'Leave call'}"></button>
        <div id="waiting"></div><script src="/fixture.js"></script>`});
  });
  const boot = {...bootstrap, attempt_id: randomUUID(), meet: {...bootstrap.meet, auth_mode: auth}};
  const meet = new MeetBrowser(page, boot, `http://127.0.0.1:${address.port}`, 'fixture-node-secret', randomUUID(), assets,
    process.platform === 'linux' ? nativeMeetInput(page) : undefined);
  await meet.prepare();
  await page.goto(boot.meeting_url, {waitUntil: 'load'});
  return {page, meet, context, errors};
}
try {
  const {page, meet, context, errors} = await preparePage();
  const browserSurface = await page.evaluate(() => ({
    webdriver: navigator.webdriver, userAgent: navigator.userAgent, language: navigator.language,
  }));
  assert.equal(browserSurface.webdriver, false);
  assert.equal(browserSurface.userAgent.includes('HeadlessChrome'), false);
  assert.equal(browserSurface.language, 'en-US');
  await meet.join();
  assert.equal((await meet.inspect()).participation, 'waiting_admission');
  assert.equal(await page.evaluate(() => JSON.stringify(window.wortlautMeetConfig).includes('fixture-node-secret')), false);
  assert.equal(await page.evaluate(async () => {
    try {
      await window.wortlautMeetBridge({type: 'control', attempt_id: 'wrong-attempt', metadata: {}});
      return false;
    } catch { return true; }
  }), true);
  await page.evaluate('window.admit()');
  await page.waitForFunction(() => window.wortlautMeet.inspect().streams === 2, undefined, {timeout: 15000})
    .catch(async (error) => { console.error({state: await meet.inspect(), errors}); throw error; });
  await page.waitForTimeout(1100);
  await page.waitForFunction(() => window.wortlautMeet.inspect().receiver_sources.every((source: any) =>
    source.encoded_transform?.state === 'observing' && source.encoded_transform.frame_count >= 8));
  assert.equal((await meet.inspect()).participation, 'capturing');
  const encodedFrames = (await meet.inspect()).receiver_sources.map((source: any) => source.encoded_transform);
  for (const observation of encodedFrames) {
    const metadata = observation.last_frame;
    assert.ok(Number.isInteger(metadata.synchronization_source));
    assert.ok(Number.isInteger(metadata.rtp_timestamp));
    assert.ok(Number.isInteger(metadata.payload_type));
    assert.equal(metadata.mime_type, 'audio/opus');
    assert.ok(metadata.receive_time >= 0);
    assert.ok(Array.isArray(metadata.contributing_sources));
    // This fixture has no SFU-provided participant/CSRC mapping.
    assert.deepEqual(metadata.contributing_sources, []);
  }

  await meet.stop('cancelled');
  const state = await meet.inspect();
  assert.equal(state.drained, true);
  assert.ok(state.audio_samples > 30000);
  assert.equal(state.capability, 'unverified');
  assert.deepEqual(errors, []);
  const audio = frames.filter((frame) => frame.pcm);
  assert.equal(new Set(audio.map((frame) => frame.metadata.stream_id)).size, 2);
  const frequencies: number[] = [];
  for (const frame of audio) {
    assert.equal(frame.metadata.speaker_id, null);
    assert.equal(frame.metadata.attribution_unknown, true);
    assert.equal(frame.pcm!.length, frame.metadata.sample_count * 2);
    const crossings: number[] = []; let negative = false, peak = 0;
    for (let i = 0; i < frame.pcm!.length; i += 2) peak = Math.max(peak, Math.abs(frame.pcm!.readInt16LE(i)));
    const threshold = Math.max(20, peak / 5);
    for (let i = 4000; i < frame.pcm!.length - 2; i += 2) {
      const value = frame.pcm!.readInt16LE(i);
      if (value < -threshold) negative = true;
      if (negative && value > threshold) { crossings.push(i / 2); negative = false; }
    }
    const steady = crossings.slice(10, -10);
    assert.ok(peak > 100 && steady.length > 20, `peak=${peak}, crossings=${steady.length}, samples=${frame.metadata.sample_count}`);
    // Opus/playout can have startup silence and packet underruns. Measure
    // pitch from intact cycles; retain every byte and the full sample duration.
    const periods = steady.slice(1).map((sample, i) => sample - steady[i]);
    const median = [...periods].sort((a, b) => a - b)[Math.floor(periods.length / 2)];
    const intact = periods.filter((period) => Math.abs(period - median) <= 2);
    assert.ok(intact.length > periods.length * 0.8);
    frequencies.push(16000 * intact.length / intact.reduce((sum, period) => sum + period, 0));
  }
  frequencies.sort((a, b) => a - b);
  assert.ok(Math.abs(frequencies[0] - 440) < 3, String(frequencies));
  assert.ok(Math.abs(frequencies[1] - 880) < 3, String(frequencies));
  assert.equal(frames.filter((frame) => frame.metadata.type === 'begin').length, 2);
  assert.equal(frames.filter((frame) => frame.metadata.type === 'end').length, 2);
  await page.evaluate('window.finishProducer()'); await context.close();

  for (const [mode, expected] of [
    ['provider', 'provider_transform'], ['reserved', 'provider_reserved'], ['wasm_sink', 'provider_reserved'],
    ['unsupported', 'unsupported'], ['failed', 'failed'], ['native', 'replaced'],
  ] as const) {
    const guarded = await preparePage('guest', false, false, mode);
    await guarded.meet.join(); await guarded.page.evaluate('window.admit()');
    await guarded.page.waitForFunction(() => window.wortlautMeet.inspect().active_audio_samples > 16000,
      undefined, {timeout: 15000});
    if (expected === 'replaced') await guarded.page.evaluate('window.installProviderTransforms()');
    await guarded.page.waitForFunction((state) => window.wortlautMeet.inspect().receiver_sources.length === 2 &&
      window.wortlautMeet.inspect().receiver_sources.every((source: any) => source.encoded_transform?.state === state),
    expected, {timeout: 10000}).catch(async (error) => {
      console.error(JSON.stringify({encoded_fixture: mode, expected, state: await guarded.meet.inspect(), errors: guarded.errors}));
      throw error;
    });
    if (expected === 'provider_transform' || expected === 'replaced') {
      assert.equal(await guarded.page.evaluate(() => (window as any).fixtureReceiver.getReceivers()
        .every((receiver: RTCRtpReceiver, i: number) => receiver.transform === (window as any).providerTransforms[i])), true);
    }
    await guarded.meet.stop('cancelled');
    const guardedState = await guarded.meet.inspect();
    assert.equal(guardedState.drained, true);
    assert.equal(guardedState.capability, 'unverified');
    assert.ok(guardedState.audio_samples > 16000);
    assert.ok(guardedState.receiver_sources.every((source: any) => source.encoded_transform.state === expected));
    if (expected === 'provider_transform' || expected === 'replaced') {
      assert.equal(await guarded.page.evaluate(() => (window as any).fixtureReceiver.getReceivers()
        .every((receiver: RTCRtpReceiver, i: number) => receiver.transform === (window as any).providerTransforms[i])), true);
    }
    assert.deepEqual(guarded.errors, []);
    await guarded.page.evaluate('window.finishProducer()'); await guarded.context.close();
  }

  const stalled = await preparePage();
  await stalled.meet.join(); await stalled.page.evaluate('window.admit()');
  await stalled.page.waitForFunction(() => {
    const inspected = window.wortlautMeet.inspect();
    return inspected.audio_samples > 16000 &&
      inspected.receiver_sources.length === 2 &&
      inspected.receiver_sources.every((source: any) => Boolean(source.encoded_transform));
  }, undefined, {timeout: 20000});
  await stalled.page.evaluate(() => (window as any).fixtureWorkers[0].terminate());
  await stalled.page.waitForFunction(() => window.wortlautMeet.inspect().reason === 'encoded_transform_failed' &&
    window.wortlautMeet.inspect().receiver_sources.every((source: any) => source.encoded_transform?.state === 'failed'),
    undefined, {timeout: 25000});
  await stalled.meet.stop('encoded_transform_failed');
  const failedObserver = await stalled.meet.inspect();
  assert.equal(failedObserver.capability, 'unverified');
  assert.equal(failedObserver.drained, true);
  assert.ok(failedObserver.receiver_sources.every((source: any) => source.encoded_transform.state === 'failed'));
  assert.equal(await stalled.page.evaluate(() => (window as any).fixtureReceiver.getReceivers()
    .every((receiver: RTCRtpReceiver) => receiver.transform === null)), true);
  assert.deepEqual(stalled.errors, []);
  await stalled.page.evaluate('window.finishProducer()'); await stalled.context.close();

  const offset = frames.length;
  const missing = await preparePage('guest', false, true);
  await missing.meet.join();
  await missing.page.evaluate('window.admit()');
  await missing.page.waitForFunction(() => window.wortlautMeet.inspect().streams === 2,
    undefined, {timeout: 15000});
  await missing.page.waitForTimeout(250);
  await missing.page.evaluate(async () => {
    const {links} = (window as unknown as {captureLinks: CaptureLinks}).captureLinks;
    for (const {source} of links) source.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 320));
    for (const {source, node} of links) {
      (AudioNode.prototype.connect as (node: AudioNode) => AudioNode).call(source, node);
    }
  });
  await missing.page.waitForTimeout(250);
  await missing.meet.stop('cancelled');
  assert.equal((await missing.meet.inspect()).drained, true);
  assert.deepEqual(missing.errors, []);
  const afterMissing = frames.slice(offset);
  const gaps = afterMissing.filter((frame) => frame.metadata.type === 'gap');
  assert.equal(gaps.length, 2);
  for (const {metadata: gap} of gaps) {
    assert.equal(gap.reason, 'capture_input_missing');
    assert.equal(gap.final, true);
    assert.ok(gap.sample_count > 4000 && gap.sample_count < 6000);
    const audio = afterMissing.filter((frame) => frame.pcm && frame.metadata.stream_id === gap.stream_id);
    assert.equal(audio.length, 2);
    const [before, after] = audio.map((frame) => frame.metadata);
    assert.equal(before.start_sample + before.sample_count, gap.start_sample);
    assert.equal(after.start_sample, gap.start_sample + gap.sample_count);
    assert.equal(after.sequence, gap.sequence + 1);
    const end = afterMissing.find((frame) => frame.metadata.type === 'end' && frame.metadata.stream_id === gap.stream_id)!;
    assert.equal(end.metadata.final_sample, after.start_sample + after.sample_count);
  }
  await missing.page.evaluate('window.finishProducer()'); await missing.context.close();

  // Exercise the documented accessible names through the real join/stop flow,
  // including switching enabled devices off before the join click.
  for (const labels of [
    {join: 'Teilnahme erbitten', micOff: 'Mikrofon deaktivieren (Strg + d)',
      micOn: 'Mikrofon aktivieren (Strg + d)', cameraOff: 'Kamera deaktivieren (Strg + e)',
      cameraOn: 'Kamera aktivieren (Strg + e)', leave: 'Anruf verlassen'},
    {join: 'Jetzt teilnehmen', micOff: 'Mikrofon ausschalten', micOn: 'Mikrofon einschalten',
      cameraOff: 'Kamera ausschalten', cameraOn: 'Kamera einschalten', leave: 'Anruf verlassen'},
    {join: 'Ask to join', micOff: 'Turn off microphone (Ctrl + d)',
      micOn: 'Turn on microphone (Ctrl + d)', cameraOff: 'Turn off camera (Ctrl + e)',
      cameraOn: 'Turn on camera (Ctrl + e)', leave: 'Leave call'},
    {join: 'Join now', micOff: 'Turn off microphone', micOn: 'Turn on microphone',
      cameraOff: 'Turn off camera', cameraOn: 'Turn on camera', leave: 'Leave call'},
  ]) {
    const localized = await preparePage();
    await localized.context.clearPermissions();
    await localized.page.evaluate((labels) => {
      const buttons = [...document.querySelectorAll('button')];
      const [join, mic, camera, leave] = buttons;
      const events: string[] = [];
      (window as any).labelEvents = events;
      join.textContent = labels.join;
      if (labels.join === 'Teilnahme erbitten') join.setAttribute('aria-label', 'Ohne Mikrofon und Kamera um Teilnahme bitten');
      mic.setAttribute('aria-label', labels.micOff);
      camera.setAttribute('aria-label', labels.cameraOn);
      leave.setAttribute('aria-label', labels.leave);
      mic.onclick = () => { mic.setAttribute('aria-label', labels.micOn); events.push('mic-off'); };
      camera.onclick = () => { camera.setAttribute('aria-label', labels.cameraOff); events.push('camera-on'); };
      join.addEventListener('click', () => { events.push('join'); });
      leave.onclick = () => { events.push('leave'); };
      // Similar text on unrelated actions must not be selected.
      const other = document.createElement('button');
      other.textContent = labels.join + ' – weitere Möglichkeiten';
      other.onclick = () => { events.push('wrong-button'); };
      document.body.append(other);
    }, labels);
    await localized.meet.join();
    assert.equal((await localized.meet.inspect()).participation, 'waiting_admission');
    if (labels.join === 'Jetzt teilnehmen') {
      (localized.meet as any).bootstrap.chat_intro = 'Hallo aus wortlaut';
      await localized.page.evaluate(() => {
        document.querySelector('#waiting')!.textContent = '';
        const tile = document.createElement('div');
        tile.dataset.selfName = 'fixture';
        document.body.append(tile);
        const chatToggle = document.createElement('button');
        chatToggle.setAttribute('aria-label', 'Mit allen chatten');
        chatToggle.setAttribute('data-panel-id', '2');
        chatToggle.setAttribute('aria-expanded', 'false');
        chatToggle.onclick = () => {
          chatToggle.setAttribute('aria-expanded', 'true');
          (window as any).labelEvents.push('chat-open');
          const box = document.createElement('textarea');
          box.setAttribute('aria-label', 'Nachricht senden');
          const send = document.createElement('button');
          send.setAttribute('aria-label', 'Nachricht senden');
          send.onclick = () => { (window as any).labelEvents.push(`chat-send:${box.value}`); };
          document.body.append(box, send);
        };
        document.body.append(chatToggle);
      });
      assert.equal((await localized.meet.inspect()).participation, 'capturing');
    }
    await localized.meet.stop('cancelled');
    assert.deepEqual(await localized.page.evaluate(() => (window as any).labelEvents),
      labels.join === 'Jetzt teilnehmen'
        ? ['mic-off', 'camera-on', 'join', 'chat-open', 'chat-send:Hallo aus wortlaut', 'leave']
        : ['mic-off', 'camera-on', 'join', 'leave']);
    assert.deepEqual(localized.errors, []);
    await localized.context.close();
  }

  const noDevices = await preparePage();
  await noDevices.page.evaluate(() => {
    (window as any).deviceClicks = 0;
    const buttons = [...document.querySelectorAll('button')];
    buttons[1].setAttribute('aria-label', 'Turn off microphone');
    buttons[2].setAttribute('aria-label', 'Turn off camera');
    for (const button of buttons.slice(1, 3)) {
      button.onclick = () => { (window as any).deviceClicks++; };
    }
  });
  await noDevices.meet.join();
  assert.equal((await noDevices.meet.inspect()).participation, 'waiting_admission');
  assert.equal(await noDevices.page.evaluate(() => (window as any).deviceClicks), 0);
  await noDevices.meet.stop('cancelled'); await noDevices.context.close();

  for (const challenge of ['bframe', 'anchor']) {
    const captcha = await preparePage();
    await captcha.page.route('**/recaptcha/api2/*', route => route.fulfill({
      contentType: 'text/html', body: challenge === 'anchor' ? '<input type="checkbox" aria-label="I am not a robot">' : '<p>Select the matching images</p>',
    }));
    await captcha.page.evaluate(() => {
      const badge = document.createElement('iframe'); badge.src = '/recaptcha/api2/badge';
      const hidden = document.createElement('iframe'); hidden.id = 'challenge';
      hidden.src = '/recaptcha/api2/bframe'; hidden.style.display = 'none';
      document.body.append(badge, hidden);
    });
    assert.equal((await captcha.meet.inspect()).stopped, false);
    await captcha.meet.join();
    assert.equal((await captcha.meet.inspect()).participation, 'waiting_admission');
    await captcha.page.locator('#challenge').evaluate((element, kind) => {
      (element as HTMLIFrameElement).src = '/recaptcha/api2/' + kind;
      (element as HTMLElement).style.display = 'block';
      (element as HTMLElement).style.opacity = '0';
    }, challenge);
    assert.equal((await captcha.meet.inspect()).stopped, false);
    if (challenge === 'anchor') await captcha.page.locator('#challenge').contentFrame().getByRole('checkbox').waitFor();
    await captcha.page.locator('#challenge').evaluate(element => { (element as HTMLElement).style.opacity = '1'; });
    assert.equal((await captcha.meet.inspect()).reason, 'human_verification_required');
    assert.equal((await captcha.meet.inspect()).stopped, true);
    await captcha.meet.stop('human_verification_required'); await captcha.context.close();
  }

  for (const title of ['Mit Ihrem Google-Konto anmelden', 'Sign in with your Google Account']) {
    const tip = await preparePage();
    await tip.page.evaluate(title => {
      const dialog = document.createElement('dialog');
      const heading = document.createElement('h2'); heading.textContent = title;
      const dismiss = document.createElement('button'); dismiss.textContent = 'OK';
      dismiss.onclick = () => dialog.remove();
      dialog.append(heading, dismiss); document.body.append(dialog); dialog.showModal();
    }, title);
    await tip.meet.join();
    assert.equal((await tip.meet.inspect()).participation, 'waiting_admission');
    assert.equal(await tip.page.locator('dialog').count(), 0);
    await tip.meet.stop('cancelled'); await tip.context.close();
  }

  const pending = await preparePage();
  if (process.platform === 'linux') {
    const screenX = await pending.page.evaluate(() => window.screenX);
    await pending.page.evaluate(value => {
      Object.defineProperty(window, 'screenX', {configurable: true, get() { return value + 200; }});
    }, screenX);
    await assert.rejects(nativeMeetInput(pending.page).click(pending.page.locator('#join')),
      /Native pointer missed target/);
    assert.equal(await pending.page.locator('#join').count(), 1);
    assert.equal(await pending.page.locator('#waiting').innerText(), '');
    await pending.page.evaluate(value => {
      Object.defineProperty(window, 'screenX', {configurable: true, get() { return value; }});
    }, screenX);
  }
  await pending.page.locator('#join').evaluate(element => { (element as HTMLElement).onclick = () => {}; });
  await pending.meet.join();
  assert.equal((await pending.meet.inspect()).participation, 'joining');
  await pending.page.locator('#waiting').evaluate(element => {
    element.textContent = 'Please wait until a meeting host brings you into the call';
  });
  assert.equal((await pending.meet.inspect()).participation, 'waiting_admission');
  await pending.meet.stop('cancelled'); await pending.context.close();

  for (const rejection of ['Deine Anfrage wurde abgelehnt', "You can't join this video call"]) {
    const rejected = await preparePage('guest', true);
    await rejected.meet.join();
    await rejected.page.locator('#waiting').evaluate((element, text) => { element.textContent = text; }, rejection);
    assert.equal((await rejected.meet.inspect()).reason, 'admission_denied');
    await rejected.meet.stop('admission_denied'); await rejected.context.close();
  }

  const blockedGuest = await preparePage('guest', true);
  await blockedGuest.page.locator('#join').evaluate((element) => { element.remove(); });
  await blockedGuest.page.locator('#waiting').evaluate((element) => {
    element.textContent = 'Sie können nicht an diesem Videoanruf teilnehmen.';
  });
  assert.equal((await blockedGuest.meet.inspect()).reason, 'prejoin_denied');
  await blockedGuest.meet.stop('prejoin_denied'); await blockedGuest.context.close();

  const coldEmptyPrejoin = await preparePage('guest', true);
  await coldEmptyPrejoin.page.evaluate(() => {
    (window as any).coldJoinClicks = 0;
    const join = document.querySelector('#join') as HTMLButtonElement;
    join.textContent = 'Teilnahme erbitten';
    join.setAttribute('aria-label', 'Lautsprecher nicht gefunden');
    join.onclick = () => {
      (window as any).coldJoinClicks++;
      join.remove();
      document.querySelector('#waiting')!.textContent =
        'Bitte warten Sie, bis Sie vom Organisator der Besprechung in den Anruf eingeladen werden';
    };
    const emptyBanner = document.createElement('div');
    emptyBanner.id = 'empty-prejoin';
    emptyBanner.textContent = 'Außer Ihnen ist niemand da';
    document.body.append(emptyBanner);
  });
  const coldJoinPromise = coldEmptyPrejoin.meet.join();
  await coldEmptyPrejoin.page.waitForFunction(() => true);
  for (let i = 0; i < 160 && (await coldEmptyPrejoin.meet.inspect()).participation !== 'waiting_admission'; i++) {
    await coldEmptyPrejoin.page.waitForTimeout(50);
  }
  assert.equal((await coldEmptyPrejoin.meet.inspect()).participation, 'waiting_admission');
  assert.equal(await coldEmptyPrejoin.page.evaluate(() => (window as any).coldJoinClicks), 0,
    'Cold empty Google Meet prejoin must hold before clicking Ask to join until a participant arrives');
  await coldEmptyPrejoin.page.evaluate(() => {
    document.querySelector('#empty-prejoin')!.textContent = '1 Teilnehmer im Anruf';
  });
  await coldJoinPromise;
  assert.equal(await coldEmptyPrejoin.page.evaluate(() => (window as any).coldJoinClicks), 1);
  assert.equal((await coldEmptyPrejoin.meet.inspect()).participation, 'waiting_admission');
  await coldEmptyPrejoin.meet.stop('cancelled'); await coldEmptyPrejoin.context.close();

  for (const localeCase of [
    {
      german: true,
      joinLabel: 'Teilnahme erbitten',
      waitingText: 'Bitte warten Sie, bis Sie vom Organisator der Besprechung in den Anruf eingeladen werden',
      organizerChatLabel: 'Nachrichten vom Organisator',
      unknownWaitingText: 'Unbekannter Warteraumhinweis',
      peopleLabel: 'Personen2',
      chatToggleLabel: 'Mit allen chatten',
      chatInputLabel: 'Nachricht an alle senden',
      chatSendLabel: 'Nachricht senden',
      chatIntro: 'Aufnahme aktiv (DE)',
    },
    {
      german: false,
      joinLabel: 'Ask to join',
      waitingText: 'Someone in the call will let you in soon',
      organizerChatLabel: 'Messages from the organizer',
      unknownWaitingText: 'Custom waiting room banner',
      peopleLabel: 'People2',
      chatToggleLabel: 'Chat with everyone',
      chatInputLabel: 'Send a message to everyone',
      chatSendLabel: 'Send a message',
      chatIntro: 'Recording active (EN)',
    },
  ]) {
    const lobbyPrewarmed = await preparePage('guest', localeCase.german);
    (lobbyPrewarmed.meet as any).bootstrap.chat_intro = localeCase.chatIntro;
    const framesBeforeLobby = frames.length;
    await lobbyPrewarmed.page.locator('#join').evaluate((el, text) => { el.textContent = text; }, localeCase.joinLabel);
    await lobbyPrewarmed.meet.join();
    await lobbyPrewarmed.page.evaluate(async ({waitingText, organizerChatLabel}) => {
      document.querySelector('#waiting')!.textContent = waitingText;
      const selfOuter = document.createElement('div');
      selfOuter.dataset.participantId = 'spaces/testroom/devices/self';
      const selfTile = document.createElement('span');
      selfTile.dataset.selfName = 'wortlaut';
      selfOuter.append(selfTile);
      const effectsBtn = document.createElement('button');
      effectsBtn.setAttribute('data-panel-id', '3');
      effectsBtn.setAttribute('aria-label', 'Visual effects');
      const organizerChatBtn = document.createElement('button');
      organizerChatBtn.id = 'organizer-chat-btn';
      organizerChatBtn.setAttribute('data-panel-id', '2');
      organizerChatBtn.setAttribute('aria-label', organizerChatLabel);
      document.body.append(selfOuter, effectsBtn, organizerChatBtn);
      const offerer = new RTCPeerConnection({iceServers: []});
      const answerer = new RTCPeerConnection({iceServers: []});
      const dc = offerer.createDataChannel('collections');
      const transceivers = [
        offerer.addTransceiver('audio', {direction: 'sendonly'}),
        offerer.addTransceiver('audio', {direction: 'sendonly'}),
        offerer.addTransceiver('audio', {direction: 'sendonly'}),
      ];
      offerer.onicecandidate = (e) => { if (e.candidate) void answerer.addIceCandidate(e.candidate); };
      answerer.onicecandidate = (e) => { if (e.candidate) void offerer.addIceCandidate(e.candidate); };
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
        while (v >= 0x80) { out.push((v & 0x7f) | 0x80); v >>>= 7; }
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
      const enc = new TextEncoder();
      const parts: Uint8Array[] = [];
      // 35 participants (~21 KB nested protobuf container) to cover large colleague calls.
      for (let i = 1; i <= 35; i++) {
        const pid = encodeBytes(1, enc.encode(`spaces/testroom/devices/${100 + i}`));
        const pname = encodeBytes(2, enc.encode(`Participant ${i}`));
        const pad = encodeBytes(3, new Uint8Array(550).fill(0x61));
        const csiTag = encodeVarint((4 << 3) | 0);
        const csiVal = encodeVarint(5000 + i);
        const entry = new Uint8Array(pid.length + pname.length + pad.length + csiTag.length + csiVal.length);
        let off = 0;
        for (const b of [pid, pname, pad, new Uint8Array(csiTag), new Uint8Array(csiVal)]) {
          entry.set(b, off); off += b.byteLength;
        }
        parts.push(encodeBytes(2, entry));
      }
      const innerLen = parts.reduce((acc, b) => acc + b.byteLength, 0);
      const inner = new Uint8Array(innerLen);
      let pos = 0;
      for (const b of parts) { inner.set(b, pos); pos += b.byteLength; }
      const outer = encodeBytes(1, inner);
      const cs = new CompressionStream('gzip');
      const writer = cs.writable.getWriter();
      void writer.write(new Uint8Array(outer));
      void writer.close();
      const gz = await new Response(cs.readable).arrayBuffer();
      dc.send(gz);
      let oscCtx: AudioContext | undefined;
      let oscNode: OscillatorNode | undefined;
      (window as any).admitFromLobby = async (cfg: {
        peopleLabel: string; chatToggleLabel: string; chatInputLabel: string; chatSendLabel: string;
      }) => {
        document.querySelector('#waiting')!.textContent = '';
        document.querySelector('#organizer-chat-btn')?.remove();
        const uiEvents: string[] = [];
        (window as any).admittedUiEvents = uiEvents;
        const chatToggle = document.createElement('button');
        chatToggle.setAttribute('aria-label', cfg.chatToggleLabel);
        chatToggle.setAttribute('data-panel-id', '2');
        chatToggle.setAttribute('aria-expanded', 'false');
        const peopleBtn = document.createElement('div');
        peopleBtn.setAttribute('role', 'button');
        peopleBtn.textContent = cfg.peopleLabel;
        peopleBtn.setAttribute('aria-expanded', 'false');
        peopleBtn.onclick = () => {
          // Real Meet shares a single side panel: opening People collapses Chat!
          peopleBtn.setAttribute('aria-expanded', 'true');
          chatToggle.setAttribute('aria-expanded', 'false');
          uiEvents.push('roster-open');
        };
        let chatInputsCreated = false;
        chatToggle.onclick = () => {
          const wasExpanded = chatToggle.getAttribute('aria-expanded') === 'true';
          chatToggle.setAttribute('aria-expanded', wasExpanded ? 'false' : 'true');
          if (!wasExpanded) peopleBtn.setAttribute('aria-expanded', 'false');
          uiEvents.push(chatInputsCreated ? 'chat-reopen' : 'chat-open');
          if (!chatInputsCreated) {
            chatInputsCreated = true;
            const box = document.createElement('textarea');
            box.setAttribute('aria-label', cfg.chatInputLabel);
            const send = document.createElement('button');
            send.setAttribute('aria-label', cfg.chatSendLabel);
            send.onclick = () => { uiEvents.push(`chat-send:${box.value}`); };
            document.body.append(box, send);
          }
        };
        document.body.append(peopleBtn, chatToggle);
        oscCtx = new AudioContext();
        const dest = oscCtx.createMediaStreamDestination();
        oscNode = oscCtx.createOscillator();
        oscNode.frequency.value = 440;
        oscNode.connect(dest);
        oscNode.start();
        await oscCtx.resume();
        // Activate RTP only on the first transceiver; the other 2 remain idle prewarmed receivers.
        await transceivers[0].sender.replaceTrack(dest.stream.getAudioTracks()[0]);
      };
      (window as any).closeLobbyPeers = async () => {
        oscNode?.stop();
        await oscCtx?.close().catch(() => {});
        dc.close(); offerer.close(); answerer.close();
      };
    }, localeCase);
    await lobbyPrewarmed.page.waitForFunction(() =>
      window.wortlautMeet.inspect().participant_sources.total === 35, undefined, {timeout: 10000});
    await lobbyPrewarmed.page.waitForTimeout(400);
    const lobbyInspected = await lobbyPrewarmed.meet.inspect();
    assert.equal(lobbyInspected.participation, 'waiting_admission',
      'Prewarmed lobby transceivers + self-tile + Leave button must remain waiting_admission');
    assert.equal(lobbyInspected.streams, 0);
    assert.equal(lobbyInspected.audio_samples, 0);
    assert.equal(lobbyInspected.participant_sources.total, 35);
    await lobbyPrewarmed.page.locator('#waiting').evaluate((el, text) => { el.textContent = text; }, localeCase.unknownWaitingText);
    assert.equal((await lobbyPrewarmed.meet.inspect()).participation, 'waiting_admission');
    assert.equal(frames.slice(framesBeforeLobby).length, 0);

    // Simulate host admitting the bot into the call: RTP starts on 1 of 3 receivers + localized controls appear.
    await lobbyPrewarmed.page.evaluate((cfg) => (window as any).admitFromLobby(cfg), localeCase);
    await lobbyPrewarmed.page.waitForFunction(() => {
      const st = window.wortlautMeet.inspect();
      return st.streams === 1 && st.audio_samples > 0;
    }, undefined, {timeout: 10000});
    const admittedInspected = await lobbyPrewarmed.meet.inspect();
    assert.equal(admittedInspected.participation, 'capturing');
    assert.equal(admittedInspected.streams, 1, 'Only the RTP-active receiver may attach AudioCapture; idle receivers stay unattached');
    assert.equal((admittedInspected.receiver_sources[0] as any)?.encoded_transform?.state, 'unsupported',
      'Google Meet SFU collections connection must skip RTCRtpScriptTransform so Chromium jitter buffer stays intact');
    assert.ok(admittedInspected.audio_samples > 0);
    assert.deepEqual(await lobbyPrewarmed.page.evaluate(() => (window as any).admittedUiEvents), [
      'chat-open',
      `chat-send:${localeCase.chatIntro}`,
      'roster-open',
    ]);
    // Second inspect() tick must restore the Chat sidebar after People collapsed it so DOM opt-outs stay live!
    await lobbyPrewarmed.meet.inspect();
    assert.deepEqual(await lobbyPrewarmed.page.evaluate(() => (window as any).admittedUiEvents), [
      'chat-open',
      `chat-send:${localeCase.chatIntro}`,
      'roster-open',
      'chat-reopen',
    ]);
    assert.equal(await lobbyPrewarmed.page.locator('button[data-panel-id="2"]').getAttribute('aria-expanded'), 'true');
    // Inject live in-call chat opt-out across legacy + 2026 Google Meet chat panel ([data-message-id]) & toast ([data-key^="notification-"])
    await lobbyPrewarmed.page.evaluate((optOutWord) => {
      const msg = document.createElement('div');
      msg.setAttribute('data-sender-name', 'Participant 1');
      msg.setAttribute('data-message-text', optOutWord);
      document.body.append(msg);
      const toast = document.createElement('div');
      toast.setAttribute('role', 'alert');
      toast.setAttribute('data-sender-name', 'Participant 2');
      toast.textContent = 'Participant 2\nstop';
      document.body.append(toast);

      const group = document.createElement('div');
      const header = document.createElement('div');
      const senderSpan = document.createElement('span');
      senderSpan.textContent = 'Participant 3';
      const timeSpan = document.createElement('span');
      timeSpan.textContent = '15:40';
      header.append(senderSpan, timeSpan);
      const msgWrap = document.createElement('div');
      const msgBubble = document.createElement('div');
      msgBubble.setAttribute('data-message-id', 'spaces/testroom/messages/1');
      const msgBody = document.createElement('div');
      msgBody.setAttribute('jsname', 'dTKtvb');
      msgBody.textContent = optOutWord;
      msgBubble.append(msgBody);
      msgWrap.append(msgBubble);
      group.append(header, msgWrap);
      document.body.append(group);

      const meetToast = document.createElement('div');
      meetToast.setAttribute('data-key', 'notification-0');
      const pair = document.createElement('div');
      const toastSender = document.createElement('div');
      toastSender.textContent = 'Participant 4';
      const toastText = document.createElement('div');
      toastText.textContent = 'stop';
      pair.append(toastSender, toastText);
      meetToast.append(pair);
      document.body.append(meetToast);
    }, localeCase.german ? 'nein' : 'no');
    const optOutInspected = await lobbyPrewarmed.meet.inspect();
    assert.ok(optOutInspected.participant_sources.opted_out?.includes('Participant 1'));
    assert.ok(optOutInspected.participant_sources.opted_out?.includes('spaces/testroom/devices/101'));
    assert.ok(optOutInspected.participant_sources.opted_out?.includes('Participant 2'));
    assert.ok(optOutInspected.participant_sources.opted_out?.includes('spaces/testroom/devices/102'));
    assert.ok(optOutInspected.participant_sources.opted_out?.includes('Participant 3'));
    assert.ok(optOutInspected.participant_sources.opted_out?.includes('spaces/testroom/devices/103'));
    assert.ok(optOutInspected.participant_sources.opted_out?.includes('Participant 4'));
    assert.ok(optOutInspected.participant_sources.opted_out?.includes('spaces/testroom/devices/104'));
    await lobbyPrewarmed.meet.stop('normal');
    assert.ok(frames.slice(framesBeforeLobby).some(f => Boolean(f.pcm && f.pcm.byteLength > 0)));
    await lobbyPrewarmed.page.evaluate(() => (window as any).closeLobbyPeers());
    await lobbyPrewarmed.context.close();
  }

  // Admitted into a muted/silent Google Meet call where tiles only expose data-requested-participant-id,
  // a post-join informational modal ("Ok") hides background buttons from the Accessibility Tree,
  // and stale organizer-chat / chat-unavailable labels remain visible.
  {
    const silentAdmitted = await preparePage('guest');
    await silentAdmitted.meet.join();
    assert.equal((await silentAdmitted.meet.inspect()).participation, 'waiting_admission');
    await silentAdmitted.page.evaluate(() => {
      document.querySelector('#waiting')!.textContent = 'Messages from the organizer — Chat is unavailable';
      const remoteTile = document.createElement('div');
      remoteTile.setAttribute('data-requested-participant-id', 'spaces/testroom/devices/muted-host');
      remoteTile.textContent = 'Muted Host';
      const peopleBtn = document.createElement('button');
      peopleBtn.setAttribute('aria-label', 'People');
      peopleBtn.setAttribute('data-panel-id', '1');
      document.body.append(remoteTile, peopleBtn);
      const infoDialog = document.createElement('dialog');
      infoDialog.id = 'post-join-info';
      const infoText = document.createElement('p');
      infoText.textContent = 'Others might still see your full video';
      const okBtn = document.createElement('button');
      okBtn.textContent = 'Ok';
      okBtn.onclick = () => infoDialog.remove();
      infoDialog.append(infoText, okBtn);
      document.body.append(infoDialog);
      infoDialog.showModal();
    });
    const silentState = await silentAdmitted.meet.inspect();
    assert.equal(await silentAdmitted.page.locator('#post-join-info').count(), 0,
      'Post-join informational modal must be dismissed so toolbar controls are accessible');
    assert.equal(silentState.participation, 'capturing',
      'Silent Google Meet room with [data-requested-participant-id] and in-call controls must enter capturing');
    await silentAdmitted.page.locator('#waiting').evaluate((el) => {
      el.textContent = 'Someone in the call will let you in';
    });
    assert.equal((await silentAdmitted.meet.inspect()).participation, 'capturing',
      'In-call chat text matching waiting keywords must never revert capturing back to waiting_admission');
    await silentAdmitted.page.evaluate(() => {
      const consentDialog = document.createElement('dialog');
      consentDialog.id = 'consent-modal';
      const consentText = document.createElement('p');
      consentText.textContent = 'Allow taking notes for me in this call?';
      const okBtn = document.createElement('button');
      okBtn.textContent = 'OK';
      okBtn.onclick = () => consentDialog.remove();
      consentDialog.append(consentText, okBtn);
      document.body.append(consentDialog);
      consentDialog.showModal();
    });
    const consentState = await silentAdmitted.meet.inspect();
    assert.equal(consentState.reason, 'consent_required',
      'Consent modal must stop with consent_required instead of being dismissed');
    assert.equal(await silentAdmitted.page.locator('#consent-modal').count(), 1);
    await silentAdmitted.page.evaluate(() => document.querySelector('#consent-modal')?.remove());
    await silentAdmitted.meet.stop('consent_required');
    await silentAdmitted.context.close();
  }

  // 4-Speaker dynamic SFU Loudest-N transceiver switching + mid-call late joiner on 2 shared RTCRtpReceivers
  {
    const sfuDynamic = await preparePage('guest');
    const sfuAttemptId = (sfuDynamic.meet as any).bootstrap.attempt_id as string;
    const beforeSfu = frames.length;
    await sfuDynamic.meet.join();
    await sfuDynamic.page.evaluate('window.admit()');
    await sfuDynamic.page.waitForFunction(() => window.wortlautMeet.inspect().streams === 2, undefined, {timeout: 10000});
    await sfuDynamic.page.evaluate(async () => {
      const offerer = new RTCPeerConnection({iceServers: []});
      const answerer = new RTCPeerConnection({iceServers: []});
      const dc = offerer.createDataChannel('collections');
      offerer.onicecandidate = (e) => { if (e.candidate) void answerer.addIceCandidate(e.candidate); };
      answerer.onicecandidate = (e) => { if (e.candidate) void offerer.addIceCandidate(e.candidate); };
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
        while (v >= 0x80) { out.push((v & 0x7f) | 0x80); v >>>= 7; }
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
      const sendCollections = async (entries: {id: string; name: string; csi: number}[]) => {
        const enc = new TextEncoder();
        const parts = entries.map((item) => {
          const pid = encodeBytes(1, enc.encode(item.id));
          const pname = encodeBytes(2, enc.encode(item.name));
          const csiTag = encodeVarint((4 << 3) | 0);
          const csiVal = encodeVarint(item.csi);
          const entry = new Uint8Array(pid.length + pname.length + csiTag.length + csiVal.length);
          let off = 0;
          for (const b of [pid, pname, new Uint8Array(csiTag), new Uint8Array(csiVal)]) {
            entry.set(b, off); off += b.byteLength;
          }
          return encodeBytes(2, entry);
        });
        const inner = new Uint8Array(parts.reduce((acc, b) => acc + b.byteLength, 0));
        let pos = 0;
        for (const b of parts) { inner.set(b, pos); pos += b.byteLength; }
        const outer = encodeBytes(1, inner);
        const cs = new CompressionStream('gzip');
        const writer = cs.writable.getWriter();
        void writer.write(new Uint8Array(outer));
        void writer.close();
        dc.send(await new Response(cs.readable).arrayBuffer());
      };

      const receivers = (window as any).fixtureReceiver.getReceivers() as RTCRtpReceiver[];
      let r0History: {csi: number; offsetMs: number}[] = [{csi: 7001, offsetMs: 0}];
      receivers[0].getContributingSources = () => {
        const now = performance.now();
        return r0History.map((h) => ({source: h.csi, timestamp: now - h.offsetMs, rtpTimestamp: 0}));
      };
      receivers[1].getContributingSources = () => [{source: 7002, timestamp: performance.now(), rtpTimestamp: 0}];

      await sendCollections([
        {id: 'spaces/testroom/devices/alice', name: 'Alice SFU', csi: 7001},
        {id: 'spaces/testroom/devices/bob', name: 'Bob SFU', csi: 7002},
        {id: 'spaces/testroom/devices/clara', name: 'Clara SFU', csi: 7003},
      ]);
      // Send a cross-referencing protobuf frame (2 device IDs + sibling name) and a mid-call
      // caption/UI frame for alice; neither may poison Alice's verified participant_name!
      {
        const enc = new TextEncoder();
        const pidA = encodeBytes(1, enc.encode('spaces/testroom/devices/alice'));
        const pidB = encodeBytes(2, enc.encode('spaces/testroom/devices/bob'));
        const crossName = encodeBytes(3, enc.encode('Bob SFU'));
        const multiMsg = new Uint8Array(pidA.length + pidB.length + crossName.length);
        multiMsg.set(pidA, 0);
        multiMsg.set(pidB, pidA.length);
        multiMsg.set(crossName, pidA.length + pidB.length);
        const captionTxt = encodeBytes(2, enc.encode('Dr. Wrong Caption Name'));
        const singleUpdate = new Uint8Array(pidA.length + captionTxt.length);
        singleUpdate.set(pidA, 0);
        singleUpdate.set(captionTxt, pidA.length);
        const batch = new Uint8Array(encodeBytes(1, multiMsg).length + encodeBytes(2, singleUpdate).length);
        const wrappedA = encodeBytes(1, multiMsg);
        const wrappedB = encodeBytes(2, singleUpdate);
        batch.set(wrappedA, 0);
        batch.set(wrappedB, wrappedA.length);
        const cs = new CompressionStream('gzip');
        const writer = cs.writable.getWriter();
        void writer.write(new Uint8Array(batch));
        void writer.close();
        dc.send(await new Response(cs.readable).arrayBuffer());
      }

      (window as any).switchSfuToClara = () => {
        // Keep Alice in Chromium's 10s CSRC window with an older timestamp (400ms ago) while Clara is current!
        r0History = [{csi: 7001, offsetMs: 400}, {csi: 7003, offsetMs: 0}];
      };
      (window as any).lateJoinDavidAndSwitch = async () => {
        await sendCollections([
          {id: 'spaces/testroom/devices/david', name: 'David Late', csi: 7004},
        ]);
        r0History = [{csi: 7001, offsetMs: 900}, {csi: 7003, offsetMs: 450}, {csi: 7004, offsetMs: 0}];
      };
      (window as any).closeSfuCollections = () => {
        dc.close(); offerer.close(); answerer.close();
      };
    });

    // Phase 1: Alice on Receiver 0, Bob on Receiver 1 (>= 2.1s so capture.ts 2s rebind hysteresis passes)
    await sfuDynamic.page.waitForFunction(() => {
      const rs = window.wortlautMeet.inspect().receiver_sources as any[];
      return rs.some(r => r.signaled_participant_id === 'spaces/testroom/devices/alice') &&
        rs.some(r => r.signaled_participant_id === 'spaces/testroom/devices/bob');
    }, undefined, {timeout: 10000});
    await sfuDynamic.page.waitForTimeout(2300);

    // Phase 2: Loudest-N switches Receiver 0 from Alice -> Clara (flushes Alice's PCM chunk & binds Clara)
    await sfuDynamic.page.evaluate(() => (window as any).switchSfuToClara());
    await sfuDynamic.page.waitForFunction(() => {
      const rs = window.wortlautMeet.inspect().receiver_sources as any[];
      return rs.some(r => r.signaled_participant_id === 'spaces/testroom/devices/clara') &&
        rs.some(r => r.signaled_participant_id === 'spaces/testroom/devices/bob');
    }, undefined, {timeout: 10000});
    await sfuDynamic.page.waitForTimeout(2300);

    // Phase 3: Mid-call late joiner David arrives via collections delta and takes Receiver 0
    await sfuDynamic.page.evaluate(() => (window as any).lateJoinDavidAndSwitch());
    await sfuDynamic.page.waitForFunction(() => {
      const st = window.wortlautMeet.inspect();
      const rs = st.receiver_sources as any[];
      return st.participant_sources.total === 4 &&
        rs.some(r => r.signaled_participant_id === 'spaces/testroom/devices/david');
    }, undefined, {timeout: 10000});
    await sfuDynamic.page.waitForTimeout(2300);

    const sfuState = await sfuDynamic.meet.inspect();
    assert.equal(sfuState.streams, 2, '4 speakers across 2 SFU transceivers must keep exactly 2 streams');
    assert.equal(sfuState.participant_sources.total, 4);
    await sfuDynamic.meet.stop('normal');
    assert.equal((await sfuDynamic.meet.inspect()).drained, true);
    await sfuDynamic.page.evaluate(async () => {
      (window as any).closeSfuCollections();
      await (window as any).finishProducer();
    });
    await sfuDynamic.context.close();

    const sfuFrames = frames.slice(beforeSfu);
    assert.equal(sfuFrames.filter(f => f.metadata.type === 'gap').length, 0,
      'Dynamic SFU CSRC switching must not emit audio gap frames');
    for (const expectedSpeaker of [
      {id: 'spaces/testroom/devices/alice', name: 'Alice SFU', switchedMidStream: false},
      {id: 'spaces/testroom/devices/bob', name: 'Bob SFU', switchedMidStream: false},
      {id: 'spaces/testroom/devices/clara', name: 'Clara SFU', switchedMidStream: true},
      {id: 'spaces/testroom/devices/david', name: 'David Late', switchedMidStream: true},
    ]) {
      assert.ok(
        sfuFrames.some(f =>
          (expectedSpeaker.switchedMidStream
            ? f.metadata.type === 'bind'
            : (f.metadata.type === 'begin' || f.metadata.type === 'bind')) &&
          f.metadata.speaker_id === expectedSpeaker.id &&
          f.metadata.participant_name === expectedSpeaker.name &&
          f.metadata.attribution_unknown === false),
        `Missing ${expectedSpeaker.switchedMidStream ? 'bind' : 'begin/bind'} frame for ${expectedSpeaker.name}`,
      );
      assert.ok(
        sfuFrames.some(f => Boolean(f.pcm && f.pcm.byteLength > 0) &&
          f.metadata.speaker_id === expectedSpeaker.id &&
          f.metadata.attribution_unknown === false),
        `Missing attributed PCM chunk for ${expectedSpeaker.name}`,
      );
    }
    const streamOf = (speakerId: string) =>
      sfuFrames.find(f => Boolean(f.pcm) && f.metadata.speaker_id === speakerId)?.metadata.stream_id;
    assert.equal(streamOf('spaces/testroom/devices/alice'), streamOf('spaces/testroom/devices/clara'));
    assert.equal(streamOf('spaces/testroom/devices/clara'), streamOf('spaces/testroom/devices/david'));
    assert.notEqual(streamOf('spaces/testroom/devices/alice'), streamOf('spaces/testroom/devices/bob'));
  }

  const account = await preparePage('account');
  await assert.rejects(account.meet.join(), (error: unknown) => error instanceof MeetError && error.reason === 'auth_session_missing');
  assert.equal(await account.page.locator('#join').count(), 1);
  await account.meet.stop('auth_session_missing'); await account.context.close();
  assert.equal(authenticated, 27);
  const webexContext = await browser.newContext();
  const webexPage = await webexContext.newPage();
  const webexUrl = 'https://example.webex.com/meet/fixture';
  await webexPage.route('https://example.webex.com/**', route => route.fulfill({
    contentType: 'text/html', body: '<iframe src="https://web.webex.com/meeting"></iframe>',
  }));
  await webexPage.route('https://web.webex.com/meeting', route => route.fulfill({
    contentType: 'text/html', body: `<button onclick="this.remove()">Reject</button>
    <button onclick="this.remove()">Continue without microphone and camera</button>
    <label>Name<input></label>
    <button>Microphone is currently muted - click to unmute</button>
    <button id="webex-video-btn" onclick="this.textContent='Sending video is enabled - click to disable'">Sending video is currently disabled - click to enable</button>
    <button onclick="this.remove();document.querySelector('#webex-state').attachShadow({mode:'open'}).innerHTML='<p>Waiting for the host</p>'">Join meeting Fixture</button>
    <div id='webex-state'></div>`,
  }));
  const webex = new WebexBrowser(webexPage, {...bootstrap, provider: 'webex',
    meeting_url: webexUrl, webex_browser: {display_name: 'wortlaut fixture'}},
  `http://127.0.0.1:${address.port}`, 'fixture-node-secret', randomUUID(), assets);
  await webex.prepare();
  await webexPage.goto(webexUrl);
  await webex.join();
  const webexFrame = webexPage.frames().find(frame => frame.url() === 'https://web.webex.com/meeting')!;
  assert.equal(await webexFrame.getByRole('textbox', {name: 'Name'}).inputValue(), 'wortlaut fixture');
  assert.equal(await webexFrame.locator('#webex-video-btn').textContent(), 'Sending video is enabled - click to disable');
  await webex.updateVideoTile({
    participation: 'waiting_admission',
    segments: [{speaker: 'Eva Webex', text: 'Test im Webex-Frame', start: 5}],
  });
  const webexTileSnap = await webexFrame.evaluate(() => window.wortlautVideoTile?.getSnapshot());
  assert.equal(webexTileSnap?.segmentCount, 1);
  assert.equal(webexTileSnap?.lastRenderedText, 'Eva Webex: Test im Webex-Frame');
  assert.equal((await webex.inspect()).participation, 'waiting_admission');
  assert.equal((await webex.inspect()).capability, 'unverified');
  await webexFrame.locator('p').evaluate(element => {
    element.textContent = '';
    const leave = document.createElement('button');
    leave.textContent = 'Leave meeting';
    leave.onclick = () => { leave.remove(); };
    document.body.append(leave);
  });
  assert.equal((await webex.inspect()).participation, 'capturing');
  await webex.stop('normal');
  assert.equal((await webex.inspect()).participation, 'ended');
  assert.equal(await webexFrame.getByRole('button', {name: 'Leave meeting'}).count(), 0);
  await webexContext.close();

  for (const german of [false, true]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const url = 'https://teams.microsoft.com/meet/123456789?p=fixture';
    const join = german ? 'Jetzt teilnehmen' : 'Join now';
    const lobby = german ? 'Sie sind im Wartebereich' : "Someone will let you in shortly";
    const unknownLobby = german ? 'Bitte gedulden Sie sich einen Augenblick' : 'Hold tight, checking room policy';
    const leave = german ? 'Verlassen' : 'Leave';
    await page.route('https://teams.microsoft.com/**', route => {
      if (route.request().url().endsWith('/roster-sync')) {
        return route.fulfill({
          contentType: 'application/json',
          body: `)]}'\n{"participants":[{"participant_id":"bob-session","csi":1002}]}`,
        });
      }
      return route.fulfill({
        contentType: 'text/html', body: `<label>${german ? 'Ihr Name' : 'Your name'}<input></label>
        <label><input type="radio" name="audio" value="computer">${german ? 'Computeraudio' : 'Computer audio'}</label>
        <button id="join">${join}</button><p id="waiting"></p>
        <script>
        let clicks = 0;
        window.teamsUiEvents = [];
        document.querySelector('#join').onclick = () => {
          if (++clicks === 1) {
            const modal = document.createElement('button');
            modal.textContent = '${german ? 'Ohne Audio oder Video fortfahren' : 'Continue without audio or video'}';
            modal.onclick = () => modal.remove();
            document.body.append(modal);
          } else {
            document.querySelector('#join').remove();
            document.querySelector('#waiting').textContent = '${lobby}';
            const leave = document.createElement('button');
            leave.textContent = '${leave}';
            leave.onclick = () => leave.remove();
            document.body.append(leave);
          }
        };
        window.admitTeamsInCall = () => {
          document.querySelector('#waiting').textContent = '';
          const chatBtn = document.createElement('button');
          chatBtn.id = 'chat-button';
          chatBtn.textContent = 'Chat';
          chatBtn.setAttribute('aria-expanded', 'false');
          let chatBoxCreated = false;
          const people = document.createElement('button');
          people.id = 'roster-button';
          people.textContent = '${german ? 'Teilnehmer' : 'People'}';
          people.setAttribute('aria-expanded', 'false');
          people.onclick = () => {
            people.setAttribute('aria-expanded', 'true');
            chatBtn.setAttribute('aria-expanded', 'false');
            window.teamsUiEvents.push('roster-open');
            const bobItem = document.createElement('div');
            bobItem.setAttribute('role', 'listitem');
            bobItem.setAttribute('data-participant-id', 'bob-session');
            bobItem.setAttribute('aria-label', 'Bob Example');
            document.body.append(bobItem);
            void fetch('https://teams.microsoft.com/roster-sync');
          };
          chatBtn.onclick = () => {
            chatBtn.setAttribute('aria-expanded', 'true');
            people.setAttribute('aria-expanded', 'false');
            window.teamsUiEvents.push(chatBoxCreated ? 'chat-reopen' : 'chat-open');
            if (!chatBoxCreated) {
              chatBoxCreated = true;
              const box = document.createElement('div');
              box.setAttribute('role', 'textbox');
              box.setAttribute('contenteditable', 'true');
              box.setAttribute('aria-label', '${german ? 'Nachricht eingeben' : 'Type a message'}');
              const send = document.createElement('button');
              send.setAttribute('aria-label', '${german ? 'Senden' : 'Send'}');
              send.onclick = () => window.teamsUiEvents.push('chat-send');
              document.body.append(box, send);
            }
          };
          document.body.append(people, chatBtn);
        };
        </script>`,
      });
    });
    const teamsAttemptId = randomUUID();
    const beforeTeams = frames.length;
    const teams = new TeamsBrowser(page, {...bootstrap, provider: 'teams', attempt_id: teamsAttemptId, meeting_url: url,
      chat_intro: german ? 'Aufnahme aktiv (Teams DE)' : 'Recording active (Teams EN)',
      deadline: new Date(Date.now() + 60000).toISOString(),
      teams: {display_name: 'wortlaut fixture', locale: german ? 'de-DE' : 'en-US'}},
      `http://127.0.0.1:${address.port}`, 'fixture-node-secret', randomUUID(), assets);
    await teams.prepare(); await page.goto(url); await teams.join();
    assert.equal(await page.getByRole('textbox').inputValue(), 'wortlaut fixture');
    assert.equal(await page.getByRole('radio').isChecked(), true);
    assert.equal((await teams.inspect()).participation, 'waiting_admission',
      'Leave button must not count as admission in lobby');
    // Unrecognized lobby text + Leave button (without in-call controls or RTP) must ALSO stay waiting_admission!
    await page.locator('#waiting').evaluate((element, text) => { element.textContent = text; }, unknownLobby);
    assert.equal((await teams.inspect()).participation, 'waiting_admission',
      'Unrecognized Teams lobby text with Leave button alone must remain waiting_admission');
    await page.locator('#waiting').evaluate(element => { element.textContent = ''; });
    assert.equal((await teams.inspect()).participation, 'waiting_admission',
      'Empty Teams lobby text with Leave button alone (no RTP, no in-call controls) must remain waiting_admission');
    await page.evaluate(() => (window as any).admitTeamsInCall());
    assert.equal((await teams.inspect()).participation, 'capturing');
    // Second inspect() tick must restore Chat panel after People closed it
    await teams.inspect();
    assert.deepEqual(await page.evaluate(() => (window as any).teamsUiEvents), [
      'chat-open',
      'chat-send',
      'roster-open',
      'chat-reopen',
    ]);
    await page.evaluate(async () => {
      const producer = new AudioContext();
      const oscillator = producer.createOscillator();
      const destination = producer.createMediaStreamDestination();
      oscillator.connect(destination); oscillator.start();
      const sender = new RTCPeerConnection({iceServers: []});
      const receiver = new RTCPeerConnection({iceServers: []});
      const roster = sender.createDataChannel('roster');
      receiver.ontrack = event => {
        const audio = document.createElement('audio'); audio.autoplay = true;
        audio.srcObject = new MediaStream([event.track]); document.body.append(audio);
      };
      sender.onicecandidate = event => { if (event.candidate) void receiver.addIceCandidate(event.candidate); };
      receiver.onicecandidate = event => { if (event.candidate) void sender.addIceCandidate(event.candidate); };
      sender.addTrack(destination.stream.getAudioTracks()[0]);
      await sender.setLocalDescription(await sender.createOffer());
      await receiver.setRemoteDescription(sender.localDescription!);
      await receiver.setLocalDescription(await receiver.createAnswer());
      await sender.setRemoteDescription(receiver.localDescription!);
      await producer.resume();
      Object.assign(window, {
        sendTeamsRoster() {
          const domTile = document.createElement('div');
          domTile.setAttribute('data-participant-id', 'alice-session');
          const nameSpan = document.createElement('span');
          nameSpan.setAttribute('data-tid', 'roster-person-name');
          nameSpan.textContent = 'Alice Example';
          domTile.appendChild(nameSpan);
          document.body.appendChild(domTile);
          const trackId = receiver.getReceivers()[0]?.track?.id;
          const ssrc = receiver.getReceivers()[0]?.getSynchronizationSources()?.[0]?.source ?? 1001;
          roster.send(JSON.stringify({
            participants: [{
              participant_id: 'alice-session',
              audio_csis: [ssrc],
              track_id: trackId,
            }],
          }));
          const idBytes = new TextEncoder().encode('alice-session');
          const pb = new Uint8Array(2 + idBytes.length + 5);
          pb[0] = (1 << 3) | 2;
          pb[1] = idBytes.length;
          pb.set(idBytes, 2);
          pb[2 + idBytes.length] = (2 << 3) | 5;
          new DataView(pb.buffer).setUint32(3 + idBytes.length, ssrc, true);
          roster.send(pb.buffer);
        },
        async finishTeamsProducer() {
          roster.close(); oscillator.stop(); sender.close(); receiver.close(); await producer.close();
        },
      });
    });
    await page.waitForFunction(() => window.wortlautMeet.inspect().audio_samples > 8000,
      undefined, {timeout: 15000});
    await page.evaluate(() => (window as any).sendTeamsRoster());
    await page.waitForFunction(() => {
      const inspected = window.wortlautMeet.inspect();
      return inspected.participant_sources.available === true &&
        inspected.receiver_sources[0]?.signaled_participant_id === 'alice-session' &&
        inspected.audio_samples > 16000;
    }, undefined, {timeout: 15000});
    const state = await teams.inspect();
    assert.equal(state.streams, 1);
    assert.ok(state.audio_samples > 16000);
    assert.ok(state.active_audio_samples > 16000);
    assert.equal(state.capability, 'unverified');
    assert.equal(state.reason, '');
    assert.equal(state.participant_sources.available, true);
    assert.equal(state.participant_sources.total, 2);
    assert.equal(state.participant_sources.dom_participants, 2);
    const aliceSource = state.participant_sources.sources.find((s) => s.participant_id === 'alice-session');
    const bobSource = state.participant_sources.sources.find((s) => s.participant_id === 'bob-session');
    assert.equal(aliceSource?.participant_name, 'Alice Example');
    assert.equal(bobSource?.participant_name, 'Bob Example');
    assert.equal((state.receiver_sources[0] as any)?.signaled_participant_id, 'alice-session');
    assert.equal((state.receiver_sources[0] as any)?.participant_name, 'Alice Example');
    assert.ok(state.sdp.descriptions >= 1);
    assert.ok(state.data_channels.some((dc) => dc.label === 'http:fetch' && dc.json_frames >= 1));
    assert.ok(state.data_channels.some((dc) => dc.label === 'roster' && dc.json_frames >= 1 &&
      dc.binary_frames >= 1 &&
      dc.wire_formats.includes('json') && dc.wire_formats.includes('protobuf') &&
      dc.protobuf_fields.includes('1:2') && dc.protobuf_fields.includes('2:5') &&
      dc.json_keys.includes('participants') && dc.json_keys.includes('participant_id')));
    await teams.stop('normal');
    assert.equal((await teams.inspect()).drained, true);
    const teamsFrames = frames.slice(beforeTeams);
    assert.ok(teamsFrames.some(f => f.metadata.type === 'begin' &&
      f.metadata.attempt_id === teamsAttemptId &&
      f.metadata.provider_source_id === `teams:${bootstrap.meeting_id}:receiver:1` &&
      f.metadata.attribution_unknown === true));
    assert.ok(teamsFrames.some(f => f.metadata.type === 'bind' &&
      f.metadata.speaker_id === 'alice-session' &&
      f.metadata.participant_id === 'alice-session' &&
      f.metadata.participant_name === 'Alice Example' &&
      f.metadata.attribution_unknown === false));
    assert.ok(teamsFrames.some(f => Boolean(f.pcm) && f.metadata.attempt_id === teamsAttemptId &&
      f.metadata.speaker_id === 'alice-session' && f.metadata.attribution_unknown === false));
    assert.ok(teamsFrames.some(f => f.metadata.type === 'end' &&
      String(f.metadata.id).startsWith(`${teamsAttemptId}/`)));
    assert.equal(await page.getByRole('button', {name: leave, exact: true}).count(), 0);
    await page.evaluate(() => (window as any).finishTeamsProducer());
    await context.close();
  }

  // Regression: Teams cold-room prejoin banner ("Jemand wird Sie einlassen, wenn die Besprechung beginnt")
  // + async FluentUI .fui-DialogSurface__backdrop covering #prejoin-join-button before join.click()
  {
    const coldTeamsCtx = await browser.newContext();
    const coldTeamsPage = await coldTeamsCtx.newPage();
    const coldTeamsUrl = 'https://teams.microsoft.com/meet/987654321?p=coldroom';
    await coldTeamsPage.route('https://teams.microsoft.com/**', route => route.fulfill({
      contentType: 'text/html',
      body: `<p id="prejoin-banner">Hallo! Jemand wird Sie einlassen, wenn die Besprechung beginnt.</p>
      <label>Ihr Name<input id="name-input" data-tid="prejoin-display-name-input"></label>
      <button id="prejoin-join-button" data-tid="prejoin-join-button">Jetzt teilnehmen</button>
      <p id="waiting"></p>
      <script>
      window.coldTeamsEvents = [];
      let backdropShown = false;
      document.querySelector('#name-input').addEventListener('input', () => {
        if (backdropShown) return;
        backdropShown = true;
        // Simulate async FluentUI dialog backdrop covering the entire viewport right before join.click()
        const backdrop = document.createElement('div');
        backdrop.className = 'fui-DialogSurface__backdrop';
        backdrop.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.5)';
        const dialog = document.createElement('div');
        dialog.setAttribute('role', 'dialog');
        dialog.style.cssText = 'position:fixed;inset:20%;z-index:10000;background:#fff;padding:24px';
        const continueBtn = document.createElement('button');
        continueBtn.textContent = 'Ohne Audio oder Video fortfahren';
        continueBtn.onclick = () => {
          window.coldTeamsEvents.push('dismiss-backdrop');
          dialog.remove();
          setTimeout(() => backdrop.remove(), 80);
        };
        dialog.append(continueBtn);
        document.body.append(backdrop, dialog);
      });
      document.querySelector('#prejoin-join-button').onclick = () => {
        window.coldTeamsEvents.push('join-clicked:' + document.querySelector('#name-input').value);
        // Real Teams 2026 keeps prejoin-join-button visible with disabled=true in the lobby.
        document.querySelector('#prejoin-join-button').disabled = true;
        document.querySelector('#waiting').textContent = 'Someone will let you in when the meeting starts.';
        const cancel = document.createElement('button');
        cancel.setAttribute('data-tid', 'prejoin-cancel-button');
        cancel.textContent = 'Cancel';
        document.body.append(cancel);
      };
      </script>`,
    }));
    const coldTeams = new TeamsBrowser(
      coldTeamsPage,
      {
        ...bootstrap,
        provider: 'teams',
        attempt_id: randomUUID(),
        meeting_url: coldTeamsUrl,
        deadline: new Date(Date.now() + 30000).toISOString(),
        teams: {display_name: 'wortlaut coldroom', locale: 'de-DE'},
      },
      `http://127.0.0.1:${address.port}`,
      'fixture-node-secret',
      randomUUID(),
      assets,
    );
    await coldTeams.prepare();
    await coldTeamsPage.goto(coldTeamsUrl);
    assert.equal((await coldTeams.inspect()).participation, 'joining',
      'Cold-room prejoin banner must not report waiting_admission before Join now is clicked');
    await coldTeams.join();
    assert.deepEqual(await coldTeamsPage.evaluate(() => (window as any).coldTeamsEvents), [
      'dismiss-backdrop',
      'join-clicked:wortlaut coldroom',
    ]);
    assert.equal((await coldTeams.inspect()).participation, 'waiting_admission');
    await coldTeams.stop('cancelled');
    await coldTeamsCtx.close();
  }

  {
    const zoomContext = await browser.newContext();
    const zoomPage = await zoomContext.newPage();
    const zoomUrl = 'https://app.zoom.us/wc/12345678901/join?pwd=fixture-passcode';
    await zoomPage.route('https://app.zoom.us/**', route => {
      if (route.request().url().endsWith('/zoom-roster')) {
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            participants: [{userId: 4201, userName: 'Clara Zoom', audioSsrc: 2002}],
          }),
        });
      }
      return route.fulfill({
        contentType: 'text/html',
        body: `<label>Your Name<input id="input-for-name"></label>
        <button id="join-btn" class="preview-join-button">Join</button>
        <div id="wc-container-left"></div>
        <p id="waiting"></p>
        <script>
        document.querySelector('#join-btn').onclick = () => {
          document.querySelector('#join-btn').remove();
          document.querySelector('#waiting').textContent = 'Please wait, the meeting host will let you in soon.';
          const leave = document.createElement('button');
          leave.textContent = 'Leave';
          leave.onclick = () => {
            const confirmLeave = document.createElement('button');
            confirmLeave.textContent = 'Leave Meeting';
            confirmLeave.onclick = () => { confirmLeave.remove(); leave.remove(); };
            document.body.append(confirmLeave);
          };
          document.body.append(leave);
        };
        window.admitZoomInCall = () => {
          document.querySelector('#waiting').textContent = '';
          const participantsBtn = document.createElement('button');
          participantsBtn.setAttribute('aria-label', 'Participants (2)');
          const audioBtn = document.createElement('button');
          audioBtn.textContent = 'Join Audio by Computer';
          audioBtn.onclick = () => {
            audioBtn.remove();
            void fetch('https://app.zoom.us/zoom-roster');
          };
          document.body.append(participantsBtn, audioBtn);
        };
        </script>`,
      });
    });
    const zoomAttemptId = randomUUID();
    const zoom = new ZoomBrowser(
      zoomPage,
      {
        ...bootstrap,
        provider: 'zoom',
        attempt_id: zoomAttemptId,
        meeting_url: zoomUrl,
        deadline: new Date(Date.now() + 60000).toISOString(),
        zoom: {display_name: 'wortlaut zoom fixture', locale: 'en-US'},
      },
      `http://127.0.0.1:${address.port}`,
      'fixture-node-secret',
      randomUUID(),
      assets,
    );
    await zoom.prepare();
    await zoomPage.goto(zoomUrl);
    await zoom.join();
    assert.equal(await zoomPage.locator('#input-for-name').inputValue(), 'wortlaut zoom fixture');
    assert.equal((await zoom.inspect()).participation, 'waiting_admission');
    // Unrecognized Zoom waiting room text + #wc-container-left + Leave button must ALSO remain waiting_admission!
    await zoomPage.locator('#waiting').evaluate(element => {
      element.textContent = 'Host is preparing the session';
    });
    assert.equal((await zoom.inspect()).participation, 'waiting_admission',
      'Unrecognized Zoom waiting room text with #wc-container-left + Leave must remain waiting_admission');
    await zoomPage.locator('#waiting').evaluate(element => { element.textContent = ''; });
    assert.equal((await zoom.inspect()).participation, 'waiting_admission',
      '#wc-container-left + Leave alone without in-call controls or RTP must remain waiting_admission');
    await zoomPage.evaluate(() => (window as any).admitZoomInCall());
    assert.equal((await zoom.inspect()).participation, 'capturing');
    await zoomPage.waitForFunction(() => {
      const inspected = window.wortlautMeet.inspect();
      return inspected.participant_sources.available === true &&
        inspected.participant_sources.sources.some(s => s.participant_id === '4201' && s.participant_name === 'Clara Zoom');
    }, undefined, {timeout: 10000});
    const zoomState = await zoom.inspect();
    assert.equal(zoomState.capability, 'unverified');
    assert.equal(zoomState.participant_sources.available, true);
    assert.equal(zoomState.participant_sources.opted_out, undefined);
    await zoomPage.evaluate(() => {
      const chatItem = document.createElement('div');
      chatItem.className = 'chat-item__container';
      const sender = document.createElement('span');
      sender.className = 'chat-item__sender';
      sender.textContent = 'Clara Zoom';
      const msg = document.createElement('div');
      msg.className = 'new-chat-message__text-box';
      msg.textContent = 'nein';
      chatItem.append(sender, msg);
      document.body.append(chatItem);
    });
    const zoomOptOutState = await zoom.inspect();
    assert.ok(zoomOptOutState.participant_sources.opted_out?.includes('Clara Zoom'));
    assert.ok(zoomOptOutState.participant_sources.opted_out?.includes('4201'));
    await zoom.stop('normal');
    assert.equal((await zoom.inspect()).participation, 'ended');
    assert.equal(await zoomPage.getByRole('button', {name: 'Leave', exact: true}).count(), 0);
    await zoomContext.close();
  }

  // Verify live transcript virtual camera tile (mediaDevices shim, audio rejection, prejoin/in-call stream isolation, immediate first frame, self-tile exclusion, and live segment rendering)
  {
    const tileFixture = await preparePage('guest', true);
    await (tileFixture.meet as any).initialize?.();
    const mediaCheck = await tileFixture.page.evaluate(async () => {
      const devices = await navigator.mediaDevices.enumerateDevices();
      let audioRejected = false;
      try {
        await navigator.mediaDevices.getUserMedia({audio: true});
      } catch (err) {
        audioRejected = (err as DOMException)?.name === 'NotFoundError';
      }
      const previewStream = await navigator.mediaDevices.getUserMedia({video: true});
      const t0 = performance.now();
      const callStream = await navigator.mediaDevices.getUserMedia({video: {width: 1280, height: 720}});
      const previewTrack = previewStream.getVideoTracks()[0];
      const callTrack = callStream.getVideoTracks()[0] as MediaStreamTrack & {__wortlautVirtualVideo?: boolean};
      previewTrack.stop();

      const selfTile = document.createElement('div');
      selfTile.setAttribute('data-tid', 'video-tile');
      selfTile.setAttribute('data-user-id', 'self-pip-1');
      const vid = document.createElement('video');
      vid.muted = true;
      vid.playsInline = true;
      vid.autoplay = true;
      vid.srcObject = callStream;
      selfTile.append(vid);

      const remoteTile = document.createElement('div');
      remoteTile.setAttribute('data-tid', 'video-tile');
      remoteTile.setAttribute('data-user-id', 'remote-bob-1');
      const remoteName = document.createElement('span');
      remoteName.setAttribute('data-tid', 'video-tile-name');
      remoteName.textContent = 'Bob Remote';
      remoteTile.append(remoteName);
      document.body.append(selfTile, remoteTile);

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('first_frame_timeout')), 1000);
        if (vid.readyState >= 2 && vid.videoWidth === 1280) {
          clearTimeout(timer);
          resolve();
          return;
        }
        vid.addEventListener(
          'loadeddata',
          () => {
            clearTimeout(timer);
            resolve();
          },
          {once: true},
        );
      });
      const firstFrameMs = performance.now() - t0;
      const inspected = window.wortlautMeet.inspect();
      const settings = callTrack.getSettings();
      return {
        deviceKinds: devices.map((d) => d.kind),
        deviceLabel: devices[0]?.label,
        audioRejected,
        previewStateAfterStop: previewTrack.readyState,
        callStateAfterPreviewStop: callTrack.readyState,
        isTaggedVirtual: callTrack.__wortlautVirtualVideo === true,
        contentHint: callTrack.contentHint,
        width: settings.width,
        height: settings.height,
        videoWidth: vid.videoWidth,
        firstFrameMs,
        domParticipants: inspected.participant_sources.dom_participants ?? 0,
        hasSelfPipSource: inspected.participant_sources.sources.some(
          (s) => s.participant_id === 'self-pip-1',
        ),
      };
    });
    assert.deepEqual(mediaCheck.deviceKinds, ['videoinput']);
    assert.equal(mediaCheck.deviceLabel, 'wortlaut Live-Protokoll');
    assert.equal(mediaCheck.audioRejected, true);
    assert.equal(mediaCheck.previewStateAfterStop, 'ended');
    assert.equal(mediaCheck.callStateAfterPreviewStop, 'live');
    assert.equal(mediaCheck.isTaggedVirtual, true);
    assert.equal(mediaCheck.contentHint, 'detail');
    assert.equal(mediaCheck.width, 1280);
    assert.equal(mediaCheck.height, 720);
    assert.equal(mediaCheck.videoWidth, 1280);
    assert.ok(mediaCheck.firstFrameMs < 1000, `Expected immediate first frame, got ${mediaCheck.firstFrameMs}ms`);
    assert.equal(mediaCheck.domParticipants, 1);
    assert.equal(mediaCheck.hasSelfPipSource, false);

    await tileFixture.meet.updateVideoTile({
      participation: 'capturing',
      segments: [
        {speaker: 'Alice Beispiel', text: 'Willkommen im Live-Wortprotokoll.', start: 4},
        {speaker: 'Bob Beispiel', text: 'Die Kachel aktualisiert sich laufend.', start: 11},
      ],
    });
    const rendered = await tileFixture.page.evaluate(() => {
      const tile = window.wortlautVideoTile!;
      const snap = tile.getSnapshot();
      const ctx = tile.canvas.getContext('2d')!;
      const sample = ctx.getImageData(100, 70, 200, 40).data;
      let nonDarkPixels = 0;
      for (let i = 0; i < sample.length; i += 4) {
        if (sample[i] > 40 || sample[i + 1] > 40 || sample[i + 2] > 40) nonDarkPixels += 1;
      }
      return {snap, nonDarkPixels};
    });
    assert.equal(rendered.snap.participation, 'capturing');
    assert.equal(rendered.snap.segmentCount, 2);
    assert.equal(rendered.snap.lastRenderedText, 'Bob Beispiel: Die Kachel aktualisiert sich laufend.');
    assert.equal(rendered.snap.activeTracks, 1);
    assert.ok(rendered.nonDarkPixels > 50);

    await tileFixture.meet.stop('cancelled');
    const afterStopSnap = await tileFixture.page.evaluate(() => window.wortlautVideoTile?.getSnapshot());
    assert.equal(afterStopSnap?.activeTracks, 0);
    await tileFixture.page.evaluate('window.finishProducer?.()');
    await tileFixture.context.close();
  }

  console.log(JSON.stringify({fixture: 'controlled Meet-origin DOM and native WebRTC; no provider identity proof',
    frequencies, samples: state.audio_samples, drained: state.drained, native_input_gaps: gaps.length,
    encoded_frames: encodedFrames, provider_transform_guards: true}));
} finally {
  await browser.close();
  for (const socket of sockets.clients) socket.terminate();
  await new Promise<void>((resolve) => sockets.close(() => server.close(() => resolve())));
}
