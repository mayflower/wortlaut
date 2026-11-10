import type {
  AuthMode,
  CalendarConnectionInfo,
  CalendarEvent,
  CalendarSyncedEventInfo,
  InstanceInfo,
  Provider,
  RecordingDetail,
  RecordingSummary,
  SourceSummary,
  TranscriptExport,
  TranscriptSegment,
} from './types';

const STORAGE_KEY = 'wortlaut_api_token';
const READER_SESSION_KEY = 'wortlaut_reader_token';
const OIDC_PKCE_STORAGE_KEY = 'wortlaut_oidc_pkce';
const CALENDAR_OAUTH_PKCE_STORAGE_KEY = 'wortlaut_cal_oauth_pkce';
const READER_TOKEN_RE =
  /^wortlaut-read-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.([A-Za-z0-9_-]+)$/;
const USER_TOKEN_RE = /^wortlaut-user-([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;

function decodeBase64UrlJson(b64url: string): Record<string, unknown> | null {
  try {
    const padded = b64url.replace(/-/g, '+').replace(/_/g, '/');
    const padLen = (4 - (padded.length % 4)) % 4;
    const raw = atob(padded + '='.repeat(padLen));
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      bytes[i] = raw.charCodeAt(i);
    }
    const text = new TextDecoder().decode(bytes);
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomBase64Url(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

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
  const userMatch = USER_TOKEN_RE.exec(trimmed);
  if (userMatch) {
    const payload = decodeBase64UrlJson(userMatch[1]);
    if (!payload || typeof payload.email !== 'string') {
      return { kind: 'unauthenticated' };
    }
    if (typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now()) {
      return { kind: 'unauthenticated' };
    }
    return {
      kind: 'operator',
      token: trimmed,
      user: {
        sub: String(payload.sub || payload.email),
        email: payload.email,
        name: String(payload.name || payload.email),
        isAdmin: Boolean(payload.is_admin),
      },
    };
  }
  return { kind: 'operator', token: trimmed };
}

export async function startOidcLogin(): Promise<void> {
  const instance = getInstanceInfo();
  const oidc = instance.oidc;
  if (!oidc?.enabled || !oidc.issuer || !oidc.clientId) {
    throw new Error('OIDC-Anmeldung ist auf dieser Instanz nicht konfiguriert.');
  }
  const verifier = randomBase64Url(32);
  const state = randomBase64Url(16);
  const nonce = randomBase64Url(16);
  const redirectUri = `${window.location.origin}/auth/callback`;

  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier)
  );
  const challenge = encodeBase64Url(new Uint8Array(digest));

  sessionStorage.setItem(
    OIDC_PKCE_STORAGE_KEY,
    JSON.stringify({ verifier, state, nonce, redirectUri })
  );

  const authUrl = new URL(`${oidc.issuer.replace(/\/$/, '')}/auth`);
  authUrl.searchParams.set('client_id', oidc.clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid profile email');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('nonce', nonce);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  window.location.assign(authUrl.toString());
}

export async function startCalendarOAuthConnect(
  provider: 'google' | 'microsoft'
): Promise<void> {
  const instance = getInstanceInfo();
  const calOAuth = instance.calendarOAuth;
  const verifier = randomBase64Url(32);
  const state = randomBase64Url(16);
  const redirectUri = `${window.location.origin}/auth/callback`;

  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier)
  );
  const challenge = encodeBase64Url(new Uint8Array(digest));

  sessionStorage.setItem(
    CALENDAR_OAUTH_PKCE_STORAGE_KEY,
    JSON.stringify({ provider, verifier, state, redirectUri })
  );

  if (provider === 'google') {
    if (!calOAuth?.googleEnabled || !calOAuth.googleClientId) {
      throw new Error(
        'Google-Calendar-OAuth ist auf dieser Instanz noch nicht mit einer Client-ID konfiguriert.'
      );
    }
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', calOAuth.googleClientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set(
      'scope',
      'openid email https://www.googleapis.com/auth/calendar.readonly'
    );
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    window.location.assign(authUrl.toString());
    return;
  }

  if (!calOAuth?.microsoftEnabled || !calOAuth.microsoftClientId) {
    throw new Error(
      'Microsoft-365-Kalender-OAuth ist auf dieser Instanz noch nicht mit einer Client-ID konfiguriert.'
    );
  }
  const tenant = calOAuth.microsoftTenantId || 'common';
  const authUrl = new URL(
    `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize`
  );
  authUrl.searchParams.set('client_id', calOAuth.microsoftClientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set(
    'scope',
    'openid email offline_access Calendars.Read'
  );
  authUrl.searchParams.set('prompt', 'select_account');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  window.location.assign(authUrl.toString());
}

export async function completeOidcCallbackIfPresent(): Promise<{
  token?: string;
  calendarConnected?: CalendarConnectionInfo;
  error?: string;
} | null> {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const state = params.get('state');
  const errParam = params.get('error');
  const errDesc = params.get('error_description');

  if (!code && !errParam && !window.location.pathname.startsWith('/auth/callback')) {
    return null;
  }

  const rawCalStored = sessionStorage.getItem(CALENDAR_OAUTH_PKCE_STORAGE_KEY);
  if (rawCalStored) {
    sessionStorage.removeItem(CALENDAR_OAUTH_PKCE_STORAGE_KEY);
    const clearToCalendar = () => {
      window.history.replaceState(null, '', '/ui#view=calendar');
    };
    if (errParam) {
      clearToCalendar();
      return {
        error: `Kalender-Verknüpfung fehlgeschlagen: ${errDesc || errParam}`,
      };
    }
    if (!code) {
      clearToCalendar();
      return null;
    }
    let calStored: {
      provider: 'google' | 'microsoft';
      verifier: string;
      state: string;
      redirectUri: string;
    };
    try {
      calStored = JSON.parse(rawCalStored);
    } catch {
      clearToCalendar();
      return { error: 'Ungültiger lokaler Kalender-OAuth-PKCE-Status.' };
    }
    if (!state || state !== calStored.state) {
      clearToCalendar();
      return { error: 'Ungültiger Kalender-OAuth-State-Parameter.' };
    }
    const activeToken = getSavedAccountToken() || loadInitialToken();
    try {
      const res = await apiRequest<{
        connection: CalendarConnectionInfo;
        synced_events: CalendarSyncedEventInfo[];
      }>('/v1/calendar/oauth/exchange', activeToken, {
        method: 'POST',
        body: JSON.stringify({
          provider: calStored.provider,
          code,
          code_verifier: calStored.verifier,
          redirect_uri: calStored.redirectUri,
        }),
      });
      clearToCalendar();
      return { calendarConnected: res.connection };
    } catch (err) {
      clearToCalendar();
      return {
        error:
          err instanceof Error
            ? `Kalender-Verknüpfung fehlgeschlagen: ${err.message}`
            : 'Kalender-Verknüpfung fehlgeschlagen.',
      };
    }
  }

  const clearCallbackUrl = () => {
    window.history.replaceState(null, '', '/ui');
  };

  if (errParam) {
    sessionStorage.removeItem(OIDC_PKCE_STORAGE_KEY);
    clearCallbackUrl();
    return { error: `SSO-Anmeldung fehlgeschlagen: ${errDesc || errParam}` };
  }

  if (!code) {
    clearCallbackUrl();
    return null;
  }

  const rawStored = sessionStorage.getItem(OIDC_PKCE_STORAGE_KEY);
  sessionStorage.removeItem(OIDC_PKCE_STORAGE_KEY);
  if (!rawStored) {
    clearCallbackUrl();
    return {
      error:
        'SSO-Sitzung abgelaufen (PKCE-Status fehlt). Bitte erneut anmelden.',
    };
  }

  let stored: {
    verifier: string;
    state: string;
    nonce?: string;
    redirectUri: string;
  };
  try {
    stored = JSON.parse(rawStored);
  } catch {
    clearCallbackUrl();
    return { error: 'Ungültiger lokaler PKCE-Status.' };
  }

  if (!state || state !== stored.state) {
    clearCallbackUrl();
    return { error: 'Ungültiger OAuth-State-Parameter.' };
  }

  try {
    const res = await apiRequest<{
      token: string;
      user: { sub: string; email: string; name: string; is_admin: boolean };
    }>('/v1/auth/oidc/exchange', '', {
      method: 'POST',
      body: JSON.stringify({
        code,
        code_verifier: stored.verifier,
        redirect_uri: stored.redirectUri,
        nonce: stored.nonce || null,
      }),
    });
    saveTokenToStorage(res.token);
    clearCallbackUrl();
    return { token: res.token };
  } catch (err) {
    clearCallbackUrl();
    return {
      error:
        err instanceof Error
          ? `SSO-Anmeldung fehlgeschlagen: ${err.message}`
          : 'SSO-Anmeldung fehlgeschlagen.',
    };
  }
}

export function loadInitialToken(): string {
  if (typeof window === 'undefined') return '';
  const hash = window.location.hash.replace(/^#/, '');
  if (hash) {
    const params = new URLSearchParams(hash);
    const hashToken = params.get('token');
    if (hashToken && hashToken.trim()) {
      const clean = hashToken.trim();
      if (READER_TOKEN_RE.test(clean)) {
        // Keep shared reader links in sessionStorage so an existing SSO / operator
        // login in localStorage is never overwritten.
        sessionStorage.setItem(READER_SESSION_KEY, clean);
      } else {
        sessionStorage.removeItem(READER_SESSION_KEY);
        localStorage.setItem(STORAGE_KEY, clean);
      }
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
  const activeReader = sessionStorage.getItem(READER_SESSION_KEY);
  if (activeReader && READER_TOKEN_RE.test(activeReader.trim())) {
    return activeReader.trim();
  }
  return localStorage.getItem(STORAGE_KEY) || '';
}

export function saveTokenToStorage(token: string): void {
  const clean = token.trim();
  if (!clean) {
    sessionStorage.removeItem(READER_SESSION_KEY);
    localStorage.removeItem(STORAGE_KEY);
    return;
  }
  if (READER_TOKEN_RE.test(clean)) {
    sessionStorage.setItem(READER_SESSION_KEY, clean);
  } else {
    sessionStorage.removeItem(READER_SESSION_KEY);
    localStorage.setItem(STORAGE_KEY, clean);
  }
}

export function getSavedAccountToken(): string {
  if (typeof window === 'undefined') return '';
  const saved = (localStorage.getItem(STORAGE_KEY) || '').trim();
  if (!saved || READER_TOKEN_RE.test(saved)) return '';
  const mode = parseTokenAuthMode(saved);
  return mode.kind === 'operator' ? saved : '';
}

export function exitReaderModeToAccount(): string {
  if (typeof window === 'undefined') return '';
  sessionStorage.removeItem(READER_SESSION_KEY);
  return getSavedAccountToken();
}

export type UiNavView = 'home' | 'meetings' | 'calendar' | 'system';

export function readNavStateFromHash(): {
  view: UiNavView;
  recordingId: string | null;
} {
  if (typeof window === 'undefined') {
    return { view: 'home', recordingId: null };
  }
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw || raw.includes('token=')) {
    return { view: 'home', recordingId: null };
  }
  const params = new URLSearchParams(raw);
  const rawView = params.get('view');
  const view: UiNavView =
    rawView === 'meetings' || rawView === 'calendar' || rawView === 'system'
      ? rawView
      : 'home';
  const id = params.get('id');
  return {
    view,
    recordingId: id && id.trim() ? id.trim() : null,
  };
}

export function writeNavStateToHash(
  view: UiNavView,
  recordingId: string | null
): void {
  if (typeof window === 'undefined') return;
  const current = readNavStateFromHash();
  if (current.view === view && current.recordingId === recordingId) {
    return;
  }
  const params = new URLSearchParams();
  if (view !== 'home') {
    params.set('view', view);
  }
  if (recordingId) {
    params.set('id', recordingId);
  }
  const nextHash = params.toString();
  const nextUrl =
    window.location.pathname +
    window.location.search +
    (nextHash ? `#${nextHash}` : '');
  window.history.pushState({ view, recordingId }, '', nextUrl);
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
        zoom: false,
      },
      mail: {
        imapEnabled: false,
        smtpEnabled: false,
        senderAuth: 'gateway',
        allowedDomains: [],
      },
      limits: {
        maxActiveMeetings: 15,
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

export const PROCESSING_LABELS: Record<string, string> = {
  pending: 'Wartet auf Verarbeitung',
  processing: 'Spracherkennung läuft…',
  completed: 'Abgeschlossen',
  failed: 'Verarbeitungsfehler',
};

export const DELIVERY_STATUS_LABELS: Record<string, string> = {
  pending: 'Ausstehend',
  sending: 'Wird gesendet…',
  sent: 'Zugestellt',
  skipped: 'Übersprungen (kein Empfänger)',
  failed: 'Zustellung fehlgeschlagen',
  delivery_unknown: 'Status unklar (SMTP-Timeout)',
};

export const SOURCE_COVERAGE_LABELS: Record<string, string> = {
  complete: 'Vollständig gebunden',
  partial: 'Teilweise gebunden',
  unknown: 'Einzelspur-Erfassung aktiv',
  none: 'Noch keine Audiospuren',
};

export const ATTRIBUTION_STATUS_LABELS: Record<string, string> = {
  bound: 'Teilnehmersitzung bestätigt',
  unbound: 'Ohne bestätigte Sitzungs-ID',
  ambiguous: 'Mehrdeutige Spurbindung',
  unknown: 'Zuordnung offen',
};

export const PROVIDER_LABELS: Record<Provider, string> = {
  google_meet: 'Google Meet',
  teams: 'Microsoft Teams',
  webex: 'Webex',
  zoom: 'Zoom',
};

export function formatApiErrorDetail(raw: unknown, status: number): string {
  if (Array.isArray(raw)) {
    const msgs = raw
      .map((item) => {
        if (item && typeof item === 'object' && 'msg' in item) {
          return String((item as { msg: unknown }).msg);
        }
        return JSON.stringify(item);
      })
      .join('; ');
    return formatApiErrorDetail(msgs, status);
  }
  const text = typeof raw === 'string' ? raw.trim() : JSON.stringify(raw);
  if (!text) return `HTTP-Fehler ${status}`;
  if (text.includes('ends_at must be after starts_at')) {
    return 'Die Endzeit muss nach der Startzeit liegen.';
  }
  if (text.includes('Meeting URL does not match provider')) {
    return 'Die eingegebene Meeting-URL passt nicht zum gewählten Konferenzsystem (Google Meet, Microsoft Teams, Webex oder Zoom).';
  }
  if (text.includes('Recording duration exceeds maximum')) {
    return 'Die geplante Aufnahmedauer überschreitet das zulässige Maximum.';
  }
  if (text.includes('Active meeting capacity reached')) {
    return 'Die maximale Anzahl gleichzeitiger Meeting-Aufzeichnungen auf dem Cluster ist erreicht.';
  }
  if (text.includes('Provider is not enabled')) {
    return 'Dieses Konferenzsystem ist auf dieser Instanz derzeit nicht aktiviert.';
  }
  return text;
}

export function detectProviderFromUrl(url: string): Provider | null {
  const trimmed = url.trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed.includes('meet.google.com/')) return 'google_meet';
  if (trimmed.includes('teams.microsoft.com/') || trimmed.includes('teams.live.com/')) {
    return 'teams';
  }
  if (trimmed.includes('.webex.com/')) return 'webex';
  if (trimmed.includes('zoom.us/j/') || trimmed.includes('zoom.us/wc/')) return 'zoom';
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
        detail = formatApiErrorDetail(err.detail, res.status);
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

export async function fetchCalendar(token: string): Promise<{
  events: CalendarEvent[];
  connections?: CalendarConnectionInfo[];
  synced_events?: CalendarSyncedEventInfo[];
}> {
  return apiRequest('/v1/calendar', token);
}

export async function syncCalendarConnection(
  token: string,
  connectionId: string
): Promise<{
  connection: CalendarConnectionInfo;
  synced_events: CalendarSyncedEventInfo[];
}> {
  return apiRequest(
    `/v1/calendar/oauth/connections/${encodeURIComponent(connectionId)}/sync`,
    token,
    { method: 'POST' }
  );
}

export async function disconnectCalendarConnection(
  token: string,
  connectionId: string
): Promise<{ deleted: boolean; id: string }> {
  return apiRequest(
    `/v1/calendar/oauth/connections/${encodeURIComponent(connectionId)}`,
    token,
    { method: 'DELETE' }
  );
}

export async function toggleCalendarSyncedEvent(
  token: string,
  eventId: string,
  enabled: boolean
): Promise<CalendarSyncedEventInfo> {
  return apiRequest(
    `/v1/calendar/oauth/events/${encodeURIComponent(eventId)}/toggle`,
    token,
    {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    }
  );
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

export async function deleteRecording(
  token: string,
  recordingId: string
): Promise<{ deleted: boolean; id: string }> {
  return apiRequest(`/v1/recordings/${encodeURIComponent(recordingId)}`, token, {
    method: 'DELETE',
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
  const mode = parseTokenAuthMode(token);
  const senderEmail =
    mode.kind === 'operator' && mode.user?.email
      ? mode.user.email
      : 'ui-import@mayflower.de';
  const body = rawContent.includes('BEGIN:VCALENDAR') && !rawContent.toLowerCase().includes('from:')
    ? [
        `From: ${senderEmail}`,
        'To: wortlaut@mayflower.de',
        `X-Wortlaut-Authenticated-Sender: ${senderEmail}`,
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
      if (err?.detail) detail = formatApiErrorDetail(err.detail, res.status);
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
  format: 'txt' | 'vtt' | 'json' | 'md'
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

export function formatWallClockTime(
  offsetSeconds: number,
  timeOriginUtc?: string | null
): string {
  if (timeOriginUtc) {
    const originMs = Date.parse(timeOriginUtc);
    if (Number.isFinite(originMs)) {
      const dt = new Date(
        originMs + Math.max(0, Number(offsetSeconds) || 0) * 1000
      );
      return dt.toLocaleTimeString('de-DE', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    }
  }
  return formatDurationClock(offsetSeconds);
}

export function getSourceFilterKey(src: SourceSummary): string {
  if (src.signaled_participant_id) {
    return `participant:${src.signaled_participant_id}`;
  }
  if (src.participant_name) {
    return `name:${src.participant_name}`;
  }
  return src.provider_source_id;
}

export function matchesSourceFilter(
  seg: TranscriptSegment,
  filterKey: string
): boolean {
  if (filterKey.startsWith('participant:')) {
    const targetPid = filterKey.slice('participant:'.length);
    const segPid = seg.participant_id || seg.speaker_id;
    return segPid === targetPid;
  }
  if (filterKey.startsWith('name:')) {
    const targetName = filterKey.slice('name:'.length);
    const segName = seg.participant_name || seg.speaker_name;
    return segName === targetName;
  }
  return seg.provider_source_id === filterKey;
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
