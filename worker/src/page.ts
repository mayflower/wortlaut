import {AudioCapture, type CaptureSink} from './capture';
import samplerateUrl from '@alexanderolsen/libsamplerate-js/dist/libsamplerate.worklet.js?url';
import {AudioTransport} from './transport';
import {audioReceiver, receiverEvidence, participantEvidence, receiveOptions, replaceGuestToken,
  type Meeting, type MediaGroup, type RemoteMedia, type WebexClient} from './webex';

type Bootstrap = {meeting_id: string; attempt_id: string; meeting_url: string;
  deadline: string; guest: {access_token: string; expires_in: number}};
type Configuration = {bootstrap: Bootstrap; credential: string; worker_id: string};
const options = receiveOptions();
const worklets = {resampler: samplerateUrl, pcm: `${import.meta.env.BASE_URL}pcm-worklet.js`};
const state = {participation: 'preparing', capability: 'unverified', reason: '',
  configured_speaker_slots: options.mediaOptions.remoteMediaManagerConfig.audio.numOfActiveSpeakerStreams,
  configured_share_slots: options.mediaOptions.remoteMediaManagerConfig.audio.numOfScreenShareStreams,
  streams: 0, source_updates: 0, audio_samples: 0, stopped: false, drained: false,
  receiver_sources: [] as ReturnType<typeof receiverEvidence>[],
  participant_sources: participantEvidence()};
let capture: AudioCapture | undefined;
let meeting: Meeting | undefined;
let client: WebexClient | undefined;
let transport: AudioTransport | undefined;
let stopping: Promise<void> | undefined;
let providerEnded = false;
let mediaConnected = false;
let onRemoved: ((data: {meetingId: string; reason: string}) => void) | undefined;
const sources = new Map<RemoteMedia, {kind: 'speaker' | 'share_audio'; track?: MediaStreamTrack;
  signature?: string;
  listener: () => void; stopped: () => void}>();
let sink: CaptureSink;
let bootstrap: Bootstrap;
let inspecting: Promise<void> | undefined;
let inspectAgain = false;

async function inspectReceivers() {
  if (stopping || !meeting || !capture) return state;
  inspectAgain = true;
  await (inspecting ??= (async () => {
    while (inspectAgain && !stopping) {
      inspectAgain = false;
      state.participant_sources = participantEvidence(meeting);
      for (const [media, source] of sources) {
        const receiver = audioReceiver(meeting!, media, source.kind);
        const sdkTracks = media.stream?.getAudioTracks() ?? [];
        const track = receiver?.track ?? (sdkTracks.length === 1 ? sdkTracks[0] : undefined);
        const evidence = receiverEvidence(meeting!, media, source.kind);
        const signature = JSON.stringify([evidence.csi, evidence.signaled_participant_id,
          evidence.source_state, evidence.ssrc.map((s) => s.source).sort((a, b) => a - b),
          evidence.csrc.map((s) => s.source).sort((a, b) => a - b)]);
        if (track === source.track && signature === source.signature) continue;
        if (source.track && (track === source.track || ![...sources.values()].some((other) =>
          other !== source && other.track === source.track))) await capture!.detach(source.track);
        source.track = track;
        source.signature = signature;
        if (track && !stopping && sources.get(media) === source) {
          await capture!.attach(track, bootstrap.meeting_id, bootstrap.attempt_id, {
            provider_source_id: evidence.provider_source_id,
            source_kind: source.kind, speaker_id: null, attribution_unknown: source.kind === 'speaker',
          }, sink);
        }
      }
      state.streams = new Set([...sources.values()].map(({track}) => track)
        .filter((track) => track?.readyState === 'live')).size;
      state.receiver_sources = [...sources].map(([media, source]) =>
        receiverEvidence(meeting!, media, source.kind));
    }
  })().finally(() => { inspecting = undefined; }));
  if (capture) Object.assign(state, {audio_clock: capture.inspectClock()});
  return state;
}

async function stop(reason = 'normal') {
  return stopping ??= (async () => {
    state.reason = reason;
    if (onRemoved) client?.meetings.off('meeting:removed', onRemoved);
    for (const [media, source] of sources) {
      media.off('sourceUpdate', source.listener); media.off('stopped', source.stopped);
    }
    try { await inspecting; } catch { /* capture initialization already reported */ }
    await capture?.stop();
    if (capture) Object.assign(state, {audio_clock: capture.inspectClock()});
    state.drained = await transport?.drain() ?? true;
    if (!providerEnded) {
      try { await meeting?.leave(); } catch { state.reason = 'leave_unconfirmed'; }
    }
    try { await client?.meetings.unregister(); } catch { /* process is ending */ }
    state.participation = 'ended'; state.stopped = true;
  })();
}

async function start(config: Configuration) {
  bootstrap = config.bootstrap;
  const ingest = new URL(`/v1/attempts/${bootstrap.attempt_id}/audio`, location.href);
  ingest.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  transport = new AudioTransport(ingest.href, config.credential, config.worker_id,
    (reason) => { void stop(reason); });
  transport.connect();
  capture = new AudioCapture(worklets); await capture.initialize();
  if (stopping) return;
  sink = {
    begin: (metadata) => transport!.control(metadata as Record<string, unknown> & {id: string}),
    end: (metadata) => transport!.control(metadata as Record<string, unknown> & {id: string}),
    gap: (metadata) => transport!.control(metadata as Record<string, unknown> & {id: string}),
    chunk: (metadata, pcm) => { state.audio_samples += metadata.sample_count; transport!.chunk(metadata, pcm); },
    error: (reason) => { void stop(reason); },
  };
  client = window.Webex.init({credentials: {access_token: bootstrap.guest.access_token},
    config: {logger: {level: 'silent'}, meetings: {
      logging: {enable: false, verboseEvents: false}, reconnection: {enabled: false, autoRejoin: false},
    }}});
  await client.meetings.register();
  if (stopping) return;
  meeting = await client.meetings.create(bootstrap.meeting_url);
  if (stopping) return;
  onRemoved = ({meetingId, reason}) => {
    if (meetingId !== meeting?.id) return;
    providerEnded = true;
    const reasons: Record<string, string> = {SELF_REMOVED: 'removed',
      MEETING_INACTIVE_TERMINATING: 'normal', MEETING_CONNECTION_FAILED: 'media_connection_failed'};
    void stop(reasons[reason] ?? 'provider_left');
  };
  client.meetings.on('meeting:removed', onRemoved);
  const attach = (group: MediaGroup, kind: 'speaker' | 'share_audio') => {
    if (stopping) return;
    for (const media of group.getRemoteMedia()) {
      if (sources.has(media)) continue;
      const listener = () => {
        state.source_updates++;
        // An observed change closes capture/VAD continuity, not a proven
        // participant boundary. Both epochs remain unattributed; never rename PCM.
        void inspectReceivers().catch(() => { void stop('capture_initialization_failed'); });
      };
      const stopped = () => {
        const source = sources.get(media);
        sources.delete(media);
        media.off('sourceUpdate', listener); media.off('stopped', stopped);
        const detached = source?.track && ![...sources.values()].some((other) =>
          other.track === source.track) ? capture!.detach(source.track) : Promise.resolve();
        void detached.then(inspectReceivers).catch(() => { void stop('capture_stop_failed'); });
      };
      sources.set(media, {kind, listener, stopped});
      media.on('sourceUpdate', listener);
      media.on('stopped', stopped);
    }
    void inspectReceivers().catch(() => { void stop('capture_initialization_failed'); });
  };
  // All media, lobby and end listeners are installed before joining.
  meeting.on('media:remoteAudio:created', (group: MediaGroup) => attach(group, 'speaker'));
  meeting.on('media:remoteScreenShareAudio:created', (group: MediaGroup) => attach(group, 'share_audio'));
  meeting.on('meeting:self:lobbyWaiting', () => {
    if (!stopping) state.participation = 'waiting_admission';
  });
  meeting.on('meeting:self:guestAdmitted', () => {
    if (stopping) return;
    state.participation = mediaConnected ? 'capturing' : 'joining';
  });
  meeting.on('media:ready', () => {
    if (stopping) return;
    mediaConnected = true;
    if (state.participation !== 'waiting_admission') state.participation = 'capturing';
    void inspectReceivers().catch(() => { void stop('capture_initialization_failed'); });
  });
  meeting.on('meeting:self:left', () => { providerEnded = true; void stop('provider_left'); });
  state.participation = 'joining';
  const result = await meeting.joinWithMedia(options);
  if (stopping) return;
  if (!result.multistreamEnabled) {
    state.capability = 'unverified'; await stop('multistream_unavailable'); return;
  }
  // Multistream exposes its own remote-media events, not legacy media:ready.
  mediaConnected = true;
  if (state.participation !== 'waiting_admission') state.participation = 'capturing';
  // Raw individual slots are useful evidence but do not establish identity or isolation.
  state.capability = 'unverified'; state.reason = 'source_binding_unverified';
  await inspectReceivers();
}

function renewGuest(guest: {access_token: string}) {
  if (!client || stopping) throw new Error('Guest client is not active');
  replaceGuestToken(client, guest);
}

declare global {
  interface Window {
    wortlaut: {start: typeof start; stop: typeof stop; renewGuest: typeof renewGuest;
      inspectReceivers: typeof inspectReceivers; state: typeof state};
    wortlautAudioTest: (seconds?: number, restart?: boolean) => Promise<AudioFixture[]>;
  }
}
window.wortlaut = {start, stop, renewGuest, inspectReceivers, state};

// Explicit synthetic fixture entry point, never selected by the worker/provider path.
type AudioFixture = {frequency: number; samples: number; duplicates: number;
  begins: number; ends: number;
  gaps: Record<string, unknown>[]; final_sample: number;
  audio_clock?: import('./capture').AudioClock;
  parts: {metadata: import('./chunks').Chunk; pcm: number[]}[]};
window.wortlautAudioTest = async (seconds = 0.5, restart = false) => {
  const producer = new AudioContext({sampleRate: 48000});
  const receiver = new AudioCapture(worklets); await receiver.initialize();
  const meetingId = crypto.randomUUID(), attemptId = crypto.randomUUID();
  const oscillators: OscillatorNode[] = [], tracks: MediaStreamTrack[] = [];
  const results: AudioFixture[] = []; let errors = 0;
  const reattach: (() => Promise<boolean>)[] = [];
  for (const frequency of [440, 880]) {
    const oscillator = producer.createOscillator(); oscillator.frequency.value = frequency;
    const destination = producer.createMediaStreamDestination(); oscillator.connect(destination);
    const track = destination.stream.getAudioTracks()[0];
    const result: AudioFixture = {frequency, samples: 0, duplicates: 0, begins: 0, ends: 0,
      gaps: [], final_sample: 0, parts: []};
    const sink: CaptureSink = {begin: () => { result.begins++; }, end: (metadata) => {
      result.ends++; result.final_sample = metadata.final_sample as number; },
      gap: (metadata) => { result.gaps.push(metadata); },
      error: () => { errors++; },
      chunk: (metadata, pcm) => { result.samples += metadata.sample_count;
        result.parts.push({metadata, pcm: Array.from(pcm)}); }};
    const binding = {provider_source_id: `fixture:${frequency}`, speaker_id: `fixture:${frequency}`,
      source_kind: 'speaker' as const, attribution_unknown: false};
    await receiver.attach(track, meetingId, attemptId, binding, sink);
    const duplicate = await receiver.attach(track, meetingId, attemptId, binding, sink);
    result.duplicates = duplicate ? 1 : 0;
    reattach.push(() => receiver.attach(track, meetingId, attemptId, binding, sink));
    results.push(result); oscillators.push(oscillator); tracks.push(track);
  }
  for (const oscillator of oscillators) oscillator.start();
  await producer.resume();
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  if (restart) {
    for (const track of tracks) await receiver.detach(track);
    for (const attach of reattach) if (!await attach()) throw new Error('Capture reattach failed');
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  }
  if (restart) await Promise.all([receiver.detach(tracks[0]), receiver.stop()]);
  else await receiver.stop();
  for (const oscillator of oscillators) oscillator.stop();
  for (const track of tracks) track.stop();
  await producer.close();
  for (const result of results) result.audio_clock = receiver.inspectClock();
  if (errors) throw new Error('Synthetic capture failed');
  return results;
};
