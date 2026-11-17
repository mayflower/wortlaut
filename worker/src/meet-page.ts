import {isTeamsOrigin} from './teams-url.js';
import {isZoomOrigin} from './zoom-url.js';
import {AudioCapture, type AudioClock, type CaptureSink} from './capture.js';
import type {Binding, Chunk} from './chunks.js';
import {ScreenShareKeyframeSampler, type KeyframeDiagnostics} from './keyframes.js';
import resamplerSource from '@alexanderolsen/libsamplerate-js/dist/libsamplerate.worklet.js?raw';
import pcmSource from '../public/pcm-worklet.js?raw';
import encodedObserverSource from '../public/encoded-audio-observer.js?raw';

export type MeetCaptureConfig = {meeting_id: string; attempt_id: string; meeting_url: string;
  provider?: 'google_meet' | 'webex' | 'teams' | 'zoom'; teams_origins?: string[];
  enable_keyframes?: boolean; bot_display_name?: string | null};
export type MeetBridgeMessage = {attempt_id: string; type: 'control' | 'chunk' | 'keyframe';
  metadata: Record<string, unknown>; pcm?: string; png?: string};

declare global {
  interface Window {
    wortlautMeetConfig: MeetCaptureConfig;
    wortlautMeetBridge: (message: MeetBridgeMessage) => Promise<void>;
    wortlautMeetReceivers: {connections: Set<RTCPeerConnection>; received: WeakSet<RTCRtpReceiver>;
      encodedReserved: WeakSet<RTCPeerConnection>;
      receiverStreams?: WeakMap<RTCRtpReceiver, string[]>;
      receiverMediaStreams?: WeakMap<RTCRtpReceiver, MediaStream>;
      encodedFrameMeta?: WeakMap<RTCRtpReceiver, {ssrc: number | null; csrcs: number[]}>;
      dataChannels?: Set<RTCDataChannel>;
      dataMessages?: unknown[];
      dataSends?: {channel: RTCDataChannel; data: unknown}[];
      onDataMessage?: (data: unknown) => void;
      transformDataSend?: (channel: RTCDataChannel, data: unknown) => unknown;
      remoteDescriptions?: string[];
      frameConnections?: Set<RTCPeerConnection>;
      onRemoteDescription?: (sdp: string) => void;
      observe?: (receiver: RTCRtpReceiver, pc: RTCPeerConnection) => void};
    wortlautMeet: {stop: () => Promise<boolean>; inspect: () => MeetCaptureState & {audio_clock: AudioClock};
      haltKeyframes?: () => void};
  }
}

type PauseWindowState = {
  started_at: string;
  ended_at: string | null;
  by?: string | null;
};

type ParticipantSourcesState = {
  available: boolean;
  total: number;
  truncated: boolean;
  dom_participants?: number;
  opted_out?: string[];
  paused?: boolean;
  pause_windows?: PauseWindowState[];
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

// Cumulative WebRTC receive counters, read from getStats(). They separate
// "the SFU sent no audio" from "audio arrived but was not decoded" and from
// "decoded audio never reached the capture worklet".
export type InboundAudioStats = {packets_received: number; bytes_received: number; packets_lost: number;
  jitter_buffer_emitted_count: number; total_samples_received: number; concealed_samples: number;
  silent_concealed_samples: number; total_audio_energy: number; audio_level: number | null;
  last_packet_ms_ago: number | null; codec: string | null};

export type MediaState = {
  peer_connections: {connection_state: string; ice_connection_state: string; dtls_state: string | null;
    selected_pair_state: string | null; selected_pair_bytes_received: number | null;
    in_frame: boolean; audio_receivers: number; inbound_audio_packets: number}[];
  // meet_foreign_tracks: live audio tracks Meet plays that no captured
  // (top-window) peer connection receives.
  audio_elements: {meet_total: number; meet_playing: number; meet_muted: number;
    meet_foreign_tracks: number; keepalive_total: number; keepalive_playing: number};
  frames: number;
  stats_age_ms: number | null;
};

type MeetCaptureState = {streams: number; audio_samples: number; active_audio_samples: number;
  reason: string; capture_ready: boolean; stopped: boolean; drained: boolean;
  receiver_sources: Record<string, unknown>[];
  participant_sources: ParticipantSourcesState;
  data_channels: DataChannelState[];
  sdp: SdpState;
  keyframes: KeyframeDiagnostics;
  media?: MediaState};

type EncodedEvidence = {state: 'unsupported' | 'failed' | 'waiting_frames' | 'observing' |
  'metadata_unavailable' | 'provider_transform' | 'provider_reserved' | 'replaced' | 'stopped';
  frame_count: number; last_frame: Record<string, unknown> | null};
type EncodedObservation = {id: number; pc: RTCPeerConnection; transform?: RTCRtpScriptTransform;
  requestedAt?: number; waitingSince?: number; evidence: EncodedEvidence};

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
  const keyframesEnabled = config.enable_keyframes !== false;
  const state: MeetCaptureState = {streams: 0, audio_samples: 0, active_audio_samples: 0,
    reason: '', stopped: false, capture_ready: false, drained: false, receiver_sources: [],
    participant_sources: {available: false, total: 0, truncated: false, sources: []},
    data_channels: [],
    sdp: {descriptions: 0, audio_sections: 0, video_sections: 0, ssrc_count: 0, cname_count: 0, msid_count: 0},
    keyframes: {
      capability: keyframesEnabled ? 'unverified' : 'disabled',
      active_share: false,
      evaluated_ticks: 0,
      emitted: 0,
      uploaded: 0,
      dropped_unverified: 0,
      dropped_opted_out: 0,
      dropped_queue_full: 0,
    }};
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
  const {connections, received, encodedReserved, receiverStreams, receiverMediaStreams, encodedFrameMeta} = window.wortlautMeetReceivers;
  const participants = new Map<string, {
    participant_id: string; participant_name: string | null;
    audio_csis: Set<number>; share_audio_csis: Set<number>;
    share_video_csis: Set<number>;
    share_video_track_ids: Set<string>;
    share_video_stream_ids: Set<string>;
    track_ids: Set<string>; stream_ids: Set<string>;
  }>();
  const cameraVideoCsis = new Set<number>();
  const cameraVideoStreamIds = new Set<string>();
  const cameraVideoTrackIds = new Set<string>();
  const meetSlideVideoMids = new Set<string>();
  const meetSlideVideoSsrcs = new Set<number>();
  const meetSlideVideoStreamIds = new Set<string>();
  const meetSlideVideoTrackIds = new Set<string>();
  const meetScreencastParent = new Map<string, string>();
  const domNames = new Map<string, string>();
  const protoNames = new Map<string, string>();
  const unmuteHookedTracks = new WeakSet<MediaStreamTrack>();
  const ignoredParticipantIds = new Set<string>();
  const optedOutParticipants = new Set<string>();
  let capturePaused = false;
  const pauseWindows: PauseWindowState[] = [];
  const seenDomChatElements = new WeakMap<Element, string>();
  let liveDomCount = 0;
  let everSawDomParticipants = false;
  const NOTETAKER_BOT_RE =
    /\b(fireflies(\.ai)?|otter(\.ai)?|read\.ai|fathom|tl;dv|tldv|meetgeek|fellow(\.app)?|avoma|sembly|supernormal|grain|krisp|tactiq|airgram|notta|nyota|circleback|sonnet|bluedot|granola|notetaker|note[\s-]*taker|meeting[\s-]*bot|ai[\s-]*notetaker|ai[\s-]*assistant)\b/i;
  const SELF_OR_UI_TEXT_RE =
    /^(?:(?:synia\s+)?wortlaut(?:\b.*)?|you|sie|ich)$/i;
  const UI_CHROME_TEXT_RE =
    /(vollständigen videofeed|full video|bildausschnitt|reframing)/i;
  const BOT_INTRO_OR_URL_RE =
    /https?:\/\/|Protokoll:|Transcript:|Datenschutz-Info:|Privacy Notice:|Schreib(?:e|en Sie) einfach|simply type "no"/i;
  const CHAT_OPT_OUT_EXACT_RE =
    /^[/!]?(?:opt[\s_-]*out|no|nein|stop|stopp|widerspruch|keine\s+(?:aufnahme|aufzeichnung|protokollierung|transkription)|nicht\s+(?:aufnehmen|aufzeichnen|protokollieren|transkribieren)|do\s+not\s+(?:record|transcribe)|don['’]?t\s+(?:record|transcribe))(?:[\s.!?,;:]+(?:bitte|please|danke|thanks|thank\s+you))?$/i;
  const CHAT_OPT_OUT_PHRASE_RE =
    /\b(?:[/!]?opt[\s_-]*out|ich\s+widerspreche|keine\s+(?:aufnahme|aufzeichnung|protokollierung|transkription)|nicht\s+(?:aufnehmen|aufzeichnen|protokollieren|transkribieren)|do\s+not\s+(?:record|transcribe)|don['’]?t\s+(?:record|transcribe))\b/i;

  const HOST_SUFFIX_RE = /\s*\((?:Host|Co-host|Gastgeber|Co-Gastgeber|Organizer|Organisator)\)\s*$/i;

  function normalizeChatCommandInput(
    rawText: unknown,
    maxLen: number,
  ): {hasMention: boolean; stripped: string} | null {
    if (typeof rawText !== 'string') return null;
    const cleaned = rawText.trim().replace(/\s+/g, ' ');
    if (!cleaned || cleaned.length > maxLen || BOT_INTRO_OR_URL_RE.test(cleaned)) return null;
    const hasMention = /^[@#]?(?:synia\s+)?wortlaut(?:\.cloud|\s+demo)?\b/i.test(cleaned);
    const stripped = cleaned
      .replace(/^[@#]?(?:synia\s+)?wortlaut(?:\.cloud|\s+demo)?(?:\s*\([^)]*\))?[\s,:;-]*/i, '')
      .trim();
    return stripped ? {hasMention, stripped} : null;
  }

  function isChatOptOutMessage(rawText: unknown, allowBareShortTokens = true): boolean {
    const norm = normalizeChatCommandInput(rawText, 240);
    if (!norm) return false;
    const core = norm.stripped
      .replace(/^[.!?,;:"'„“”‚‘’()[\]\s-]+|[.!?,;:"'„“”‚‘’()[\]\s-]+$/g, '')
      .trim();
    if (!core) return false;
    if (!allowBareShortTokens && !norm.hasMention && /^(?:no|stop)$/i.test(core)) {
      return false;
    }
    if (CHAT_OPT_OUT_EXACT_RE.test(core)) return true;
    return core.length <= 140 && CHAT_OPT_OUT_PHRASE_RE.test(core);
  }

  function parseChatPauseCommand(rawText: unknown): 'pause' | 'resume' | null {
    const norm = normalizeChatCommandInput(rawText, 160);
    if (!norm) return null;
    const core = norm.stripped
      .replace(/^[.,;:"'„“”‚‘’()[\]\s]+|[.!?,;:"'„“”‚‘’()[\]\s]+$/g, '')
      .trim();
    if (!core) return null;
    if (
      /^(?:[#\/!](?:pause|pausieren|off[-_\s]*the[-_\s]*record|otr)|off\s+the\s+record)(?:[\s.!?,;:]+(?:bitte|please|jetzt|now))?$/i.test(
        core,
      ) ||
      (norm.hasMention && /^(?:pause|pausieren)(?:[\s.!?,;:]+(?:bitte|please|jetzt|now))?$/i.test(core))
    ) {
      return 'pause';
    }
    if (
      /^(?:[#\/!](?:resume|weiter|continue|fortsetzen|on[-_\s]*the[-_\s]*record)|back\s+on\s+(?:the\s+)?record)(?:[\s.!?,;:]+(?:bitte|please|jetzt|now))?$/i.test(
        core,
      ) ||
      (norm.hasMention &&
        /^(?:resume|weiter|continue|fortsetzen)(?:[\s.!?,;:]+(?:bitte|please|jetzt|now))?$/i.test(core))
    ) {
      return 'resume';
    }
    return null;
  }

  function resolveChatSender(
    senderId?: string | null,
    senderName?: string | null,
  ): {rejected: boolean; cleanId: string; cleanName: string; authorName: string | null} {
    const cleanId = typeof senderId === 'string' ? senderId.trim() : '';
    const cleanName = typeof senderName === 'string' ? senderName.replace(HOST_SUFFIX_RE, '').trim() : '';
    if (
      (cleanName && isIgnoredParticipantName(cleanName)) ||
      (cleanId && (cleanId === webexSelfParticipantId || ignoredParticipantIds.has(cleanId)))
    ) {
      return {rejected: true, cleanId, cleanName, authorName: null};
    }
    const resolvedName =
      cleanName ||
      (cleanId
        ? (domNames.get(cleanId) ??
          protoNames.get(cleanId) ??
          participants.get(cleanId)?.participant_name ??
          '')
        : '');
    if (resolvedName && isIgnoredParticipantName(resolvedName)) {
      return {rejected: true, cleanId, cleanName, authorName: null};
    }
    return {
      rejected: false,
      cleanId,
      cleanName,
      authorName: resolvedName ? resolvedName.slice(0, 120) : null,
    };
  }

  function syncVideoTileFromChat() {
    window.wortlautVideoTile?.update({
      paused: capturePaused,
    });
  }

  function applyPauseState(nextPaused: boolean, senderId?: string | null, senderName?: string | null): boolean {
    const sender = resolveChatSender(senderId, senderName);
    if (sender.rejected) return false;
    if (nextPaused === capturePaused) return false;
    capturePaused = nextPaused;
    capture.setMuted(nextPaused);
    const nowIso = capture.nowUtc();
    if (nextPaused) {
      if (pauseWindows.length < 64) {
        pauseWindows.push({
          started_at: nowIso,
          ended_at: null,
          ...(sender.authorName ? {by: sender.authorName} : {}),
        });
      }
      teardownProbeVideo();
      state.keyframes.active_share = false;
    } else {
      for (let i = pauseWindows.length - 1; i >= 0; i--) {
        if (pauseWindows[i].ended_at === null) {
          pauseWindows[i].ended_at = nowIso;
          break;
        }
      }
    }
    syncVideoTileFromChat();
    return true;
  }

  function purgeOptedOutChatArtifacts(): boolean {
    if (!optedOutParticipants.size) return false;
    let scrubbed = false;
    for (const w of pauseWindows) {
      if (w.by && isParticipantOptedOut(null, w.by)) {
        delete w.by;
        scrubbed = true;
      }
    }
    return scrubbed;
  }

  function syncOptOutCrossLinks(): boolean {
    if (!optedOutParticipants.size) return false;
    let added = false;
    const lowerSet = new Set<string>();
    for (const item of optedOutParticipants) lowerSet.add(item.trim().toLowerCase());
    for (const p of participants.values()) {
      const pidLow = p.participant_id.trim().toLowerCase();
      const nameLow = p.participant_name?.trim().toLowerCase() ?? '';
      if (lowerSet.has(pidLow) || (nameLow && lowerSet.has(nameLow))) {
        if (!optedOutParticipants.has(p.participant_id) && optedOutParticipants.size < 256) {
          optedOutParticipants.add(p.participant_id);
          lowerSet.add(pidLow);
          added = true;
        }
        if (p.participant_name && !optedOutParticipants.has(p.participant_name) && optedOutParticipants.size < 256) {
          optedOutParticipants.add(p.participant_name);
          lowerSet.add(nameLow);
          added = true;
        }
      }
    }
    for (const [pid, dName] of [...domNames, ...protoNames]) {
      const pidLow = pid.trim().toLowerCase();
      const nameLow = dName.trim().toLowerCase();
      if (lowerSet.has(pidLow) || (nameLow && lowerSet.has(nameLow))) {
        if (!optedOutParticipants.has(pid) && optedOutParticipants.size < 256) {
          optedOutParticipants.add(pid);
          lowerSet.add(pidLow);
          added = true;
        }
        if (!optedOutParticipants.has(dName) && optedOutParticipants.size < 256) {
          optedOutParticipants.add(dName);
          lowerSet.add(nameLow);
          added = true;
        }
      }
    }
    if (purgeOptedOutChatArtifacts()) added = true;
    return added;
  }

  function recordOptOutAuthor(senderId?: string | null, senderName?: string | null): boolean {
    const sender = resolveChatSender(senderId, senderName);
    if (sender.rejected) return false;
    let added = false;
    if (
      sender.cleanId &&
      sender.cleanId.length <= 200 &&
      !optedOutParticipants.has(sender.cleanId) &&
      optedOutParticipants.size < 256
    ) {
      optedOutParticipants.add(sender.cleanId);
      added = true;
    }
    if (
      sender.cleanName &&
      sender.cleanName.length <= 200 &&
      !optedOutParticipants.has(sender.cleanName) &&
      optedOutParticipants.size < 256
    ) {
      optedOutParticipants.add(sender.cleanName);
      added = true;
    }
    if (syncOptOutCrossLinks()) added = true;
    if (purgeOptedOutChatArtifacts()) added = true;
    return added;
  }

  function isParticipantOptedOut(participantId?: string | null, participantName?: string | null): boolean {
    if (!optedOutParticipants.size) return false;
    const cleanId = participantId?.trim() ?? '';
    if (cleanId) {
      if (optedOutParticipants.has(cleanId)) return true;
      const lowerId = cleanId.toLowerCase();
      for (const item of optedOutParticipants) {
        if (item.toLowerCase() === lowerId) return true;
      }
    }
    const effectiveName = participantName?.trim() ||
      (cleanId ? (domNames.get(cleanId) ?? protoNames.get(cleanId) ?? participants.get(cleanId)?.participant_name ?? '') : '');
    if (effectiveName) {
      const clean = effectiveName.trim();
      if (optedOutParticipants.has(clean)) return true;
      const lower = clean.toLowerCase();
      for (const item of optedOutParticipants) {
        if (item.toLowerCase() === lower) return true;
      }
    }
    return false;
  }

  function isIgnoredParticipantName(name: string | null | undefined): boolean {
    if (!name) return false;
    const trimmed = name.trim();
    if (!trimmed) return false;
    const customBotName = config.bot_display_name?.trim().toLowerCase();
    if (customBotName && trimmed.toLowerCase() === customBotName) return true;
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
  const webexSlotSsrcToCsi = new Map<number, number>();
  const webexSsrcToParticipant = new Map<number, string>();
  const webexSlideVideoSsrcToParticipant = new Map<number, string>();
  let webexCurrentActiveSpeakerCsis: number[] = [];
  let webexLastActiveSpeakerAt = 0;
  const sources = new Map<RTCRtpReceiver, {id: string; track?: MediaStreamTrack; recovered?: boolean; silentSamples?: number}>();
  const sourceLastVoicedAt = new Map<string, number>();

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
            if (ms && typeof ms === 'object' && validCsi((ms as Record<string, unknown>).csi)) {
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
    for (const [slotSsrc, stCsi] of webexSlotSsrcToCsi) {
      const pid = findWebexParticipantByCsi(stCsi);
      if (pid && pid !== webexSelfParticipantId && webexSsrcToParticipant.get(slotSsrc) !== pid) {
        webexSsrcToParticipant.set(slotSsrc, pid);
        changed = true;
      }
    }
    for (const [ssrc, pid] of webexSsrcToParticipant) {
      if (!participants.has(pid) || pid === webexSelfParticipantId) {
        webexSsrcToParticipant.delete(ssrc);
        changed = true;
      }
    }
    const now = performance.now();
    const activePids: string[] = [];
    if (webexCurrentActiveSpeakerCsis.length > 0 && now - webexLastActiveSpeakerAt <= 3000) {
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
      const voicedSet = new Set<number>();
      const allLiveCandidates: {ssrc: number; ts: number}[] = [];
      let maxTs = -Infinity;
      for (const pc of connections) {
        if (pc.connectionState === 'closed') continue;
        for (const receiver of pc.getReceivers()) {
          if (!received.has(receiver) || receiver.track?.kind !== 'audio' || receiver.track.readyState !== 'live') {
            continue;
          }
          const srcEntry = sources.get(receiver);
          const pcmVoiced = Boolean(srcEntry && now - (sourceLastVoicedAt.get(srcEntry.id) ?? -Infinity) <= 900);
          for (const item of receiver.getSynchronizationSources()) {
            if (!validCsi(item.source) || shareCsis.has(item.source) || webexSlotSsrcToCsi.has(item.source)) continue;
            const ts = typeof item.timestamp === 'number' && Number.isFinite(item.timestamp) ? item.timestamp : 0;
            if (ts > maxTs) maxTs = ts;
            allLiveCandidates.push({ssrc: item.source, ts});
            const rtpVoiced = typeof item.audioLevel === 'number' && item.audioLevel > 0.01;
            if (pcmVoiced || rtpVoiced) voicedSet.add(item.source);
          }
        }
      }
      const allLiveSsrcs = [
        ...new Set(
          allLiveCandidates
            .filter((c) => !Number.isFinite(maxTs) || maxTs <= 0 || maxTs - c.ts <= 600)
            .map((c) => c.ssrc),
        ),
      ];
      const liveSet = new Set(allLiveSsrcs);
      const voicedSsrcs = [...voicedSet].filter((s) => liveSet.has(s));
      const candidateSsrcs =
        voicedSsrcs.length > 0 ? voicedSsrcs : allLiveSsrcs.length === 1 ? allLiveSsrcs : [];
      if (candidateSsrcs.length > 0) {
        const unresolvedSsrcs = candidateSsrcs.filter((s) => {
          const cur = webexSsrcToParticipant.get(s);
          return !cur || !activePids.includes(cur);
        });
        const matchedPids = new Set(
          candidateSsrcs
            .map((s) => webexSsrcToParticipant.get(s))
            .filter((p): p is string => Boolean(p && activePids.includes(p))),
        );
        const unassignedPids = activePids.filter((p) => !matchedPids.has(p));
        if (unresolvedSsrcs.length === 1 && unassignedPids.length === 1) {
          const targetSsrc = unresolvedSsrcs[0];
          const targetPid = unassignedPids[0];
          if (webexSsrcToParticipant.get(targetSsrc) !== targetPid) {
            webexSsrcToParticipant.set(targetSsrc, targetPid);
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
    const rawName = domNames.get(id) ??
      node.participant_name ?? node.participantName ?? node.displayName ??
      node.userName ?? node.user_name ??
      details?.displayName ?? person?.name ?? person?.displayName ?? person?.primaryDisplayString ??
      protoNames.get(id);
    const cleanedName = typeof rawName === 'string' && rawName.trim() && rawName.trim().length <= 200
      ? rawName.trim() : null;
    if (isIgnoredParticipantName(cleanedName)) {
      ignoredParticipantIds.add(id);
      domNames.delete(id);
      protoNames.delete(id);
      if (participants.delete(id)) {
        totalParticipants = Math.max(0, totalParticipants - 1);
      }
      return false;
    }
    if (cleanedName && !domNames.has(id) && (protoNames.size < 256 || protoNames.has(id))) {
      protoNames.set(id, cleanedName);
    }
    const teamsAudioCsis: number[] = [];
    const teamsShareCsis: number[] = [];
    const teamsShareVideoCsis: number[] = [];
    if (node.endpoints && typeof node.endpoints === 'object') {
      for (const ep of Object.values(node.endpoints as Record<string, unknown>).slice(0, 16)) {
        if (!ep || typeof ep !== 'object') continue;
        const epRec = ep as Record<string, unknown>;
        for (const [modKey, mod] of Object.entries(epRec).slice(0, 12)) {
          if (!mod || typeof mod !== 'object') continue;
          const streams = (mod as Record<string, unknown>).mediaStreams;
          if (!Array.isArray(streams)) continue;
          const isShareModality = /share|sharing|vbss|screen/i.test(modKey);
          for (const ms of streams.slice(0, 16)) {
            if (!ms || typeof ms !== 'object') continue;
            const msRec = ms as Record<string, unknown>;
            const sid = typeof msRec.sourceId === 'string' && /^\d+$/.test(msRec.sourceId)
              ? Number(msRec.sourceId) : msRec.sourceId;
            if (!validCsi(sid)) continue;
            const msType = typeof msRec.type === 'string' ? msRec.type.toLowerCase() : '';
            const msContent = typeof msRec.content === 'string' ? msRec.content.toLowerCase() : '';
            if (msType === 'applicationsharing-audio' || msType === 'sharing-audio' || (isShareModality && msType === 'audio')) {
              teamsShareCsis.push(sid);
            } else if (msType === 'audio') {
              teamsAudioCsis.push(sid);
            } else if (
              msType === 'applicationsharing-video' ||
              msType === 'sharing-video' ||
              msType === 'vbss' ||
              /share|screen|vbss/i.test(msType) ||
              /screen|slide|share/i.test(msContent) ||
              (isShareModality && msType === 'video')
            ) {
              teamsShareVideoCsis.push(sid);
              cameraVideoCsis.delete(sid);
            } else if (msType === 'video') {
              if (cameraVideoCsis.size < 512) cameraVideoCsis.add(sid);
            }
          }
        }
      }
    }
    const webexAudioCsis: number[] = [];
    const webexShareCsis: number[] = [];
    const webexShareVideoCsis: number[] = [];
    const webexDeviceFallbackCsis: number[] = [];
    if (isWebexParticipant) {
      if (node.state === 'LEFT' || node.state === 'REMOVED') {
        webexParticipantOwnedCsis.delete(id);
        webexParticipantDeviceCsis.delete(id);
        for (const [ssrc, ownerId] of webexSlideVideoSsrcToParticipant) {
          if (ownerId === id) webexSlideVideoSsrcToParticipant.delete(ssrc);
        }
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
            const mType = typeof msRec.mediaType === 'string' ? msRec.mediaType.toLowerCase() : '';
            const mContent = typeof msRec.mediaContent === 'string' ? msRec.mediaContent.toLowerCase() : '';
            if (mType === 'audio') {
              if (mContent === 'slides') {
                webexShareCsis.push(csi);
              } else {
                webexAudioCsis.push(csi);
              }
            } else if (mType === 'video') {
              if (mContent === 'slides') {
                webexShareVideoCsis.push(csi);
                cameraVideoCsis.delete(csi);
              } else if (cameraVideoCsis.size < 512) {
                cameraVideoCsis.add(csi);
              }
            }
          }
        }
      }
      if (node.state !== 'LEFT' && node.state !== 'REMOVED') {
        if (webexAudioCsis.length || webexShareCsis.length || webexShareVideoCsis.length) {
          let owned = webexParticipantOwnedCsis.get(id);
          if (!owned && webexParticipantOwnedCsis.size < 256) {
            owned = new Set<number>();
            webexParticipantOwnedCsis.set(id, owned);
          }
          if (owned) {
            for (const c of webexAudioCsis) if (owned.size < 64) owned.add(c);
            for (const c of webexShareCsis) if (owned.size < 64) owned.add(c);
            for (const c of webexShareVideoCsis) if (owned.size < 64) owned.add(c);
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
    const shareVideoRaw = [
      ...(Array.isArray(node.share_video_csis) ? node.share_video_csis : []),
      ...(Array.isArray(node.shareVideoCsis) ? node.shareVideoCsis : []),
      ...teamsShareVideoCsis,
      ...webexShareVideoCsis,
    ].filter(validCsi);
    const shareVideoTrackRaw = [
      ...(Array.isArray(node.share_video_track_ids) ? node.share_video_track_ids : []),
    ].filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256);
    const shareVideoStreamRaw = [
      ...(Array.isArray(node.share_video_stream_ids) ? node.share_video_stream_ids : []),
    ].filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256);
    const trackRaw = [
      node.track_id, node.trackId, node.audioTrackId,
      ...(Array.isArray(node.track_ids) ? node.track_ids : []),
    ].filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256);
    const streamRaw = [
      node.stream_id, node.streamId, node.msid,
      ...(Array.isArray(node.stream_ids) ? node.stream_ids : []),
    ].filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256);
    let entry = participants.get(id);
    if (
      !audioRaw.length &&
      !shareRaw.length &&
      !shareVideoRaw.length &&
      !shareVideoTrackRaw.length &&
      !shareVideoStreamRaw.length &&
      !trackRaw.length &&
      !streamRaw.length
    ) {
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
        share_video_csis: new Set(), share_video_track_ids: new Set(), share_video_stream_ids: new Set(),
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
    for (const csi of shareVideoRaw) {
      if (entry.share_video_csis.size < 64 && !entry.share_video_csis.has(csi)) {
        entry.share_video_csis.add(csi); changed = true;
      }
    }
    for (const tid of shareVideoTrackRaw) {
      if (entry.share_video_track_ids.size < 64 && !entry.share_video_track_ids.has(tid)) {
        entry.share_video_track_ids.add(tid); changed = true;
      }
    }
    for (const sid of shareVideoStreamRaw) {
      if (entry.share_video_stream_ids.size < 64 && !entry.share_video_stream_ids.has(sid)) {
        entry.share_video_stream_ids.add(sid); changed = true;
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

  const MEET_PRESENTATION_SUFFIX_RE =
    /\s*(?:\((?:Presentation|Präsentation)\)|['’]s\s+presentation|\s+is\s+presenting|\s+präsentiert)\s*$/i;

  function extractDomParticipantName(el: Element): string | null {
    const cleanCandidate = (raw: string): string | null => {
      const stripped = raw.replace(MEET_PRESENTATION_SUFFIX_RE, '').trim();
      return stripped && stripped.length >= 2 && stripped.length <= 120 && stripped !== 'fixture' ? stripped : null;
    };
    for (const attr of ['data-participant-name', 'data-self-name', 'data-display-name']) {
      const val = el.getAttribute(attr)?.trim();
      if (val && val.length <= 200 && val !== 'fixture') return cleanCandidate(val) ?? val;
    }
    if (el.getAttribute('data-cid') === 'calling-participant-stream') {
      const tidName = el.getAttribute('data-tid')?.trim();
      if (tidName && tidName.length <= 200 && !/^(?:calling-|video-|stage-|roster-|share-)/i.test(tidName)) {
        return cleanCandidate(tidName) ?? tidName;
      }
    }
    if (el.getAttribute('role') === 'listitem') {
      const aria = el.getAttribute('aria-label')?.trim();
      const cleanedAria = aria ? cleanCandidate(aria) : null;
      if (cleanedAria) return cleanedAria;
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
      if (attrVal && attrVal.length <= 200 && attrVal !== 'fixture') return cleanCandidate(attrVal) ?? attrVal;
    }
    for (const np of Array.from(el.querySelectorAll('.notranslate, [jsslot]')).slice(0, 16)) {
      if (np.children.length > 0 || np.closest('button') || np.closest('[role="tooltip"]')) continue;
      const cls = typeof np.className === 'string' ? np.className : '';
      if (/material-icons|google-symbols|google-material-icons/i.test(cls)) continue;
      const txt = (np.textContent || '').trim();
      if (
        txt &&
        !UI_CHROME_TEXT_RE.test(txt) &&
        !/^\d{1,2}:\d{2}(?::\d{2})?$/.test(txt) &&
        !/^(devices|mic|mic_off|mic_none|more_vert|keep|keep_off|keep_outline|push_pin|frame_person|visual_effects|volume_up|volume_off|present_to_all|screen_share|stop_screen_share|zoom_in|open_in_new|open_in_full)$/i.test(txt)
      ) {
        const cleaned = cleanCandidate(txt);
        if (cleaned) return cleaned;
      }
    }
    for (const child of Array.from(el.querySelectorAll('span, div, p')).slice(0, 64)) {
      if (
        child.children.length > 0 ||
        child.closest('button') ||
        child.closest('[role="tooltip"]') ||
        child.closest('[aria-hidden="true"]')
      ) {
        continue;
      }
      const cls = child.className || '';
      if (typeof cls === 'string' && /material-icons|google-symbols|google-material-icons/i.test(cls)) continue;
      const txt = (child.textContent || '').trim();
      if (txt && txt.length >= 2 && txt.length <= 120 && txt !== 'fixture' &&
          !UI_CHROME_TEXT_RE.test(txt) &&
          !/^\d{1,2}:\d{2}(?::\d{2})?$/.test(txt) &&
          !/^(devices|mic|mic_off|mic_none|more_vert|keep|keep_off|keep_outline|push_pin|frame_person|visual_effects|volume_up|volume_off|present_to_all|screen_share|stop_screen_share|zoom_in|open_in_new|open_in_full)$/i.test(txt)) {
        return cleanCandidate(txt) ?? txt;
      }
    }
    return null;
  }

  function parseAttrCsi(raw: string | null): number | null {
    if (!raw || !/^\d+$/.test(raw.trim())) return null;
    const num = Number(raw.trim());
    return validCsi(num) ? num : null;
  }

  function scanDomChatOptOut(): boolean {
    if (!document.body) return false;
    let updated = false;

    const handleDomChatEntry = (
      el: Element,
      candidateText: string,
      rawText: string,
      authorId: string | null,
      authorName: string | null,
    ) => {
      if (isChatOptOutMessage(candidateText) || isChatOptOutMessage(rawText)) {
        if (recordOptOutAuthor(authorId, authorName)) updated = true;
      }
      const prevSeen = seenDomChatElements.get(el);
      if (prevSeen === candidateText) return;
      seenDomChatElements.set(el, candidateText);

      const pauseCmd = parseChatPauseCommand(candidateText) ?? parseChatPauseCommand(rawText);
      if (pauseCmd) {
        if (applyPauseState(pauseCmd === 'pause', authorId, authorName)) {
          updated = true;
        }
      }
    };

    const chatItems = document.querySelectorAll(
      '[data-message-text], [data-sender-name], ' +
      '[data-tid="chat-pane-item"], [data-tid="chat-pane-message"], ' +
      '[role="alert"][data-sender-name], [aria-live] [data-message-text], ' +
      '.chat-item__container, .new-chat-message__container, .chat-message__text-box, ' +
      '[class*="chat-message"], [class*="chatMessage"], [class*="message-item"]'
    );
    let lastKnownSenderName: string | null = null;
    let lastKnownSenderId: string | null = null;
    for (const el of Array.from(chatItems).slice(0, 128)) {
      const explicitSenderId = (
        el.getAttribute('data-sender-id') ??
        el.getAttribute('data-participant-id') ??
        el.getAttribute('data-user-id') ??
        el.closest('[data-sender-id], [data-participant-id]')?.getAttribute('data-sender-id') ??
        el.closest('[data-sender-id], [data-participant-id]')?.getAttribute('data-participant-id') ??
        ''
      ).trim() || null;
      const senderSelector =
        '[data-sender-name], [data-tid="message-author-name"], [data-tid="chat-message-author"], ' +
        '.chat-item__sender, .new-chat-message__sender, [class*="sender-name"], [class*="senderName"], [class*="author-name"]';
      const itemContainer =
        el.parentElement?.closest(
          '[data-tid="chat-pane-item"], .chat-item__container, .chat-item__chat-info, .new-chat-message__container, ' +
          '[class*="chat-message"], [class*="chatMessage"], [class*="message-item"]'
        ) ??
        (el.parentElement &&
        el.parentElement !== document.body &&
        el.parentElement.querySelectorAll(
          '[data-tid="chat-pane-message"], .chat-message__text-box, .chat-message__text-content, [data-message-text]'
        ).length <= 1
          ? el.parentElement
          : null);
      const senderNode = el.querySelector(senderSelector) ?? itemContainer?.querySelector(senderSelector) ?? null;
      const explicitSenderName = (
        el.getAttribute('data-sender-name') ??
        el.closest('[data-sender-name]')?.getAttribute('data-sender-name') ??
        senderNode?.getAttribute('data-sender-name') ??
        senderNode?.textContent ??
        ''
      ).trim() || null;
      if (resolveChatSender(explicitSenderId, explicitSenderName).rejected) {
        lastKnownSenderName = null;
        lastKnownSenderId = null;
        continue;
      }
      if (explicitSenderName) {
        lastKnownSenderName = explicitSenderName;
      }
      if (explicitSenderId) {
        lastKnownSenderId = explicitSenderId;
      }
      const msgNode = el.querySelector(
        '[data-message-text], [data-tid="chat-pane-message"], .chat-message__text-content, .new-chat-message__text-box, [class*="message-text"], [class*="messageText"]'
      );
      const rawText = (
        el.getAttribute('data-message-text') ??
        msgNode?.getAttribute('data-message-text') ??
        msgNode?.textContent ??
        el.textContent ??
        ''
      ).trim();
      if (!rawText) continue;
      let candidateText = rawText;
      const authorName = explicitSenderName ?? lastKnownSenderName;
      const authorId = explicitSenderId ?? lastKnownSenderId;
      if (authorName && candidateText.startsWith(authorName)) {
        candidateText = candidateText.slice(authorName.length).replace(/^[\s•·:,-]+/, '').replace(/^\d{1,2}:\d{2}(?:\s*[AP]M)?[\s•·:,-]*/i, '').trim();
      }
      handleDomChatEntry(el, candidateText, rawText, authorId, authorName);
    }
    for (const msgEl of Array.from(document.querySelectorAll('[data-message-id]')).slice(0, 128)) {
      const msgText = (
        msgEl.querySelector('[jsname="dTKtvb"]')?.textContent ??
        msgEl.textContent ??
        ''
      ).trim();
      if (
        !msgText ||
        (!isChatOptOutMessage(msgText) &&
          !parseChatPauseCommand(msgText))
      ) {
        continue;
      }
      let senderName: string | null = null;
      let cur: Element | null = msgEl.parentElement;
      for (let depth = 0; depth < 5 && cur && cur !== document.body; depth++) {
        if (cur.children.length >= 2 && !cur.children[0].contains(msgEl)) {
          const headerEl = cur.children[0];
          const rawHeader = (
            headerEl.children.length >= 2
              ? headerEl.children[0].textContent
              : headerEl.textContent?.replace(/\s*\d{1,2}:\d{2}(?:\s*[AP]M)?$/i, '')
          )?.trim() || '';
          if (rawHeader && rawHeader.length <= 120) {
            senderName = rawHeader;
            break;
          }
        }
        cur = cur.parentElement;
      }
      if (senderName && isIgnoredParticipantName(senderName)) continue;
      handleDomChatEntry(msgEl, msgText, msgText, null, senderName);
    }
    for (const toastEl of Array.from(document.querySelectorAll('[data-key^="notification-"]')).slice(0, 32)) {
      for (const pair of Array.from(toastEl.querySelectorAll('div'))) {
        if (
          pair.children.length === 2 &&
          pair.children[0].children.length === 0 &&
          pair.children[1].children.length === 0
        ) {
          const senderName = (pair.children[0].textContent ?? '').trim();
          const msgText = (pair.children[1].textContent ?? '').trim();
          if (!senderName || !msgText || isIgnoredParticipantName(senderName)) continue;
          handleDomChatEntry(pair, msgText, msgText, null, senderName);
        }
      }
    }
    return updated;
  }

  function scanDomParticipants(): boolean {
    if (!document.body) return false;
    let updated = false;
    const seenLiveDom = new Set<string>();
    const nodes = document.querySelectorAll(
      '[data-participant-id], [data-requested-participant-id], [data-member-id], ' +
      '[data-endpoint-id], [data-user-id], [data-tid*="roster"], [data-tid*="video-tile"], ' +
      '[data-tid*="share"], [data-cid*="screen-sharing"], [data-cid="calling-participant-stream"], ' +
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
      const hasMeetPresentationMarker =
        config.provider === 'google_meet' &&
        (Array.from(el.querySelectorAll('.google-symbols, .material-icons, .google-material-icons'))
          .slice(0, 12)
          .some((ic) => /^(?:present_to_all|screen_share)$/.test((ic.textContent || '').trim())) ||
          /\((?:Presentation|Präsentation)\)|['’]s\s+presentation\b|\bPräsentation\s+von\b|\bis\s+presenting\b|\bpräsentiert\b/i.test(
            `${el.getAttribute('aria-label') ?? ''} ${(el.textContent ?? '').slice(0, 240)}`,
          ));
      const isScreencastTile =
        (rawId !== '' && meetScreencastParent.has(rawId)) ||
        hasMeetPresentationMarker ||
        el.getAttribute('data-is-screencast') === 'true' ||
        el.hasAttribute('data-screencast') ||
        el.getAttribute('data-is-presentation') === 'true' ||
        /^screensharing$/i.test(el.getAttribute('data-stream-type') ?? '') ||
        el.getAttribute('data-type') === 'screen-sharing' ||
        Boolean(
          el.querySelector(
            '[data-is-screencast="true"], [data-is-presentation="true"], [data-type="screen-sharing"], [data-stream-type="ScreenSharing"]',
          ),
        ) ||
        Boolean(el.closest('[data-is-screencast="true"], [data-is-presentation="true"]')) ||
        /screen-share|stage-share|sharing-stage|application-sharing|screen-sharing/i.test(
          `${el.getAttribute('data-tid') ?? ''} ${el.getAttribute('data-cid') ?? ''}`,
        );
      const mediaElements = Array.from(
        el.querySelectorAll('audio:not([data-wortlaut-keepalive]), video:not([data-wortlaut-keyframe-probe])'),
      ).slice(0, 8);
      const hasVirtualSelfVideo = mediaElements.some((media) => {
        const ownerTile = media.closest(
          '[data-participant-id], [data-requested-participant-id], [data-member-id], ' +
          '[data-endpoint-id], [data-user-id], [data-tid*="video-tile"], [data-cid="calling-participant-stream"]'
        );
        if (ownerTile && ownerTile !== el) return false;
        const src = (media as HTMLMediaElement).srcObject;
        return src instanceof MediaStream && src.getTracks().some(
          (t) => Boolean((t as MediaStreamTrack & {__wortlautVirtualVideo?: boolean}).__wortlautVirtualVideo),
        );
      });
      const isSelfTile = el.hasAttribute('data-self-name') ||
        Boolean(el.querySelector('[data-self-name]')) ||
        /\((?:Me|Ich)\)/i.test(zoomRowLabel) ||
        hasVirtualSelfVideo;
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
      const shareVideoStreamIds: string[] = [];
      const shareVideoTrackIds: string[] = [];
      for (const node of [el, ...Array.from(el.querySelectorAll('[data-ssrc], [data-csi], [data-csrc], [data-stream-id], [data-msid], [data-track-id], [data-audio-track-id]')).slice(0, 16)]) {
        for (const attr of ['data-ssrc', 'data-csi', 'data-csrc']) {
          const parsed = parseAttrCsi(node.getAttribute(attr));
          if (parsed !== null) csis.push(parsed);
        }
        for (const attr of ['data-stream-id', 'data-msid']) {
          const val = node.getAttribute(attr)?.trim();
          if (val && val.length <= 256) {
            if (isScreencastTile) shareVideoStreamIds.push(val);
            else streamIds.push(val);
          }
        }
        for (const attr of ['data-track-id', 'data-audio-track-id']) {
          const val = node.getAttribute(attr)?.trim();
          if (val && val.length <= 256) {
            if (isScreencastTile && attr === 'data-track-id') shareVideoTrackIds.push(val);
            else trackIds.push(val);
          }
        }
      }
      for (const media of mediaElements) {
        const src = (media as HTMLMediaElement).srcObject;
        if (src instanceof MediaStream) {
          if (src.getTracks().some(
            (t) => Boolean((t as MediaStreamTrack & {__wortlautVirtualVideo?: boolean}).__wortlautVirtualVideo),
          )) {
            continue;
          }
          if (media.tagName.toLowerCase() === 'video') {
            if (isScreencastTile) {
              if (src.id) {
                shareVideoStreamIds.push(src.id);
                if (meetSlideVideoStreamIds.size < 256) meetSlideVideoStreamIds.add(src.id);
                cameraVideoStreamIds.delete(src.id);
              }
              for (const vt of src.getVideoTracks()) {
                if (vt.id) {
                  shareVideoTrackIds.push(vt.id);
                  if (meetSlideVideoTrackIds.size < 256) meetSlideVideoTrackIds.add(vt.id);
                  cameraVideoTrackIds.delete(vt.id);
                }
              }
            } else {
              if (src.id && !meetSlideVideoStreamIds.has(src.id) && cameraVideoStreamIds.size < 512) {
                cameraVideoStreamIds.add(src.id);
              }
              for (const vt of src.getVideoTracks()) {
                if (vt.id && !meetSlideVideoTrackIds.has(vt.id) && cameraVideoTrackIds.size < 512) {
                  cameraVideoTrackIds.add(vt.id);
                }
              }
            }
          }
          if (!isScreencastTile) {
            if (src.id) streamIds.push(src.id);
            for (const t of src.getTracks()) if (t.id) trackIds.push(t.id);
          }
          for (const group of sdpCnames.values()) {
            const sharesStream = src.id && group.stream_ids.has(src.id);
            const sharesTrack = src.getTracks().some((t) => group.track_ids.has(t.id));
            if (sharesStream || sharesTrack) {
              if (!isScreencastTile) {
                csis.push(...group.audio_ssrcs);
                streamIds.push(...group.stream_ids);
                trackIds.push(...group.track_ids);
              }
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
      const mappedParentId = rawId && isScreencastTile ? (meetScreencastParent.get(rawId) ?? rawId) : rawId;
      if (isScreencastTile && rawId) {
        const existingScreenEntry = participants.get(rawId);
        if (existingScreenEntry) {
          for (const c of existingScreenEntry.audio_csis) {
            if (meetSlideVideoSsrcs.size < 256) meetSlideVideoSsrcs.add(c);
            cameraVideoCsis.delete(c);
            csis.push(c);
          }
          if (mappedParentId !== rawId) {
            participants.delete(rawId);
            totalParticipants = Math.max(0, totalParticipants - 1);
          }
        }
      }
      let resolvedTeamsRosterId = '';
      if (!mappedParentId && name && config.provider === 'teams') {
        const targetLower = name.trim().toLowerCase();
        const rosterMatches = [...participants.values()].filter(
          (p) =>
            !ignoredParticipantIds.has(p.participant_id) &&
            !p.participant_id.startsWith('dom:') &&
            Boolean(p.participant_name) &&
            p.participant_name!.trim().toLowerCase() === targetLower,
        );
        if (rosterMatches.length === 1) {
          resolvedTeamsRosterId = rosterMatches[0].participant_id;
        }
      }
      const effectiveId =
        mappedParentId ||
        resolvedTeamsRosterId ||
        (name &&
        !(config.provider === 'teams' && isScreencastTile) &&
        (streamIds.length || trackIds.length || csis.length || shareVideoStreamIds.length || shareVideoTrackIds.length)
          ? `dom:${streamIds[0] ?? trackIds[0] ?? shareVideoStreamIds[0] ?? shareVideoTrackIds[0] ?? csis[0]}`
          : '');
      if (effectiveId && (csis.length || streamIds.length || trackIds.length || shareVideoStreamIds.length || shareVideoTrackIds.length)) {
        const effectiveParticipantName =
          isScreencastTile && mappedParentId !== rawId
            ? (domNames.get(effectiveId) ?? protoNames.get(effectiveId) ?? participants.get(effectiveId)?.participant_name ?? name ?? null)
            : (name ?? domNames.get(effectiveId) ?? protoNames.get(effectiveId) ?? null);
        if (ingestParticipantRecord({
          participant_id: effectiveId,
          participant_name: effectiveParticipantName,
          ...(isScreencastTile ? {share_video_csis: csis} : {audio_csis: csis}),
          stream_ids: streamIds,
          track_ids: trackIds,
          share_video_stream_ids: shareVideoStreamIds,
          share_video_track_ids: shareVideoTrackIds,
        })) updated = true;
      }
    }
    liveDomCount = seenLiveDom.size;
    if (liveDomCount > 0) everSawDomParticipants = true;
    if (scanDomChatOptOut()) updated = true;
    if (syncOptOutCrossLinks()) updated = true;
    return updated;
  }

  let sdpHasApplication = false;

  function onRemoteDescription(sdp: string) {
    if (typeof sdp !== 'string' || !sdp || sdp.length > 524288) return;
    sdpStats.descriptions++;
    let currentMedia: 'audio' | 'video' | 'other' = 'other';
    const ssrcCname = new Map<number, string>();
    const ssrcMsid = new Map<number, {streamId: string; trackId?: string}>();
    let sectionMsid: {streamId: string; trackId?: string} | null = null;
    let sectionMid: string | null = null;
    let sectionIsSlides = false;
    let sectionSsrcs: number[] = [];
    const flushVideoSection = () => {
      if (currentMedia !== 'video' || !sectionIsSlides) return;
      if (sectionMid && meetSlideVideoMids.size < 128) meetSlideVideoMids.add(sectionMid);
      if (sectionMsid) {
        if (meetSlideVideoStreamIds.size < 256) meetSlideVideoStreamIds.add(sectionMsid.streamId);
        cameraVideoStreamIds.delete(sectionMsid.streamId);
        if (sectionMsid.trackId) {
          if (meetSlideVideoTrackIds.size < 256) meetSlideVideoTrackIds.add(sectionMsid.trackId);
          cameraVideoTrackIds.delete(sectionMsid.trackId);
        }
      }
      for (const ssrc of sectionSsrcs) {
        if (meetSlideVideoSsrcs.size < 256) meetSlideVideoSsrcs.add(ssrc);
        cameraVideoCsis.delete(ssrc);
      }
    };
    for (const rawLine of sdp.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.startsWith('m=audio ')) {
        flushVideoSection();
        currentMedia = 'audio'; sdpStats.audio_sections++;
        sectionMsid = null; sectionMid = null; sectionIsSlides = false; sectionSsrcs = [];
      } else if (line.startsWith('m=video ')) {
        flushVideoSection();
        currentMedia = 'video'; sdpStats.video_sections++;
        sectionMsid = null; sectionMid = null; sectionIsSlides = false; sectionSsrcs = [];
      } else if (line.startsWith('m=')) {
        flushVideoSection();
        if (line.startsWith('m=application ')) sdpHasApplication = true;
        currentMedia = 'other';
        sectionMsid = null; sectionMid = null; sectionIsSlides = false; sectionSsrcs = [];
      } else if (line.startsWith('a=mid:')) {
        const mid = line.slice(6).trim();
        if (mid && mid.length <= 64) sectionMid = mid;
      } else if (
        currentMedia === 'video' &&
        (line === 'a=content:slides' ||
          /^a=content:.*\bslides\b/i.test(line) ||
          /^a=label:.*(?:screen|slides|presentation)/i.test(line))
      ) {
        sectionIsSlides = true;
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
        if (currentMedia === 'video' && sectionSsrcs.length < 64 && !sectionSsrcs.includes(ssrc)) {
          sectionSsrcs.push(ssrc);
        }
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
            if (sectionMsid && currentMedia === 'audio') {
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
    flushVideoSection();
    for (const [ssrc, msid] of ssrcMsid) {
      if (meetSlideVideoSsrcs.has(ssrc)) {
        if (meetSlideVideoStreamIds.size < 256) meetSlideVideoStreamIds.add(msid.streamId);
        cameraVideoStreamIds.delete(msid.streamId);
        if (msid.trackId) {
          if (meetSlideVideoTrackIds.size < 256) meetSlideVideoTrackIds.add(msid.trackId);
          cameraVideoTrackIds.delete(msid.trackId);
        }
        continue;
      }
      const cname = ssrcCname.get(ssrc);
      const group = cname ? sdpCnames.get(cname) : undefined;
      if (group) {
        if (group.stream_ids.size < 64) group.stream_ids.add(msid.streamId);
        if (msid.trackId && group.track_ids.size < 64) group.track_ids.add(msid.trackId);
      }
    }
    let updated = scanDomParticipants();
    for (const [cname, group] of sdpCnames) {
      if (!group.audio_ssrcs.size && !group.video_ssrcs.size && !group.stream_ids.size && !group.track_ids.size) continue;
      const matchedId = (domNames.has(cname) || protoNames.has(cname) || participants.has(cname))
        ? cname
        : [...group.stream_ids].find((sid) => domNames.has(sid) || protoNames.has(sid) || participants.has(sid)) ??
          [...participants.values()].find((p) => [...group.audio_ssrcs].some((s) => p.audio_csis.has(s)))?.participant_id;
      if (matchedId) {
        const slideSsrcs = [...group.video_ssrcs].filter((s) => meetSlideVideoSsrcs.has(s));
        const slideStreamIds: string[] = [];
        const slideTrackIds: string[] = [];
        for (const s of slideSsrcs) {
          const m = ssrcMsid.get(s);
          if (m) {
            slideStreamIds.push(m.streamId);
            if (m.trackId) slideTrackIds.push(m.trackId);
          }
        }
        if (ingestParticipantRecord({
          participant_id: matchedId,
          participant_name: domNames.get(matchedId) ?? protoNames.get(matchedId) ?? null,
          audio_csis: [...group.audio_ssrcs],
          stream_ids: [...group.stream_ids],
          track_ids: [...group.track_ids],
          share_video_csis: slideSsrcs,
          share_video_stream_ids: slideStreamIds,
          share_video_track_ids: slideTrackIds,
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
                    if (webexSlotSsrcToCsi.size < 128) webexSlotSsrcToCsi.set(slotSsrc, stCsi);
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
            } else if (outer.mediaFamily === 'VIDEO' && outer.payload && typeof outer.payload === 'object') {
              const inner = outer.payload as Record<string, unknown>;
              const innerPayload = inner.payload && typeof inner.payload === 'object'
                ? (inner.payload as Record<string, unknown>) : undefined;
              const isSlides = String(outer.mediaContent ?? '').toUpperCase() === 'SLIDES';
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
                  if (!validCsi(slotSsrc)) continue;
                  if (isSlides) {
                    const pid = validCsi(stCsi) ? findWebexParticipantByCsi(stCsi) : null;
                    if (pid && pid !== webexSelfParticipantId) {
                      webexSlideVideoSsrcToParticipant.set(slotSsrc, pid);
                      cameraVideoCsis.delete(slotSsrc);
                      for (const [entryId, entry] of participants) {
                        if (entryId === pid) {
                          if (entry.share_video_csis.size < 64) entry.share_video_csis.add(slotSsrc);
                        } else {
                          entry.share_video_csis.delete(slotSsrc);
                        }
                      }
                      updated = true;
                    } else {
                      webexSlideVideoSsrcToParticipant.delete(slotSsrc);
                    }
                  } else {
                    if (cameraVideoCsis.size < 512) cameraVideoCsis.add(slotSsrc);
                    webexSlideVideoSsrcToParticipant.delete(slotSsrc);
                    for (const entry of participants.values()) entry.share_video_csis.delete(slotSsrc);
                  }
                }
              }
            }
          }
        }
        if (ingestParticipantRecord(record)) {
          syncOptOutCrossLinks();
          updated = true;
        }
        const explicitChatText = record.chatMessage ?? record.chat_text ?? record.messageText;
        const chatBodyCandidate = explicitChatText ?? record.text ??
          record.content ?? record.msg ??
          (typeof record.body === 'string' && !record.body.startsWith('{') && !record.body.startsWith('[') && !record.body.startsWith('H4sI') ? record.body : undefined);
        if (typeof chatBodyCandidate === 'string') {
          const isOptOut = isChatOptOutMessage(chatBodyCandidate, explicitChatText !== undefined);
          const pauseCmd = parseChatPauseCommand(chatBodyCandidate);
          if (isOptOut || pauseCmd) {
            const fromObj = record.from && typeof record.from === 'object' ? (record.from as Record<string, unknown>) : undefined;
            const senderObj = record.sender && typeof record.sender === 'object' ? (record.sender as Record<string, unknown>) : undefined;
            const userObj = (fromObj?.user && typeof fromObj.user === 'object' ? (fromObj.user as Record<string, unknown>) : undefined) ??
              (senderObj?.user && typeof senderObj.user === 'object' ? (senderObj.user as Record<string, unknown>) : undefined);
            const sId = [
              record.senderId, record.sender_id, record.participantId, record.participant_id,
              record.authorId, record.author_id, record.userId, record.user_id, record.fromId,
              fromObj?.id, senderObj?.id, userObj?.id,
            ].find((v) => (typeof v === 'string' && v.trim()) || (typeof v === 'number' && Number.isFinite(v)));
            const sName = [
              record.senderName, record.sender_name, record.displayName, record.display_name,
              record.authorName, record.author_name, record.userName, record.user_name, record.imDisplayName,
              fromObj?.name, fromObj?.displayName, senderObj?.name, senderObj?.displayName, userObj?.displayName,
            ].find((v): v is string => typeof v === 'string' && Boolean(v.trim()));
            const resolvedId = sId !== undefined ? String(sId) : null;
            const resolvedName = sName ?? null;
            if (isOptOut && recordOptOutAuthor(resolvedId, resolvedName)) {
              updated = true;
            }
            if (pauseCmd && applyPauseState(pauseCmd === 'pause', resolvedId, resolvedName)) {
              updated = true;
            }
          }
        }
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

  function isProtobufSubmessage(bytes: Uint8Array): boolean {
    if (bytes.byteLength < 2) return false;
    let offset = 0, tags = 0, hasControlByte = false;
    for (let i = 0; i < bytes.byteLength; i++) {
      const b = bytes[i];
      if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) {
        hasControlByte = true;
        break;
      }
    }
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
    while (offset < bytes.byteLength && tags < 512) {
      const tag = readVarint();
      if (tag === null || tag <= 0) return false;
      const fieldNo = Math.floor(tag / 8);
      const wireType = tag & 7;
      if (fieldNo < 1 || fieldNo > 16384) return false;
      tags++;
      if (wireType === 0) {
        if (readVarint() === null) return false;
      } else if (wireType === 1) {
        if (offset + 8 > bytes.byteLength) return false;
        offset += 8;
      } else if (wireType === 5) {
        if (offset + 4 > bytes.byteLength) return false;
        offset += 4;
      } else if (wireType === 2) {
        const len = readVarint();
        if (len === null || len < 0 || offset + len > bytes.byteLength) return false;
        offset += len;
      } else {
        return false;
      }
    }
    if (offset !== bytes.byteLength || tags === 0) return false;
    if (hasControlByte) return true;
    if (tags >= 2) {
      if (bytes[0] < 0x20) return true;
      const text = new TextDecoder('utf-8', {fatal: false}).decode(bytes);
      if (/(?:spaces\/[^/\s]+\/)?devices\/[^/\s]+/.test(text)) return true;
    }
    return false;
  }

  function isKnownAudioParticipant(devId: string): boolean {
    for (const [rcv] of sources) {
      if (lastResolvedBindings.get(rcv)?.signaled_participant_id === devId) return true;
    }
    return false;
  }

  function registerMeetScreencastDevice(screencastDev: string, presenterDev: string): boolean {
    if (
      !screencastDev ||
      !presenterDev ||
      screencastDev === presenterDev ||
      ignoredParticipantIds.has(screencastDev) ||
      ignoredParticipantIds.has(presenterDev) ||
      isKnownAudioParticipant(screencastDev)
    ) {
      return false;
    }
    let changed = false;
    if (meetScreencastParent.size < 128 && meetScreencastParent.get(screencastDev) !== presenterDev) {
      meetScreencastParent.set(screencastDev, presenterDev);
      changed = true;
    }
    const existing = participants.get(screencastDev);
    if (existing) {
      const movedCsis = [...existing.audio_csis, ...existing.share_video_csis];
      for (const c of movedCsis) {
        if (meetSlideVideoSsrcs.size < 256) meetSlideVideoSsrcs.add(c);
        cameraVideoCsis.delete(c);
      }
      if (movedCsis.length > 0) {
        if (
          ingestParticipantRecord({
            participant_id: presenterDev,
            participant_name:
              participants.get(presenterDev)?.participant_name ??
              domNames.get(presenterDev) ??
              protoNames.get(presenterDev) ??
              existing.participant_name ??
              null,
            share_video_csis: movedCsis,
          })
        ) {
          changed = true;
        }
      }
      participants.delete(screencastDev);
      totalParticipants = Math.max(0, totalParticipants - 1);
      changed = true;
    }
    return changed;
  }

  function parseProtobufPayload(
    bytes: Uint8Array,
    stat: ReturnType<typeof getChannelStat>,
    depth = 0,
  ): {updated: boolean; deviceIds: string[]; csis: number[]} {
    if (depth > 8 || bytes.byteLength < 2 || bytes.byteLength > 262144) {
      return {updated: false, deviceIds: [], csis: []};
    }
    let offset = 0, tags = 0, updated = false;
    const strings: string[] = [];
    const ints: number[] = [];
    const childDeviceIds: string[] = [];
    const childCsis: number[] = [];
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
    while (offset < bytes.byteLength && tags < 512) {
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
        if (len > 0 && len <= 65536 && (slice[0] === 0x7b || slice[0] === 0x5b)) {
          const decoded = new TextDecoder('utf-8', {fatal: false}).decode(slice);
          if (parseJsonText(decoded, stat)) {
            updated = true;
            continue;
          }
        }
        if (depth < 8 && len >= 2 && isProtobufSubmessage(slice)) {
          const sub = parseProtobufPayload(slice, stat, depth + 1);
          if (sub.updated) updated = true;
          for (const d of sub.deviceIds) {
            if (childDeviceIds.length < 16 && !childDeviceIds.includes(d)) childDeviceIds.push(d);
          }
          for (const c of sub.csis) {
            if (childCsis.length < 32 && !childCsis.includes(c)) childCsis.push(c);
          }
          continue;
        }
        if (len > 0 && len <= 200) {
          const decoded = new TextDecoder('utf-8', {fatal: false}).decode(slice);
          if (!decoded.includes('\ufffd') && /^[\x20-\x7e\u00a0-\ufffc]+$/.test(decoded)) {
            const trimmed = decoded.trim();
            if (/^\d{3,10}$/.test(trimmed)) {
              const num = Number(trimmed);
              if (validCsi(num) && num >= 100 && ints.length < 32) ints.push(num);
            } else if (trimmed) {
              strings.push(trimmed);
            }
          }
        } else if (depth < 8 && len > 200) {
          const sub = parseProtobufPayload(slice, stat, depth + 1);
          if (sub.updated) updated = true;
          for (const d of sub.deviceIds) {
            if (childDeviceIds.length < 16 && !childDeviceIds.includes(d)) childDeviceIds.push(d);
          }
          for (const c of sub.csis) {
            if (childCsis.length < 32 && !childCsis.includes(c)) childCsis.push(c);
          }
        }
      } else {
        break;
      }
    }
    const isDeviceId = (s: string) =>
      domNames.has(s) || protoNames.has(s) || participants.has(s) || /^(?:spaces\/[^/\s]+\/)?devices\/[^/\s]+$/.test(s);
    const matchedIds = [...new Set(strings.filter(isDeviceId))];
    if (strings.length > 0) {
      scanDomParticipants();
      if (config.provider === 'google_meet') {
        if (matchedIds.length === 2) {
          const [firstDev, secondDev] = matchedIds;
          const [screencastDev, presenterDev] = isKnownAudioParticipant(firstDev) && !isKnownAudioParticipant(secondDev)
            ? [secondDev, firstDev]
            : [firstDev, secondDev];
          if (registerMeetScreencastDevice(screencastDev, presenterDev)) updated = true;
        } else if (matchedIds.length === 1) {
          const selfDev = matchedIds[0];
          const otherChildDevs = childDeviceIds.filter((d) => d !== selfDev);
          if (otherChildDevs.length === 1 && !isKnownAudioParticipant(selfDev)) {
            const presenterDev = otherChildDevs[0];
            if (registerMeetScreencastDevice(selfDev, presenterDev)) updated = true;
            const allDevCsis = [...new Set([...ints, ...childCsis])];
            if (allDevCsis.length > 0) {
              for (const c of allDevCsis) {
                if (meetSlideVideoSsrcs.size < 256) meetSlideVideoSsrcs.add(c);
                cameraVideoCsis.delete(c);
              }
              if (
                ingestParticipantRecord({
                  participant_id: presenterDev,
                  participant_name: domNames.get(presenterDev) ?? protoNames.get(presenterDev) ?? null,
                  share_video_csis: allDevCsis,
                })
              ) {
                updated = true;
              }
            }
          }
        }
      }
      const matchedId = matchedIds.length === 1 ? matchedIds[0] : null;
      const isNameCandidate = (s: string, excludeA?: string | null, excludeB?: string | null) =>
        s !== excludeA &&
        s !== excludeB &&
        !isDeviceId(s) &&
        s.length >= 2 &&
        s.length <= 120 &&
        !/^\d+$/.test(s) &&
        !/https?:\/\/|googleusercontent\.com/i.test(s) &&
        !/^(?:spaces\/|devices\/|collections\/|conferenceRecords\/|users\/|FID$)/i.test(s) &&
        !/^(?:audio|video|application|text|image)\/[a-z0-9.+-]+$/i.test(s) &&
        !/^[a-z]{2}(?:-[A-Z]{2})?$/.test(s) &&
        !/^[A-Za-z0-9+/=_-]{20,}$/.test(s);
      const optOutStr = strings.find((s) => isChatOptOutMessage(s, false));
      const pauseStr = strings.find((s) => parseChatPauseCommand(s) !== null);
      const chatCommandStr = optOutStr ?? pauseStr;
      if (chatCommandStr && matchedIds.length <= 1) {
        const senderNameCandidate = (matchedId
          ? (domNames.get(matchedId) ?? protoNames.get(matchedId) ?? participants.get(matchedId)?.participant_name)
          : null) ??
          strings.find((s) => isNameCandidate(s, chatCommandStr, matchedId)) ?? null;
        if (optOutStr && recordOptOutAuthor(matchedId, senderNameCandidate)) {
          updated = true;
        }
        if (pauseStr) {
          const cmd = parseChatPauseCommand(pauseStr);
          if (cmd && applyPauseState(cmd === 'pause', matchedId, senderNameCandidate)) {
            updated = true;
          }
        }
      }
      if (matchedId && !ignoredParticipantIds.has(matchedId)) {
        const screencastPresenter = meetScreencastParent.get(matchedId);
        if (screencastPresenter) {
          if (ints.length > 0) {
            for (const c of ints) {
              if (meetSlideVideoSsrcs.size < 256) meetSlideVideoSsrcs.add(c);
              cameraVideoCsis.delete(c);
            }
            if (
              ingestParticipantRecord({
                participant_id: screencastPresenter,
                participant_name: domNames.get(screencastPresenter) ?? protoNames.get(screencastPresenter) ?? null,
                share_video_csis: ints,
              })
            ) {
              updated = true;
            }
          }
        } else {
          const protoName = strings.find((s) => isNameCandidate(s, matchedId, chatCommandStr)) ?? null;
          if (protoName && isIgnoredParticipantName(protoName)) {
            if (!domNames.has(matchedId) && !protoNames.has(matchedId)) {
              ignoredParticipantIds.add(matchedId);
              participants.delete(matchedId);
            }
          } else {
            if (protoName && !domNames.has(matchedId) && !protoNames.has(matchedId)) {
              if (protoNames.size < 256) protoNames.set(matchedId, protoName);
              const existing = participants.get(matchedId);
              if (existing && !existing.participant_name) {
                existing.participant_name = protoName;
                updated = true;
              }
            }
            if (ints.length > 0) {
              const candidateName = domNames.get(matchedId) ?? protoNames.get(matchedId) ?? null;
              if (ingestParticipantRecord({
                participant_id: matchedId,
                participant_name: candidateName,
                audio_csis: ints,
              })) updated = true;
            }
          }
        }
      }
    }
    const allSeenDevices = [...new Set([...matchedIds, ...childDeviceIds])].slice(0, 16);
    const allSeenCsis = [...new Set([...ints, ...childCsis])].slice(0, 32);
    return {updated, deviceIds: allSeenDevices, csis: allSeenCsis};
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
    if (parseProtobufPayload(bytes, stat, 0).updated) {
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
    const isRealSfuConnection =
      sdpHasApplication ||
      channelStats.has('collections') ||
      (pc.getConfiguration?.().iceServers?.length ?? 0) > 0 ||
      [...(window.wortlautMeetReceivers.dataChannels ?? [])].some((dc) => dc.label === 'collections') ||
      /\bm=application\b/.test(pc.remoteDescription?.sdp ?? '') ||
      /\bm=application\b/.test(pc.localDescription?.sdp ?? '');
    const entry: EncodedObservation = {
      id: ++nextObservation, pc,
      evidence: {state: observerState === 'ready' ? 'waiting_frames' : observerState,
        frame_count: 0, last_frame: null},
    };
    observations.set(receiver, entry);
    if (receiver.transform) entry.evidence.state = 'provider_transform';
    else if (encodedReserved.has(pc)) entry.evidence.state = 'provider_reserved';
    else if (observerState === 'ready' && observer) {
      if ((config.provider ?? 'google_meet') === 'google_meet' && !isRealSfuConnection) {
        try {
          entry.transform = new RTCRtpScriptTransform(observer, {id: entry.id});
          receiver.transform = entry.transform;
        } catch { entry.transform = undefined; entry.evidence.state = 'failed'; }
      } else {
        entry.evidence.state = 'unsupported';
      }
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
  const keepaliveAudios = new Map<RTCRtpReceiver, {el: HTMLAudioElement; track: MediaStreamTrack}>();
  const receiverStats = new Map<RTCRtpReceiver, InboundAudioStats>();
  let peerStats: MediaState['peer_connections'] = [];
  let statsAt: number | undefined;
  const finite = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  async function refreshMediaStats() {
    for (const receiver of sources.keys()) {
      const report = await receiver.getStats();
      let best: Record<string, unknown> | undefined;
      let codec: string | null = null;
      report.forEach((stat: Record<string, unknown>) => {
        if (stat.type === 'inbound-rtp' && stat.kind === 'audio' &&
            finite(stat.packetsReceived) >= finite(best?.packetsReceived)) best = stat;
      });
      if (best && typeof best.codecId === 'string') {
        const entry = report.get(best.codecId) as Record<string, unknown> | undefined;
        codec = typeof entry?.mimeType === 'string' ? entry.mimeType : null;
      }
      const lastPacket = best?.lastPacketReceivedTimestamp;
      receiverStats.set(receiver, {
        packets_received: finite(best?.packetsReceived),
        bytes_received: finite(best?.bytesReceived),
        packets_lost: Math.max(0, finite(best?.packetsLost)),
        jitter_buffer_emitted_count: finite(best?.jitterBufferEmittedCount),
        total_samples_received: finite(best?.totalSamplesReceived),
        concealed_samples: finite(best?.concealedSamples),
        silent_concealed_samples: finite(best?.silentConcealedSamples),
        total_audio_energy: finite(best?.totalAudioEnergy),
        audio_level: typeof best?.audioLevel === 'number' ? best.audioLevel : null,
        last_packet_ms_ago: typeof lastPacket === 'number' && typeof best?.timestamp === 'number'
          ? Math.max(0, Math.round(best.timestamp - lastPacket)) : null,
        codec,
      });
    }
    for (const receiver of receiverStats.keys()) if (!sources.has(receiver)) receiverStats.delete(receiver);
    const next: MediaState['peer_connections'] = [];
    const frameConnections = window.wortlautMeetReceivers.frameConnections ?? new Set<RTCPeerConnection>();
    for (const [pc, inFrame] of [...[...connections].map((c) => [c, false] as const),
      ...[...frameConnections].map((c) => [c, true] as const)]) {
      if (next.length >= 16) break;
      if (pc.connectionState === 'closed') { if (inFrame) frameConnections.delete(pc); continue; }
      const report = await pc.getStats();
      let dtls: string | null = null, pairId: string | undefined, inboundPackets = 0;
      report.forEach((stat: Record<string, unknown>) => {
        if (stat.type === 'transport') {
          if (typeof stat.dtlsState === 'string') dtls = stat.dtlsState;
          if (typeof stat.selectedCandidatePairId === 'string') pairId = stat.selectedCandidatePairId;
        }
        if (stat.type === 'inbound-rtp' && stat.kind === 'audio') inboundPackets += finite(stat.packetsReceived);
      });
      const pair = pairId ? report.get(pairId) as Record<string, unknown> | undefined : undefined;
      next.push({connection_state: pc.connectionState, ice_connection_state: pc.iceConnectionState,
        dtls_state: dtls, selected_pair_state: typeof pair?.state === 'string' ? pair.state : null,
        selected_pair_bytes_received: pair ? finite(pair.bytesReceived) : null, in_frame: inFrame,
        audio_receivers: pc.getReceivers().filter((r) => r.track?.kind === 'audio').length,
        inbound_audio_packets: inboundPackets});
    }
    peerStats = next;
    statsAt = performance.now();
  }
  let refreshingStats = false;
  const statsInterval = setInterval(() => {
    if (refreshingStats) return;
    refreshingStats = true;
    void refreshMediaStats().catch(() => {}).finally(() => { refreshingStats = false; });
  }, 2000);
  function mediaState(): MediaState {
    const meet = [...document.querySelectorAll<HTMLAudioElement>('audio:not([data-wortlaut-keepalive])')]
      .filter((el) => el.srcObject instanceof MediaStream);
    const keepalive = [...keepaliveAudios.values()].map((entry) => entry.el);
    const capturedTracks = new Set<string>();
    for (const pc of connections) {
      for (const receiver of pc.getReceivers()) if (receiver.track) capturedTracks.add(receiver.track.id);
    }
    const foreign = new Set<string>();
    for (const el of meet) {
      for (const track of (el.srcObject as MediaStream).getAudioTracks()) {
        if (track.readyState === 'live' && !capturedTracks.has(track.id)) foreign.add(track.id);
      }
    }
    return {
      peer_connections: peerStats,
      audio_elements: {meet_total: meet.length, meet_playing: meet.filter((el) => !el.paused).length,
        meet_muted: meet.filter((el) => el.muted).length, meet_foreign_tracks: foreign.size,
        keepalive_total: keepalive.length, keepalive_playing: keepalive.filter((el) => !el.paused).length},
      frames: window.frames.length,
      stats_age_ms: statsAt === undefined ? null : Math.round(performance.now() - statsAt),
    };
  }
  let nextSource = 0;
  let pendingBytes = 0, pendingMessages = 0;
  let bridge: Promise<void> = Promise.resolve();
  let bridgeFailed = false;
  let inspecting: Promise<void> | undefined;
  let inspectAgain = false;
  let stopping: Promise<boolean> | undefined;

  function send(message: MeetBridgeMessage, bytes: number) {
    if (bridgeFailed) return;
    if (pendingMessages >= 256 || pendingBytes + bytes > 12 * 1024 * 1024) {
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
    isOptedOut: (b: Binding) =>
      isParticipantOptedOut(b.participant_id ?? b.speaker_id, b.participant_name),
    chunk: (metadata: Chunk, pcm: Uint8Array) => {
      // Five-second blocks, not one RPC per AudioWorklet render quantum.
      const optedOut = isParticipantOptedOut(metadata.participant_id ?? metadata.speaker_id, metadata.participant_name);
      const silenceChunk = optedOut || capturePaused;
      const effectivePcm = silenceChunk ? new Uint8Array(pcm.length) : pcm;
      let raw = '';
      for (let offset = 0; offset < effectivePcm.length; offset += 8192) {
        raw += String.fromCharCode(...effectivePcm.subarray(offset, offset + 8192));
      }
      const encoded = btoa(raw);
      send({attempt_id: config.attempt_id, type: 'chunk', metadata, pcm: encoded}, encoded.length + 8192);
      state.audio_samples += metadata.sample_count;
      let chunkActive = false;
      if (!silenceChunk) {
        const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
        for (let i = 0; i + 1 < pcm.byteLength; i += 2) {
          if (Math.abs(view.getInt16(i, true)) >= 200) {
            state.active_audio_samples += metadata.sample_count;
            chunkActive = true;
            break;
          }
        }
      }
      for (const source of sources.values()) {
        if (source.id === metadata.provider_source_id) {
          source.silentSamples = chunkActive || silenceChunk ? 0 : (source.silentSamples ?? 0) + metadata.sample_count;
          break;
        }
      }
    },
    activity: ({level, provider_source_id, participant_id, participant_name, speaker_id}) => {
      if (provider_source_id && level >= 0.025) {
        sourceLastVoicedAt.set(provider_source_id, performance.now());
        if (config.provider === 'webex' && updateWebexActiveSpeakerBindings()) {
          void inspectReceivers();
        }
      }
      if (capturePaused || isParticipantOptedOut(participant_id ?? speaker_id, participant_name)) {
        return;
      }
      window.wortlautVideoTile?.reportAudioActivity?.(level, participant_name ?? null);
    },
    error: (reason) => { state.reason = reason; }};

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
    const hookedMeta = encodedFrameMeta?.get(receiver);
    const recentCsrcs = recentRtpSources(receiver.getContributingSources()).filter(validCsi);
    const csrcs = [...new Set(
      recentCsrcs.length > 0
        ? recentCsrcs
        : (Array.isArray(lastFrame?.contributing_sources)
            ? (lastFrame.contributing_sources as number[])
            : (hookedMeta?.csrcs ?? [])
          ).filter(validCsi),
    )];
    const recentSsrcs = recentRtpSources(receiver.getSynchronizationSources()).filter(validCsi);
    const ssrcs = [...new Set(
      recentSsrcs.length > 0
        ? recentSsrcs
        : (validCsi(lastFrame?.synchronization_source)
            ? [lastFrame.synchronization_source]
            : validCsi(hookedMeta?.ssrc) ? [hookedMeta.ssrc] : []
          ).filter(validCsi),
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
          const recvTransceivers = new Set<RTCRtpReceiver>();
          if (typeof pc.getTransceivers === 'function') {
            for (const tr of pc.getTransceivers()) {
              if (tr.receiver && (tr.currentDirection === 'recvonly' || tr.currentDirection === 'sendrecv')) {
                recvTransceivers.add(tr.receiver);
              }
            }
          }
          for (const receiver of pc.getReceivers()) {
            if ((received.has(receiver) || recvTransceivers.has(receiver)) &&
                receiver.track?.kind === 'audio' && receiver.track.readyState === 'live') {
              if (!unmuteHookedTracks.has(receiver.track)) {
                unmuteHookedTracks.add(receiver.track);
                receiver.track.addEventListener('unmute', () => { void inspectReceivers(); });
              }
              const receiverActive =
                !receiver.track.muted ||
                receiver.getSynchronizationSources().length > 0 ||
                receiver.getContributingSources().length > 0 ||
                Boolean(receiver.transform) ||
                encodedReserved.has(pc) ||
                observations.has(receiver);
              if (receiverActive) observe(receiver, pc);
              live.add(receiver);
            }
          }
        }
        if (live.size > 64) { state.reason = 'audio_source_limit'; return; }
        const domAudioTracks = new Set<MediaStreamTrack>();
        for (const el of document.querySelectorAll<HTMLAudioElement>('audio:not([data-wortlaut-keepalive])')) {
          const stream = el.srcObject instanceof MediaStream ? el.srcObject : null;
          if (!stream) continue;
          const tracks = stream.getAudioTracks().filter((t) => t.readyState === 'live');
          if (!tracks.length) continue;
          for (const t of tracks) domAudioTracks.add(t);
          if (el.muted) el.muted = false;
          if (el.volume < 1) el.volume = 1;
          if (el.paused) void el.play().catch(() => {});
        }
        for (const [receiver, ka] of keepaliveAudios) {
          if (!live.has(receiver) || ka.track !== receiver.track || domAudioTracks.has(receiver.track)) {
            ka.el.pause();
            ka.el.srcObject = null;
            ka.el.remove();
            keepaliveAudios.delete(receiver);
          } else if (ka.el.paused) {
            void ka.el.play().catch(() => {});
          }
        }
        for (const receiver of live) {
          if (!domAudioTracks.has(receiver.track) && !keepaliveAudios.has(receiver)) {
            try {
              const el = document.createElement('audio');
              el.dataset.wortlautKeepalive = '1';
              el.autoplay = true;
              el.muted = false;
              el.volume = 1;
              el.style.display = 'none';
              el.srcObject = receiverMediaStreams?.get(receiver) ?? new MediaStream([receiver.track]);
              document.body?.append(el);
              void el.play().catch(() => {});
              keepaliveAudios.set(receiver, {el, track: receiver.track});
            } catch { /* ignore headless audio element errors */ }
          }
        }
        const hasSignaledOrDomParticipants = participants.size > 0 || liveDomCount > 0;
        const silentCaptureWithParticipants =
          hasSignaledOrDomParticipants &&
          state.active_audio_samples === 0 &&
          state.audio_samples >= 16000 * 10;
        for (const [receiver, entry] of observations) {
          if (!live.has(receiver)) { detachObservation(receiver); continue; }
          if (!entry.transform) continue;
          if (receiver.transform !== entry.transform) {
            if (entry.evidence.state !== 'replaced') observer?.postMessage({type: 'forget', id: entry.id});
            entry.evidence.state = 'replaced'; continue;
          }
          if (entry.evidence.state === 'waiting_frames' && entry.evidence.frame_count === 0) {
            entry.waitingSince ??= performance.now();
          } else {
            entry.waitingSince = undefined;
          }
          const stalledWaitingFrames =
            entry.waitingSince !== undefined && performance.now() - entry.waitingSince >= 1000;
          if ((silentCaptureWithParticipants || stalledWaitingFrames) &&
              entry.evidence.state === 'waiting_frames' && entry.evidence.frame_count === 0) {
            receiver.transform = null; entry.transform = undefined; entry.waitingSince = undefined;
            entry.evidence.state = 'unsupported';
            observer?.postMessage({type: 'forget', id: entry.id});
            continue;
          }
          if (entry.requestedAt !== undefined && performance.now() - entry.requestedAt > 5000) {
            observerState = 'failed';
            state.reason = 'encoded_transform_failed';
            for (const [otherReceiver, otherEntry] of observations) {
              if (otherEntry.transform && otherReceiver.transform === otherEntry.transform) {
                otherReceiver.transform = null;
                otherEntry.transform = undefined;
                otherEntry.requestedAt = undefined;
                otherEntry.evidence.state = 'failed';
              }
            }
            observer?.terminate();
            break;
          }
          if (entry.requestedAt === undefined && observerState === 'ready') {
            entry.requestedAt = performance.now(); observer?.postMessage({type: 'snapshot', id: entry.id});
          }
        }
        for (const [receiver, source] of sources) {
          const rtpStat = receiverStats.get(receiver);
          const rtpHasDecodedEnergy =
            (rtpStat?.jitter_buffer_emitted_count ?? 0) >= 48000 &&
            (rtpStat?.total_audio_energy ?? 0) > 0.001;
          const forceReattach =
            hasSignaledOrDomParticipants &&
            state.active_audio_samples === 0 &&
            rtpHasDecodedEnergy &&
            (source.silentSamples ?? 0) >= 16000 * 10 &&
            !source.recovered &&
            source.track === receiver.track;
          if (!live.has(receiver) || receiver.track !== source.track || forceReattach) {
            if (source.track && ![...sources].some(([other, entry]) => other !== receiver &&
                live.has(other) && entry.track === source.track)) await capture.detach(source.track);
            if (!live.has(receiver)) sources.delete(receiver);
            else {
              if (forceReattach) {
                source.recovered = true;
                source.silentSamples = 0;
              }
              source.track = undefined;
            }
          }
        }
        if (config.provider === 'webex') {
          updateWebexActiveSpeakerBindings();
        }
        for (const receiver of live) {
          let source = sources.get(receiver);
          if (!source) {
            const obs = observations.get(receiver);
            const hasRtp = !receiver.track.muted ||
              receiver.getSynchronizationSources().length > 0 ||
              receiver.getContributingSources().length > 0 ||
              (obs?.evidence.frame_count ?? 0) > 0 ||
              Boolean(encodedFrameMeta?.get(receiver));
            if (!hasRtp) continue;
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

  let nextVideoSource = 0;
  const videoSourceIds = new WeakMap<RTCRtpReceiver, string>();
  let probeVideo: {el: HTMLVideoElement; track: MediaStreamTrack} | null = null;

  function teardownProbeVideo() {
    if (!probeVideo) return;
    try {
      probeVideo.el.pause();
      probeVideo.el.srcObject = null;
      probeVideo.el.remove();
    } catch { /* ignore DOM detach errors */ }
    probeVideo = null;
  }

  function isOutboundOrSelfVideoTrack(
    track: MediaStreamTrack | null | undefined,
    owningPc?: RTCPeerConnection,
  ): boolean {
    if (!track) return true;
    if ((track as MediaStreamTrack & {__wortlautVirtualVideo?: boolean}).__wortlautVirtualVideo) {
      return true;
    }
    if (track.label.startsWith('wortlaut Live-Protokoll')) {
      return true;
    }
    for (const pc of connections) {
      if (pc.connectionState === 'closed') continue;
      for (const sender of pc.getSenders()) {
        if (!sender.track) continue;
        if (sender.track === track) return true;
        if (owningPc && pc === owningPc && sender.track.id === track.id) return true;
      }
    }
    return false;
  }

  function extractZoomSharePresenterName(): {presenterId: string | null; presenterName: string | null} {
    if (!document.body) return {presenterId: null, presenterName: null};
    const explicit = document.querySelector(
      '.sharing-layout-container [data-presenter-id], [class*="sharee-container"] [data-presenter-id], ' +
      '.sharing-layout-container[data-presenter-id], canvas#sharee-container-canvas[data-presenter-id]',
    );
    if (explicit) {
      const pid = explicit.getAttribute('data-presenter-id')?.trim() || null;
      const pname = explicit.getAttribute('data-presenter-name')?.trim() || null;
      if (pid || pname) return {presenterId: pid, presenterName: pname};
    }
    const banners = document.querySelectorAll(
      '[class*="share-info"], [class*="sharing-banner"], [class*="view-sharing"], ' +
      '[aria-label*="screen" i], [aria-label*="Bildschirm" i]',
    );
    const patterns = [
      /You are viewing\s+(.+?)(?:['’]s|s)\s+screen/i,
      /Viewing\s+(.+?)(?:['’]s|s)\s+screen/i,
      /Sie sehen den Bildschirm von\s+(.+?)(?:\s*$|[.!|])/i,
      /(.+?)\s+(?:is sharing|shared)\s+(?:their\s+)?screen/i,
      /(.+?)\s+gibt\s+(?:den\s+)?Bildschirm\s+frei/i,
    ];
    for (const banner of Array.from(banners).slice(0, 32)) {
      const candidates = [banner.getAttribute('aria-label') ?? '', banner.textContent ?? ''];
      for (const raw of candidates) {
        const cleaned = raw.trim().replace(/\s+/g, ' ');
        if (!cleaned || cleaned.length > 240) continue;
        for (const pat of patterns) {
          const m = pat.exec(cleaned);
          if (m && m[1]) {
            const name = m[1]
              .replace(/\s*\((?:Host|Co-host|Gastgeber|Co-Gastgeber|Organizer|Organisator)\)\s*$/i, '')
              .trim();
            if (name && name.length <= 200) {
              return {presenterId: null, presenterName: name};
            }
          }
        }
      }
    }
    return {presenterId: null, presenterName: null};
  }

  function resolveZoomRosterByPresenter(
    presenterId: string | null,
    presenterName: string | null,
  ): {participant_id: string; participant_name: string | null} | null {
    const roster = new Map<string, string | null>();
    for (const p of participants.values()) {
      if (ignoredParticipantIds.has(p.participant_id)) continue;
      roster.set(
        p.participant_id,
        p.participant_name ?? domNames.get(p.participant_id) ?? protoNames.get(p.participant_id) ?? null,
      );
    }
    for (const [pid, name] of domNames) {
      if (!ignoredParticipantIds.has(pid) && !isIgnoredParticipantName(name) && !roster.has(pid)) {
        roster.set(pid, name);
      }
    }
    for (const [pid, name] of protoNames) {
      if (!ignoredParticipantIds.has(pid) && !isIgnoredParticipantName(name) && !roster.has(pid)) {
        roster.set(pid, name);
      }
    }
    if (presenterId && roster.has(presenterId)) {
      return {participant_id: presenterId, participant_name: roster.get(presenterId) ?? presenterName};
    }
    if (!presenterName) return null;
    const target = presenterName.trim().toLowerCase();
    if (!target || isIgnoredParticipantName(presenterName)) return null;
    const matches: {participant_id: string; participant_name: string | null}[] = [];
    for (const [pid, name] of roster) {
      if (name && name.trim().toLowerCase() === target) {
        matches.push({participant_id: pid, participant_name: name});
      }
    }
    return matches.length === 1 ? matches[0] : null;
  }

  function resolveWebRtcShareReceiver():
    | {kind: 'admitted'; receiver: RTCRtpReceiver; participant_id: string; participant_name: string | null}
    | {kind: 'opted_out'}
    | {kind: 'unverified'}
    | {kind: 'none'} {
    const provider = config.provider ?? 'google_meet';
    const candidates: {receiver: RTCRtpReceiver; pc: RTCPeerConnection; mid: string | null}[] = [];
    for (const pc of connections) {
      if (pc.connectionState === 'closed') continue;
      const midByReceiver = new Map<RTCRtpReceiver, string | null>();
      if (typeof pc.getTransceivers === 'function') {
        for (const tr of pc.getTransceivers()) {
          if (
            tr.receiver &&
            (tr.currentDirection === 'recvonly' ||
              tr.currentDirection === 'sendrecv' ||
              tr.direction === 'recvonly' ||
              tr.direction === 'sendrecv')
          ) {
            midByReceiver.set(tr.receiver, tr.mid ?? null);
          }
        }
      }
      for (const receiver of pc.getReceivers()) {
        if (
          (received.has(receiver) || midByReceiver.has(receiver)) &&
          receiver.track?.kind === 'video' &&
          receiver.track.readyState === 'live' &&
          !isOutboundOrSelfVideoTrack(receiver.track, pc)
        ) {
          candidates.push({receiver, pc, mid: midByReceiver.get(receiver) ?? null});
        }
      }
    }
    if (!candidates.length) return {kind: 'none'};

    let sawOptedOut = false;
    for (const {receiver, mid} of candidates) {
      const trackId = receiver.track.id;
      const streamIds = receiverStreams?.get(receiver) ?? [];

      const hookedMeta = encodedFrameMeta?.get(receiver);
      const csrcs = [
        ...new Set([
          ...recentRtpSources(receiver.getContributingSources()).filter(validCsi),
          ...(hookedMeta?.csrcs ?? []).filter(validCsi),
        ]),
      ];
      const ssrcs = [
        ...new Set([
          ...recentRtpSources(receiver.getSynchronizationSources()).filter(validCsi),
          ...(validCsi(hookedMeta?.ssrc) ? [hookedMeta.ssrc] : []),
        ]),
      ];
      const allCsis = [...new Set([...csrcs, ...ssrcs])];
      if (allCsis.some((c) => cameraVideoCsis.has(c) || webexSelfCsis.has(c))) continue;

      const hasPositiveShareCsi = allCsis.some((c) => {
        if (provider === 'google_meet' && meetSlideVideoSsrcs.has(c)) return true;
        if (provider === 'webex' && webexSlideVideoSsrcToParticipant.has(c)) return true;
        for (const p of participants.values()) {
          if (p.share_video_csis.has(c)) return true;
        }
        return false;
      });
      if (!hasPositiveShareCsi) {
        if (cameraVideoTrackIds.has(trackId)) continue;
        if (streamIds.some((sid) => cameraVideoStreamIds.has(sid))) continue;
      }

      let matchedOwners: {participant_id: string; participant_name: string | null}[] = [];
      if (provider === 'teams') {
        const owners = new Map<string, string | null>();
        for (const p of participants.values()) {
          if (ignoredParticipantIds.has(p.participant_id)) continue;
          if (
            allCsis.some((c) => p.share_video_csis.has(c)) ||
            p.share_video_track_ids.has(trackId) ||
            streamIds.some((sid) => p.share_video_stream_ids.has(sid))
          ) {
            owners.set(p.participant_id, p.participant_name);
          }
        }
        matchedOwners = [...owners.entries()].map(([participant_id, participant_name]) => ({
          participant_id,
          participant_name,
        }));
      } else if (provider === 'webex') {
        const owners = new Map<string, string | null>();
        for (const c of allCsis) {
          const mappedPid = webexSlideVideoSsrcToParticipant.get(c);
          if (mappedPid && mappedPid !== webexSelfParticipantId && !ignoredParticipantIds.has(mappedPid)) {
            const entry = participants.get(mappedPid);
            owners.set(mappedPid, entry?.participant_name ?? domNames.get(mappedPid) ?? protoNames.get(mappedPid) ?? null);
          }
          for (const p of participants.values()) {
            if (p.participant_id === webexSelfParticipantId || ignoredParticipantIds.has(p.participant_id)) continue;
            if (p.share_video_csis.has(c)) {
              owners.set(p.participant_id, p.participant_name);
            }
          }
        }
        matchedOwners = [...owners.entries()].map(([participant_id, participant_name]) => ({
          participant_id,
          participant_name,
        }));
      } else if (provider === 'google_meet') {
        const isPositivelySlides =
          (mid !== null && meetSlideVideoMids.has(mid)) ||
          meetSlideVideoTrackIds.has(trackId) ||
          streamIds.some((sid) => meetSlideVideoStreamIds.has(sid)) ||
          allCsis.some((c) => meetSlideVideoSsrcs.has(c));
        if (!isPositivelySlides) continue;

        const owners = new Map<string, string | null>();
        for (const p of participants.values()) {
          if (ignoredParticipantIds.has(p.participant_id)) continue;
          if (
            allCsis.some((c) => p.share_video_csis.has(c)) ||
            p.share_video_track_ids.has(trackId) ||
            streamIds.some((sid) => p.share_video_stream_ids.has(sid))
          ) {
            owners.set(p.participant_id, p.participant_name);
          }
        }
        if (owners.size === 0 && allCsis.length > 0) {
          for (const [cname, group] of sdpCnames) {
            if (!allCsis.some((c) => group.video_ssrcs.has(c))) continue;
            for (const p of participants.values()) {
              if (ignoredParticipantIds.has(p.participant_id)) continue;
              if (
                p.participant_id === cname ||
                [...group.audio_ssrcs].some((a) => p.audio_csis.has(a)) ||
                [...group.stream_ids].some((s) => p.stream_ids.has(s))
              ) {
                owners.set(p.participant_id, p.participant_name);
              }
            }
          }
        }
        matchedOwners = [...owners.entries()].map(([participant_id, participant_name]) => ({
          participant_id,
          participant_name,
        }));
      }

      if (matchedOwners.length === 1) {
        const owner = matchedOwners[0];
        const resolvedName =
          owner.participant_name ??
          domNames.get(owner.participant_id) ??
          protoNames.get(owner.participant_id) ??
          null;
        if (isParticipantOptedOut(owner.participant_id, resolvedName)) {
          sawOptedOut = true;
          continue;
        }
        return {
          kind: 'admitted',
          receiver,
          participant_id: owner.participant_id,
          participant_name: resolvedName,
        };
      }
    }

    if (sawOptedOut) return {kind: 'opted_out'};
    return {kind: 'unverified'};
  }

  const sampler = new ScreenShareKeyframeSampler(
    (metadata, base64Png, byteLength) => {
      if (capturePaused) return;
      send(
        {
          attempt_id: config.attempt_id,
          type: 'keyframe',
          metadata: metadata as unknown as Record<string, unknown>,
          png: base64Png,
        },
        base64Png.length + byteLength + 1024,
      );
    },
    {
      nowUtc: () => capture.nowUtc(),
    },
  );

  let samplingTick = false;
  async function sampleKeyframeTick() {
    if (!keyframesEnabled || stopping || sampler.isHalted || samplingTick) return;
    samplingTick = true;
    try {
      await initialized;
      if (stopping || state.reason || sampler.isHalted) return;
      scanDomParticipants();
      if (capturePaused) {
        teardownProbeVideo();
        state.keyframes.active_share = false;
        await sampler.tick(null);
        return;
      }

      if (config.provider === 'zoom') {
        teardownProbeVideo();
        const rawCanvases = Array.from(
          document.querySelectorAll<HTMLCanvasElement>(
            'canvas#sharee-container-canvas, .sharing-layout-container canvas, [class*="sharee-container"] canvas',
          ),
        );
        const shareCanvas = rawCanvases.find(
          (c) =>
            c !== window.wortlautVideoTile?.canvas &&
            !c.hasAttribute('data-wortlaut-video-tile') &&
            !c.closest('.gallery-video-container, .speaker-active-container, .video-avatar'),
        );
        if (!shareCanvas) {
          state.keyframes.active_share = false;
          const nonShareCanvas = Array.from(
            document.querySelectorAll<HTMLCanvasElement>(
              '#sv-active-video canvas, .speaker-active-container canvas, .gallery-video-container canvas',
            ),
          ).some((c) => c !== window.wortlautVideoTile?.canvas && !c.hasAttribute('data-wortlaut-video-tile'));
          if (nonShareCanvas) {
            state.keyframes.dropped_unverified += 1;
          }
          await sampler.tick(null);
          return;
        }
        const {presenterId, presenterName} = extractZoomSharePresenterName();
        const owner = resolveZoomRosterByPresenter(presenterId, presenterName);
        if (!owner) {
          state.keyframes.active_share = false;
          state.keyframes.dropped_unverified += 1;
          await sampler.tick(null);
          return;
        }
        if (isParticipantOptedOut(owner.participant_id, owner.participant_name)) {
          state.keyframes.active_share = false;
          state.keyframes.dropped_opted_out += 1;
          await sampler.tick(null);
          return;
        }
        state.keyframes.capability = 'active';
        state.keyframes.active_share = true;
        const w = shareCanvas.width || shareCanvas.clientWidth;
        const h = shareCanvas.height || shareCanvas.clientHeight;
        await sampler.tick({
          element: shareCanvas,
          sourceWidth: w,
          sourceHeight: h,
          provider_source_id: `zoom:${config.meeting_id}:share_canvas:1`,
          participant_id: owner.participant_id,
          participant_name: owner.participant_name,
        });
        return;
      }

      const resolution = resolveWebRtcShareReceiver();
      if (resolution.kind !== 'admitted') {
        teardownProbeVideo();
        state.keyframes.active_share = false;
        if (resolution.kind === 'opted_out') {
          state.keyframes.dropped_opted_out += 1;
        } else if (resolution.kind === 'unverified') {
          state.keyframes.dropped_unverified += 1;
        }
        await sampler.tick(null);
        return;
      }

      const {receiver, participant_id, participant_name} = resolution;
      let providerSourceId = videoSourceIds.get(receiver);
      if (!providerSourceId) {
        providerSourceId = `${config.provider ?? 'google_meet'}:${config.meeting_id}:video_receiver:${++nextVideoSource}`;
        videoSourceIds.set(receiver, providerSourceId);
      }

      state.keyframes.capability = 'active';
      state.keyframes.active_share = true;

      let readySubscribedVideo: HTMLVideoElement | null = null;
      for (const el of document.querySelectorAll<HTMLVideoElement>('video:not([data-wortlaut-keyframe-probe])')) {
        const src = el.srcObject;
        if (
          src instanceof MediaStream &&
          src.getVideoTracks().some((t) => t === receiver.track || t.id === receiver.track.id)
        ) {
          if (el.paused) void el.play().catch(() => {});
          if (el.readyState >= 2 && el.videoWidth >= 2 && el.videoHeight >= 2) {
            readySubscribedVideo = el;
            break;
          }
        }
      }

      let targetVideo: HTMLVideoElement | null = readySubscribedVideo;
      if (targetVideo) {
        teardownProbeVideo();
      } else {
        if (!probeVideo || probeVideo.track !== receiver.track) {
          teardownProbeVideo();
          try {
            const el = document.createElement('video');
            el.dataset.wortlautKeyframeProbe = '1';
            el.autoplay = true;
            el.playsInline = true;
            el.muted = true;
            el.style.position = 'fixed';
            el.style.width = '2px';
            el.style.height = '2px';
            el.style.opacity = '0';
            el.style.pointerEvents = 'none';
            el.srcObject = receiverMediaStreams?.get(receiver) ?? new MediaStream([receiver.track]);
            document.body?.append(el);
            void el.play().catch(() => {});
            probeVideo = {el, track: receiver.track};
          } catch { /* ignore headless video element errors */ }
        } else if (probeVideo.el.paused) {
          void probeVideo.el.play().catch(() => {});
        }
        targetVideo = probeVideo?.el ?? null;
      }

      if (targetVideo && targetVideo.readyState >= 2 && targetVideo.videoWidth >= 2 && targetVideo.videoHeight >= 2) {
        await sampler.tick({
          element: targetVideo,
          sourceWidth: targetVideo.videoWidth,
          sourceHeight: targetVideo.videoHeight,
          provider_source_id: providerSourceId,
          participant_id,
          participant_name,
        });
      }
    } finally {
      state.keyframes.evaluated_ticks = sampler.evaluatedTicks;
      state.keyframes.emitted = sampler.emitted;
      samplingTick = false;
    }
  }

  for (const sdp of window.wortlautMeetReceivers.remoteDescriptions?.splice(0) ?? []) onRemoteDescription(sdp);
  window.wortlautMeetReceivers.onRemoteDescription = onRemoteDescription;
  for (const queued of window.wortlautMeetReceivers.dataMessages?.splice(0) ?? []) onDataMessage(queued);
  window.wortlautMeetReceivers.onDataMessage = onDataMessage;
  const interval = setInterval(() => {
    void inspectReceivers();
  }, 250);
  const keyframeInterval = keyframesEnabled
    ? setInterval(() => {
        void sampleKeyframeTick();
      }, 1000)
    : undefined;
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
      csrc: receiver.getContributingSources().slice(0, 64).map(source),
      ...(receiverStats.has(receiver) ? {rtp_stats: receiverStats.get(receiver)} : {})};
  };
  window.wortlautMeet = {
    haltKeyframes: () => {
      sampler.halt();
      teardownProbeVideo();
      state.keyframes.active_share = false;
    },
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
        ...(everSawDomParticipants || domNames.size > 0 ? {dom_participants: liveDomCount} : {}),
        ...(optedOutParticipants.size > 0 ? {opted_out: [...optedOutParticipants].slice(0, 64)} : {}),
        ...(capturePaused ? {paused: true} : {}),
        ...(pauseWindows.length > 0 ? {pause_windows: pauseWindows.slice(0, 64).map((w) => ({...w}))} : {}),
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
      state.keyframes.evaluated_ticks = sampler.evaluatedTicks;
      state.keyframes.emitted = sampler.emitted;
      // Media evidence stays the pre-stop snapshot: stopping closes receivers.
      if (!stopping) state.media = mediaState();
      return {...state, keyframes: {...state.keyframes}, audio_clock: capture.inspectClock()};
    },
    stop: () => stopping ??= (async () => {
      clearInterval(interval);
      if (keyframeInterval !== undefined) clearInterval(keyframeInterval);
      clearInterval(statsInterval);
      if (capturePaused) {
        const stopIso = capture.nowUtc();
        for (let i = pauseWindows.length - 1; i >= 0; i--) {
          if (pauseWindows[i].ended_at === null) {
            pauseWindows[i].ended_at = stopIso;
            break;
          }
        }
        capturePaused = false;
      }
      teardownProbeVideo();
      state.keyframes.active_share = false;
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
      for (const [, ka] of keepaliveAudios) {
        ka.el.pause();
        ka.el.srcObject = null;
        ka.el.remove();
      }
      keepaliveAudios.clear();
      observer?.terminate();
      state.drained = !bridgeFailed;
      state.stopped = true;
      return state.drained;
    })(),
  };
}
