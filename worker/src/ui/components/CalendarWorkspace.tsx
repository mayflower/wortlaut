import React, { useState } from 'react';
import {
  ArrowRight,
  Calendar,
  CalendarPlus,
  Check,
  CheckCircle2,
  Copy,
  Link2,
  Mail,
  RefreshCw,
  Trash2,
  XCircle,
} from 'lucide-react';
import {
  disconnectCalendarConnection,
  getFailureReasons,
  getInstanceInfo,
  startCalendarOAuthConnect,
  syncCalendarConnection,
  toggleCalendarSyncedEvent,
} from '../api';
import type {
  CalendarConnectionInfo,
  CalendarEvent,
  CalendarSyncedEventInfo,
} from '../types';
import { Button, ProviderBadge, cn } from './ui/primitives';

export interface CalendarWorkspaceProps {
  token: string;
  events: CalendarEvent[];
  connections: CalendarConnectionInfo[];
  syncedEvents: CalendarSyncedEventInfo[];
  onRefreshCalendar: () => void;
  onSelectRecording: (recordingId: string) => void;
  onOpenImportModal: () => void;
}

const CALENDAR_STATUS_LABELS: Record<string, string> = {
  accepted: 'Eingeplant',
  cancelled: 'Abgesagt',
  rejected: 'Abgelehnt',
  ignored: 'Ignoriert',
};

export function CalendarWorkspace({
  token,
  events,
  connections,
  syncedEvents,
  onRefreshCalendar,
  onSelectRecording,
  onOpenImportModal,
}: CalendarWorkspaceProps) {
  const instance = getInstanceInfo();
  const failureReasons = getFailureReasons();
  const [copiedMail, setCopiedMail] = useState(false);
  const [oauthBusy, setOauthBusy] = useState<string | null>(null);
  const [oauthError, setOauthError] = useState<string | null>(null);

  const calOAuth = instance.calendarOAuth;
  const googleConn = connections.find((c) => c.provider === 'google') || null;
  const microsoftConn =
    connections.find((c) => c.provider === 'microsoft') || null;

  const handleCopyMail = async () => {
    if (!instance.botEmail || !navigator.clipboard) return;
    await navigator.clipboard.writeText(instance.botEmail).catch(() => {});
    setCopiedMail(true);
    setTimeout(() => setCopiedMail(false), 1800);
  };

  const handleConnectOAuth = async (provider: 'google' | 'microsoft') => {
    setOauthError(null);
    setOauthBusy(`connect-${provider}`);
    try {
      await startCalendarOAuthConnect(provider);
    } catch (err) {
      setOauthError(err instanceof Error ? err.message : String(err));
      setOauthBusy(null);
    }
  };

  const handleSyncConnection = async (connectionId: string) => {
    setOauthError(null);
    setOauthBusy(`sync-${connectionId}`);
    try {
      await syncCalendarConnection(token, connectionId);
      onRefreshCalendar();
    } catch (err) {
      setOauthError(err instanceof Error ? err.message : String(err));
    } finally {
      setOauthBusy(null);
    }
  };

  const handleDisconnectConnection = async (connectionId: string) => {
    setOauthError(null);
    setOauthBusy(`disconnect-${connectionId}`);
    try {
      await disconnectCalendarConnection(token, connectionId);
      onRefreshCalendar();
    } catch (err) {
      setOauthError(err instanceof Error ? err.message : String(err));
    } finally {
      setOauthBusy(null);
    }
  };

  const handleToggleSyncedEvent = async (
    ev: CalendarSyncedEventInfo,
    enabled: boolean
  ) => {
    setOauthError(null);
    setOauthBusy(`toggle-${ev.id}`);
    try {
      await toggleCalendarSyncedEvent(token, ev.id, enabled);
      onRefreshCalendar();
    } catch (err) {
      setOauthError(err instanceof Error ? err.message : String(err));
    } finally {
      setOauthBusy(null);
    }
  };

  return (
    <section id="calendar-details" className="mx-auto max-w-6xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-white">
            <Calendar className="h-5 w-5 text-sky-400" />
            <span>Kalender &amp; E-Mail-Einladungen</span>
          </h1>
          <p className="text-xs text-slate-400">
            Verbinden Sie Ihren Google- oder Microsoft-365-Kalender per OAuth2
            oder laden Sie den Bot per Kalendereinladung / <code>.ics</code>{' '}
            ein.
          </p>
        </div>
        <Button variant="primary" size="md" onClick={onOpenImportModal}>
          <CalendarPlus className="h-4 w-4" />
          <span>.ics / .eml Einladung hochladen</span>
        </Button>
      </div>

      {/* OAuth2 Read-Only Calendar Connect (Google Calendar & Microsoft 365) */}
      <div
        id="calendar-oauth-panel"
        className="rounded-xl border border-slate-800 bg-slate-900/80 p-5 space-y-4"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-sky-400">
              <Link2 className="h-4 w-4" />
              <span>
                Direkte Kalender-Synchronisation (OAuth2 Read-Only)
              </span>
            </div>
            <p className="text-xs leading-relaxed text-slate-300 max-w-3xl">
              <strong>Eigene Termine (Sie sind Organisator):</strong> Werden
              automatisch zur Aufzeichnung eingeplant (per 1-Klick abschaltbar).{' '}
              <strong>Externe Termine (z. B. Kundeneinladung):</strong>{' '}
              Erscheinen in Ihrer Terminliste und können mit 1 Klick
              aufgezeichnet werden, ohne den Bot in die Gästeliste des Kunden
              einzutragen.
            </p>
          </div>
        </div>

        {oauthError && (
          <div className="rounded-lg border border-red-800/80 bg-red-950/60 px-3.5 py-2.5 text-xs text-red-200">
            {oauthError}
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {/* Google Calendar Card */}
          <div className="flex flex-col justify-between gap-3 rounded-lg border border-slate-800 bg-slate-950/70 p-4">
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-white">
                  Google Calendar
                </span>
                {googleConn ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-emerald-800/80 bg-emerald-950/80 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-300">
                    <CheckCircle2 className="h-3 w-3" />
                    Verbunden
                  </span>
                ) : (
                  <span className="text-[11px] text-slate-400">
                    Scope: <code>calendar.readonly</code>
                  </span>
                )}
              </div>
              {googleConn ? (
                <div className="text-xs text-slate-300 space-y-1">
                  <div>
                    Konto:{' '}
                    <strong className="text-white">
                      {googleConn.account_email}
                    </strong>
                  </div>
                  {googleConn.last_synced_at && (
                    <div className="text-[11px] text-slate-400">
                      Zuletzt synchronisiert:{' '}
                      {new Date(googleConn.last_synced_at).toLocaleString(
                        'de-DE'
                      )}
                    </div>
                  )}
                  {googleConn.sync_error && (
                    <div className="text-[11px] text-red-300">
                      Sync-Fehler: {googleConn.sync_error}
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-xs text-slate-400">
                  Synchronisiert automatisch Termine mit Google Meet-, Teams-
                  oder Webex-Link aus Ihrem primären Google-Kalender.
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {googleConn ? (
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={oauthBusy !== null}
                    onClick={() => handleSyncConnection(googleConn.id)}
                  >
                    <RefreshCw
                      className={cn(
                        'h-3.5 w-3.5',
                        oauthBusy === `sync-${googleConn.id}` && 'animate-spin'
                      )}
                    />
                    <span>Jetzt synchronisieren</span>
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={oauthBusy !== null}
                    onClick={() => handleDisconnectConnection(googleConn.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    <span>Trennen</span>
                  </Button>
                </>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={oauthBusy !== null || !calOAuth?.googleEnabled}
                  onClick={() => handleConnectOAuth('google')}
                >
                  <Link2 className="h-3.5 w-3.5" />
                  <span>
                    {calOAuth?.googleEnabled
                      ? 'Google Kalender verbinden'
                      : 'Google OAuth nicht konfiguriert'}
                  </span>
                </Button>
              )}
            </div>
          </div>

          {/* Microsoft 365 / Outlook Calendar Card */}
          <div className="flex flex-col justify-between gap-3 rounded-lg border border-slate-800 bg-slate-950/70 p-4">
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-white">
                  Microsoft 365 / Outlook
                </span>
                {microsoftConn ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-emerald-800/80 bg-emerald-950/80 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-300">
                    <CheckCircle2 className="h-3 w-3" />
                    Verbunden
                  </span>
                ) : (
                  <span className="text-[11px] text-slate-400">
                    Scope: <code>Calendars.Read</code>
                  </span>
                )}
              </div>
              {microsoftConn ? (
                <div className="text-xs text-slate-300 space-y-1">
                  <div>
                    Konto:{' '}
                    <strong className="text-white">
                      {microsoftConn.account_email}
                    </strong>
                  </div>
                  {microsoftConn.last_synced_at && (
                    <div className="text-[11px] text-slate-400">
                      Zuletzt synchronisiert:{' '}
                      {new Date(microsoftConn.last_synced_at).toLocaleString(
                        'de-DE'
                      )}
                    </div>
                  )}
                  {microsoftConn.sync_error && (
                    <div className="text-[11px] text-red-300">
                      Sync-Fehler: {microsoftConn.sync_error}
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-xs text-slate-400">
                  Synchronisiert automatisch Termine mit Microsoft Teams-,
                  Google Meet- oder Webex-Link über Microsoft Graph.
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {microsoftConn ? (
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={oauthBusy !== null}
                    onClick={() => handleSyncConnection(microsoftConn.id)}
                  >
                    <RefreshCw
                      className={cn(
                        'h-3.5 w-3.5',
                        oauthBusy === `sync-${microsoftConn.id}` &&
                          'animate-spin'
                      )}
                    />
                    <span>Jetzt synchronisieren</span>
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={oauthBusy !== null}
                    onClick={() => handleDisconnectConnection(microsoftConn.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    <span>Trennen</span>
                  </Button>
                </>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={oauthBusy !== null || !calOAuth?.microsoftEnabled}
                  onClick={() => handleConnectOAuth('microsoft')}
                >
                  <Link2 className="h-3.5 w-3.5" />
                  <span>
                    {calOAuth?.microsoftEnabled
                      ? 'Microsoft 365 Kalender verbinden'
                      : 'Microsoft OAuth nicht konfiguriert'}
                  </span>
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* Synced OAuth Events Table */}
        {syncedEvents.length > 0 && (
          <div
            id="calendar-synced-events"
            className="overflow-hidden rounded-lg border border-slate-800 bg-slate-950/60"
          >
            <div className="border-b border-slate-800 px-4 py-2.5 text-xs font-semibold text-slate-200 flex items-center justify-between">
              <span>
                Synchronisierte Termine mit Konferenz-Link (
                {syncedEvents.length})
              </span>
              <span className="text-[11px] font-normal text-slate-400">
                1-Klick-Steuerung für Auto-Join
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-800 bg-slate-950/80 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  <tr>
                    <th className="px-4 py-2.5">Aufzeichnung</th>
                    <th className="px-4 py-2.5">Termin &amp; Konferenz</th>
                    <th className="px-4 py-2.5">Rolle / Regel</th>
                    <th className="px-4 py-2.5">Zeitpunkt</th>
                    <th className="px-4 py-2.5 text-right">Aktion</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {syncedEvents.map((ev) => {
                    const isCancelled = ev.status === 'cancelled';
                    const startStr = new Date(ev.starts_at).toLocaleString(
                      'de-DE',
                      {
                        day: '2-digit',
                        month: '2-digit',
                        year: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      }
                    );
                    const toggleBusy = oauthBusy === `toggle-${ev.id}`;
                    return (
                      <tr
                        key={ev.id}
                        className="hover:bg-slate-800/40 transition-colors"
                      >
                        <td className="px-4 py-3 whitespace-nowrap">
                          {isCancelled ? (
                            <span className="inline-flex items-center gap-1 rounded-full border border-red-800/80 bg-red-950/80 px-2.5 py-0.5 text-[11px] font-semibold text-red-300">
                              <XCircle className="h-3 w-3" />
                              Abgesagt
                            </span>
                          ) : (
                            <button
                              type="button"
                              disabled={oauthBusy !== null}
                              onClick={() =>
                                handleToggleSyncedEvent(ev, !ev.auto_record)
                              }
                              className={cn(
                                'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-semibold transition-colors cursor-pointer',
                                ev.auto_record
                                  ? 'border-emerald-700 bg-emerald-950/90 text-emerald-200 hover:bg-emerald-900/80'
                                  : 'border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800'
                              )}
                            >
                              <span
                                className={cn(
                                  'h-2 w-2 rounded-full',
                                  ev.auto_record
                                    ? 'bg-emerald-400'
                                    : 'bg-slate-500'
                                )}
                              />
                              <span>
                                {toggleBusy
                                  ? 'Speichert…'
                                  : ev.auto_record
                                    ? 'Aufzeichnen: An'
                                    : 'Aufzeichnen: Aus'}
                              </span>
                            </button>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <ProviderBadge provider={ev.meeting_provider} />
                            <span className="font-semibold text-slate-100">
                              {ev.title || 'Kalendertermin'}
                            </span>
                            <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] uppercase text-slate-400">
                              {ev.calendar_provider === 'google'
                                ? 'Google'
                                : 'M365'}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-slate-300">
                          {ev.is_self_organized ? (
                            <span className="inline-flex items-center gap-1 text-[11px] text-sky-300">
                              Selbst organisiert (Auto-Join)
                            </span>
                          ) : (
                            <span
                              className="inline-flex items-center gap-1 text-[11px] text-amber-300"
                              title={ev.organizer_email || undefined}
                            >
                              Extern ({ev.organizer_email || 'Gast-Termin'})
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-slate-300 whitespace-nowrap">
                          {startStr}
                        </td>
                        <td className="px-4 py-3 text-right whitespace-nowrap">
                          {ev.recording_id ? (
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() =>
                                onSelectRecording(ev.recording_id!)
                              }
                            >
                              <span>Meeting öffnen</span>
                              <ArrowRight className="h-3.5 w-3.5" />
                            </Button>
                          ) : (
                            <span className="text-slate-500">–</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Onboarding / How-To Card for Mara */}
      <div className="grid grid-cols-1 gap-4 rounded-xl border border-slate-800 bg-slate-900/80 p-5 md:grid-cols-2">
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-sky-400">
            <Mail className="h-4 w-4" />
            <span>Option 1: Direkt im Kalender als Gast einladen</span>
          </div>
          {instance.botEmail ? (
            <>
              <p className="text-xs leading-relaxed text-slate-300">
                Fügen Sie in Google Calendar, Outlook oder Apple Kalender
                folgende Bot-Adresse als Teilnehmer zu Ihrem Termin hinzu:
              </p>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <code className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 font-mono text-xs font-semibold text-white">
                  {instance.botEmail}
                </code>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleCopyMail}
                >
                  {copiedMail ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-emerald-400" />
                      <span>Kopiert!</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5" />
                      <span>Adresse kopieren</span>
                    </>
                  )}
                </Button>
              </div>
              {instance.mail.allowedDomains.length > 0 && (
                <p className="text-[11px] text-slate-400 pt-0.5">
                  Berechtigte Absender-Domains ({instance.mail.senderAuth.toUpperCase()}):{' '}
                  <strong className="text-slate-200">
                    {instance.mail.allowedDomains
                      .map((d) => `@${d}`)
                      .join(', ')}
                  </strong>
                  . Nach Meeting-Ende wird das fertige Transkript automatisch an
                  den Organisator gesendet.
                </p>
              )}
            </>
          ) : (
            <p className="text-xs leading-relaxed text-slate-400">
              Sobald ein IMAP-Postfach konfiguriert ist, können Sie den Bot
              direkt per E-Mail-Einladung zu Terminen hinzufügen. Nutzen Sie
              bis dahin den manuellen Datei-Import rechts.
            </p>
          )}
        </div>

        <div className="space-y-2 border-t border-slate-800/80 pt-3 md:border-t-0 md:border-l md:pl-5 md:pt-0">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-emerald-400">
            <CalendarPlus className="h-4 w-4" />
            <span>Option 2: .ics- oder .eml-Datei hochladen</span>
          </div>
          <p className="text-xs leading-relaxed text-slate-300">
            Laden Sie eine gespeicherte Kalendereinladung (<code>.ics</code>)
            oder weitergeleitete E-Mail (<code>.eml</code>) direkt hier im
            Browser hoch. Terminverschiebungen und Absagen werden automatisch
            synchronisiert.
          </p>
        </div>
      </div>

      <div
        id="calendar-list"
        className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/75"
      >
        {events.length === 0 ? (
          <div className="p-12 text-center space-y-3">
            <Mail className="mx-auto h-8 w-8 text-slate-600" />
            <div className="text-sm font-medium text-slate-200">
              Noch keine Kalendereinladungen vorhanden
            </div>
            <p className="mx-auto max-w-md text-xs text-slate-400">
              Laden Sie oben eine <code>.ics</code>-Einladung hoch oder fügen
              Sie die Bot-Adresse zu einem Termin mit Google Meet-, Microsoft
              Teams- oder Webex-Link hinzu.
            </p>
            <Button variant="secondary" size="sm" onClick={onOpenImportModal}>
              <CalendarPlus className="h-3.5 w-3.5" />
              <span>Erste .ics-Datei importieren</span>
            </Button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-800 bg-slate-950/80 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Termin &amp; Konferenzsystem</th>
                  <th className="px-4 py-3">Eingeladen von</th>
                  <th className="px-4 py-3">Geplante Zeit</th>
                  <th className="px-4 py-3 text-right">Aufnahme</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {events.map((ev, idx) => {
                  const recId =
                    ev.recording_id ||
                    (ev.recording_ids && ev.recording_ids[0]) ||
                    null;
                  const isAccepted = ev.status === 'accepted';
                  const statusLabel =
                    CALENDAR_STATUS_LABELS[ev.status] || ev.status;
                  const reasonText =
                    ev.reason && failureReasons[ev.reason]
                      ? failureReasons[ev.reason]
                      : ev.reason;
                  const startStr = ev.starts_at
                    ? new Date(ev.starts_at).toLocaleString('de-DE', {
                        day: '2-digit',
                        month: '2-digit',
                        year: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                    : 'Serientermin';

                  return (
                    <tr
                      key={`${ev.uid}-${ev.recurrence_id}-${idx}`}
                      className="hover:bg-slate-800/40 transition-colors"
                    >
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span
                          className={cn(
                            'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold border',
                            isAccepted
                              ? 'border-emerald-800/80 bg-emerald-950/80 text-emerald-300'
                              : 'border-red-800/80 bg-red-950/80 text-red-300'
                          )}
                        >
                          {isAccepted ? (
                            <CheckCircle2 className="h-3 w-3" />
                          ) : (
                            <XCircle className="h-3 w-3" />
                          )}
                          {statusLabel}
                        </span>
                        {reasonText && (
                          <div className="mt-1 text-[11px] text-red-300 max-w-xs whitespace-normal">
                            {reasonText}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          {ev.provider && (
                            <ProviderBadge provider={ev.provider} />
                          )}
                          <span
                            className="font-semibold text-slate-100"
                            title={`iCal-UID: ${ev.uid} (Sequenz #${ev.sequence})`}
                          >
                            {ev.title || 'Kalendertermin'}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-slate-300">
                        {ev.organizer || '–'}
                      </td>
                      <td className="px-4 py-3 text-slate-300 whitespace-nowrap">
                        {startStr}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        {recId ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => onSelectRecording(recId)}
                          >
                            <span>Meeting öffnen</span>
                            <ArrowRight className="h-3.5 w-3.5" />
                          </Button>
                        ) : (
                          <span className="text-slate-500">–</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
