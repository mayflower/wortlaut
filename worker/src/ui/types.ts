export type Provider = 'google_meet' | 'teams' | 'webex';

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
  segment_id: string;
  stream_id: string;
  epoch: string;
  provider_source_id: string;
  speaker_id: string | null;
  speaker_name: string | null;
  speaker_label: string;
  attribution_status: string;
  start: number;
  end: number;
  start_sample: number;
  end_sample: number;
  text: string;
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
  last_known_audio_utc: string | null;
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

export type AuthMode =
  | { kind: 'unauthenticated' }
  | { kind: 'operator'; token: string }
  | { kind: 'reader'; token: string; recordingId: string };

export interface InstanceInfo {
  assistantName: string;
  botEmail: string | null;
  providers: {
    google_meet: boolean;
    google_meet_auth_session: boolean;
    teams: boolean;
    webex: boolean;
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
}

declare global {
  interface Window {
    __WORTLAUT_BOOT__?: {
      failureReasons?: Record<string, string>;
      instance?: InstanceInfo;
    };
  }
}
