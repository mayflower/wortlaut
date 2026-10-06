export type RemoteMedia = {
  id: string; csi?: number; memberId?: string; sourceState?: string;
  stream?: MediaStream;
  getUnderlyingReceiveSlot?: () => {id: string; wcmeReceiveSlot: unknown} | undefined;
  on: (event: 'sourceUpdate' | 'stopped', listener: (data: {csi?: number; memberId?: string; state?: string}) => void) => void;
  off: (event: 'sourceUpdate' | 'stopped', listener: (data: {csi?: number; memberId?: string; state?: string}) => void) => void;
};
export type MediaGroup = {getRemoteMedia: () => RemoteMedia[]};
export type Meeting = {
  id: string;
  members?: {
    membersCollection: {getAll: () => Record<string, unknown>};
    getCsisForMember: (id: string, mediaType: 'audio', mediaContent: 'main' | 'slides') => number[];
  };
  mediaProperties?: {webrtcMediaConnection?: {multistreamConnection?: {
    pc: {getUnderlyingRTCPeerConnection: () => RTCPeerConnection};
    recvTransceivers: Map<string, {receiveSlot: unknown; receiver: RTCRtpReceiver}[]>;
  }}};
  on: (event: string, listener: (...args: any[]) => void) => void;
  joinWithMedia: (options: Record<string, unknown>) => Promise<{multistreamEnabled: boolean}>;
  leave: () => Promise<void>;
};

// SDK members/index.ts derives these CSIs from participant devices' signaled
// audio mediaSessions. Keep them separate from received RTP SSRCs/CSRCs;
// neither a numerical match nor this snapshot assigns captured samples.
export function participantEvidence(meeting?: Pick<Meeting, 'members'>) {
  const members = meeting?.members;
  if (!members) return {available: false, total: 0, truncated: false, sources: []};
  const ids = Object.keys(members.membersCollection.getAll());
  let truncated = ids.length > 256;
  const csis = (id: string, content: 'main' | 'slides') => {
    const raw = members.getCsisForMember(id, 'audio', content);
    const valid = [...new Set(raw.filter((csi) => Number.isInteger(csi) && csi >= 0 && csi <= 0xffffffff))];
    if (valid.length > 64 || raw.some((csi) => !Number.isInteger(csi) || csi < 0 || csi > 0xffffffff)) {
      truncated = true;
    }
    return valid.slice(0, 64);
  };
  const sources = ids.slice(0, 256).map((id) => ({participant_id: id,
    audio_csis: csis(id, 'main'), share_audio_csis: csis(id, 'slides')}));
  return {available: true, total: ids.length, truncated, sources};
}

// webex 3.12.0 / internal-media-core 2.23.1 / WCME 3.39.1:
// RemoteMedia.getUnderlyingReceiveSlot().wcmeReceiveSlot identifies the exact
// ReceiveOnlyTransceiver. Its receiver belongs to the underlying native PC.
// This is a version-bound access, not a CSI == SSRC/CSRC identity assumption.
export function audioReceiver(meeting: Meeting, media: RemoteMedia,
                              kind: 'speaker' | 'share_audio'): RTCRtpReceiver | undefined {
  const slot = media.getUnderlyingReceiveSlot?.();
  const connection = meeting.mediaProperties?.webrtcMediaConnection?.multistreamConnection;
  if (!slot || !connection) return;
  const transceivers = connection.recvTransceivers.get(kind === 'speaker' ? 'AUDIO-MAIN' : 'AUDIO-SLIDES');
  const transceiver = transceivers?.find((candidate) => candidate.receiveSlot === slot.wcmeReceiveSlot);
  const receiver = transceiver?.receiver;
  if (receiver?.track.kind !== 'audio' ||
      !connection.pc.getUnderlyingRTCPeerConnection().getReceivers().includes(receiver)) return;
  return receiver;
}

export function receiverEvidence(meeting: Meeting, media: RemoteMedia,
                                 kind: 'speaker' | 'share_audio') {
  const receiver = audioReceiver(meeting, media, kind);
  // Each RTP timestamp/source is evidence only. Neither it nor signal arrival
  // defines a binding boundary in the captured AudioContext sample clock.
  const describe = (source: RTCRtpSynchronizationSource) => ({source: source.source,
    timestamp: source.timestamp, rtp_timestamp: source.rtpTimestamp});
  return {provider_source_id: `webex:slot:${media.getUnderlyingReceiveSlot?.()?.id ?? media.id}`,
    source_kind: kind, capture_path: receiver ? 'rtc_receiver' : 'sdk_stream',
    track_id: receiver?.track.id ?? media.stream?.getAudioTracks()[0]?.id,
    csi: media.csi, signaled_participant_id: media.memberId, source_state: media.sourceState,
    ssrc: receiver?.getSynchronizationSources().map(describe) ?? [],
    csrc: receiver?.getContributingSources().map(describe) ?? []};
}
export type WebexClient = {
  credentials: {
    set: (key: 'supertoken', value: Record<string, unknown>) => void;
    userTokens: {reset: (tokens: unknown[]) => void};
  };
  meetings: {
    on: (event: 'meeting:removed', listener: (data: {meetingId: string; reason: string}) => void) => void;
    off: (event: 'meeting:removed', listener: (data: {meetingId: string; reason: string}) => void) => void;
    register: () => Promise<void>;
    unregister: () => Promise<void>;
    create: (url: string) => Promise<Meeting>;
  };
};

declare global {
  interface Window {
    Webex: {init: (options: Record<string, unknown>) => WebexClient};
  }
}

// webex 3.12.0 published source: plugin-meetings meeting/index.ts forwards
// RemoteMediaManager AudioCreated to media:remoteAudio:created; each RemoteMedia
// exposes stream/csi/memberId and sourceUpdate. These events alone do not prove
// audio isolation or participant binding; the underlying receiver path also needs inspection.
export function receiveOptions(streams = 3) {
  return {joinOptions: {enableMultistream: true}, mediaOptions: {
    allowMediaInLobby: true, audioEnabled: true, videoEnabled: false,
    shareAudioEnabled: true, shareVideoEnabled: false,
    additionalMediaOptions: {sendAudio: false, sendVideo: false, receiveAudio: true, receiveVideo: false},
    remoteMediaManagerConfig: {
      audio: {numOfActiveSpeakerStreams: streams, numOfScreenShareStreams: 1},
      video: {preferLiveVideo: false, initialLayoutId: 'audio', layouts: {audio: {}}},
    },
  }};
}

// webex-core 3.12.0 credentials.js converts supertoken to its Token model.
// Clear cached user tokens so subsequent authorization uses the replacement.
// Guests have no refresh_token: do not synthesize one to enable a callback.
export function replaceGuestToken(client: WebexClient, guest: {access_token: string}) {
  if (!guest.access_token) throw new Error('Guest access token is missing');
  client.credentials.set('supertoken', {access_token: guest.access_token, token_type: 'Bearer'});
  client.credentials.userTokens.reset([]);
}
