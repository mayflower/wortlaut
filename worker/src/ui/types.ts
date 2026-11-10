export type Provider = 'google_meet' | 'teams' | 'webex' | 'zoom';

export type ParticipationState =
  | 'scheduled'
  | 'starting'
  | 'preparing'
  | 'joining'
  | 'waiting_admission'
  | 'capturing'
  | 'ended'
  | 'unknown';

export type ProcessingState = 'pending' | 'processing' | 'completed' | 'failed';

export interface RecordingQualitySummary {
  durable_sample_count: number;
  has_audio_gaps: boolean;
  capture_end_unknown: boolean;
  attribution_unknown: boolean;
  incomplete_drain: boolean;
  unprocessed_audio: boolean;
  failed_asr: boolean;
}

export interface DeliveryInfo {
  status: string;
  message_id?: string | null;
  attempts?: number;
  error?: string | null;
  retry_at?: string | null;
  delivered_at?: string | null;
  accepted_recipients?: string[];
  refused_codes?: Record<string, number>;
}

export interface RecordingSummary {
  id: string;
  provider: Provider;
  title: string | null;
  guest_name: string | null;
  owner_email?: string | null;
  starts_at: string;
  ends_at: string;
  participation: ParticipationState;
  processing: ProcessingState;
  processing_error: string | null;
  participation_reason: string | null;
  cancelled_at: string | null;
  audio_deleted_at: string | null;
  transcript_deleted_at: string | null;
  metadata_deleted_at: string | null;
  active_attempt_id: string | null;
  calendar_entry_id: string | null;
  calendar_conflict: boolean;
  recurrence_key: string | null;
  quality?: RecordingQualitySummary;
  delivery?: DeliveryInfo;
}

export interface LiveStatus {
  is_active: boolean;
  participation: ParticipationState;
  processing: ProcessingState;
  active_streams: number;
  audio_seconds: number;
  active_audio_seconds: number;
  bound_receivers: number;
  bound_named_receivers: number;
  total_receivers: number;
  dom_or_signaled_participants: number;
  named_participants: number;
  dom_participants: number;
  data_channel_count: number;
  sdp_descriptions: number;
  last_heartbeat_at: string | null;
  last_audio_activity: string | null;
}

export interface AttemptInfo {
  id: string;
  last_heartbeat_at: string | null;
  ended_at: string | null;
  end_reason: string | null;
  diagnostics?: Record<string, unknown> | null;
  job_name?: string | null;
  job_uid?: string | null;
  pod_uids?: string[] | null;
  process_ended_at?: string | null;
}

export interface AudioStreamInfo {
  stream_id: string;
  epoch: string;
  segmented_until_sample: number;
  segmentation_complete: boolean;
  durable_sample_count: number;
  has_audio_gaps: boolean;
  attribution_unknown: boolean;
  unreadable_audio: boolean;
}

export interface RecordingDetail extends RecordingSummary {
  attempts: AttemptInfo[];
  audio: AudioStreamInfo[];
  ingest: {
    durable_sample_count: number;
    durable_chunk_count: number;
    last_audio_activity: string | null;
  };
  asr: {
    pending: number;
    failed: number;
    completed: number;
    pending_source_seconds: number;
    oldest_pending_seconds: number | null;
  };
  live_status: LiveStatus;
}

export interface SourceSummary {
  provider_source_id: string;
  csi: number | null;
  signaled_participant_id: string | null;
  participant_name: string | null;
  speaker_label: string;
  accepted_seconds: number;
  speech_seconds: number;
  segment_count: number;
  sample_text: string | null;
}

export interface TranscriptSegment {
  id?: string;
  segment_id: string;
  stream_id: string;
  epoch: string;
  provider_source_id: string;
  participant_id?: string | null;
  participant_name?: string | null;
  speaker_id: string | null;
  speaker_name: string | null;
  speaker_label: string;
  attribution_status: string;
  attribution_unknown?: boolean;
  start: number;
  end: number;
  start_sample: number;
  end_sample: number;
  text: string;
}

export interface ProtocolSummary {
  summary: string;
  topics: Array<{ title: string; details: string }>;
  action_items: Array<{ owner: string; task: string; due?: string }>;
  model?: string;
  generated_at?: string;
}

export interface TranscriptExport {
  recording_id: string;
  provider: Provider;
  title: string | null;
  guest_name: string | null;
  participation: ParticipationState;
  participation_reason: string | null;
  processing: ProcessingState;
  processing_error: string | null;
  scheduled_period: { start: string; end: string };
  time_origin_utc?: string | null;
  last_known_audio_utc: string | null;
  audio_available?: boolean;
  summary?: ProtocolSummary | null;
  notes?: string;
  speaker_overrides?: Record<string, string>;
  term_replacements?: Record<string, string>;
  quality: {
    no_audio_received: boolean;
    has_audio_gaps: boolean;
    audio_clock_interrupted: boolean;
    capture_end_unknown: boolean;
    attribution_unknown: boolean;
    source_coverage: string;
    incomplete_drain: boolean;
    unprocessed_audio: boolean;
    failed_asr_ranges: Array<{ stream_id: string; start: number; end: number }>;
  };
  sources_summary: SourceSummary[];
  segments: TranscriptSegment[];
}

export interface CalendarEvent {
  uid: string;
  recurrence_id: string;
  sequence: number;
  dtstamp: string;
  organizer: string;
  provider: Provider | null;
  title: string | null;
  status: string;
  reason: string | null;
  starts_at: string | null;
  ends_at: string | null;
  recording_id: string | null;
  recording_ids?: string[];
}

export interface CalendarConnectionInfo {
  id: string;
  provider: 'google' | 'microsoft';
  account_email: string;
  owner_email: string;
  last_synced_at: string | null;
  sync_error: string | null;
  created_at: string;
}

export interface CalendarSyncedEventInfo {
  id: string;
  connection_id: string;
  calendar_provider: 'google' | 'microsoft';
  external_event_id: string;
  title: string | null;
  starts_at: string;
  ends_at: string;
  organizer_email: string | null;
  is_self_organized: boolean;
  meeting_provider: Provider;
  meeting_url: string;
  status: string;
  auto_record: boolean;
  user_override: boolean | null;
  recording_id: string | null;
  recording_participation: ParticipationState | null;
}

export interface UserIdentity {
  sub: string;
  email: string;
  name: string;
  isAdmin: boolean;
}

export type AuthMode =
  | { kind: 'unauthenticated' }
  | { kind: 'operator'; token: string; user?: UserIdentity }
  | { kind: 'reader'; token: string; recordingId: string };

export interface InstanceInfo {
  assistantName: string;
  botEmail: string | null;
  oidc?: {
    enabled: boolean;
    issuer: string;
    clientId: string;
    allowedDomains: string[];
  };
  calendarOAuth?: {
    googleEnabled: boolean;
    microsoftEnabled: boolean;
    googleClientId: string;
    microsoftClientId: string;
    microsoftTenantId: string;
  };
  providers: {
    google_meet: boolean;
    google_meet_auth_session: boolean;
    teams: boolean;
    webex: boolean;
    zoom?: boolean;
    zoom_auth_session?: boolean;
  };
  mail: {
    imapEnabled: boolean;
    smtpEnabled: boolean;
    senderAuth: string;
    allowedDomains: string[];
  };
  limits: {
    maxActiveMeetings: number;
    lobbyTimeoutSeconds: number;
    emptyRoomTimeoutSeconds: number;
  };
  retention: {
    audioHours: number;
    transcriptDays: number;
  };
  llmSummaryEnabled?: boolean;
  llmModel?: string;
}

export function formatBotDisplayName(
  recording: { guest_name?: string | null; owner_email?: string | null },
  assistantName = 'wortlaut'
): string {
  const base = (recording.guest_name || assistantName || 'wortlaut').trim() || 'wortlaut';
  const rawOwner = (recording.owner_email || '').trim();
  if (!rawOwner) return base;
  const local = rawOwner.split('@')[0].trim();
  const tokens = local.split(/[._+]+/).filter(Boolean);
  const inviterName = tokens.length
    ? tokens
        .map((tok) =>
          tok
            .split('-')
            .filter(Boolean)
            .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase())
            .join('-')
        )
        .join(' ')
    : local;
  if (!inviterName) return base;
  if (base.toLowerCase().includes(inviterName.toLowerCase()) || base.includes('(')) {
    return base;
  }
  const combined = `${base} (${inviterName})`;
  if (combined.length <= 60) return combined;
  const maxInviter = Math.max(1, 60 - base.length - 3);
  return `${base} (${inviterName.slice(0, maxInviter).trimEnd()})`;
}

declare global {
  interface Window {
    __WORTLAUT_BOOT__?: {
      failureReasons?: Record<string, string>;
      instance?: InstanceInfo;
    };
  }
}
