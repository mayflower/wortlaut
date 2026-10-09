import {readFile} from 'node:fs/promises';
import type {Locator, Page} from 'playwright';
import type {CaptureSink} from '../src/capture.js';
import type {Chunk} from '../src/chunks.js';
import type {MeetBridgeMessage, MeetCaptureConfig} from '../src/meet-page.js';
import {AudioTransport} from '../src/transport.js';

export type MeetBootstrap = {provider: 'google_meet'; meeting_id: string; attempt_id: string;
  meeting_url: string; deadline: string; lobby_timeout_seconds: number;
  meet: {display_name: string; locale: string; auth_mode: 'guest' | 'account'}};

export class MeetError extends Error {
  constructor(readonly reason: string) { super(reason); }
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export async function installMeetCapture(page: Page, bootstrap: MeetBootstrap, sink: CaptureSink,
  assets = new URL('../../dist/meet/', import.meta.url)) {
  const bundle = await readFile(new URL('capture.js', assets), 'utf8');
  const active = new Set<string>();
  await page.exposeBinding('wortlautMeetBridge', (source, raw: MeetBridgeMessage) => {
    const url = new URL(source.frame.url());
    if (source.page !== page || source.frame !== page.mainFrame() ||
        url.origin !== 'https://meet.google.com' || url.pathname !== new URL(bootstrap.meeting_url).pathname ||
        !raw || raw.attempt_id !== bootstrap.attempt_id || !['control', 'chunk'].includes(raw.type)) {
      throw new MeetError('browser_bridge_rejected');
    }
    const metadata = raw.metadata;
    if (!metadata || JSON.stringify(metadata).length > 8192 || typeof metadata.stream_id !== 'string' ||
        !uuid.test(metadata.stream_id) || typeof metadata.epoch !== 'string' || !uuid.test(metadata.epoch)) {
      throw new MeetError('browser_bridge_rejected');
    }
    const key = `${metadata.stream_id}/${metadata.epoch}`;
    const unsigned = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
    const binding = () => metadata.meeting_id === bootstrap.meeting_id &&
      metadata.attempt_id === bootstrap.attempt_id && metadata.sample_rate === 16000 &&
      metadata.channels === 1 && metadata.encoding === 'pcm_s16le' &&
      metadata.source_kind === 'speaker' && metadata.speaker_id === null && metadata.attribution_unknown === true &&
      typeof metadata.provider_source_id === 'string' && metadata.provider_source_id.length <= 256 &&
      metadata.provider_source_id.startsWith(`google_meet:${bootstrap.meeting_id}:receiver:`);
    if (raw.type === 'control' && metadata.type === 'begin') {
      if (!binding() || (active.size >= 64 && !active.has(key)) ||
          metadata.id !== `${bootstrap.attempt_id}/${key}/begin`) throw new MeetError('browser_bridge_rejected');
      active.add(key); sink.begin(metadata);
    } else if (raw.type === 'control' && metadata.type === 'end') {
      if (!active.has(key) || !unsigned(metadata.final_sample) ||
          !Number.isSafeInteger(metadata.last_sequence) || (metadata.last_sequence as number) < -1 ||
          metadata.id !== `${bootstrap.attempt_id}/${key}/end`) throw new MeetError('browser_bridge_rejected');
      active.delete(key); sink.end(metadata);
    } else if (raw.type === 'control' && metadata.type === 'gap') {
      if (!active.has(key) || !unsigned(metadata.sequence) || !unsigned(metadata.start_sample) ||
          !unsigned(metadata.sample_count) || (metadata.sample_count as number) < 1 ||
          (metadata.sample_count as number) > 80000 || metadata.final !== true ||
          metadata.reason !== 'capture_input_missing' ||
          metadata.id !== `${bootstrap.attempt_id}/${key}/${metadata.sequence}/gap`) {
        throw new MeetError('browser_bridge_rejected');
      }
      sink.gap(metadata);
    } else if (raw.type === 'chunk') {
      if (!active.has(key) || !binding() || !unsigned(metadata.sequence) || !unsigned(metadata.start_sample) ||
          !unsigned(metadata.sample_count) || (metadata.sample_count as number) < 1 ||
          (metadata.sample_count as number) > 80000 || typeof raw.pcm !== 'string' || raw.pcm.length > 213336 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(raw.pcm)) throw new MeetError('browser_bridge_rejected');
      const pcm = Buffer.from(raw.pcm, 'base64');
      if (pcm.length !== (metadata.sample_count as number) * 2) throw new MeetError('browser_bridge_rejected');
      sink.chunk(metadata as Chunk, pcm);
    } else throw new MeetError('browser_bridge_rejected');
  });
  const config: MeetCaptureConfig = {meeting_id: bootstrap.meeting_id, attempt_id: bootstrap.attempt_id,
    meeting_url: bootstrap.meeting_url};
  // Only the small native hook belongs in every new document. The local WASM
  // bundle is loaded once in the main Meet document, before clicking join.
  await page.addInitScript((config: MeetCaptureConfig) => {
    if (window !== window.top || location.origin !== 'https://meet.google.com' ||
        location.pathname !== new URL(config.meeting_url).pathname) return;
    window.wortlautMeetConfig = config;
    const connections = new Set<RTCPeerConnection>(), received = new WeakSet<RTCRtpReceiver>();
    const encodedReserved = new WeakSet<RTCPeerConnection>();
    window.wortlautMeetReceivers = {connections, received, encodedReserved};
    const Native = window.RTCPeerConnection;
    window.RTCPeerConnection = new Proxy(Native, {construct(target, args, newTarget) {
      const pc = Reflect.construct(target, args, newTarget) as RTCPeerConnection;
      connections.add(pc);
      if (args[0]?.encodedInsertableStreams === true) encodedReserved.add(pc);
      pc.addEventListener('track', (event) => {
        received.add(event.receiver);
        window.wortlautMeetReceivers.observe?.(event.receiver, pc);
      });
      pc.addEventListener('connectionstatechange', () => {
        if (pc.connectionState === 'closed') connections.delete(pc);
      });
      return pc;
    }});
  }, config);
  return async () => {
    const url = new URL(page.url());
    if (url.origin === 'https://accounts.google.com') throw new MeetError('auth_session_missing');
    if (url.href !== bootstrap.meeting_url) throw new MeetError('unexpected_browser_origin');
    await page.evaluate(bundle);
    await page.waitForFunction(() => window.wortlautMeet?.inspect().capture_ready ||
      window.wortlautMeet?.inspect().reason, undefined, {timeout: 10000});
    const state = await page.evaluate(() => window.wortlautMeet.inspect());
    if (state.reason) throw new MeetError(state.reason);
  };
}

// Join/admission selectors were reviewed against @vexa/join's Google Meet
// implementation at 18e7ac1d6a0201d1489ce30b12b6f7138067a598 (Apache-2.0).
// Only exact English/German actions are used; no broad structural button click.
const actions = {
  join: /^(Ask to join|Join now|Um Teilnahme bitten|Jetzt teilnehmen)$/i,
  leave: /^(Leave call|Leave meeting|Anruf verlassen|Besprechung verlassen)(?: \(.*\))?$/i,
  micOff: /^(Turn off microphone|Mikrofon ausschalten)(?: \(.*\))?$/i,
  micOn: /^(Turn on microphone|Mikrofon einschalten)(?: \(.*\))?$/i,
  cameraOff: /^(Turn off camera|Kamera ausschalten)(?: \(.*\))?$/i,
  cameraOn: /^(Turn on camera|Kamera einschalten)(?: \(.*\))?$/i,
};
const waiting = /Asking to be let in|You[’']ll join the call when someone lets you|Waiting for the host|waiting room|Um Teilnahme gebeten|Warten.*(?:Zulassung|Gastgeber)|Sobald.*(?:zugelassen|teilnehmen)/i;
const denied = /denied your request|request to join was denied|not allowed to join|weren[’']t allowed|Anfrage.*abgelehnt|Teilnahme.*(?:abgelehnt|nicht gestattet)|Sie können nicht an diesem Videoanruf teilnehmen/i;
const removed = /removed from (?:the )?(?:call|meeting)|aus.*(?:Besprechung|Anruf).*entfernt/i;
const ended = /^(?:This )?(?:meeting|call) (?:has )?ended\.?$|Besprechung.*beendet|Anruf.*beendet/i;

async function visible(locator: Locator) { return locator.first().isVisible(); }

export class MeetBrowser {
  private participation = 'joining';
  private reason = '';
  private stopping: Promise<void> | undefined;
  private readonly transport: AudioTransport;
  private drained = false;
  private joinSent = false;
  private initialize?: () => Promise<void>;

  constructor(private readonly page: Page, private readonly bootstrap: MeetBootstrap,
    api: string, credential: string, workerId: string,
    private readonly assets?: URL) {
    const ingest = new URL(`/v1/attempts/${bootstrap.attempt_id}/audio`, api);
    if (!['https:', 'http:'].includes(ingest.protocol)) throw new MeetError('invalid_ingest_url');
    ingest.protocol = ingest.protocol === 'https:' ? 'wss:' : 'ws:';
    this.transport = new AudioTransport(ingest.href, credential, workerId,
      (reason) => { this.reason = reason; });
  }

  async prepare() {
    this.initialize = await installMeetCapture(this.page, this.bootstrap, {
      begin: (metadata) => this.transport.control(metadata as Record<string, unknown> & {id: string}),
      end: (metadata) => this.transport.control(metadata as Record<string, unknown> & {id: string}),
      gap: (metadata) => this.transport.control(metadata as Record<string, unknown> & {id: string}),
      chunk: (metadata, pcm) => this.transport.chunk(metadata, pcm),
      error: (reason) => { this.reason = reason; },
    }, this.assets);
    this.transport.connect();
  }

  async join() {
    await this.initialize?.();
    const button = this.page.getByRole('button', {name: actions.join});
    await button.first().waitFor({state: 'visible', timeout: 30000});
    if (this.stopping) return;
    const name = this.page.locator('input[type="text"]:not([aria-hidden="true"])');
    if (await visible(name)) {
      if (this.bootstrap.meet.auth_mode === 'account') throw new MeetError('auth_session_missing');
      if (await name.count() !== 1) throw new MeetError('join_control_ambiguous');
      await name.fill(this.bootstrap.meet.display_name);
    } else if (this.bootstrap.meet.auth_mode === 'guest') {
      throw new MeetError('guest_name_missing');
    }
    for (const [off, on] of [[actions.micOff, actions.micOn], [actions.cameraOff, actions.cameraOn]]) {
      const turnOff = this.page.getByRole('button', {name: off});
      if (await visible(turnOff)) await turnOff.click({timeout: 5000});
      // Refuse to join with an unconfirmed sending state. Browser permissions
      // are empty as well; no fake microphone/camera is supplied in production.
      await this.page.getByRole('button', {name: on}).first().waitFor({state: 'visible', timeout: 10000});
    }
    if (this.stopping) return;
    if (await button.count() !== 1) throw new MeetError('join_control_ambiguous');
    await button.click({timeout: 5000});
    this.joinSent = true;
    this.participation = 'waiting_admission';
  }

  async inspect() {
    let state;
    try { state = await this.page.evaluate(() => window.wortlautMeet?.inspect()); }
    catch { /* navigation may be in progress; classify its origin below */ }
    const url = new URL(this.page.url());
    if (url.origin === 'https://accounts.google.com') this.reason = 'auth_session_missing';
    else if (url.origin !== 'https://meet.google.com') this.reason = 'unexpected_browser_origin';
    if (state?.reason) this.reason = state.reason;
    if (!this.stopping) {
      if (await visible(this.page.getByText(denied))) this.reason = 'admission_denied';
      else if (await visible(this.page.getByText(removed))) this.reason = 'removed';
      else if (await visible(this.page.getByText(ended))) this.reason = 'meeting_ended';
      else if (await this.page.locator('iframe[src*="recaptcha"]').count()) this.reason = 'human_verification_required';
      else if (await visible(this.page.getByRole('dialog').filter({hasText: /take notes for me|taking notes|Notizen.*(?:zustimmen|Einwilligung)/i}))) {
        this.reason = 'consent_required';
      } else if (await visible(this.page.getByText(waiting))) this.participation = 'waiting_admission';
      else if (this.joinSent && !await visible(this.page.getByRole('button', {name: actions.join})) &&
          await visible(this.page.getByRole('button', {name: actions.leave})) &&
          await this.page.locator('[data-self-name], [data-participant-id]').count()) {
        this.participation = 'capturing';
      }
    }
    return {capability: 'unverified', participation: this.stopping ? 'ended' : this.participation,
      reason: this.reason || (this.participation === 'capturing' ? 'source_binding_unverified' : ''),
      stopped: Boolean(this.reason || this.stopping), streams: state?.streams ?? 0,
      audio_samples: state?.audio_samples ?? 0, drained: this.stopping ? this.drained : null,
      configured_speaker_slots: null, configured_share_slots: null,
      receiver_sources: state?.receiver_sources ?? [],
      audio_clock: state?.audio_clock,
      participant_sources: {available: false, total: 0, truncated: false, sources: []}};
  }

  stop(reason: string) {
    return this.stopping ??= (async () => {
      const bridged = await this.page.evaluate(() => window.wortlautMeet?.stop()).catch(() => false);
      this.drained = (await this.transport.drain()) && bridged === true;
      if (!['removed', 'meeting_ended', 'admission_denied'].includes(reason)) {
        const leave = this.page.getByRole('button', {name: actions.leave});
        if (await visible(leave)) await leave.first().click({timeout: 3000}).catch(() => { this.reason = 'leave_unconfirmed'; });
      }
    })();
  }
}
