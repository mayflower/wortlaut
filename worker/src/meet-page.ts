import {isTeamsOrigin} from './teams-url.js';
import {AudioCapture, type AudioClock, type CaptureSink} from './capture.js';
import type {Binding, Chunk} from './chunks.js';
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
      receiverStreams?: WeakMap<RTCRtpReceiver, string[]>;
      dataChannels?: Set<RTCDataChannel>;
      dataMessages?: unknown[];
      onDataMessage?: (data: unknown) => void;
      observe?: (receiver: RTCRtpReceiver, pc: RTCPeerConnection) => void};
    wortlautMeet: {stop: () => Promise<boolean>; inspect: () => MeetCaptureState & {audio_clock: AudioClock}};
  }
}

type ParticipantSourcesState = {
  available: boolean;
  total: number;
  truncated: boolean;
  sources: {participant_id: string; audio_csis: number[]; share_audio_csis: number[]}[];
};

type MeetCaptureState = {streams: number; audio_samples: number; reason: string;
  capture_ready: boolean; stopped: boolean; drained: boolean;
  receiver_sources: Record<string, unknown>[];
  participant_sources: ParticipantSourcesState};

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
    capture_ready: false, drained: false, receiver_sources: [],
    participant_sources: {available: false, total: 0, truncated: false, sources: []}};
  // The pinned modules travel in this local bundle. Blob URLs never resolve
  // to Google or a CDN and are subject to the page's actual CSP.
  const modules = [resamplerSource, pcmSource].map((source) =>
    URL.createObjectURL(new Blob([source], {type: 'application/javascript'})));
  const capture = new AudioCapture({resampler: modules[0], pcm: modules[1]});
  const {connections, received, encodedReserved, receiverStreams} = window.wortlautMeetReceivers;
  const participants = new Map<string, {
    participant_id: string; participant_name: string | null;
    audio_csis: Set<number>; share_audio_csis: Set<number>;
    track_ids: Set<string>; stream_ids: Set<string>;
  }>();
  let totalParticipants = 0;

  function validCsi(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
  }

  function ingestParticipantRecord(node: Record<string, unknown>) {
    const rawId = node.participant_id ?? node.participantId ?? node.endpointId;
    if (typeof rawId !== 'string' || !rawId.trim() || rawId.length > 200) return false;
    const id = rawId.trim();
    const audioRaw = [
      ...(Array.isArray(node.audio_csis) ? node.audio_csis : []),
      ...(Array.isArray(node.audioCsis) ? node.audioCsis : []),
      ...(Array.isArray(node.ssrcs) ? node.ssrcs : []),
      ...(Array.isArray(node.csrcs) ? node.csrcs : []),
      ...(validCsi(node.csi) ? [node.csi] : []),
      ...(validCsi(node.csrc) ? [node.csrc] : []),
      ...(validCsi(node.ssrc) ? [node.ssrc] : []),
    ].filter(validCsi);
    const shareRaw = [
      ...(Array.isArray(node.share_audio_csis) ? node.share_audio_csis : []),
      ...(Array.isArray(node.shareAudioCsis) ? node.shareAudioCsis : []),
      ...(Array.isArray(node.shareSsrcs) ? node.shareSsrcs : []),
    ].filter(validCsi);
    const trackRaw = [node.track_id, node.trackId, node.audioTrackId]
      .filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256);
    const streamRaw = [node.stream_id, node.streamId, node.msid]
      .filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256);
    if (!audioRaw.length && !shareRaw.length && !trackRaw.length && !streamRaw.length) return false;
    let entry = participants.get(id);
    if (!entry) {
      totalParticipants++;
      if (participants.size >= 256) return false;
      entry = {participant_id: id, participant_name: null,
        audio_csis: new Set(), share_audio_csis: new Set(),
        track_ids: new Set(), stream_ids: new Set()};
      participants.set(id, entry);
    }
    const rawName = node.participant_name ?? node.participantName ?? node.displayName;
    if (typeof rawName === 'string' && rawName.trim() && rawName.trim().length <= 200) {
      entry.participant_name = rawName.trim();
    }
    for (const csi of audioRaw) if (entry.audio_csis.size < 64) entry.audio_csis.add(csi);
    for (const csi of shareRaw) if (entry.share_audio_csis.size < 64) entry.share_audio_csis.add(csi);
    for (const tid of trackRaw) if (entry.track_ids.size < 64) entry.track_ids.add(tid);
    for (const sid of streamRaw) if (entry.stream_ids.size < 64) entry.stream_ids.add(sid);
    return true;
  }

  function onDataMessage(raw: unknown) {
    let text = '';
    if (typeof raw === 'string') text = raw;
    else if (raw instanceof ArrayBuffer && raw.byteLength <= 65536) text = new TextDecoder().decode(raw);
    else if (ArrayBuffer.isView(raw) && raw.byteLength <= 65536) text = new TextDecoder().decode(raw);
    text = text.trim();
    if (!text || text.length > 65536 || (text[0] !== '{' && text[0] !== '[')) return;
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return; }
    const queue: unknown[] = [parsed];
    let updated = false, visited = 0;
    while (queue.length && visited < 512) {
      const current = queue.shift();
      visited++;
      if (Array.isArray(current)) {
        for (const item of current.slice(0, 256)) queue.push(item);
      } else if (current && typeof current === 'object') {
        const record = current as Record<string, unknown>;
        if (ingestParticipantRecord(record)) updated = true;
        for (const key of ['participants', 'sources', 'roster', 'members', 'endpoints', 'data', 'payload']) {
          if (record[key] && typeof record[key] === 'object') queue.push(record[key]);
        }
      }
    }
    if (updated) void inspectReceivers();
  }
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
  const sink: CaptureSink = {begin: control, bind: control, end: control, gap: control,
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

  function resolveReceiver(receiver: RTCRtpReceiver): {
    csi: number | null; signaled_participant_id: string | null;
    participant_name: string | null; source_kind: 'speaker' | 'share_audio'; bound: boolean;
  } {
    if (!participants.size) {
      return {csi: null, signaled_participant_id: null, participant_name: null, source_kind: 'speaker', bound: false};
    }
    const lastFrame = observations.get(receiver)?.evidence.last_frame;
    const csrcs = [...new Set([
      ...receiver.getContributingSources().map((s) => s.source),
      ...(Array.isArray(lastFrame?.contributing_sources) ? (lastFrame.contributing_sources as number[]) : []),
    ].filter(validCsi))];
    const ssrcs = [...new Set([
      ...receiver.getSynchronizationSources().map((s) => s.source),
      ...(validCsi(lastFrame?.synchronization_source) ? [lastFrame.synchronization_source] : []),
    ].filter(validCsi))];

    const matchByCsi = (candidates: number[]) => {
      const hits: {id: string; name: string | null; kind: 'speaker' | 'share_audio'; csi: number}[] = [];
      for (const csi of candidates) {
        for (const p of participants.values()) {
          if (p.audio_csis.has(csi)) hits.push({id: p.participant_id, name: p.participant_name, kind: 'speaker', csi});
          if (p.share_audio_csis.has(csi)) hits.push({id: p.participant_id, name: p.participant_name, kind: 'share_audio', csi});
        }
      }
      if (!hits.length) return null;
      const first = hits[0];
      if (hits.every((h) => h.id === first.id && h.kind === first.kind)) return first;
      return 'ambiguous' as const;
    };

    if (csrcs.length > 0) {
      const csrcMatch = matchByCsi(csrcs);
      if (csrcMatch === 'ambiguous') {
        return {csi: null, signaled_participant_id: null, participant_name: null, source_kind: 'speaker', bound: false};
      }
      if (csrcMatch) {
        return {csi: csrcMatch.csi, signaled_participant_id: csrcMatch.id,
          participant_name: csrcMatch.name, source_kind: csrcMatch.kind, bound: true};
      }
      if (csrcs.length > 1) {
        return {csi: null, signaled_participant_id: null, participant_name: null, source_kind: 'speaker', bound: false};
      }
    }
    if (ssrcs.length > 0) {
      const ssrcMatch = matchByCsi(ssrcs);
      if (ssrcMatch === 'ambiguous') {
        return {csi: null, signaled_participant_id: null, participant_name: null, source_kind: 'speaker', bound: false};
      }
      if (ssrcMatch) {
        return {csi: ssrcMatch.csi, signaled_participant_id: ssrcMatch.id,
          participant_name: ssrcMatch.name, source_kind: ssrcMatch.kind, bound: true};
      }
    }
    const streamIds = receiverStreams?.get(receiver) ?? [];
    const trackMatches = [...participants.values()].filter((p) =>
      p.track_ids.has(receiver.track.id) || streamIds.some((sid) => p.stream_ids.has(sid)));
    if (trackMatches.length === 1) {
      const p = trackMatches[0];
      const firstCsi = [...p.audio_csis][0] ?? null;
      return {csi: firstCsi, signaled_participant_id: p.participant_id,
        participant_name: p.participant_name, source_kind: 'speaker', bound: true};
    }
    return {csi: null, signaled_participant_id: null, participant_name: null, source_kind: 'speaker', bound: false};
  }

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
          if (stopping) continue;
          const match = resolveReceiver(receiver);
          const binding: Binding = match.bound && match.signaled_participant_id ? {
            provider_source_id: source.id,
            source_kind: match.source_kind,
            speaker_id: match.source_kind === 'speaker' ? match.signaled_participant_id : null,
            attribution_unknown: false,
            participant_id: match.signaled_participant_id,
            ...(match.participant_name ? {participant_name: match.participant_name} : {}),
          } : {
            provider_source_id: source.id,
            source_kind: 'speaker',
            speaker_id: null,
            attribution_unknown: true,
          };
          if (source.track !== receiver.track) {
            source.track = receiver.track;
            await capture.attach(receiver.track, config.meeting_id, config.attempt_id, binding, sink);
          } else {
            await capture.rebind(receiver.track, binding);
          }
        }
        state.streams = new Set([...sources.values()].map((source) => source.track)).size;
      }
    })().catch(() => { state.reason ||= 'capture_initialization_failed'; })
      .finally(() => { inspecting = undefined; }));
  }

  for (const queued of window.wortlautMeetReceivers.dataMessages?.splice(0) ?? []) onDataMessage(queued);
  window.wortlautMeetReceivers.onDataMessage = onDataMessage;
  const interval = setInterval(() => { void inspectReceivers(); }, 500);
  const evidence = (receiver: RTCRtpReceiver, id: string) => {
    const source = (item: RTCRtpContributingSource) => ({source: item.source,
      timestamp: item.timestamp, rtp_timestamp: item.rtpTimestamp});
    const match = resolveReceiver(receiver);
    return {provider_source_id: id, source_kind: match.source_kind,
      capture_path: 'rtc_receiver',
      track_id: receiver.track.id, csi: match.csi, signaled_participant_id: match.signaled_participant_id,
      source_state: receiver.track.readyState,
      encoded_transform: observations.get(receiver)?.evidence,
      ssrc: receiver.getSynchronizationSources().slice(0, 64).map(source),
      csrc: receiver.getContributingSources().slice(0, 64).map(source)};
  };
  window.wortlautMeet = {
    inspect: () => {
      state.receiver_sources = [...sources].slice(0, 64).map(([receiver, source]) => evidence(receiver, source.id));
      state.participant_sources = {
        available: participants.size > 0,
        total: totalParticipants,
        truncated: totalParticipants > 256,
        sources: [...participants.values()].slice(0, 256).map((p) => ({
          participant_id: p.participant_id,
          audio_csis: [...p.audio_csis].slice(0, 64),
          share_audio_csis: [...p.share_audio_csis].slice(0, 64),
        })),
      };
      return {...state, audio_clock: capture.inspectClock()};
    },
    stop: () => stopping ??= (async () => {
      clearInterval(interval);
      await initialized;
      await inspecting;
      await capture.stop();
      await bridge;
      window.wortlautMeetReceivers.observe = undefined;
      window.wortlautMeetReceivers.onDataMessage = undefined;
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
