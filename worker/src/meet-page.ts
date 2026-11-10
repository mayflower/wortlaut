import {isTeamsOrigin} from './teams-url.js';
import {isZoomOrigin} from './zoom-url.js';
import {AudioCapture, type AudioClock, type CaptureSink} from './capture.js';
import type {Binding, Chunk} from './chunks.js';
import resamplerSource from '@alexanderolsen/libsamplerate-js/dist/libsamplerate.worklet.js?raw';
import pcmSource from '../public/pcm-worklet.js?raw';
import encodedObserverSource from '../public/encoded-audio-observer.js?raw';

export type MeetCaptureConfig = {meeting_id: string; attempt_id: string; meeting_url: string;
  provider?: 'google_meet' | 'webex' | 'teams' | 'zoom'; teams_origins?: string[]};
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
      dataSends?: {channel: RTCDataChannel; data: unknown}[];
      onDataMessage?: (data: unknown) => void;
      transformDataSend?: (channel: RTCDataChannel, data: unknown) => unknown;
      remoteDescriptions?: string[];
      onRemoteDescription?: (sdp: string) => void;
      observe?: (receiver: RTCRtpReceiver, pc: RTCPeerConnection) => void};
    wortlautMeet: {stop: () => Promise<boolean>; inspect: () => MeetCaptureState & {audio_clock: AudioClock}};
  }
}

type ParticipantSourcesState = {
  available: boolean;
  total: number;
  truncated: boolean;
  dom_participants?: number;
  sources: {participant_id: string; participant_name?: string | null; audio_csis: number[]; share_audio_csis: number[]}[];
};

type DataChannelState = {
  label: string;
  ready_state: string;
  text_frames: number;
  binary_frames: number;
  json_frames: number;
  json_keys: string[];
  wire_formats: string[];
  protobuf_fields: string[];
};

type SdpState = {
  descriptions: number;
  audio_sections: number;
  video_sections: number;
  ssrc_count: number;
  cname_count: number;
  msid_count: number;
};

type MeetCaptureState = {streams: number; audio_samples: number; active_audio_samples: number;
  reason: string; capture_ready: boolean; stopped: boolean; drained: boolean;
  receiver_sources: Record<string, unknown>[];
  participant_sources: ParticipantSourcesState;
  data_channels: DataChannelState[];
  sdp: SdpState};

type EncodedEvidence = {state: 'unsupported' | 'failed' | 'waiting_frames' | 'observing' |
  'metadata_unavailable' | 'provider_transform' | 'provider_reserved' | 'replaced' | 'stopped';
  frame_count: number; last_frame: Record<string, unknown> | null};
type EncodedObservation = {id: number; pc: RTCPeerConnection; transform?: RTCRtpScriptTransform;
  requestedAt?: number; evidence: EncodedEvidence};

// The small receiver hook runs before Meet; this bundle is loaded before join. It has no backend
// credentials, provider login cookies, API URL or direct backend connection.
const config = window.wortlautMeetConfig;
if (config.provider === 'webex'
  ? location.origin === 'https://web.webex.com' && /^\/(?:meeting|guest-join-meeting)$/.test(location.pathname) &&
    !location.search.includes('preload=true')
  : config.provider === 'teams' ? window === window.top && isTeamsOrigin(new URL(location.href))
  : config.provider === 'zoom' ? window === window.top && isZoomOrigin(new URL(location.href))
  : window === window.top && location.origin === 'https://meet.google.com' &&
    location.pathname.replace(/^\/meet\//, '/') === new URL(config.meeting_url).pathname.replace(/^\/meet\//, '/')) install(config);

function install(config: MeetCaptureConfig) {
  const state: MeetCaptureState = {streams: 0, audio_samples: 0, active_audio_samples: 0,
    reason: '', stopped: false, capture_ready: false, drained: false, receiver_sources: [],
    participant_sources: {available: false, total: 0, truncated: false, sources: []},
    data_channels: [],
    sdp: {descriptions: 0, audio_sections: 0, video_sections: 0, ssrc_count: 0, cname_count: 0, msid_count: 0}};
  let trustedPolicy: {createScriptURL: (url: string) => unknown} | undefined;
  function toWorkerScriptUrl(url: string): string {
    const tt = (window as unknown as {
      trustedTypes?: {
        createPolicy?: (
          name: string,
          rules: {createScriptURL: (s: string) => string},
        ) => {createScriptURL: (s: string) => unknown};
      };
    }).trustedTypes;
    if (!tt?.createPolicy) return url;
    if (!trustedPolicy) {
      for (const name of [
        '@msstream/azuremediaplayer#worker-noop',
        '@msstream/azuremediaplayer#noop',
        'dompurify',
        'default',
      ]) {
        try {
          trustedPolicy = tt.createPolicy(name, {createScriptURL: (s: string) => s});
          break;
        } catch {
          // try next allowed policy name
        }
      }
    }
    return (trustedPolicy ? trustedPolicy.createScriptURL(url) : url) as string;
  }

  // The pinned modules travel in this local bundle. Blob URLs never resolve
  // to Google or a CDN and are subject to the page's actual CSP.
  const modules = [resamplerSource, pcmSource].map((source) =>
    URL.createObjectURL(new Blob([source], {type: 'application/javascript'})));
  const capture = new AudioCapture({
    resampler: modules[0],
    pcm: modules[1],
    createWorker: (sampleRate: number) => {
      const patchedResampler = resamplerSource
        .replace('"AudioWorkletGlobalScope"===globalThis.constructor.name', 'true')
        .replace(/export\{[^}]+\};?\s*$/, '');
      const shim = `
        globalThis.sampleRate = ${Number(sampleRate) || 48000};
        globalThis.currentFrame = 0;
        let instance = null;
        globalThis.AudioWorkletProcessor = class {
          constructor() {
            this.port = {
              postMessage: (msg, transfer) => self.postMessage(msg, transfer || []),
              onmessage: null,
            };
          }
        };
        globalThis.registerProcessor = (_name, cls) => { instance = new cls(); };
        self.onmessage = (event) => {
          const data = event.data;
          if (data && data.type === '__process') {
            const ch = data.samples;
            const len = ch ? ch.length : 128;
            if (typeof data.currentFrame === 'number') globalThis.currentFrame = data.currentFrame;
            instance?.process(ch ? [[ch]] : [[]], [[new Float32Array(len)]], {capturing: [data.capturing]});
            globalThis.currentFrame += len;
            return;
          }
          instance?.port?.onmessage?.(event);
        };
      `;
      const blobUrl = URL.createObjectURL(
        new Blob([shim, '\n', patchedResampler, '\n', pcmSource], {type: 'application/javascript'}),
      );
      setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
      return new Worker(toWorkerScriptUrl(blobUrl));
    },
  });
  const {connections, received, encodedReserved, receiverStreams} = window.wortlautMeetReceivers;
  const participants = new Map<string, {
    participant_id: string; participant_name: string | null;
    audio_csis: Set<number>; share_audio_csis: Set<number>;
    track_ids: Set<string>; stream_ids: Set<string>;
  }>();
  const domNames = new Map<string, string>();
  const ignoredParticipantIds = new Set<string>();
  let liveDomCount = 0;
  const NOTETAKER_BOT_RE =
    /\b(fireflies(\.ai)?|otter(\.ai)?|read\.ai|fathom|tl;dv|tldv|meetgeek|fellow(\.app)?|avoma|sembly|supernormal|grain|krisp|tactiq|airgram|notta|nyota|circleback|sonnet|bluedot|granola|notetaker|note[\s-]*taker|meeting[\s-]*bot|ai[\s-]*notetaker|ai[\s-]*assistant)\b/i;
  const SELF_OR_UI_TEXT_RE =
    /^(wortlaut(?:\b.*)?|you|sie|ich)$/i;
  const UI_CHROME_TEXT_RE =
    /(vollständigen videofeed|full video|bildausschnitt|reframing)/i;

  function isIgnoredParticipantName(name: string | null | undefined): boolean {
    if (!name) return false;
    const trimmed = name.trim();
    if (!trimmed) return false;
    return (
      NOTETAKER_BOT_RE.test(trimmed) ||
      SELF_OR_UI_TEXT_RE.test(trimmed) ||
      UI_CHROME_TEXT_RE.test(trimmed)
    );
  }
  const sdpCnames = new Map<string, {
    audio_ssrcs: Set<number>; video_ssrcs: Set<number>;
    stream_ids: Set<string>; track_ids: Set<string>;
  }>();
  const sdpStats = {
    descriptions: 0, audio_sections: 0, video_sections: 0,
    ssrcs: new Set<number>(), cnames: new Set<string>(), msids: new Set<string>(),
  };
  let totalParticipants = 0;

  function validCsi(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
  }

  let webexSelfParticipantId: string | null = null;
  const webexSelfCsis = new Set<number>();
  const webexParticipantOwnedCsis = new Map<string, Set<number>>();
  const webexParticipantDeviceCsis = new Map<string, Set<number>>();
  const webexSsrcToParticipant = new Map<number, string>();
  let webexCurrentActiveSpeakerCsis: number[] = [];
  let webexLastActiveSpeakerAt = 0;

  function findWebexParticipantByCsi(csi: number): string | null {
    for (const [pid, set] of webexParticipantOwnedCsis) {
      if (set.has(csi)) return pid;
    }
    const masked = (csi & 0xfffffffe) >>> 0;
    for (const [pid, set] of webexParticipantOwnedCsis) {
      for (const pCsi of set) {
        if (((pCsi & 0xfffffffe) >>> 0) === masked) return pid;
      }
    }
    for (const [pid, set] of webexParticipantDeviceCsis) {
      if (set.has(csi)) return pid;
      for (const pCsi of set) {
        if (((pCsi & 0xfffffffe) >>> 0) === masked) return pid;
      }
    }
    return null;
  }

  function ingestWebexSelf(selfNode: Record<string, unknown>) {
    if (typeof selfNode.id === 'string' && selfNode.id.trim()) {
      webexSelfParticipantId = selfNode.id.trim();
      participants.delete(webexSelfParticipantId);
      webexParticipantOwnedCsis.delete(webexSelfParticipantId);
      webexParticipantDeviceCsis.delete(webexSelfParticipantId);
    }
    const status = selfNode.status && typeof selfNode.status === 'object'
      ? (selfNode.status as Record<string, unknown>) : undefined;
    if (Array.isArray(status?.csis)) {
      for (const c of status.csis) if (validCsi(c)) webexSelfCsis.add(c);
    }
    if (Array.isArray(selfNode.devices)) {
      for (const dev of selfNode.devices.slice(0, 16)) {
        if (!dev || typeof dev !== 'object') continue;
        const devRec = dev as Record<string, unknown>;
        if (Array.isArray(devRec.csis)) {
          for (const c of devRec.csis) if (validCsi(c)) webexSelfCsis.add(c);
        }
        if (Array.isArray(devRec.mediaSessions)) {
          for (const ms of devRec.mediaSessions.slice(0, 16)) {
            if (ms && typeof ms !== 'object' && validCsi((ms as Record<string, unknown>).csi)) {
              webexSelfCsis.add((ms as Record<string, unknown>).csi as number);
            }
          }
        }
      }
    }
  }

  function updateWebexActiveSpeakerBindings(): boolean {
    if (config.provider !== 'webex') return false;
    let changed = false;
    for (const [ssrc, pid] of webexSsrcToParticipant) {
      if (!participants.has(pid) || pid === webexSelfParticipantId) {
        webexSsrcToParticipant.delete(ssrc);
        changed = true;
      }
    }
    const activePids: string[] = [];
    if (webexCurrentActiveSpeakerCsis.length > 0 && performance.now() - webexLastActiveSpeakerAt <= 3000) {
      for (const csi of webexCurrentActiveSpeakerCsis) {
        const pid = findWebexParticipantByCsi(csi);
        if (pid && pid !== webexSelfParticipantId && !activePids.includes(pid)) {
          activePids.push(pid);
        }
      }
    }
    if (activePids.length > 0) {
      const shareCsis = new Set<number>();
      for (const p of participants.values()) {
        for (const sc of p.share_audio_csis) shareCsis.add(sc);
      }
      const candidates: {ssrc: number; ts: number}[] = [];
      let maxTs = -Infinity;
      for (const pc of connections) {
        if (pc.connectionState === 'closed') continue;
        for (const receiver of pc.getReceivers()) {
          if (!received.has(receiver) || receiver.track?.kind !== 'audio' || receiver.track.readyState !== 'live') {
            continue;
          }
          for (const item of receiver.getSynchronizationSources()) {
            if (!validCsi(item.source) || shareCsis.has(item.source)) continue;
            const ts = typeof item.timestamp === 'number' && Number.isFinite(item.timestamp) ? item.timestamp : 0;
            if (ts > maxTs) maxTs = ts;
            candidates.push({ssrc: item.source, ts});
          }
        }
      }
      const liveSsrcs = [...new Set(
        candidates
          .filter((c) => !Number.isFinite(maxTs) || maxTs <= 0 || maxTs - c.ts <= 600)
          .map((c) => c.ssrc),
      )];
      if (liveSsrcs.length === 1 && activePids.length >= 1) {
        const ssrc = liveSsrcs[0];
        const pid = activePids[0];
        if (webexSsrcToParticipant.get(ssrc) !== pid) {
          webexSsrcToParticipant.set(ssrc, pid);
          changed = true;
        }
      } else if (liveSsrcs.length > 1) {
        const usedPids = new Set<string>();
        for (const ssrc of liveSsrcs) {
          const cur = webexSsrcToParticipant.get(ssrc);
          if (cur && activePids.includes(cur) && !usedPids.has(cur)) {
            usedPids.add(cur);
          }
        }
        for (const ssrc of liveSsrcs) {
          const cur = webexSsrcToParticipant.get(ssrc);
          if (cur && activePids.includes(cur) && usedPids.has(cur)) continue;
          const nextPid = activePids.find((p) => !usedPids.has(p)) ?? activePids[0];
          if (nextPid && webexSsrcToParticipant.get(ssrc) !== nextPid) {
            webexSsrcToParticipant.set(ssrc, nextPid);
            usedPids.add(nextPid);
            changed = true;
          }
        }
      }
    }
    for (const [ssrc, ownerId] of webexSsrcToParticipant) {
      for (const [pid, entry] of participants) {
        if (pid === ownerId) {
          if (entry.audio_csis.size < 64 && !entry.audio_csis.has(ssrc)) {
            entry.audio_csis.add(ssrc);
            changed = true;
          }
        } else if (entry.audio_csis.delete(ssrc)) {
          changed = true;
        }
      }
    }
    return changed;
  }

  function ingestParticipantRecord(node: Record<string, unknown>) {
    const details = node.details && typeof node.details === 'object'
      ? (node.details as Record<string, unknown>) : undefined;
    const person = node.person && typeof node.person === 'object'
      ? (node.person as Record<string, unknown>) : undefined;
    const isWebexParticipant = config.provider === 'webex' && Boolean(
      person || Array.isArray(node.devices) ||
      (typeof node.url === 'string' && node.url.includes('/locus/'))
    );
    const isZoomParticipant = config.provider === 'zoom' && Boolean(
      node.userId !== undefined || node.user_id !== undefined ||
      node.userName !== undefined || node.user_name !== undefined ||
      node.audioSsrc !== undefined
    );
    const rawIdCandidate = node.participant_id ?? node.participantId ?? node.endpointId ?? details?.id ??
      (isWebexParticipant ? node.id : undefined) ??
      (isZoomParticipant ? (node.userId ?? node.user_id ?? node.id) : undefined);
    const rawId = typeof rawIdCandidate === 'number' && Number.isFinite(rawIdCandidate) && isZoomParticipant
      ? String(rawIdCandidate)
      : rawIdCandidate;
    if (typeof rawId !== 'string' || !rawId.trim() || rawId.length > 200) return false;
    const id = rawId.trim();
    if (isWebexParticipant && id === webexSelfParticipantId) return false;
    if (ignoredParticipantIds.has(id)) return false;
    const rawName = node.participant_name ?? node.participantName ?? node.displayName ??
      node.userName ?? node.user_name ??
      details?.displayName ?? person?.name ?? person?.displayName ?? person?.primaryDisplayString ??
      domNames.get(id);
    const cleanedName = typeof rawName === 'string' && rawName.trim() && rawName.trim().length <= 200
      ? rawName.trim() : null;
    if (isIgnoredParticipantName(cleanedName)) {
      ignoredParticipantIds.add(id);
      domNames.delete(id);
      if (participants.delete(id)) {
        totalParticipants = Math.max(0, totalParticipants - 1);
      }
      return false;
    }
    if (cleanedName && (domNames.size < 256 || domNames.has(id))) {
      domNames.set(id, cleanedName);
    }
    const teamsAudioCsis: number[] = [];
    const teamsShareCsis: number[] = [];
    if (node.endpoints && typeof node.endpoints === 'object') {
      for (const ep of Object.values(node.endpoints as Record<string, unknown>).slice(0, 16)) {
        if (!ep || typeof ep !== 'object') continue;
        const epRec = ep as Record<string, unknown>;
        const mod = epRec.call;
        if (!mod || typeof mod !== 'object') continue;
        const streams = (mod as Record<string, unknown>).mediaStreams;
        if (!Array.isArray(streams)) continue;
        for (const ms of streams.slice(0, 16)) {
          if (!ms || typeof ms !== 'object') continue;
          const msRec = ms as Record<string, unknown>;
          const sid = typeof msRec.sourceId === 'string' && /^\d+$/.test(msRec.sourceId)
            ? Number(msRec.sourceId) : msRec.sourceId;
          if (!validCsi(sid)) continue;
          if (msRec.type === 'audio') teamsAudioCsis.push(sid);
          else if (msRec.type === 'applicationsharing-audio' || msRec.type === 'sharing-audio') {
            teamsShareCsis.push(sid);
          }
        }
      }
    }
    const webexAudioCsis: number[] = [];
    const webexShareCsis: number[] = [];
    const webexDeviceFallbackCsis: number[] = [];
    if (isWebexParticipant) {
      if (node.state === 'LEFT' || node.state === 'REMOVED') {
        webexParticipantOwnedCsis.delete(id);
        webexParticipantDeviceCsis.delete(id);
        updateWebexActiveSpeakerBindings();
      }
      const status = node.status && typeof node.status === 'object'
        ? (node.status as Record<string, unknown>) : undefined;
      if (Array.isArray(status?.csis)) {
        for (const c of status.csis) {
          if (validCsi(c) && !webexSelfCsis.has(c)) webexDeviceFallbackCsis.push(c);
        }
      }
      if (Array.isArray(node.devices)) {
        for (const dev of node.devices.slice(0, 16)) {
          if (!dev || typeof dev !== 'object') continue;
          const devRec = dev as Record<string, unknown>;
          if (Array.isArray(devRec.csis)) {
            for (const c of devRec.csis) {
              if (validCsi(c) && !webexSelfCsis.has(c)) webexDeviceFallbackCsis.push(c);
            }
          }
          if (!Array.isArray(devRec.mediaSessions)) continue;
          for (const ms of devRec.mediaSessions.slice(0, 16)) {
            if (!ms || typeof ms !== 'object') continue;
            const msRec = ms as Record<string, unknown>;
            const csi = msRec.csi;
            if (!validCsi(csi)) continue;
            if (msRec.mediaType === 'audio') {
              if (msRec.mediaContent === 'slides') {
                webexShareCsis.push(csi);
              } else {
                webexAudioCsis.push(csi);
              }
            }
          }
        }
      }
      if (node.state !== 'LEFT' && node.state !== 'REMOVED') {
        if (webexAudioCsis.length || webexShareCsis.length) {
          let owned = webexParticipantOwnedCsis.get(id);
          if (!owned && webexParticipantOwnedCsis.size < 256) {
            owned = new Set<number>();
            webexParticipantOwnedCsis.set(id, owned);
          }
          if (owned) {
            for (const c of webexAudioCsis) if (owned.size < 64) owned.add(c);
            for (const c of webexShareCsis) if (owned.size < 64) owned.add(c);
          }
        }
        if (webexDeviceFallbackCsis.length) {
          let devSet = webexParticipantDeviceCsis.get(id);
          if (!devSet && webexParticipantDeviceCsis.size < 256) {
            devSet = new Set<number>();
            webexParticipantDeviceCsis.set(id, devSet);
          }
          if (devSet) {
            for (const c of webexDeviceFallbackCsis) if (devSet.size < 64) devSet.add(c);
          }
        }
      }
    }
    const audioRaw = [
      ...(Array.isArray(node.audio_csis) ? node.audio_csis : []),
      ...(Array.isArray(node.audioCsis) ? node.audioCsis : []),
      ...(Array.isArray(node.ssrcs) ? node.ssrcs : []),
      ...(Array.isArray(node.csrcs) ? node.csrcs : []),
      ...teamsAudioCsis,
      ...webexAudioCsis,
      ...(validCsi(node.csi) ? [node.csi] : []),
      ...(validCsi(node.csrc) ? [node.csrc] : []),
      ...(validCsi(node.ssrc) ? [node.ssrc] : []),
      ...(validCsi(node.audioSsrc) ? [node.audioSsrc] : []),
      ...(validCsi(node.audio_ssrc) ? [node.audio_ssrc] : []),
    ].filter(validCsi);
    const shareRaw = [
      ...(Array.isArray(node.share_audio_csis) ? node.share_audio_csis : []),
      ...(Array.isArray(node.shareAudioCsis) ? node.shareAudioCsis : []),
      ...(Array.isArray(node.shareSsrcs) ? node.shareSsrcs : []),
      ...(validCsi(node.shareSsrc) ? [node.shareSsrc] : []),
      ...(validCsi(node.share_ssrc) ? [node.share_ssrc] : []),
      ...teamsShareCsis,
      ...webexShareCsis,
    ].filter(validCsi);
    const trackRaw = [
      node.track_id, node.trackId, node.audioTrackId,
      ...(Array.isArray(node.track_ids) ? node.track_ids : []),
    ].filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256);
    const streamRaw = [
      node.stream_id, node.streamId, node.msid,
      ...(Array.isArray(node.stream_ids) ? node.stream_ids : []),
    ].filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256);
    let entry = participants.get(id);
    if (!audioRaw.length && !shareRaw.length && !trackRaw.length && !streamRaw.length) {
      if (entry && cleanedName && entry.participant_name !== cleanedName) {
        entry.participant_name = cleanedName;
        return true;
      }
      return false;
    }
    let changed = false;
    if (!entry) {
      totalParticipants++;
      if (participants.size >= 256) return false;
      entry = {participant_id: id, participant_name: null,
        audio_csis: new Set(), share_audio_csis: new Set(),
        track_ids: new Set(), stream_ids: new Set()};
      participants.set(id, entry);
      changed = true;
    }
    if (cleanedName && entry.participant_name !== cleanedName) {
      entry.participant_name = cleanedName;
      changed = true;
    }
    for (const csi of audioRaw) {
      if (entry.audio_csis.size < 64 && !entry.audio_csis.has(csi)) {
        entry.audio_csis.add(csi); changed = true;
      }
    }
    for (const csi of shareRaw) {
      if (entry.share_audio_csis.size < 64 && !entry.share_audio_csis.has(csi)) {
        entry.share_audio_csis.add(csi); changed = true;
      }
    }
    for (const tid of trackRaw) {
      if (entry.track_ids.size < 64 && !entry.track_ids.has(tid)) {
        entry.track_ids.add(tid); changed = true;
      }
    }
    for (const sid of streamRaw) {
      if (entry.stream_ids.size < 64 && !entry.stream_ids.has(sid)) {
        entry.stream_ids.add(sid); changed = true;
      }
    }
    return changed;
  }

  function extractDomParticipantName(el: Element): string | null {
    for (const attr of ['data-participant-name', 'data-self-name', 'data-display-name']) {
      const val = el.getAttribute(attr)?.trim();
      if (val && val.length <= 200 && val !== 'fixture') return val;
    }
    if (el.getAttribute('role') === 'listitem') {
      const aria = el.getAttribute('aria-label')?.trim();
      if (aria && aria.length >= 2 && aria.length <= 120 && aria !== 'fixture') return aria;
    }
    if (el.hasAttribute('data-participants-row') || el.classList.contains('participants-li')) {
      const displayNameEl = el.querySelector('.participants-item__display-name');
      const rawDisplay = (displayNameEl?.textContent || el.getAttribute('aria-label')?.split(',')[0] || '').trim();
      const cleaned = rawDisplay.replace(/\s*\((?:Host|Co-host|Gastgeber|Co-Gastgeber|Me|Ich)\)\s*$/i, '').trim();
      if (cleaned && cleaned.length >= 2 && cleaned.length <= 120 && cleaned !== 'fixture') return cleaned;
    }
    const sub = el.querySelector(
      '[data-participant-name], [data-self-name], [data-display-name], ' +
      '[data-tid="roster-person-name"], [data-tid="video-tile-name"], ' +
      '.participants-item__display-name, ' +
      '[class*="participant-name"], [class*="participantName"], [class*="displayName"], [class*="nameplate"]'
    );
    if (sub) {
      const attrVal = (sub.getAttribute('data-participant-name') ||
        sub.getAttribute('data-self-name') ||
        sub.getAttribute('data-display-name') ||
        sub.textContent || '').trim();
      if (attrVal && attrVal.length <= 200 && attrVal !== 'fixture') return attrVal;
    }
    for (const child of Array.from(el.querySelectorAll('span, div, p')).slice(0, 64)) {
      if (child.children.length > 0 || child.closest('button') || child.closest('[aria-hidden="true"]')) continue;
      const cls = child.className || '';
      if (typeof cls === 'string' && /material-icons|google-symbols/i.test(cls)) continue;
      const txt = (child.textContent || '').trim();
      if (txt && txt.length >= 2 && txt.length <= 120 && txt !== 'fixture' &&
          !UI_CHROME_TEXT_RE.test(txt) &&
          !/^\d{1,2}:\d{2}(?::\d{2})?$/.test(txt) &&
          !/^(devices|mic|mic_off|more_vert|keep|push_pin|frame_person|visual_effects|volume_up|volume_off)$/i.test(txt)) {
        return txt;
      }
    }
    return null;
  }

  function parseAttrCsi(raw: string | null): number | null {
    if (!raw || !/^\d+$/.test(raw.trim())) return null;
    const num = Number(raw.trim());
    return validCsi(num) ? num : null;
  }

  function scanDomParticipants(): boolean {
    if (!document.body) return false;
    let updated = false;
    const seenLiveDom = new Set<string>();
    const nodes = document.querySelectorAll(
      '[data-participant-id], [data-requested-participant-id], [data-member-id], ' +
      '[data-endpoint-id], [data-user-id], [data-tid*="roster"], [data-tid*="video-tile"], ' +
      '[role="listitem"][data-participant-id], [role="listitem"][data-member-id], ' +
      '.participants-li[data-participants-row]'
    );
    for (const el of Array.from(nodes).slice(0, 256)) {
      const rawId = (
        el.getAttribute('data-participant-id') ??
        el.getAttribute('data-requested-participant-id') ??
        el.getAttribute('data-member-id') ??
        el.getAttribute('data-endpoint-id') ??
        el.getAttribute('data-user-id') ?? ''
      ).trim();
      const zoomRowLabel = el.hasAttribute('data-participants-row')
        ? (el.getAttribute('aria-label') || el.textContent || '')
        : '';
      const isSelfTile = el.hasAttribute('data-self-name') ||
        Boolean(el.querySelector('[data-self-name]')) ||
        /\((?:Me|Ich)\)/i.test(zoomRowLabel);
      const name = extractDomParticipantName(el);
      if (isSelfTile || isIgnoredParticipantName(name)) {
        if (rawId) {
          ignoredParticipantIds.add(rawId);
          domNames.delete(rawId);
          if (participants.delete(rawId)) {
            totalParticipants = Math.max(0, totalParticipants - 1);
            updated = true;
          }
        }
        continue;
      }
      if (rawId && ignoredParticipantIds.has(rawId)) continue;
      if (rawId && rawId.length <= 200 && name) {
        seenLiveDom.add(rawId);
        if (domNames.size < 256 || domNames.has(rawId)) domNames.set(rawId, name);
        const existing = participants.get(rawId);
        if (existing && existing.participant_name !== name) {
          existing.participant_name = name;
          updated = true;
        }
      } else if (rawId && domNames.has(rawId)) {
        seenLiveDom.add(rawId);
      } else if (!rawId && name) {
        seenLiveDom.add(`name:${name}`);
      }
      const csis: number[] = [];
      const streamIds: string[] = [];
      const trackIds: string[] = [];
      for (const node of [el, ...Array.from(el.querySelectorAll('[data-ssrc], [data-csi], [data-csrc], [data-stream-id], [data-msid], [data-track-id], [data-audio-track-id]')).slice(0, 16)]) {
        for (const attr of ['data-ssrc', 'data-csi', 'data-csrc']) {
          const parsed = parseAttrCsi(node.getAttribute(attr));
          if (parsed !== null) csis.push(parsed);
        }
        for (const attr of ['data-stream-id', 'data-msid']) {
          const val = node.getAttribute(attr)?.trim();
          if (val && val.length <= 256) streamIds.push(val);
        }
        for (const attr of ['data-track-id', 'data-audio-track-id']) {
          const val = node.getAttribute(attr)?.trim();
          if (val && val.length <= 256) trackIds.push(val);
        }
      }
      for (const media of Array.from(el.querySelectorAll('audio, video')).slice(0, 8)) {
        const src = (media as HTMLMediaElement).srcObject;
        if (src instanceof MediaStream) {
          if (src.id) streamIds.push(src.id);
          for (const t of src.getTracks()) if (t.id) trackIds.push(t.id);
          for (const group of sdpCnames.values()) {
            const sharesStream = src.id && group.stream_ids.has(src.id);
            const sharesTrack = src.getTracks().some((t) => group.track_ids.has(t.id));
            if (sharesStream || sharesTrack) {
              csis.push(...group.audio_ssrcs);
              streamIds.push(...group.stream_ids);
              trackIds.push(...group.track_ids);
            }
          }
        }
      }
      if (rawId && sdpCnames.has(rawId)) {
        const group = sdpCnames.get(rawId)!;
        csis.push(...group.audio_ssrcs);
        streamIds.push(...group.stream_ids);
        trackIds.push(...group.track_ids);
      }
      const effectiveId = rawId || (name && (streamIds.length || trackIds.length || csis.length)
        ? `dom:${streamIds[0] ?? trackIds[0] ?? csis[0]}`
        : '');
      if (effectiveId && (csis.length || streamIds.length || trackIds.length)) {
        if (ingestParticipantRecord({
          participant_id: effectiveId,
          participant_name: name ?? domNames.get(effectiveId) ?? null,
          audio_csis: csis,
          stream_ids: streamIds,
          track_ids: trackIds,
        })) updated = true;
      }
    }
    liveDomCount = seenLiveDom.size;
    return updated;
  }

  function onRemoteDescription(sdp: string) {
    if (typeof sdp !== 'string' || !sdp || sdp.length > 524288) return;
    sdpStats.descriptions++;
    let currentMedia: 'audio' | 'video' | 'other' = 'other';
    const ssrcCname = new Map<number, string>();
    const ssrcMsid = new Map<number, {streamId: string; trackId?: string}>();
    let sectionMsid: {streamId: string; trackId?: string} | null = null;
    for (const rawLine of sdp.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.startsWith('m=audio ')) {
        currentMedia = 'audio'; sdpStats.audio_sections++; sectionMsid = null;
      } else if (line.startsWith('m=video ')) {
        currentMedia = 'video'; sdpStats.video_sections++; sectionMsid = null;
      } else if (line.startsWith('m=')) {
        currentMedia = 'other'; sectionMsid = null;
      } else if (line.startsWith('a=msid:')) {
        const parts = line.slice(7).trim().split(/\s+/);
        if (parts[0] && parts[0] !== '-' && parts[0].length <= 256) {
          sectionMsid = {streamId: parts[0], trackId: parts[1]};
          if (sdpStats.msids.size < 256) sdpStats.msids.add(parts[0]);
        }
      } else if (line.startsWith('a=ssrc:')) {
        const match = /^a=ssrc:(\d+)\s+([a-zA-Z0-9_-]+):(.*)$/.exec(line);
        if (!match) continue;
        const ssrc = Number(match[1]);
        const attr = match[2].toLowerCase();
        const val = match[3].trim();
        if (!validCsi(ssrc)) continue;
        if (sdpStats.ssrcs.size < 256) sdpStats.ssrcs.add(ssrc);
        if (attr === 'cname' && val && val.length <= 256) {
          if (sdpStats.cnames.size < 256) sdpStats.cnames.add(val);
          ssrcCname.set(ssrc, val);
          let group = sdpCnames.get(val);
          if (!group && sdpCnames.size < 256) {
            group = {audio_ssrcs: new Set(), video_ssrcs: new Set(), stream_ids: new Set(), track_ids: new Set()};
            sdpCnames.set(val, group);
          }
          if (group) {
            if (currentMedia === 'audio' && group.audio_ssrcs.size < 64) group.audio_ssrcs.add(ssrc);
            if (currentMedia === 'video' && group.video_ssrcs.size < 64) group.video_ssrcs.add(ssrc);
            if (sectionMsid) {
              if (group.stream_ids.size < 64) group.stream_ids.add(sectionMsid.streamId);
              if (sectionMsid.trackId && group.track_ids.size < 64) group.track_ids.add(sectionMsid.trackId);
            }
          }
        } else if (attr === 'msid' && val) {
          const parts = val.split(/\s+/);
          if (parts[0] && parts[0] !== '-' && parts[0].length <= 256) {
            ssrcMsid.set(ssrc, {streamId: parts[0], trackId: parts[1]});
            if (sdpStats.msids.size < 256) sdpStats.msids.add(parts[0]);
          }
        }
      }
    }
    for (const [ssrc, msid] of ssrcMsid) {
      const cname = ssrcCname.get(ssrc);
      const group = cname ? sdpCnames.get(cname) : undefined;
      if (group) {
        if (group.stream_ids.size < 64) group.stream_ids.add(msid.streamId);
        if (msid.trackId && group.track_ids.size < 64) group.track_ids.add(msid.trackId);
      }
    }
    let updated = scanDomParticipants();
    for (const [cname, group] of sdpCnames) {
      if (!group.audio_ssrcs.size && !group.stream_ids.size && !group.track_ids.size) continue;
      const matchedId = (domNames.has(cname) || participants.has(cname))
        ? cname
        : [...group.stream_ids].find((sid) => domNames.has(sid) || participants.has(sid));
      if (matchedId) {
        if (ingestParticipantRecord({
          participant_id: matchedId,
          participant_name: domNames.get(matchedId) ?? null,
          audio_csis: [...group.audio_ssrcs],
          stream_ids: [...group.stream_ids],
          track_ids: [...group.track_ids],
        })) updated = true;
      }
    }
    if (updated) void inspectReceivers();
  }

  const channelStats = new Map<string, {
    ready_state: string; text_frames: number; binary_frames: number;
    json_frames: number; json_keys: Set<string>;
    wire_formats: Set<string>; protobuf_fields: Set<string>;
  }>();

  function getChannelStat(label: string, readyState = 'open') {
    const clean = (label || 'default').slice(0, 128);
    let stat = channelStats.get(clean);
    if (!stat && channelStats.size < 32) {
      stat = {ready_state: readyState, text_frames: 0, binary_frames: 0,
        json_frames: 0, json_keys: new Set(), wire_formats: new Set(), protobuf_fields: new Set()};
      channelStats.set(clean, stat);
    }
    if (stat) stat.ready_state = readyState;
    return stat;
  }

  function parseJsonText(text: string, stat: ReturnType<typeof getChannelStat>): boolean {
    let trimmed = text.replace(/^\)\]\}'\s*/, '').replace(/^\d+:+/, '').trim();
    if (trimmed.startsWith('POST ') || trimmed.startsWith('HTTP/')) {
      const bodyIdx = trimmed.indexOf('\r\n\r\n');
      if (bodyIdx !== -1) trimmed = trimmed.slice(bodyIdx + 4).trim();
    }
    if (!trimmed || trimmed.length > 262144 || (trimmed[0] !== '{' && trimmed[0] !== '[')) return false;
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { return false; }
    if (stat) {
      stat.json_frames++;
      if (stat.wire_formats.size < 16) stat.wire_formats.add('json');
    }
    scanDomParticipants();
    const queue: unknown[] = [parsed];
    let updated = false, visited = 0;
    while (queue.length && visited < 2048) {
      const current = queue.shift();
      visited++;
      if (Array.isArray(current)) {
        for (const item of current.slice(0, 256)) queue.push(item);
      } else if (current && typeof current === 'object') {
        const record = current as Record<string, unknown>;
        if (stat && stat.json_keys.size < 32) {
          for (const k of Object.keys(record)) {
            if (/^[a-zA-Z0-9_.-]{1,64}$/.test(k) && stat.json_keys.size < 32) {
              stat.json_keys.add(k);
            }
          }
        }
        if (config.provider === 'webex') {
          if (record.self && typeof record.self === 'object' && !Array.isArray(record.self)) {
            ingestWebexSelf(record.self as Record<string, unknown>);
          }
          if (record.msgType === 'multistream' && record.payload && typeof record.payload === 'object') {
            const outer = record.payload as Record<string, unknown>;
            if (outer.mediaFamily === 'AUDIO' && (outer.mediaContent === 'MAIN' || outer.mediaContent === 'SLIDES') &&
                outer.payload && typeof outer.payload === 'object') {
              const inner = outer.payload as Record<string, unknown>;
              const innerPayload = inner.payload && typeof inner.payload === 'object'
                ? (inner.payload as Record<string, unknown>) : undefined;
              if (inner.msgType === 'mediaRequest' && Array.isArray(innerPayload?.requests)) {
                for (const req of innerPayload.requests) {
                  if (!req || typeof req !== 'object') continue;
                  const pInfo = (req as Record<string, unknown>).policySpecificInfo;
                  const selfCsi = pInfo && typeof pInfo === 'object'
                    ? (pInfo as Record<string, unknown>).csi : undefined;
                  if (validCsi(selfCsi)) webexSelfCsis.add(selfCsi);
                }
              } else if (inner.msgType === 'mediaRequestStatus' && Array.isArray(innerPayload?.streamStates)) {
                for (const st of innerPayload.streamStates) {
                  if (!st || typeof st !== 'object') continue;
                  const stRec = st as Record<string, unknown>;
                  const idObj = stRec.id && typeof stRec.id === 'object'
                    ? (stRec.id as Record<string, unknown>) : undefined;
                  const slotSsrc = idObj?.ssrc;
                  const stCsi = stRec.csi;
                  if (validCsi(slotSsrc) && validCsi(stCsi)) {
                    const pid = findWebexParticipantByCsi(stCsi);
                    if (pid && pid !== webexSelfParticipantId) {
                      webexSsrcToParticipant.set(slotSsrc, pid);
                      updated = true;
                    }
                  }
                }
                if (updateWebexActiveSpeakerBindings()) updated = true;
              } else if (inner.msgType === 'activeSpeakerNotification' && Array.isArray(innerPayload?.csis)) {
                const csis = innerPayload.csis.filter((c): c is number => validCsi(c) && !webexSelfCsis.has(c));
                if (csis.length > 0) {
                  webexCurrentActiveSpeakerCsis = csis;
                  webexLastActiveSpeakerAt = performance.now();
                  if (updateWebexActiveSpeakerBindings()) updated = true;
                  else updated = true;
                }
              }
            }
          }
        }
        if (ingestParticipantRecord(record)) updated = true;
        for (const b64Key of ['message', 'body'] as const) {
          const b64Val = record[b64Key];
          if (typeof b64Val === 'string' && b64Val.startsWith('H4sI') && b64Val.length <= 262144) {
            try {
              const bin = atob(b64Val);
              const gz = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) gz[i] = bin.charCodeAt(i);
              if (stat && stat.wire_formats.size < 16) stat.wire_formats.add('gzip');
              void decompressPayload(gz, 'gzip').then((out) => { if (out) processPayloadBytes(out, stat); });
            } catch { /* ignore invalid base64 */ }
          } else if (typeof b64Val === 'string' && (b64Val.startsWith('{') || b64Val.startsWith('['))) {
            if (parseJsonText(b64Val, stat)) updated = true;
          }
        }
        for (const key of ['participants', 'participant', 'locus', 'sources', 'roster', 'members', 'endpoints', 'data', 'payload', 'mediaNegotiation', 'result', 'entitys', 'entities']) {
          const child = record[key];
          if (child && typeof child === 'object') {
            queue.push(child);
            if (!Array.isArray(child) && (key === 'participants' || key === 'members' || key === 'sources')) {
              for (const [mapKey, item] of Object.entries(child as Record<string, unknown>).slice(0, 256)) {
                if (item && typeof item === 'object' && !Array.isArray(item)) {
                  const itemRec = item as Record<string, unknown>;
                  queue.push(itemRec.participant_id ? itemRec : {participant_id: mapKey, ...itemRec});
                }
              }
            }
          }
        }
      }
    }
    if (updated && config.provider === 'webex') updateWebexActiveSpeakerBindings();
    return updated;
  }

  function parseProtobufPayload(bytes: Uint8Array, stat: ReturnType<typeof getChannelStat>, depth = 0): boolean {
    if (depth > 8 || bytes.byteLength < 2 || bytes.byteLength > 65536) return false;
    let offset = 0, tags = 0, updated = false;
    const strings: string[] = [];
    const ints: number[] = [];
    const readVarint = (): number | null => {
      let result = 0, shift = 0;
      while (offset < bytes.byteLength && shift < 64) {
        const b = bytes[offset++];
        result += (b & 0x7f) * (2 ** shift);
        if ((b & 0x80) === 0) return result;
        shift += 7;
      }
      return null;
    };
    while (offset < bytes.byteLength && tags < 128) {
      const tag = readVarint();
      if (tag === null || tag <= 0) break;
      const fieldNo = Math.floor(tag / 8);
      const wireType = tag & 7;
      if (fieldNo < 1 || fieldNo > 536870911) break;
      tags++;
      if (depth === 0 && stat) {
        if (stat.wire_formats.size < 16) stat.wire_formats.add('protobuf');
        const sig = `${fieldNo}:${wireType}`;
        if (stat.protobuf_fields.size < 32) stat.protobuf_fields.add(sig);
      }
      if (wireType === 0) {
        const val = readVarint();
        if (val === null) break;
        if (validCsi(val) && val >= 100 && ints.length < 32) ints.push(val);
      } else if (wireType === 1) {
        if (offset + 8 > bytes.byteLength) break;
        offset += 8;
      } else if (wireType === 5) {
        if (offset + 4 > bytes.byteLength) break;
        const val = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
        offset += 4;
        if (validCsi(val) && val > 0 && ints.length < 32) ints.push(val);
      } else if (wireType === 2) {
        const len = readVarint();
        if (len === null || len < 0 || offset + len > bytes.byteLength) break;
        const slice = bytes.subarray(offset, offset + len);
        offset += len;
        if (len > 0 && len <= 4096) {
          const decoded = new TextDecoder('utf-8', {fatal: false}).decode(slice);
          if (decoded && (decoded[0] === '{' || decoded[0] === '[')) {
            if (parseJsonText(decoded, stat)) updated = true;
            continue;
          }
          if (len <= 200 && /^[\x20-\x7e\u00a0-\uffff]+$/.test(decoded)) {
            const trimmed = decoded.trim();
            if (/^\d{3,10}$/.test(trimmed)) {
              const num = Number(trimmed);
              if (validCsi(num) && num >= 100 && ints.length < 32) ints.push(num);
            } else if (trimmed) {
              strings.push(trimmed);
            }
          }
          if (depth < 8 && len >= 2 && parseProtobufPayload(slice, stat, depth + 1)) {
            updated = true;
          }
        }
      } else {
        break;
      }
    }
    if (strings.length > 0) {
      scanDomParticipants();
      const matchedId = strings.find((s) =>
        domNames.has(s) || participants.has(s) || /^(?:spaces\/[^/\s]+\/)?devices\/[^/\s]+$/.test(s));
      if (matchedId) {
        const protoName = strings.find((s) =>
          s !== matchedId &&
          s.length >= 2 &&
          s.length <= 120 &&
          !/^\d+$/.test(s) &&
          !/https?:\/\/|googleusercontent\.com/i.test(s) &&
          !/^(?:spaces\/|devices\/|FID$)/i.test(s) &&
          !/^[A-Za-z0-9+/=_-]{24,}$/.test(s)) ?? null;
        if (protoName) {
          if (domNames.size < 256 || domNames.has(matchedId)) domNames.set(matchedId, protoName);
          const existing = participants.get(matchedId);
          if (existing && existing.participant_name !== protoName) {
            existing.participant_name = protoName;
            updated = true;
          }
        }
        if (ints.length > 0) {
          const candidateName = domNames.get(matchedId) ?? protoName;
          if (ingestParticipantRecord({
            participant_id: matchedId,
            participant_name: candidateName,
            audio_csis: ints,
          })) updated = true;
        }
      }
    }
    return updated;
  }

  async function decompressPayload(bytes: Uint8Array, format: 'gzip' | 'deflate'): Promise<Uint8Array | null> {
    if (typeof DecompressionStream !== 'function') return null;
    try {
      const ds = new DecompressionStream(format);
      const writer = ds.writable.getWriter();
      void writer.write(new Uint8Array(bytes)).catch(() => {});
      void writer.close().catch(() => {});
      const reader = ds.readable.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (total <= 262144) {
        const {done, value} = await reader.read();
        if (done || !value) break;
        chunks.push(value);
        total += value.byteLength;
      }
      if (!total || total > 262144) return null;
      const out = new Uint8Array(total);
      let pos = 0;
      for (const c of chunks) { out.set(c, pos); pos += c.byteLength; }
      return out;
    } catch { return null; }
  }

  function processPayloadBytes(bytes: Uint8Array, stat: ReturnType<typeof getChannelStat>) {
    if (bytes.byteLength > 262144) return;
    const text = new TextDecoder().decode(bytes);
    if (parseJsonText(text, stat)) {
      void inspectReceivers();
      return;
    }
    if (parseProtobufPayload(bytes, stat, 0)) {
      void inspectReceivers();
    }
  }

  function onDataMessage(input: unknown) {
    let raw = input;
    let label = 'default';
    let readyState = 'open';
    if (input && typeof input === 'object' && !(input instanceof ArrayBuffer) &&
        !ArrayBuffer.isView(input) && '__wortlautChannel' in (input as Record<string, unknown>)) {
      const env = input as {__wortlautChannel: string; readyState?: string; data: unknown};
      label = env.__wortlautChannel || 'default';
      readyState = env.readyState || 'open';
      raw = env.data;
    }
    const stat = getChannelStat(label, readyState);
    if (typeof raw === 'string') {
      if (stat) {
        stat.text_frames++;
        if (stat.wire_formats.size < 16) stat.wire_formats.add('utf8');
      }
      if (parseJsonText(raw, stat)) void inspectReceivers();
      return;
    }
    let bytes: Uint8Array | null = null;
    if (raw instanceof ArrayBuffer) {
      if (stat) stat.binary_frames++;
      if (raw.byteLength <= 262144) bytes = new Uint8Array(raw);
    } else if (ArrayBuffer.isView(raw)) {
      if (stat) stat.binary_frames++;
      if (raw.byteLength <= 262144) bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    }
    if (!bytes || !bytes.byteLength) return;
    if (bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
      if (stat && stat.wire_formats.size < 16) stat.wire_formats.add('gzip');
      void decompressPayload(bytes, 'gzip').then((out) => { if (out) processPayloadBytes(out, stat); });
      return;
    }
    if (bytes.byteLength >= 2 && bytes[0] === 0x78 &&
        (bytes[1] === 0x01 || bytes[1] === 0x5e || bytes[1] === 0x9c || bytes[1] === 0xda)) {
      if (stat && stat.wire_formats.size < 16) stat.wire_formats.add('zlib');
      void decompressPayload(bytes, 'deflate').then((out) => { if (out) processPayloadBytes(out, stat); });
      return;
    }
    processPayloadBytes(bytes, stat);
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
      observer = new Worker(toWorkerScriptUrl(url));
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
      const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      for (let i = 0; i + 1 < pcm.byteLength; i += 2) {
        if (Math.abs(view.getInt16(i, true)) >= 200) {
          state.active_audio_samples += metadata.sample_count;
          break;
        }
      }
    }, error: (reason) => { state.reason = reason; }};

  function recentRtpSources(items: RTCRtpContributingSource[]): number[] {
    if (!items.length) return [];
    let maxTs = -Infinity;
    for (const item of items) {
      if (typeof item.timestamp === 'number' && Number.isFinite(item.timestamp) && item.timestamp > maxTs) {
        maxTs = item.timestamp;
      }
    }
    const filtered = Number.isFinite(maxTs)
      ? items.filter((item) =>
          typeof item.timestamp !== 'number' || !Number.isFinite(item.timestamp) || maxTs - item.timestamp <= 25)
      : items;
    return filtered.map((item) => item.source);
  }

  const lastResolvedBindings = new WeakMap<RTCRtpReceiver, {
    csi: number | null; signaled_participant_id: string | null;
    participant_name: string | null; source_kind: 'speaker' | 'share_audio'; bound: boolean;
  }>();

  function resolveReceiver(receiver: RTCRtpReceiver): {
    csi: number | null; signaled_participant_id: string | null;
    participant_name: string | null; source_kind: 'speaker' | 'share_audio'; bound: boolean;
  } {
    if (!participants.size) {
      return {csi: null, signaled_participant_id: null, participant_name: null, source_kind: 'speaker', bound: false};
    }
    const lastFrame = observations.get(receiver)?.evidence.last_frame;
    const recentCsrcs = recentRtpSources(receiver.getContributingSources()).filter(validCsi);
    const csrcs = [...new Set(
      recentCsrcs.length > 0
        ? recentCsrcs
        : (Array.isArray(lastFrame?.contributing_sources) ? (lastFrame.contributing_sources as number[]) : []).filter(validCsi),
    )];
    const recentSsrcs = recentRtpSources(receiver.getSynchronizationSources()).filter(validCsi);
    const ssrcs = [...new Set(
      recentSsrcs.length > 0
        ? recentSsrcs
        : (validCsi(lastFrame?.synchronization_source) ? [lastFrame.synchronization_source] : []).filter(validCsi),
    )];

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

    const remember = (res: {
      csi: number | null; signaled_participant_id: string | null;
      participant_name: string | null; source_kind: 'speaker' | 'share_audio'; bound: boolean;
    }) => {
      if (res.bound && res.signaled_participant_id) {
        lastResolvedBindings.set(receiver, res);
      }
      return res;
    };

    if (csrcs.length > 0) {
      const csrcMatch = matchByCsi(csrcs);
      if (csrcMatch === 'ambiguous') {
        lastResolvedBindings.delete(receiver);
        return {csi: null, signaled_participant_id: null, participant_name: null, source_kind: 'speaker', bound: false};
      }
      if (csrcMatch) {
        return remember({csi: csrcMatch.csi, signaled_participant_id: csrcMatch.id,
          participant_name: csrcMatch.name, source_kind: csrcMatch.kind, bound: true});
      }
      if (csrcs.length > 1) {
        lastResolvedBindings.delete(receiver);
        return {csi: null, signaled_participant_id: null, participant_name: null, source_kind: 'speaker', bound: false};
      }
    }
    if (ssrcs.length > 0) {
      const ssrcMatch = matchByCsi(ssrcs);
      if (ssrcMatch === 'ambiguous') {
        lastResolvedBindings.delete(receiver);
        return {csi: null, signaled_participant_id: null, participant_name: null, source_kind: 'speaker', bound: false};
      }
      if (ssrcMatch) {
        return remember({csi: ssrcMatch.csi, signaled_participant_id: ssrcMatch.id,
          participant_name: ssrcMatch.name, source_kind: ssrcMatch.kind, bound: true});
      }
    }
    const streamIds = receiverStreams?.get(receiver) ?? [];
    const trackMatches = [...participants.values()].filter((p) =>
      p.track_ids.has(receiver.track.id) || streamIds.some((sid) => p.stream_ids.has(sid)));
    if (trackMatches.length === 1) {
      const p = trackMatches[0];
      const firstCsi = [...p.audio_csis][0] ?? null;
      return remember({csi: firstCsi, signaled_participant_id: p.participant_id,
        participant_name: p.participant_name, source_kind: 'speaker', bound: true});
    }
    const previous = lastResolvedBindings.get(receiver);
    if (previous && csrcs.length === 0 && previous.signaled_participant_id) {
      const latestParticipant = participants.get(previous.signaled_participant_id);
      return {
        ...previous,
        participant_name: latestParticipant?.participant_name ?? previous.participant_name,
      };
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
        scanDomParticipants();
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
        if (config.provider === 'webex') {
          updateWebexActiveSpeakerBindings();
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

  for (const sdp of window.wortlautMeetReceivers.remoteDescriptions?.splice(0) ?? []) onRemoteDescription(sdp);
  window.wortlautMeetReceivers.onRemoteDescription = onRemoteDescription;
  for (const queued of window.wortlautMeetReceivers.dataMessages?.splice(0) ?? []) onDataMessage(queued);
  window.wortlautMeetReceivers.onDataMessage = onDataMessage;
  const interval = setInterval(() => {
    void inspectReceivers();
  }, 250);
  const evidence = (receiver: RTCRtpReceiver, id: string) => {
    const source = (item: RTCRtpContributingSource) => ({source: item.source,
      timestamp: item.timestamp, rtp_timestamp: item.rtpTimestamp});
    const match = resolveReceiver(receiver);
    return {provider_source_id: id, source_kind: match.source_kind,
      capture_path: 'rtc_receiver',
      track_id: receiver.track.id, csi: match.csi, signaled_participant_id: match.signaled_participant_id,
      ...(match.participant_name ? {participant_name: match.participant_name} : {}),
      source_state: receiver.track.readyState,
      encoded_transform: observations.get(receiver)?.evidence,
      ssrc: receiver.getSynchronizationSources().slice(0, 64).map(source),
      csrc: receiver.getContributingSources().slice(0, 64).map(source)};
  };
  window.wortlautMeet = {
    inspect: () => {
      scanDomParticipants();
      for (const dc of window.wortlautMeetReceivers.dataChannels ?? []) {
        getChannelStat(dc.label || 'default', dc.readyState || 'open');
      }
      state.receiver_sources = [...sources].slice(0, 64).map(([receiver, source]) => evidence(receiver, source.id));
      state.participant_sources = {
        available: participants.size > 0,
        total: totalParticipants,
        truncated: totalParticipants > 256,
        ...(liveDomCount > 0 || domNames.size > 0 ? {dom_participants: liveDomCount} : {}),
        sources: [...participants.values()].slice(0, 256).map((p) => ({
          participant_id: p.participant_id,
          ...(p.participant_name ? {participant_name: p.participant_name} : {}),
          audio_csis: [...p.audio_csis].slice(0, 64),
          share_audio_csis: [...p.share_audio_csis].slice(0, 64),
        })),
      };
      state.data_channels = [...channelStats.entries()].slice(0, 32).map(([label, s]) => ({
        label,
        ready_state: s.ready_state,
        text_frames: s.text_frames,
        binary_frames: s.binary_frames,
        json_frames: s.json_frames,
        json_keys: [...s.json_keys].slice(0, 32),
        wire_formats: [...s.wire_formats].slice(0, 16),
        protobuf_fields: [...s.protobuf_fields].slice(0, 32),
      }));
      state.sdp = {
        descriptions: sdpStats.descriptions,
        audio_sections: sdpStats.audio_sections,
        video_sections: sdpStats.video_sections,
        ssrc_count: sdpStats.ssrcs.size,
        cname_count: sdpStats.cnames.size,
        msid_count: sdpStats.msids.size,
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
      window.wortlautMeetReceivers.transformDataSend = undefined;
      window.wortlautMeetReceivers.onRemoteDescription = undefined;
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
