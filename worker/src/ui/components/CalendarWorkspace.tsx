import { useState } from 'react';
import {
  ArrowRight,
  Calendar,
  CalendarPlus,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Link2,
  Mail,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { Layout, LayoutContent, LayoutHeader } from '@astryxdesign/core/Layout';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { HStack } from '@astryxdesign/core/HStack';
import { VStack } from '@astryxdesign/core/VStack';
import { Card } from '@astryxdesign/core/Card';
import { Button } from '@astryxdesign/core/Button';
import { IconButton } from '@astryxdesign/core/IconButton';
import { MoreMenu } from '@astryxdesign/core/MoreMenu';
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
  loadError?: string | null;
  onRefreshCalendar: () => void;
  onSelectRecording: (recordingId: string) => void;
  onOpenImportModal: () => void;
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

export function isPastCalendarSlot(
  endsAt: string | null | undefined,
  nowMs: number
): boolean {
  return endsAt != null && new Date(endsAt).getTime() < nowMs;
}

function formatCalendarSlot(
  startsAt: string | null,
  endsAt: string | null | undefined,
  lang: UiLang
): string {
  const localeTag = lang === 'en' ? 'en-US' : 'de-DE';
  if (!startsAt) return lang === 'en' ? 'Recurring' : 'Serie';
  const start = new Date(startsAt);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today.getTime() + 86400000);
  const yesterday = new Date(today.getTime() - 86400000);
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
  } else if (targetDay.getTime() === yesterday.getTime()) {
    dayPrefix = lang === 'en' ? 'Yesterday' : 'Gestern';
  } else {
    dayPrefix = start.toLocaleDateString(localeTag, {
      weekday: 'short',
      day: '2-digit',
      month: '2-digit',
      ...(start.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
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
  loadError = null,
  onRefreshCalendar,
  onSelectRecording,
  onOpenImportModal,
}: CalendarWorkspaceProps) {
  const { lang, localeTag, tr } = useI18n();
  const instance = getInstanceInfo();
  const failureReasons = getFailureReasons();
  const [copiedMail, setCopiedMail] = useState(false);
  const [copiedProtocolId, setCopiedProtocolId] = useState<string | null>(null);
  const [oauthBusy, setOauthBusy] = useState<string | null>(null);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [showPastSynced, setShowPastSynced] = useState(false);
  const [showPastIcs, setShowPastIcs] = useState(false);
  const nowMs = Date.now();

  const upcomingSyncedEvents = syncedEvents
    .filter((ev) => !isPastCalendarSlot(ev.ends_at, nowMs))
    .sort((a, b) => {
      const aCancelled = a.status === 'cancelled' ? 1 : 0;
      const bCancelled = b.status === 'cancelled' ? 1 : 0;
      if (aCancelled !== bCancelled) return aCancelled - bCancelled;
      return new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime();
    });
  const activeUpcomingSyncedCount = upcomingSyncedEvents.filter(
    (ev) => ev.status !== 'cancelled'
  ).length;
  const pastSyncedEvents = syncedEvents
    .filter((ev) => isPastCalendarSlot(ev.ends_at, nowMs))
    .sort(
      (a, b) =>
        new Date(b.starts_at).getTime() - new Date(a.starts_at).getTime()
    );

  const calOAuth = instance.calendarOAuth;
  const googleConn = connections.find((c) => c.provider === 'google') || null;
  const microsoftConn =
    connections.find((c) => c.provider === 'microsoft') || null;
  const hasMultipleConnections = Boolean(googleConn && microsoftConn);
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
      header: tr('Aufnahme', 'Record'),
      width: pixel(115),
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
        if (isPastCalendarSlot(ev.ends_at, nowMs)) {
          return ev.recording_id ? (
            <StatusIndicator
              variant="success"
              weight="medium"
              label={tr('Erfasst', 'Recorded')}
            />
          ) : (
            <StatusIndicator
              variant="neutral"
              weight="normal"
              label={tr('Beendet', 'Ended')}
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
      header: tr('Termin', 'Meeting'),
      width: proportional(3.2, { minWidth: 260 }),
      renderCell: (ev) => (
        <HStack gap={2} vAlign="center" wrap="nowrap">
          <span className="shrink-0">
            <ProviderBadge provider={ev.meeting_provider} />
          </span>
          <Text type="body" weight="semibold" color="primary" maxLines={1}>
            {ev.title || tr('Kalendertermin', 'Calendar event')}
          </Text>
          {hasMultipleConnections && (
            <span className="shrink-0">
              <Token
                size="sm"
                color="gray"
                label={ev.calendar_provider === 'google' ? 'Google' : 'M365'}
              />
            </span>
          )}
        </HStack>
      ),
    },
    {
      key: 'organizer_email',
      header: tr('Rolle', 'Role'),
      width: pixel(135),
      renderCell: (ev) => (
        <Text type="supporting" color="secondary" maxLines={1}>
          {ev.is_self_organized
            ? tr('Organisator', 'Organizer')
            : tr('Gast', 'Attendee')}
        </Text>
      ),
    },
    {
      key: 'starts_at',
      header: tr('Zeitfenster', 'Time'),
      width: pixel(185),
      renderCell: (ev) => (
        <Text type="supporting" color="secondary" hasTabularNumbers>
          {formatCalendarSlot(ev.starts_at, ev.ends_at, lang)}
        </Text>
      ),
    },
    {
      key: 'recording_id',
      header: tr('Protokoll', 'Protocol'),
      width: pixel(155),
      align: 'end',
      renderCell: (ev) => {
        if (!ev.recording_id) {
          return (
            <Text type="supporting" color="secondary">
              {ev.auto_record ? tr('Eingeplant', 'Scheduled') : '–'}
            </Text>
          );
        }
        const isCompleted = ev.recording_processing === 'completed';
        return (
          <HStack gap={1} vAlign="center" justify="end" wrap="nowrap">
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
                label={tr('Öffnen', 'Open')}
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
  const upcomingIcsRows = icsRows
    .filter((ev) => !isPastCalendarSlot(ev.ends_at, nowMs))
    .sort((a, b) => {
      const aCancelled =
        a.status === 'cancelled' || a.status === 'CANCELLED' ? 1 : 0;
      const bCancelled =
        b.status === 'cancelled' || b.status === 'CANCELLED' ? 1 : 0;
      if (aCancelled !== bCancelled) return aCancelled - bCancelled;
      const aMs = a.starts_at
        ? new Date(a.starts_at).getTime()
        : Number.MAX_SAFE_INTEGER;
      const bMs = b.starts_at
        ? new Date(b.starts_at).getTime()
        : Number.MAX_SAFE_INTEGER;
      return aMs - bMs;
    });
  const activeUpcomingIcsCount = upcomingIcsRows.filter(
    (ev) => ev.status !== 'cancelled' && ev.status !== 'CANCELLED'
  ).length;
  const pastIcsRows = icsRows
    .filter((ev) => isPastCalendarSlot(ev.ends_at, nowMs))
    .sort((a, b) => {
      const aMs = a.starts_at ? new Date(a.starts_at).getTime() : 0;
      const bMs = b.starts_at ? new Date(b.starts_at).getTime() : 0;
      return bMs - aMs;
    });

  const icsColumns: TableColumn<IcsEventRow>[] = [
    {
      key: 'status',
      header: 'Status',
      width: pixel(150),
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
      header: tr('Termin', 'Meeting'),
      width: proportional(2.8, { minWidth: 240 }),
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
      header: tr('Organisator', 'Organizer'),
      width: proportional(1.2, { minWidth: 150 }),
      renderCell: (ev) => (
        <Text type="supporting" color="secondary" maxLines={1}>
          {ev.organizer || '–'}
        </Text>
      ),
    },
    {
      key: 'starts_at',
      header: tr('Zeitfenster', 'Time'),
      width: pixel(185),
      renderCell: (ev) => (
        <Text type="supporting" color="secondary" hasTabularNumbers>
          {formatCalendarSlot(ev.starts_at, ev.ends_at, lang)}
        </Text>
      ),
    },
    {
      key: 'recording_id',
      header: tr('Protokoll', 'Protocol'),
      width: pixel(135),
      align: 'end',
      renderCell: (ev) => {
        const recId =
          ev.recording_id ||
          (ev.recording_ids && ev.recording_ids[0]) ||
          null;
        return recId ? (
          <Button
            variant="ghost"
            size="sm"
            label={tr('Öffnen', 'Open')}
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

  const renderConnectionCard = (
    provider: 'google' | 'microsoft',
    titleLabel: string,
    conn: CalendarConnectionInfo | null,
    enabled: boolean | undefined
  ) => {
    const needsWriteUpgrade =
      conn != null &&
      syncedEvents.some(
        (ev) =>
          ev.connection_id === conn.id &&
          !ev.calendar_link_synced_at &&
          ev.calendar_link_error === 'insufficient_calendar_write_scope'
      );
    return (
      <Card>
        <VStack gap={2}>
          <HStack justify="between" vAlign="center" gap={2}>
            <Text type="body" weight="semibold" color="primary">
              {titleLabel}
            </Text>
            {conn ? (
              needsWriteUpgrade ? (
                <StatusIndicator
                  variant="warning"
                  weight="medium"
                  label={tr(
                    'Nur Lesen · Schreibzugriff erneuern',
                    'Read-only · Reconnect for write access'
                  )}
                />
              ) : (
                <StatusIndicator
                  variant="success"
                  weight="medium"
                  label={tr('Verbunden', 'Connected')}
                />
              )
            ) : null}
          </HStack>

          {conn ? (
            <HStack justify="between" vAlign="center" wrap="wrap" gap={2}>
              <VStack gap={0.5}>
                <Text type="supporting" weight="semibold" color="primary">
                  {conn.account_email}
                </Text>
                {conn.sync_error ? (
                  <Text type="supporting" color="secondary">
                    {conn.sync_error}
                  </Text>
                ) : conn.last_synced_at ? (
                  <Text
                    type="supporting"
                    color="secondary"
                    hasTabularNumbers
                  >
                    {tr('Sync', 'Synced')}:{' '}
                    {new Date(conn.last_synced_at).toLocaleTimeString(localeTag, {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </Text>
                ) : null}
              </VStack>

              <HStack gap={1.5} vAlign="center">
                {needsWriteUpgrade && (
                  <Button
                    variant="primary"
                    size="sm"
                    isLoading={oauthBusy === `connect-${provider}`}
                    isDisabled={oauthBusy !== null}
                    icon={<Link2 className="h-3.5 w-3.5" />}
                    label={tr(
                      'Schreibzugriff aktivieren',
                      'Enable write access'
                    )}
                    onClick={() => handleConnectOAuth(provider)}
                  />
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  isLoading={oauthBusy === `sync-${conn.id}`}
                  isDisabled={oauthBusy !== null}
                  icon={<RefreshCw className="h-3.5 w-3.5" />}
                  label={tr('Synchronisieren', 'Sync')}
                  onClick={() => handleSyncConnection(conn.id)}
                />
                <MoreMenu
                  size="sm"
                  variant="ghost"
                  alignment="end"
                  label={tr('Konto-Aktionen', 'Account actions')}
                  items={[
                    {
                      id: 'reconnect',
                      label: tr(
                        'Berechtigung erneuern',
                        'Reconnect permissions'
                      ),
                      icon: <Link2 className="h-3.5 w-3.5" />,
                      onClick: () => handleConnectOAuth(provider),
                    },
                    {
                      id: 'disconnect',
                      label: tr('Verbindung trennen', 'Disconnect'),
                      variant: 'destructive',
                      icon: <Trash2 className="h-3.5 w-3.5" />,
                      onClick: () => handleDisconnectConnection(conn.id),
                    },
                  ]}
                />
              </HStack>
            </HStack>
          ) : (
            <HStack justify="between" vAlign="center" wrap="wrap" gap={2}>
              <Text type="supporting" color="secondary">
                {tr(
                  'Termine synchronisieren & Protokoll-Link automatisch hinterlegen.',
                  'Sync meetings & write protocol link back into calendar.'
                )}
              </Text>
              <Button
                variant="secondary"
                size="sm"
                isLoading={oauthBusy === `connect-${provider}`}
                isDisabled={oauthBusy !== null || !enabled}
                icon={<Link2 className="h-3.5 w-3.5" />}
                label={
                  enabled
                    ? tr('Verbinden', 'Connect')
                    : tr('Nicht konfiguriert', 'Not configured')
                }
                onClick={() => handleConnectOAuth(provider)}
              />
            </HStack>
          )}
        </VStack>
      </Card>
    );
  };

  return (
    <Layout
      height="fill"
      header={
        <LayoutHeader hasDivider>
          <div className="wl-page-container">
            <HStack justify="between" vAlign="center" wrap="wrap" gap={3}>
              <Heading level={1}>{tr('Kalender', 'Calendar')}</Heading>

              <HStack gap={2} vAlign="center" wrap="wrap">
                {instance.botEmail && (
                  <Button
                    variant="ghost"
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
                        ? tr('Kopiert', 'Copied')
                        : instance.botEmail
                    }
                    onClick={handleCopyMail}
                  />
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<CalendarPlus className="h-3.5 w-3.5" />}
                  label={tr('.ics importieren', 'Import .ics')}
                  onClick={onOpenImportModal}
                />
              </HStack>
            </HStack>
          </div>
        </LayoutHeader>
      }
      content={
        <LayoutContent>
          <div className="wl-page-container">
            <VStack gap={6} id="calendar-details">
              {(oauthError || loadError) && (
                <Banner
                  status="error"
                  container="card"
                  title={oauthError || loadError || ''}
                  isDismissable={Boolean(oauthError)}
                  onDismiss={oauthError ? () => setOauthError(null) : undefined}
                  endContent={
                    loadError ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<RefreshCw className="h-3.5 w-3.5" />}
                        label={tr('Erneut laden', 'Retry')}
                        onClick={onRefreshCalendar}
                      />
                    ) : undefined
                  }
                />
              )}

              <VStack gap={3}>
                <Heading level={2}>
                  {tr('Verbundene Konten', 'Connected Accounts')}
                </Heading>
                <div
                  id="calendar-oauth-panel"
                  className="grid grid-cols-1 gap-4 md:grid-cols-2"
                >
                  {renderConnectionCard(
                    'google',
                    'Google Calendar',
                    googleConn,
                    calOAuth?.googleEnabled
                  )}
                  {renderConnectionCard(
                    'microsoft',
                    'Microsoft 365',
                    microsoftConn,
                    calOAuth?.microsoftEnabled
                  )}
                </div>
              </VStack>

              {(syncedEvents.length > 0 || googleConn || microsoftConn) && (
                <VStack gap={3} id="calendar-synced-events">
                  <HStack justify="between" vAlign="center" wrap="wrap" gap={2}>
                    <HStack gap={2} vAlign="center">
                      <Heading level={2}>
                        {tr('Anstehende Termine', 'Upcoming Meetings')}
                      </Heading>
                      <Token
                        size="sm"
                        color="gray"
                        label={String(activeUpcomingSyncedCount)}
                      />
                    </HStack>
                    <Text type="supporting" color="secondary">
                      {tr(
                        'Eigene Termine starten automatisch; Gast-Termine per Schalter',
                        'Self-organized auto-join; attendee invites via toggle'
                      )}
                    </Text>
                  </HStack>

                  {upcomingSyncedEvents.length > 0 ? (
                    <>
                      <div className="md:hidden divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)] bg-[var(--color-background-surface)]">
                        {upcomingSyncedEvents.map((ev) => {
                          const toggleBusy = oauthBusy === `toggle-${ev.id}`;
                          return (
                            <div key={ev.id} className="p-3.5">
                              <HStack justify="between" vAlign="start" gap={3}>
                                <VStack gap={1} className="min-w-0 flex-1">
                                  <Text
                                    type="body"
                                    weight="semibold"
                                    color="primary"
                                  >
                                    {ev.title ||
                                      tr('Kalendertermin', 'Calendar event')}
                                  </Text>
                                  <HStack gap={2} vAlign="center" wrap="wrap">
                                    <ProviderBadge
                                      provider={ev.meeting_provider}
                                      size="sm"
                                    />
                                    <Text
                                      type="supporting"
                                      color="secondary"
                                      hasTabularNumbers
                                    >
                                      {formatCalendarSlot(
                                        ev.starts_at,
                                        ev.ends_at,
                                        lang
                                      )}
                                    </Text>
                                  </HStack>
                                </VStack>
                                {ev.status !== 'cancelled' && (
                                  <Switch
                                    size="sm"
                                    value={ev.auto_record}
                                    isLoading={toggleBusy}
                                    isDisabled={oauthBusy !== null}
                                    label={
                                      ev.auto_record
                                        ? tr('An', 'On')
                                        : tr('Aus', 'Off')
                                    }
                                    onChange={(checked) =>
                                      handleToggleSyncedEvent(ev, checked)
                                    }
                                  />
                                )}
                              </HStack>
                            </div>
                          );
                        })}
                      </div>

                      <div className="hidden md:block">
                        <Table<SyncedEventRow>
                          idKey="id"
                          density="balanced"
                          dividers="rows"
                          hasHover
                          data={upcomingSyncedEvents as SyncedEventRow[]}
                          columns={syncedColumns}
                        />
                      </div>
                    </>
                  ) : (
                    <EmptyState
                      isCompact
                      icon={<Calendar className="h-6 w-6" />}
                      title={tr(
                        'Keine anstehenden Konferenz-Termine',
                        'No upcoming conference meetings'
                      )}
                      description={tr(
                        'Termine mit Meet-, Teams-, Webex- oder Zoom-Link erscheinen automatisch.',
                        'Events with Meet, Teams, Webex, or Zoom links appear automatically.'
                      )}
                    />
                  )}

                  {pastSyncedEvents.length > 0 && (
                    <VStack gap={2} hAlign="stretch">
                      <HStack justify="start">
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={
                            showPastSynced ? (
                              <ChevronUp className="h-3.5 w-3.5" />
                            ) : (
                              <ChevronDown className="h-3.5 w-3.5" />
                            )
                          }
                          label={
                            showPastSynced
                              ? tr(
                                  `Vergangene ausblenden (${pastSyncedEvents.length})`,
                                  `Hide past (${pastSyncedEvents.length})`
                                )
                              : tr(
                                  `Vergangene 7 Tage (${pastSyncedEvents.length})`,
                                  `Past 7 days (${pastSyncedEvents.length})`
                                )
                          }
                          onClick={() => setShowPastSynced((prev) => !prev)}
                        />
                      </HStack>
                      {showPastSynced && (
                        <Table<SyncedEventRow>
                          idKey="id"
                          density="compact"
                          dividers="rows"
                          hasHover
                          data={pastSyncedEvents as SyncedEventRow[]}
                          columns={syncedColumns}
                        />
                      )}
                    </VStack>
                  )}
                </VStack>
              )}

              {(events.length > 0 || (!googleConn && !microsoftConn)) && (
                <VStack gap={3} id="calendar-list">
                  <HStack gap={2} vAlign="center">
                    <Heading level={2}>
                      {tr('E-Mail- & .ics-Einladungen', 'Email & .ics Invites')}
                    </Heading>
                    <Token
                      size="sm"
                      color="gray"
                      label={String(activeUpcomingIcsCount)}
                    />
                  </HStack>

                  {events.length === 0 ? (
                    <EmptyState
                      isCompact
                      icon={<Mail className="h-6 w-6" />}
                      title={tr(
                        'Noch keine Kalendereinladungen',
                        'No calendar invites yet'
                      )}
                      description={tr(
                        'Verbinden Sie oben Ihren Kalender oder laden Sie eine .ics-Datei hoch.',
                        'Connect your calendar above or upload an .ics invitation.'
                      )}
                    />
                  ) : (
                    <>
                      {upcomingIcsRows.length > 0 && (
                        <>
                          <div className="hidden md:block">
                            <Table<IcsEventRow>
                              idKey="_rowKey"
                              density="balanced"
                              dividers="rows"
                              hasHover
                              data={upcomingIcsRows}
                              columns={icsColumns}
                            />
                          </div>
                          <div className="md:hidden rounded-lg border border-[var(--color-border)] divide-y divide-[var(--color-border)]">
                            {upcomingIcsRows.map((ev) => {
                              const isAccepted =
                                ev.status === 'accepted' ||
                                ev.status === 'CONFIRMED' ||
                                ev.status === 'confirmed';
                              const statusLabel =
                                statusMap[ev.status] || ev.status;
                              const recId =
                                ev.recording_id ||
                                (ev.recording_ids && ev.recording_ids[0]) ||
                                null;
                              return (
                                <div key={ev._rowKey} className="p-3.5">
                                  <VStack gap={1.5}>
                                    <Text
                                      type="body"
                                      weight="semibold"
                                      color="primary"
                                    >
                                      {ev.title ||
                                        tr('Kalendertermin', 'Calendar event')}
                                    </Text>
                                    <HStack
                                      gap={2}
                                      vAlign="center"
                                      justify="between"
                                      wrap="wrap"
                                    >
                                      <HStack gap={2} vAlign="center" wrap="wrap">
                                        <StatusIndicator
                                          variant={
                                            isAccepted ? 'success' : 'error'
                                          }
                                          weight="medium"
                                          label={statusLabel}
                                        />
                                        {ev.provider && (
                                          <ProviderBadge provider={ev.provider} />
                                        )}
                                        <Text
                                          type="supporting"
                                          color="secondary"
                                          hasTabularNumbers
                                        >
                                          {formatCalendarSlot(
                                            ev.starts_at,
                                            ev.ends_at,
                                            lang
                                          )}
                                        </Text>
                                      </HStack>
                                      {recId && (
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          label={tr('Öffnen', 'Open')}
                                          endContent={
                                            <ArrowRight className="h-3.5 w-3.5" />
                                          }
                                          onClick={() =>
                                            onSelectRecording(recId)
                                          }
                                        />
                                      )}
                                    </HStack>
                                  </VStack>
                                </div>
                              );
                            })}
                          </div>
                        </>
                      )}
                      {pastIcsRows.length > 0 && (
                        <VStack gap={2} hAlign="stretch">
                          <HStack justify="start">
                            <Button
                              variant="ghost"
                              size="sm"
                              icon={
                                showPastIcs ? (
                                  <ChevronUp className="h-3.5 w-3.5" />
                                ) : (
                                  <ChevronDown className="h-3.5 w-3.5" />
                                )
                              }
                              label={
                                showPastIcs
                                  ? tr(
                                      `Vergangene ausblenden (${pastIcsRows.length})`,
                                      `Hide past (${pastIcsRows.length})`
                                    )
                                  : tr(
                                      `Vergangene anzeigen (${pastIcsRows.length})`,
                                      `Show past (${pastIcsRows.length})`
                                    )
                              }
                              onClick={() => setShowPastIcs((prev) => !prev)}
                            />
                          </HStack>
                          {showPastIcs && (
                            <Table<IcsEventRow>
                              idKey="_rowKey"
                              density="compact"
                              dividers="rows"
                              hasHover
                              data={pastIcsRows}
                              columns={icsColumns}
                            />
                          )}
                        </VStack>
                      )}
                    </>
                  )}
                </VStack>
              )}
            </VStack>
          </div>
        </LayoutContent>
      }
    />
  );
}
