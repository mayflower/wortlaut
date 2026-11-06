import {isTeamsOrigin} from './teams-url.js';
import {AudioCapture, type AudioClock, type CaptureSink} from './capture.js';
import type {Chunk} from './chunks.js';
import resamplerSource from '@alexanderolsen/libsamplerate-js/dist/libsamplerate.worklet.js?raw';
import pcmSource from '../public/pcm-worklet.js?raw';
import encodedObserverSource from '../public/encoded-audio-observer.js?raw';

export type MeetCaptureConfig = {meeting_id: string; attempt_id: string; meeting_url: string;
  provider?: 'google_meet' | 'webex' | 'teams'; teams_origins?: string[]};
export type MeetBridgeMessage = {attempt_id: string; type: 'control' | 'chunk';
  metadata: Record<string, unknown>; pcm?: string};

declare global {
  interface Window {
    wortlautMeetConfig: MeetCaptureConfig;
    wortlautMeetBridge: (message: MeetBridgeMessage) => Promise<void>;
    wortlautMeetReceivers: {connections: Set<RTCPeerConnection>; received: WeakSet<RTCRtpReceiver>;
      encodedReserved: WeakSet<RTCPeerConnection>;
      observe?: (receiver: RTCRtpReceiver, pc: RTCPeerConnection) => void};
    wortlautMeet: {stop: () => Promise<boolean>; inspect: () => MeetCaptureState & {audio_clock: AudioClock}};
  }
}

type MeetCaptureState = {streams: number; audio_samples: number; reason: string;
  capture_ready: boolean; stopped: boolean; drained: boolean; receiver_sources: Record<string, unknown>[]};

type EncodedEvidence = {state: 'unsupported' | 'failed' | 'waiting_frames' | 'observing' |
  'metadata_unavailable' | 'provider_transform' | 'provider_reserved' | 'replaced' | 'stopped';
  frame_count: number; last_frame: Record<string, unknown> | null};
type EncodedObservation = {id: number; pc: RTCPeerConnection; transform?: RTCRtpScriptTransform;
  requestedAt?: number; evidence: EncodedEvidence};

// The small receiver hook runs before Meet; this bundle is loaded before join. It has no backend
// credentials, provider login cookies, API URL or direct backend connection.
const config = window.wortlautMeetConfig;
if (config.provider === 'webex'
  ? location.origin === 'https://web.webex.com' && location.pathname === '/meeting'
  : config.provider === 'teams' ? window === window.top && isTeamsOrigin(new URL(location.href))
  : window === window.top && location.origin === 'https://meet.google.com' &&
    location.pathname === new URL(config.meeting_url).pathname) install(config);

function install(config: MeetCaptureConfig) {
  const state: MeetCaptureState = {streams: 0, audio_samples: 0, reason: '', stopped: false,
    capture_ready: false, drained: false, receiver_sources: []};
  // The pinned modules travel in this local bundle. Blob URLs never resolve
  // to Google or a CDN and are subject to the page's actual CSP.
  const modules = [resamplerSource, pcmSource].map((source) =>
    URL.createObjectURL(new Blob([source], {type: 'application/javascript'})));
  const capture = new AudioCapture({resampler: modules[0], pcm: modules[1]});
  const {connections, received, encodedReserved} = window.wortlautMeetReceivers;
  const observations = new Map<RTCRtpReceiver, EncodedObservation>();
  let observer: Worker | undefined;
  let observerState: 'unsupported' | 'failed' | 'ready' = 'unsupported';
  let nextObservation = 0;
  function detachObservation(receiver: RTCRtpReceiver) {
    const entry = observations.get(receiver);
    // Provider replacement always wins, including during teardown.
    if (entry?.transform && receiver.transform === entry.transform) receiver.transform = null;
    if (entry && observerState === 'ready') observer?.postMessage({type: 'forget', id: entry.id});
    observations.delete(receiver);
  }
  function observe(receiver: RTCRtpReceiver, pc: RTCPeerConnection) {
    if (receiver.track.kind !== 'audio' || observations.has(receiver)) return;
    for (const [old, entry] of observations) {
      if (old.track.readyState === 'ended' || entry.pc.connectionState === 'closed') detachObservation(old);
    }
    if (observations.size >= 64) { state.reason = 'audio_source_limit'; return; }
    const entry: EncodedObservation = {
      id: ++nextObservation, pc,
      evidence: {state: observerState === 'ready' ? 'waiting_frames' : observerState,
        frame_count: 0, last_frame: null},
    };
    observations.set(receiver, entry);
    if (receiver.transform) entry.evidence.state = 'provider_transform';
    else if (encodedReserved.has(pc)) entry.evidence.state = 'provider_reserved';
    else if (observerState === 'ready' && observer) {
      try {
        entry.transform = new RTCRtpScriptTransform(observer, {id: entry.id});
        receiver.transform = entry.transform;
      } catch { entry.transform = undefined; entry.evidence.state = 'failed'; }
    }
  }
  async function initializeObserver() {
    if (typeof RTCRtpScriptTransform !== 'function' || !('transform' in RTCRtpReceiver.prototype)) return;
    const url = URL.createObjectURL(new Blob([encodedObserverSource], {type: 'application/javascript'}));
    try {
      observer = new Worker(url);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { observerState = 'failed'; observer?.terminate(); resolve(); }, 2000);
        observer!.onerror = (event) => {
          event.preventDefault(); observerState = 'failed'; clearTimeout(timer);
          for (const [receiver, entry] of observations) {
            if (entry.transform && receiver.transform === entry.transform) {
              receiver.transform = null; entry.evidence.state = 'failed';
              entry.transform = undefined; entry.requestedAt = undefined;
              state.reason = 'encoded_transform_failed';
            }
          }
          observer?.terminate(); resolve();
        };
        observer!.onmessage = ({data}) => {
          if (data.type === 'ready') {
            if (observerState !== 'failed') observerState = 'ready';
            clearTimeout(timer); resolve(); return;
          }
          for (const [receiver, entry] of observations) {
            if (entry.id !== data.id || receiver.transform !== entry.transform) continue;
            entry.requestedAt = undefined;
            if (data.type === 'snapshot') entry.evidence = data.evidence;
            else if (data.type === 'failed') {
              receiver.transform = null; entry.evidence.state = 'failed';
              entry.transform = undefined;
              state.reason = 'encoded_transform_failed';
            }
          }
        };
      });
    } catch { observerState = 'failed'; }
    finally { URL.revokeObjectURL(url); }
  }
  const initialized = new Promise<void>((resolve) => {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => resolve(), {once: true});
    else resolve();
  }).then(() => Promise.all([capture.initialize(), initializeObserver()]))
    .then(() => { window.wortlautMeetReceivers.observe = observe; state.capture_ready = true; })
    .catch(() => { state.reason = 'capture_modules_failed'; })
    .finally(() => { modules.forEach((url) => URL.revokeObjectURL(url)); });
  const sources = new Map<RTCRtpReceiver, {id: string; track?: MediaStreamTrack}>();
  let nextSource = 0;
  let pendingBytes = 0, pendingMessages = 0;
  let bridge: Promise<void> = Promise.resolve();
  let bridgeFailed = false;
  let inspecting: Promise<void> | undefined;
  let inspectAgain = false;
  let stopping: Promise<boolean> | undefined;

  function send(message: MeetBridgeMessage, bytes: number) {
    if (bridgeFailed) return;
    if (pendingMessages >= 64 || pendingBytes + bytes > 4 * 1024 * 1024) {
      bridgeFailed = true; state.reason = 'browser_bridge_limit'; return;
    }
    pendingMessages++; pendingBytes += bytes;
    bridge = bridge.then(async () => {
      if (bridgeFailed) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([window.wortlautMeetBridge(message), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Bridge deadline')), 5000);
        })]);
      } catch { bridgeFailed = true; state.reason = 'browser_bridge_failed'; }
      finally { clearTimeout(timer); }
    }).finally(() => { pendingBytes -= bytes; pendingMessages--; });
  }
  const control = (metadata: Record<string, unknown>) => {
    send({attempt_id: config.attempt_id, type: 'control', metadata}, JSON.stringify(metadata).length);
  };
  const sink: CaptureSink = {begin: control, end: control, gap: control,
    chunk: (metadata: Chunk, pcm: Uint8Array) => {
      // Five-second blocks, not one RPC per AudioWorklet render quantum.
      let raw = '';
      for (let offset = 0; offset < pcm.length; offset += 8192) {
        raw += String.fromCharCode(...pcm.subarray(offset, offset + 8192));
      }
      const encoded = btoa(raw);
      send({attempt_id: config.attempt_id, type: 'chunk', metadata, pcm: encoded}, encoded.length + 8192);
      state.audio_samples += metadata.sample_count;
    }, error: (reason) => { state.reason = reason; }};

  async function inspectReceivers() {
    if (stopping) return;
    inspectAgain = true;
    await (inspecting ??= (async () => {
      await initialized;
      if (state.reason) return;
      while (inspectAgain && !stopping) {
        inspectAgain = false;
        const live = new Set<RTCRtpReceiver>();
        for (const pc of connections) {
          if (pc.connectionState === 'closed') { connections.delete(pc); continue; }
          for (const receiver of pc.getReceivers()) {
            if (received.has(receiver) && receiver.track?.kind === 'audio' && receiver.track.readyState === 'live') {
              observe(receiver, pc); live.add(receiver);
            }
          }
        }
        if (live.size > 64) { state.reason = 'audio_source_limit'; return; }
        for (const [receiver, entry] of observations) {
          if (!live.has(receiver)) { detachObservation(receiver); continue; }
          if (!entry.transform) continue;
          if (receiver.transform !== entry.transform) {
            if (entry.evidence.state !== 'replaced') observer?.postMessage({type: 'forget', id: entry.id});
            entry.evidence.state = 'replaced'; continue;
          }
          if (entry.requestedAt !== undefined && performance.now() - entry.requestedAt > 5000) {
            receiver.transform = null; entry.transform = undefined;
            entry.evidence.state = 'failed'; state.reason = 'encoded_transform_failed';
            observer?.postMessage({type: 'forget', id: entry.id});
            continue;
          }
          if (entry.requestedAt === undefined && observerState === 'ready') {
            entry.requestedAt = performance.now(); observer?.postMessage({type: 'snapshot', id: entry.id});
          }
        }
        for (const [receiver, source] of sources) {
          if (!live.has(receiver) || receiver.track !== source.track) {
            if (source.track && ![...sources].some(([other, entry]) => other !== receiver &&
                live.has(other) && entry.track === source.track)) await capture.detach(source.track);
            if (!live.has(receiver)) sources.delete(receiver);
            else source.track = undefined;
          }
        }
        for (const receiver of live) {
          let source = sources.get(receiver);
          if (!source) {
            source = {id: `${config.provider ?? 'google_meet'}:${config.meeting_id}:receiver:${++nextSource}`};
            sources.set(receiver, source);
          }
          if (source.track === receiver.track || stopping) continue;
          source.track = receiver.track;
          // A receiver ID is diagnostic evidence only. No name, energy or tile
          // determines the participant, and accepted PCM is never renamed later.
          await capture.attach(receiver.track, config.meeting_id, config.attempt_id,
            {provider_source_id: source.id, source_kind: 'speaker', speaker_id: null,
              attribution_unknown: true}, sink);
        }
        state.streams = new Set([...sources.values()].map((source) => source.track)).size;
      }
    })().catch(() => { state.reason ||= 'capture_initialization_failed'; })
      .finally(() => { inspecting = undefined; }));
  }

  const interval = setInterval(() => { void inspectReceivers(); }, 500);
  const evidence = (receiver: RTCRtpReceiver, id: string) => {
    const source = (item: RTCRtpContributingSource) => ({source: item.source,
      timestamp: item.timestamp, rtp_timestamp: item.rtpTimestamp});
    return {provider_source_id: id, source_kind: 'speaker',
      capture_path: 'rtc_receiver',
      track_id: receiver.track.id, csi: null, signaled_participant_id: null,
      source_state: receiver.track.readyState,
      encoded_transform: observations.get(receiver)?.evidence,
      ssrc: receiver.getSynchronizationSources().slice(0, 64).map(source),
      csrc: receiver.getContributingSources().slice(0, 64).map(source)};
  };
  window.wortlautMeet = {
    inspect: () => {
      state.receiver_sources = [...sources].slice(0, 64).map(([receiver, source]) => evidence(receiver, source.id));
      return {...state, audio_clock: capture.inspectClock()};
    },
    stop: () => stopping ??= (async () => {
      clearInterval(interval);
      await initialized;
      await inspecting;
      await capture.stop();
      await bridge;
      window.wortlautMeetReceivers.observe = undefined;
      for (const [receiver, entry] of observations) {
        if (entry.transform && receiver.transform === entry.transform) {
          receiver.transform = null;
          if (entry.evidence.state !== 'failed') entry.evidence.state = 'stopped';
        }
      }
      observer?.terminate();
      state.drained = !bridgeFailed;
      state.stopped = true;
      return state.drained;
    })(),
  };
}
