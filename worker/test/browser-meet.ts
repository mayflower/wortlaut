import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {once} from 'node:events';
import {launchBrowser, nativeMeetInput} from '../runtime/browser';
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
  lobby_timeout_seconds: 30, meet: {display_name: 'wortlaut fixture', locale: 'en-US', auth_mode: 'guest'}};

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
    ...(window.encodedFixtureMode === 'reserved' ? {encodedInsertableStreams: true} : {})});
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
  sender.onicecandidate = e => { if (e.candidate) receiver.addIceCandidate(e.candidate); };
  receiver.onicecandidate = e => { if (e.candidate) sender.addIceCandidate(e.candidate); };
  receiver.ontrack = e => {
    // Prove native events and prototypes still work after installing the hook.
    if (!(e.receiver instanceof RTCRtpReceiver) || !(receiver instanceof RTCPeerConnection)) throw Error('Native RTC changed');
    const audio = document.createElement('audio'); audio.autoplay = true;
    audio.srcObject = new MediaStream([e.track]); document.body.append(audio);
  };
  const nodes = [], tracks = [];
  for (const frequency of [440, 880]) {
    const tone = producer.createOscillator(); tone.frequency.value = frequency;
    const destination = producer.createMediaStreamDestination(); tone.connect(destination);
    tracks.push(destination.stream);
    tone.start(); nodes.push(tone);
  }
  if (['provider', 'reserved'].includes(window.encodedFixtureMode)) {
    // Offer the preconfigured receive transceivers so the test really uses
    // those transforms, rather than creating additional unassociated slots.
    await receiver.setLocalDescription(await receiver.createOffer());
    await sender.setRemoteDescription(receiver.localDescription);
    tracks.forEach(stream => sender.addTrack(stream.getAudioTracks()[0], stream));
    await sender.setLocalDescription(await sender.createAnswer());
    await receiver.setRemoteDescription(sender.localDescription);
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
    providerWorker?.terminate(); URL.revokeObjectURL(providerUrl);
  };
};`;
type CaptureLinks = {links: {source: MediaStreamAudioSourceNode; node: AudioNode}[]};
async function preparePage(auth: 'guest' | 'account' = 'guest', german = false, missingInput = false,
  encoded: 'native' | 'provider' | 'reserved' | 'unsupported' | 'failed' = 'native') {
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
    ['provider', 'provider_transform'], ['reserved', 'provider_reserved'],
    ['unsupported', 'unsupported'], ['failed', 'failed'], ['native', 'replaced'],
  ] as const) {
    const guarded = await preparePage('guest', false, false, mode);
    await guarded.meet.join(); await guarded.page.evaluate('window.admit()');
    await guarded.page.waitForFunction(() => window.wortlautMeet.inspect().audio_samples > 16000,
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
  await stalled.page.waitForFunction(() => window.wortlautMeet.inspect().audio_samples > 16000,
    undefined, {timeout: 15000});
  await stalled.page.evaluate(() => (window as any).fixtureWorkers[0].terminate());
  await stalled.page.waitForFunction(() => window.wortlautMeet.inspect().reason === 'encoded_transform_failed',
    undefined, {timeout: 8000});
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
      camera.setAttribute('aria-label', labels.cameraOff);
      leave.setAttribute('aria-label', labels.leave);
      mic.onclick = () => { mic.setAttribute('aria-label', labels.micOn); events.push('mic-off'); };
      camera.onclick = () => { camera.setAttribute('aria-label', labels.cameraOn); events.push('camera-off'); };
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
    await localized.meet.stop('cancelled');
    assert.deepEqual(await localized.page.evaluate(() => (window as any).labelEvents),
      ['mic-off', 'camera-off', 'join', 'leave']);
    assert.deepEqual(localized.errors, []);
    await localized.context.close();
  }

  const noDevices = await preparePage();
  await noDevices.page.evaluate(() => {
    navigator.mediaDevices.enumerateDevices = async () => [];
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
      Object.defineProperty(window, 'screenX', {configurable: true, get: () => value + 200});
    }, screenX);
    await assert.rejects(nativeMeetInput(pending.page).click(pending.page.locator('#join')),
      /Native pointer missed target/);
    assert.equal(await pending.page.locator('#join').count(), 1);
    assert.equal(await pending.page.locator('#waiting').innerText(), '');
    await pending.page.evaluate(value => {
      Object.defineProperty(window, 'screenX', {configurable: true, get: () => value});
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

  const account = await preparePage('account');
  await assert.rejects(account.meet.join(), (error: unknown) => error instanceof MeetError && error.reason === 'auth_session_missing');
  assert.equal(await account.page.locator('#join').count(), 1);
  await account.meet.stop('auth_session_missing'); await account.context.close();
  assert.equal(authenticated, 22);
  console.log(JSON.stringify({fixture: 'controlled Meet-origin DOM and native WebRTC; no provider identity proof',
    frequencies, samples: state.audio_samples, drained: state.drained, native_input_gaps: gaps.length,
    encoded_frames: encodedFrames, provider_transform_guards: true}));
} finally {
  await browser.close();
  for (const socket of sockets.clients) socket.terminate();
  await new Promise<void>((resolve) => sockets.close(() => server.close(() => resolve())));
}
