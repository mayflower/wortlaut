import React, { useState } from 'react';
import {
  ArrowRight,
  CalendarPlus,
  Check,
  Copy,
  Link2,
  Mail,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { Layout, LayoutContent, LayoutHeader } from '@astryxdesign/core/Layout';
import { Breadcrumbs, BreadcrumbItem } from '@astryxdesign/core/Breadcrumbs';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { HStack } from '@astryxdesign/core/HStack';
import { VStack } from '@astryxdesign/core/VStack';
import { Card } from '@astryxdesign/core/Card';
import { Section } from '@astryxdesign/core/Section';
import { Button } from '@astryxdesign/core/Button';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Switch } from '@astryxdesign/core/Switch';
import { Token } from '@astryxdesign/core/Token';
import { Banner } from '@astryxdesign/core/Banner';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import {
  Table,
  pixel,
  proportional,
  type TableColumn,
} from '@astryxdesign/core/Table';
import {
  disconnectCalendarConnection,
  getFailureReasons,
  getInstanceInfo,
  startCalendarOAuthConnect,
  syncCalendarConnection,
  toggleCalendarSyncedEvent,
} from '../api';
import { useI18n, type UiLang } from '../i18n';
import type {
  CalendarConnectionInfo,
  CalendarEvent,
  CalendarSyncedEventInfo,
} from '../types';
import { ProviderBadge, StatusIndicator } from './ui/primitives';

export interface CalendarWorkspaceProps {
  token: string;
  events: CalendarEvent[];
  connections: CalendarConnectionInfo[];
  syncedEvents: CalendarSyncedEventInfo[];
  onRefreshCalendar: () => void;
  onSelectRecording: (recordingId: string) => void;
  onOpenImportModal: () => void;
  onNavigateHome?: () => void;
}

const CALENDAR_STATUS_LABELS_DE: Record<string, string> = {
  accepted: 'Eingeplant',
  CONFIRMED: 'Bestätigt',
  confirmed: 'Bestätigt',
  cancelled: 'Abgesagt',
  CANCELLED: 'Abgesagt',
  rejected: 'Abgelehnt',
  ignored: 'Ignoriert',
};

const CALENDAR_STATUS_LABELS_EN: Record<string, string> = {
  accepted: 'Scheduled',
  CONFIRMED: 'Confirmed',
  confirmed: 'Confirmed',
  cancelled: 'Cancelled',
  CANCELLED: 'Cancelled',
  rejected: 'Rejected',
  ignored: 'Ignored',
};

type SyncedEventRow = CalendarSyncedEventInfo & Record<string, unknown>;
type IcsEventRow = CalendarEvent & { _rowKey: string } & Record<string, unknown>;

function formatCalendarSlot(
  startsAt: string | null,
  endsAt: string | null | undefined,
  lang: UiLang
): string {
  const localeTag = lang === 'en' ? 'en-US' : 'de-DE';
  if (!startsAt) return lang === 'en' ? 'Recurring event' : 'Serientermin';
  const start = new Date(startsAt);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today.getTime() + 86400000);
  const targetDay = new Date(
    start.getFullYear(),
    start.getMonth(),
    start.getDate()
  );

  let dayPrefix: string;
  if (targetDay.getTime() === today.getTime()) {
    dayPrefix = lang === 'en' ? 'Today' : 'Heute';
  } else if (targetDay.getTime() === tomorrow.getTime()) {
    dayPrefix = lang === 'en' ? 'Tomorrow' : 'Morgen';
  } else {
    dayPrefix = start.toLocaleDateString(localeTag, {
      weekday: 'short',
      day: '2-digit',
      month: '2-digit',
    });
  }

  const startTime = start.toLocaleTimeString(localeTag, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  if (endsAt) {
    const end = new Date(endsAt);
    const endTime = end.toLocaleTimeString(localeTag, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return `${dayPrefix}, ${startTime} – ${endTime}`;
  }
  return `${dayPrefix}, ${startTime}`;
}

export function CalendarWorkspace({
  token,
  events,
  connections,
  syncedEvents,
  onRefreshCalendar,
  onSelectRecording,
  onOpenImportModal,
  onNavigateHome,
}: CalendarWorkspaceProps) {
  const { lang, localeTag, tr } = useI18n();
  const instance = getInstanceInfo();
  const failureReasons = getFailureReasons();
  const [copiedMail, setCopiedMail] = useState(false);
  const [copiedProtocolId, setCopiedProtocolId] = useState<string | null>(null);
  const [oauthBusy, setOauthBusy] = useState<string | null>(null);
  const [oauthError, setOauthError] = useState<string | null>(null);

  const calOAuth = instance.calendarOAuth;
  const googleConn = connections.find((c) => c.provider === 'google') || null;
  const microsoftConn =
    connections.find((c) => c.provider === 'microsoft') || null;
  const statusMap =
    lang === 'en' ? CALENDAR_STATUS_LABELS_EN : CALENDAR_STATUS_LABELS_DE;

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

  const syncedColumns: TableColumn<SyncedEventRow>[] = [
    {
      key: 'auto_record',
      header: tr('Aufzeichnen', 'Auto-record'),
      width: pixel(120),
      renderCell: (ev) => {
        if (ev.status === 'cancelled') {
          return (
            <StatusIndicator
              variant="error"
              weight="medium"
              label={tr('Abgesagt', 'Cancelled')}
            />
          );
        }
        const toggleBusy = oauthBusy === `toggle-${ev.id}`;
        return (
          <Switch
            size="sm"
            value={ev.auto_record}
            isLoading={toggleBusy}
            isDisabled={oauthBusy !== null}
            label={ev.auto_record ? tr('An', 'On') : tr('Aus', 'Off')}
            onChange={(checked) => handleToggleSyncedEvent(ev, checked)}
          />
        );
      },
    },
    {
      key: 'title',
      header: tr('Termin & Konferenz', 'Meeting & Provider'),
      width: proportional(2, { minWidth: 240 }),
      renderCell: (ev) => (
        <HStack gap={2} vAlign="center" wrap="nowrap">
          <span className="shrink-0">
            <ProviderBadge provider={ev.meeting_provider} />
          </span>
          <Text type="body" weight="semibold" color="primary" maxLines={1}>
            {ev.title || tr('Kalendertermin', 'Calendar event')}
          </Text>
          <span className="shrink-0">
            <Token
              size="sm"
              color="gray"
              label={ev.calendar_provider === 'google' ? 'Google' : 'M365'}
            />
          </span>
        </HStack>
      ),
    },
    {
      key: 'organizer_email',
      header: tr('Rolle / Regel', 'Role / Policy'),
      width: proportional(1.2, { minWidth: 180 }),
      renderCell: (ev) =>
        ev.is_self_organized ? (
          <Token
            size="sm"
            color="blue"
            label={tr('Organisator (Auto-Join)', 'Organizer (auto-join)')}
          />
        ) : (
          <Token
            size="sm"
            color="orange"
            label={`${tr('Gast', 'Attendee')} (${ev.organizer_email || tr('Extern', 'External')})`}
          />
        ),
    },
    {
      key: 'starts_at',
      header: tr('Zeitfenster', 'Time slot'),
      width: pixel(160),
      renderCell: (ev) => (
        <Text type="supporting" color="secondary" hasTabularNumbers>
          {formatCalendarSlot(ev.starts_at, ev.ends_at, lang)}
        </Text>
      ),
    },
    {
      key: 'recording_id',
      header: tr('Protokoll', 'Protocol'),
      width: pixel(290),
      align: 'end',
      renderCell: (ev) => {
        if (!ev.recording_id) {
          return (
            <Text type="supporting" color="secondary">
              –
            </Text>
          );
        }
        const isCompleted = ev.recording_processing === 'completed';
        return (
          <HStack gap={1.5} vAlign="center" justify="end" wrap="nowrap">
            {ev.calendar_link_synced_at && (
              <span className="shrink-0">
                <Token
                  size="sm"
                  color="green"
                  label={tr('Im Termin verlinkt', 'Linked in event')}
                />
              </span>
            )}
            {isCompleted && ev.protocol_url && (
              <IconButton
                variant="ghost"
                size="sm"
                label={
                  copiedProtocolId === ev.id
                    ? tr('Kopiert', 'Copied')
                    : tr('Protokoll-Link kopieren', 'Copy protocol link')
                }
                tooltip={
                  copiedProtocolId === ev.id
                    ? tr('Kopiert!', 'Copied!')
                    : tr('Protokoll-Link kopieren', 'Copy protocol link')
                }
                icon={
                  copiedProtocolId === ev.id ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )
                }
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(ev.protocol_url!);
                    setCopiedProtocolId(ev.id);
                    setTimeout(() => setCopiedProtocolId(null), 2000);
                  } catch {
                    // ignore clipboard errors
                  }
                }}
              />
            )}
            <span className="shrink-0">
              <Button
                variant={isCompleted ? 'secondary' : 'ghost'}
                size="sm"
                label={
                  isCompleted
                    ? tr('Protokoll öffnen', 'Open transcript')
                    : tr('Öffnen', 'Open')
                }
                endContent={<ArrowRight className="h-3.5 w-3.5" />}
                onClick={() => onSelectRecording(ev.recording_id!)}
              />
            </span>
          </HStack>
        );
      },
    },
  ];

  const icsRows: IcsEventRow[] = events.map((ev, idx) => ({
    ...ev,
    _rowKey: `${ev.uid}-${ev.recurrence_id}-${idx}`,
  }));

  const icsColumns: TableColumn<IcsEventRow>[] = [
    {
      key: 'status',
      header: 'Status',
      width: pixel(175),
      renderCell: (ev) => {
        const isAccepted =
          ev.status === 'accepted' ||
          ev.status === 'CONFIRMED' ||
          ev.status === 'confirmed';
        const statusLabel = statusMap[ev.status] || ev.status;
        const reasonText =
          ev.reason && failureReasons[ev.reason]
            ? failureReasons[ev.reason]
            : ev.reason;
        return (
          <VStack gap={0.5} hAlign="start">
            <StatusIndicator
              variant={isAccepted ? 'success' : 'error'}
              weight="medium"
              label={statusLabel}
            />
            {reasonText && (
              <Text type="supporting" color="secondary" maxLines={1}>
                {reasonText}
              </Text>
            )}
          </VStack>
        );
      },
    },
    {
      key: 'title',
      header: tr('Termin & Konferenzsystem', 'Meeting & Provider'),
      width: proportional(2, { minWidth: 220 }),
      renderCell: (ev) => (
        <HStack gap={2} vAlign="center" wrap="nowrap">
          {ev.provider && <ProviderBadge provider={ev.provider} />}
          <Text type="body" weight="semibold" color="primary" maxLines={1}>
            {ev.title || tr('Kalendertermin', 'Calendar event')}
          </Text>
        </HStack>
      ),
    },
    {
      key: 'organizer',
      header: tr('Eingeladen von', 'Organizer'),
      width: proportional(1.2, { minWidth: 160 }),
      renderCell: (ev) => (
        <Text type="supporting" color="secondary">
          {ev.organizer || '–'}
        </Text>
      ),
    },
    {
      key: 'starts_at',
      header: tr('Geplante Zeit', 'Scheduled slot'),
      width: pixel(190),
      renderCell: (ev) => (
        <Text type="supporting" color="secondary" hasTabularNumbers>
          {formatCalendarSlot(ev.starts_at, ev.ends_at, lang)}
        </Text>
      ),
    },
    {
      key: 'recording_id',
      header: tr('Protokoll', 'Protocol'),
      width: pixel(180),
      align: 'end',
      renderCell: (ev) => {
        const recId =
          ev.recording_id ||
          (ev.recording_ids && ev.recording_ids[0]) ||
          null;
        const isCompleted = ev.recording_processing === 'completed';
        return recId ? (
          <Button
            variant={isCompleted ? 'secondary' : 'ghost'}
            size="sm"
            label={
              isCompleted
                ? tr('Protokoll öffnen', 'Open transcript')
                : tr('Öffnen', 'Open')
            }
            endContent={<ArrowRight className="h-3.5 w-3.5" />}
            onClick={() => onSelectRecording(recId)}
          />
        ) : (
          <Text type="supporting" color="secondary">
            –
          </Text>
        );
      },
    },
  ];

  return (
    <Layout
      height="fill"
      header={
        <LayoutHeader hasDivider>
          <div className="wl-page-container">
          <VStack gap={2}>
            {onNavigateHome && (
              <Breadcrumbs
                variant="supporting"
                label={tr('Pfadnavigation', 'Breadcrumb')}
              >
                <BreadcrumbItem onClick={onNavigateHome}>
                  {tr('Startseite', 'Home')}
                </BreadcrumbItem>
                <BreadcrumbItem isCurrent>
                  {tr('Kalender', 'Calendar')}
                </BreadcrumbItem>
              </Breadcrumbs>
            )}
            <HStack justify="between" vAlign="center" wrap="wrap" gap={3}>
              <VStack gap={0.5}>
                <Heading level={1}>
                  {tr(
                    'Kalender & E-Mail-Einladungen',
                    'Calendar & Email Invitations'
                  )}
                </Heading>
                <Text type="supporting" color="secondary">
                  {tr(
                    'Verbinden Sie Ihren Google- oder Microsoft-365-Kalender per OAuth2 (inkl. automatischer Protokoll-Verlinkung im Termin) oder laden Sie eine Kalendereinladung hoch.',
                    'Connect your Google Calendar or Microsoft 365 account via OAuth2 (including automatic transcript writeback into the event) or upload an .ics invitation.'
                  )}
                </Text>
              </VStack>

            <HStack gap={2} vAlign="center" wrap="wrap">
              {instance.botEmail && (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={
                    copiedMail ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )
                  }
                  label={
                    copiedMail
                      ? tr('Bot-Adresse kopiert!', 'Bot address copied!')
                      : `${tr('Bot-Adresse', 'Bot address')}: ${instance.botEmail}`
                  }
                  onClick={handleCopyMail}
                />
              )}
              <Button
                variant="primary"
                size="sm"
                icon={<CalendarPlus className="h-3.5 w-3.5" />}
                label={tr(
                  '.ics / .eml Einladung hochladen',
                  'Upload .ics / .eml invite'
                )}
                onClick={onOpenImportModal}
              />
            </HStack>
            </HStack>
          </VStack>
          </div>
        </LayoutHeader>
      }
      content={
        <LayoutContent>
          <div className="wl-page-container">
          <VStack gap={4} id="calendar-details">
            {oauthError && (
              <Banner
                status="error"
                container="card"
                title={oauthError}
                isDismissable
                onDismiss={() => setOauthError(null)}
              />
            )}

            {/* Discrete OAuth2 Account Cards */}
            <div
              id="calendar-oauth-panel"
              className="grid grid-cols-1 gap-4 md:grid-cols-2"
            >
              <Card>
                <VStack gap={3}>
                  <HStack justify="between" vAlign="center">
                    <Heading level={3}>Google Calendar</Heading>
                    {googleConn ? (
                      <StatusIndicator
                        variant="success"
                        weight="medium"
                        label={tr('Verbunden', 'Connected')}
                      />
                    ) : (
                      <Token size="sm" color="gray" label="calendar.events" />
                    )}
                  </HStack>

                  {googleConn ? (
                    <VStack gap={0.5}>
                      <Text type="body" color="primary">
                        {tr('Konto', 'Account')}:{' '}
                        <strong>{googleConn.account_email}</strong>
                      </Text>
                      {googleConn.last_synced_at && (
                        <Text type="supporting" color="secondary">
                          {tr('Zuletzt synchronisiert', 'Last synced')}:{' '}
                          {new Date(googleConn.last_synced_at).toLocaleString(
                            localeTag
                          )}
                        </Text>
                      )}
                      {googleConn.sync_error && (
                        <Text type="supporting" color="secondary">
                          {tr('Sync-Fehler', 'Sync error')}:{' '}
                          {googleConn.sync_error}
                        </Text>
                      )}
                    </VStack>
                  ) : (
                    <Text type="supporting" color="secondary">
                      {tr(
                        'Synchronisiert automatisch Termine mit Google Meet-, Teams-, Webex- oder Zoom-Link und hinterlegt nach dem Call den Protokoll-Link direkt im Kalendereintrag.',
                        'Automatically syncs events with Google Meet, Teams, Webex, or Zoom links and writes a read-only transcript link back into the calendar event after the call.'
                      )}
                    </Text>
                  )}

                  <HStack gap={2} wrap="wrap">
                    {googleConn ? (
                      <>
                        <Button
                          variant="secondary"
                          size="sm"
                          isLoading={oauthBusy === `sync-${googleConn.id}`}
                          isDisabled={oauthBusy !== null}
                          icon={<RefreshCw className="h-3.5 w-3.5" />}
                          label={tr('Jetzt synchronisieren', 'Sync now')}
                          onClick={() => handleSyncConnection(googleConn.id)}
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          isLoading={oauthBusy === 'connect-google'}
                          isDisabled={oauthBusy !== null}
                          icon={<Link2 className="h-3.5 w-3.5" />}
                          label={tr(
                            'Berechtigung erneuern',
                            'Reconnect permissions'
                          )}
                          onClick={() => handleConnectOAuth('google')}
                        />
                        <Button
                          variant="destructive"
                          size="sm"
                          isLoading={
                            oauthBusy === `disconnect-${googleConn.id}`
                          }
                          isDisabled={oauthBusy !== null}
                          icon={<Trash2 className="h-3.5 w-3.5" />}
                          label={tr('Trennen', 'Disconnect')}
                          onClick={() =>
                            handleDisconnectConnection(googleConn.id)
                          }
                        />
                      </>
                    ) : (
                      <Button
                        variant="secondary"
                        size="sm"
                        isLoading={oauthBusy === 'connect-google'}
                        isDisabled={
                          oauthBusy !== null || !calOAuth?.googleEnabled
                        }
                        icon={<Link2 className="h-3.5 w-3.5" />}
                        label={
                          calOAuth?.googleEnabled
                            ? tr(
                                'Google Kalender verbinden',
                                'Connect Google Calendar'
                              )
                            : tr(
                                'Google OAuth nicht konfiguriert',
                                'Google OAuth not configured'
                              )
                        }
                        onClick={() => handleConnectOAuth('google')}
                      />
                    )}
                  </HStack>
                </VStack>
              </Card>

              <Card>
                <VStack gap={3}>
                  <HStack justify="between" vAlign="center">
                    <Heading level={3}>Microsoft 365 / Outlook</Heading>
                    {microsoftConn ? (
                      <StatusIndicator
                        variant="success"
                        weight="medium"
                        label={tr('Verbunden', 'Connected')}
                      />
                    ) : (
                      <Token size="sm" color="gray" label="Calendars.ReadWrite" />
                    )}
                  </HStack>

                  {microsoftConn ? (
                    <VStack gap={0.5}>
                      <Text type="body" color="primary">
                        {tr('Konto', 'Account')}:{' '}
                        <strong>{microsoftConn.account_email}</strong>
                      </Text>
                      {microsoftConn.last_synced_at && (
                        <Text type="supporting" color="secondary">
                          {tr('Zuletzt synchronisiert', 'Last synced')}:{' '}
                          {new Date(
                            microsoftConn.last_synced_at
                          ).toLocaleString(localeTag)}
                        </Text>
                      )}
                      {microsoftConn.sync_error && (
                        <Text type="supporting" color="secondary">
                          {tr('Sync-Fehler', 'Sync error')}:{' '}
                          {microsoftConn.sync_error}
                        </Text>
                      )}
                    </VStack>
                  ) : (
                    <Text type="supporting" color="secondary">
                      {tr(
                        'Synchronisiert automatisch Termine mit Microsoft Teams-, Google Meet-, Webex- oder Zoom-Link und hinterlegt nach dem Call den Protokoll-Link direkt im Termin.',
                        'Automatically syncs events with Microsoft Teams, Google Meet, Webex, or Zoom links and writes the protocol link directly into the calendar invite after the call.'
                      )}
                    </Text>
                  )}

                  <HStack gap={2} wrap="wrap">
                    {microsoftConn ? (
                      <>
                        <Button
                          variant="secondary"
                          size="sm"
                          isLoading={oauthBusy === `sync-${microsoftConn.id}`}
                          isDisabled={oauthBusy !== null}
                          icon={<RefreshCw className="h-3.5 w-3.5" />}
                          label={tr('Jetzt synchronisieren', 'Sync now')}
                          onClick={() => handleSyncConnection(microsoftConn.id)}
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          isLoading={oauthBusy === 'connect-microsoft'}
                          isDisabled={oauthBusy !== null}
                          icon={<Link2 className="h-3.5 w-3.5" />}
                          label={tr(
                            'Berechtigung erneuern',
                            'Reconnect permissions'
                          )}
                          onClick={() => handleConnectOAuth('microsoft')}
                        />
                        <Button
                          variant="destructive"
                          size="sm"
                          isLoading={
                            oauthBusy === `disconnect-${microsoftConn.id}`
                          }
                          isDisabled={oauthBusy !== null}
                          icon={<Trash2 className="h-3.5 w-3.5" />}
                          label={tr('Trennen', 'Disconnect')}
                          onClick={() =>
                            handleDisconnectConnection(microsoftConn.id)
                          }
                        />
                      </>
                    ) : (
                      <Button
                        variant="secondary"
                        size="sm"
                        isLoading={oauthBusy === 'connect-microsoft'}
                        isDisabled={
                          oauthBusy !== null || !calOAuth?.microsoftEnabled
                        }
                        icon={<Link2 className="h-3.5 w-3.5" />}
                        label={
                          calOAuth?.microsoftEnabled
                            ? tr(
                                'Microsoft 365 Kalender verbinden',
                                'Connect Microsoft 365 Calendar'
                              )
                            : tr(
                                'Microsoft OAuth nicht konfiguriert',
                                'Microsoft OAuth not configured'
                              )
                        }
                        onClick={() => handleConnectOAuth('microsoft')}
                      />
                    )}
                  </HStack>
                </VStack>
              </Card>
            </div>

            {/* Synced OAuth Events */}
            {syncedEvents.length > 0 && (
              <div id="calendar-synced-events">
                <Section variant="section">
                  <VStack gap={2}>
                    <HStack justify="between" vAlign="center" wrap="wrap">
                      <Heading level={3}>
                        {tr(
                          `Synchronisierte Termine mit Konferenz-Link (${syncedEvents.length})`,
                          `Synced Calendar Meetings (${syncedEvents.length})`
                        )}
                      </Heading>
                      <Text type="supporting" color="secondary">
                        {tr(
                          'Eigene Termine (mit bestätigten Gästen) starten automatisch; externe Termine per 1-Klick-Schalter zuschaltbar',
                          'Self-organized meetings auto-join; external invites can be toggled on with 1 click'
                        )}
                      </Text>
                    </HStack>

                    <Table<SyncedEventRow>
                      idKey="id"
                      density="balanced"
                      dividers="rows"
                      hasHover
                      data={syncedEvents as SyncedEventRow[]}
                      columns={syncedColumns}
                    />
                  </VStack>
                </Section>
              </div>
            )}

            {/* Imported .ics / IMAP Events */}
            {(events.length > 0 || (!googleConn && !microsoftConn)) && (
              <div id="calendar-list">
                <Section variant="section">
                  <VStack gap={2}>
                    <HStack justify="between" vAlign="center" wrap="wrap">
                      <Heading level={3}>
                        {tr(
                          `E-Mail- & .ics-Kalendereinladungen (${events.length})`,
                          `Email & .ics Calendar Invites (${events.length})`
                        )}
                      </Heading>
                      {instance.botEmail && (
                        <Text type="supporting" color="secondary">
                          {tr('Einladungsadresse', 'Invite address')}:{' '}
                          <code>{instance.botEmail}</code>
                        </Text>
                      )}
                    </HStack>

                    {events.length === 0 ? (
                      <EmptyState
                        isCompact
                        icon={<Mail className="h-6 w-6" />}
                        title={tr(
                          'Noch keine Kalendereinladungen vorhanden',
                          'No .ics calendar invites yet'
                        )}
                        description={tr(
                          'Verbinden Sie oben Ihren Google- oder Microsoft-365-Kalender oder laden Sie eine .ics-Datei hoch.',
                          'Connect your Google Calendar or Microsoft 365 account above, or upload an .ics invitation file.'
                        )}
                        actions={
                          <Button
                            variant="secondary"
                            size="sm"
                            icon={<CalendarPlus className="h-3.5 w-3.5" />}
                            label={tr(
                              '.ics-Datei importieren',
                              'Import .ics file'
                            )}
                            onClick={onOpenImportModal}
                          />
                        }
                      />
                    ) : (
                      <Table<IcsEventRow>
                        idKey="_rowKey"
                        density="balanced"
                        dividers="rows"
                        hasHover
                        data={icsRows}
                        columns={icsColumns}
                      />
                    )}
                  </VStack>
                </Section>
              </div>
            )}
          </VStack>
          </div>
        </LayoutContent>
      }
    />
  );
}
