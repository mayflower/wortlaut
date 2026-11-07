import type {
  AuthMode,
  CalendarEvent,
  InstanceInfo,
  Provider,
  RecordingDetail,
  RecordingSummary,
  TranscriptExport,
} from './types';

const STORAGE_KEY = 'wortlaut_api_token';
const READER_TOKEN_RE =
  /^wortlaut-read-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.([A-Za-z0-9_-]+)$/;

export function normalizeBearerToken(rawToken: string): string {
  const trimmed = rawToken.trim();
  const match = READER_TOKEN_RE.exec(trimmed);
  if (match) {
    return `wortlaut-read-${match[2]}`;
  }
  return trimmed;
}

export function parseTokenAuthMode(rawToken: string): AuthMode {
  const trimmed = rawToken.trim();
  if (!trimmed) {
    return { kind: 'unauthenticated' };
  }
  const match = READER_TOKEN_RE.exec(trimmed);
  if (match) {
    return {
      kind: 'reader',
      token: `wortlaut-read-${match[2]}`,
      recordingId: match[1].toLowerCase(),
    };
  }
  return { kind: 'operator', token: trimmed };
}

export function loadInitialToken(): string {
  if (typeof window === 'undefined') return '';
  const hash = window.location.hash.replace(/^#/, '');
  if (hash) {
    const params = new URLSearchParams(hash);
    const hashToken = params.get('token');
    if (hashToken && hashToken.trim()) {
      const clean = hashToken.trim();
      localStorage.setItem(STORAGE_KEY, clean);
      params.delete('token');
      const remaining = params.toString();
      window.history.replaceState(
        null,
        '',
        window.location.pathname + window.location.search + (remaining ? '#' + remaining : '')
      );
      return clean;
    }
  }
  return localStorage.getItem(STORAGE_KEY) || '';
}

export function saveTokenToStorage(token: string): void {
  const clean = token.trim();
  if (clean) {
    localStorage.setItem(STORAGE_KEY, clean);
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
}

export function getFailureReasons(): Record<string, string> {
  return window.__WORTLAUT_BOOT__?.failureReasons || {};
}

export function getInstanceInfo(): InstanceInfo {
  return (
    window.__WORTLAUT_BOOT__?.instance || {
      assistantName: 'wortlaut',
      botEmail: null,
      providers: {
        google_meet: true,
        google_meet_auth_session: false,
        teams: true,
        webex: false,
      },
      mail: {
        imapEnabled: false,
        smtpEnabled: false,
        senderAuth: 'gateway',
        allowedDomains: [],
      },
      limits: {
        maxActiveMeetings: 2,
        lobbyTimeoutSeconds: 600,
        emptyRoomTimeoutSeconds: 300,
      },
      retention: {
        audioHours: 24,
        transcriptDays: 30,
      },
    }
  );
}

export const PARTICIPATION_LABELS: Record<string, string> = {
  scheduled: 'Geplant',
  starting: 'Worker startet',
  preparing: 'Worker startet',
  joining: 'Tritt Meeting bei…',
  waiting_admission: 'Im Warteraum',
  capturing: 'Zeichnet auf',
  ended: 'Beendet',
  unknown: 'Unbekannt',
};

export const PROVIDER_LABELS: Record<Provider, string> = {
  google_meet: 'Google Meet',
  teams: 'Microsoft Teams',
  webex: 'Webex',
};

export function detectProviderFromUrl(url: string): Provider | null {
  const trimmed = url.trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed.includes('meet.google.com/')) return 'google_meet';
  if (trimmed.includes('teams.microsoft.com/') || trimmed.includes('teams.live.com/')) {
    return 'teams';
  }
  if (trimmed.includes('.webex.com/')) return 'webex';
  return null;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function apiRequest<T>(
  path: string,
  token: string,
  options: RequestInit = {}
): Promise<T> {
  const headers = new Headers(options.headers || {});
  if (token) {
    headers.set('Authorization', `Bearer ${normalizeBearerToken(token)}`);
  }
  if (options.body && typeof options.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(path, { ...options, headers });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const err = await res.json();
      if (err?.detail) {
        detail = typeof err.detail === 'string' ? err.detail : JSON.stringify(err.detail);
      }
    } catch {
      // ignore non-json error bodies
    }
    throw new ApiError(res.status, detail || `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export interface RecordingsFilter {
  provider?: string;
  participation?: string;
  processing?: string;
  q?: string;
}

export async function fetchRecordings(
  token: string,
  filter: RecordingsFilter
): Promise<{ items: RecordingSummary[]; next_cursor: string | null }> {
  const params = new URLSearchParams({ limit: '60', order: 'desc' });
  if (filter.provider) params.set('provider', filter.provider);
  if (filter.participation) params.set('participation', filter.participation);
  if (filter.processing) params.set('processing', filter.processing);
  if (filter.q && filter.q.trim()) params.set('q', filter.q.trim());
  return apiRequest(`/v1/recordings?${params.toString()}`, token);
}

export async function fetchRecordingDetail(
  token: string,
  recordingId: string
): Promise<RecordingDetail> {
  return apiRequest(`/v1/recordings/${encodeURIComponent(recordingId)}`, token);
}

export async function fetchTranscript(
  token: string,
  recordingId: string
): Promise<TranscriptExport> {
  return apiRequest(`/v1/recordings/${encodeURIComponent(recordingId)}/transcript`, token);
}

export async function fetchCalendar(token: string): Promise<{ events: CalendarEvent[] }> {
  return apiRequest('/v1/calendar', token);
}

export async function createRecording(
  token: string,
  payload: {
    meeting_url: string;
    starts_at: string;
    ends_at: string;
    title?: string | null;
    guest_name?: string | null;
  }
): Promise<RecordingSummary> {
  const key = 'ui-' + (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
  return apiRequest('/v1/recordings', token, {
    method: 'POST',
    headers: { 'Idempotency-Key': key },
    body: JSON.stringify(payload),
  });
}

export async function cancelRecording(
  token: string,
  recordingId: string
): Promise<RecordingSummary> {
  return apiRequest(`/v1/recordings/${encodeURIComponent(recordingId)}/cancel`, token, {
    method: 'POST',
  });
}

export async function rejoinRecording(
  token: string,
  recordingId: string
): Promise<RecordingSummary> {
  return apiRequest(`/v1/recordings/${encodeURIComponent(recordingId)}/rejoin`, token, {
    method: 'POST',
  });
}

export async function retryMailDelivery(
  token: string,
  recordingId: string
): Promise<unknown> {
  return apiRequest(`/v1/recordings/${encodeURIComponent(recordingId)}/delivery/retry`, token, {
    method: 'POST',
  });
}

export async function issueReaderToken(
  token: string,
  recordingId: string
): Promise<{ recording_id: string; reader_token: string; ui_token: string }> {
  return apiRequest(`/v1/recordings/${encodeURIComponent(recordingId)}/reader-token`, token, {
    method: 'POST',
  });
}

export async function importCalendarPayload(
  token: string,
  rawContent: string
): Promise<{ events: CalendarEvent[] }> {
  const body = rawContent.includes('BEGIN:VCALENDAR') && !rawContent.toLowerCase().includes('from:')
    ? [
        'From: ui-import@mayflower.de',
        'To: wortlaut@mayflower.de',
        'X-Wortlaut-Authenticated-Sender: ui-import@mayflower.de',
        'MIME-Version: 1.0',
        'Content-Type: text/calendar; charset="utf-8"; method=REQUEST',
        '',
        rawContent.trim(),
        '',
      ].join('\r\n')
    : rawContent;

  const headers = new Headers({
    Authorization: `Bearer ${token}`,
    'Content-Type': 'message/rfc822',
  });
  const res = await fetch('/v1/calendar/messages', {
    method: 'POST',
    headers,
    body,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const err = await res.json();
      if (err?.detail) detail = String(err.detail);
    } catch {
      // ignore
    }
    throw new ApiError(res.status, detail);
  }
  return (await res.json()) as { events: CalendarEvent[] };
}

export async function downloadExportFile(
  token: string,
  recordingId: string,
  format: 'txt' | 'vtt' | 'json'
): Promise<void> {
  const res = await fetch(
    `/v1/recordings/${encodeURIComponent(recordingId)}/exports/${format}`,
    {
      headers: { Authorization: `Bearer ${normalizeBearerToken(token)}` },
    }
  );
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const err = await res.json();
      if (err?.detail) detail = String(err.detail);
    } catch {
      // ignore
    }
    throw new ApiError(res.status, detail);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `wortlaut-${recordingId}.${format}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function formatDurationClock(seconds: number): string {
  const totalSec = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function formatDurationHuman(seconds: number): string {
  const totalSec = Math.max(0, Math.round(Number(seconds) || 0));
  if (totalSec === 0) return '0s';
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `${s}s`;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

export function formatRecordingTitle(rec: {
  title: string | null;
  provider: Provider;
  starts_at: string;
}): string {
  if (rec.title && rec.title.trim()) {
    return rec.title.trim();
  }
  const dateStr = new Date(rec.starts_at).toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${PROVIDER_LABELS[rec.provider] || rec.provider} (${dateStr})`;
}
