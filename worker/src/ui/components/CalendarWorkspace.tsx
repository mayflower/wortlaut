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
import { Switch } from '@astryxdesign/core/Switch';
import { StatusDot } from '@astryxdesign/core/StatusDot';
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

const CALENDAR_STATUS_LABELS: Record<string, string> = {
  accepted: 'Eingeplant',
  CONFIRMED: 'Bestätigt',
  confirmed: 'Bestätigt',
  cancelled: 'Abgesagt',
  CANCELLED: 'Abgesagt',
  rejected: 'Abgelehnt',
  ignored: 'Ignoriert',
};

type SyncedEventRow = CalendarSyncedEventInfo & Record<string, unknown>;
type IcsEventRow = CalendarEvent & { _rowKey: string } & Record<string, unknown>;

function formatCalendarSlot(
  startsAt: string | null,
  endsAt?: string | null
): string {
  if (!startsAt) return 'Serientermin';
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
    dayPrefix = 'Heute';
  } else if (targetDay.getTime() === tomorrow.getTime()) {
    dayPrefix = 'Morgen';
  } else {
    dayPrefix = start.toLocaleDateString('de-DE', {
      weekday: 'short',
      day: '2-digit',
      month: '2-digit',
    });
  }

  const startTime = start.toLocaleTimeString('de-DE', {
    hour: '2-digit',
    minute: '2-digit',
  });
  if (endsAt) {
    const end = new Date(endsAt);
    const endTime = end.toLocaleTimeString('de-DE', {
      hour: '2-digit',
      minute: '2-digit',
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

  const syncedColumns: TableColumn<SyncedEventRow>[] = [
    {
      key: 'auto_record',
      header: 'Aufzeichnen',
      width: pixel(150),
      renderCell: (ev) => {
        if (ev.status === 'cancelled') {
          return <StatusIndicator variant="error" weight="medium" label="Abgesagt" />;
        }
        const toggleBusy = oauthBusy === `toggle-${ev.id}`;
        return (
          <Switch
            size="sm"
            value={ev.auto_record}
            isLoading={toggleBusy}
            isDisabled={oauthBusy !== null}
            label={ev.auto_record ? 'An' : 'Aus'}
            onChange={(checked) => handleToggleSyncedEvent(ev, checked)}
          />
        );
      },
    },
    {
      key: 'title',
      header: 'Termin & Konferenz',
      width: proportional(2, { minWidth: 240 }),
      renderCell: (ev) => (
        <HStack gap={2} vAlign="center" wrap="nowrap">
          <span className="shrink-0">
            <ProviderBadge provider={ev.meeting_provider} />
          </span>
          <Text type="body" weight="semibold" color="primary" maxLines={1}>
            {ev.title || 'Kalendertermin'}
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
      header: 'Rolle / Regel',
      width: proportional(1.2, { minWidth: 180 }),
      renderCell: (ev) =>
        ev.is_self_organized ? (
          <Token size="sm" color="blue" label="Organisator (Auto-Join)" />
        ) : (
          <Token
            size="sm"
            color="orange"
            label={`Gast (${ev.organizer_email || 'Extern'})`}
          />
        ),
    },
    {
      key: 'starts_at',
      header: 'Zeitfenster',
      width: pixel(190),
      renderCell: (ev) => (
        <Text type="supporting" color="secondary" hasTabularNumbers>
          {formatCalendarSlot(ev.starts_at, ev.ends_at)}
        </Text>
      ),
    },
    {
      key: 'recording_id',
      header: '',
      width: pixel(140),
      align: 'end',
      renderCell: (ev) =>
        ev.recording_id ? (
          <Button
            variant="ghost"
            size="sm"
            label="Öffnen"
            endContent={<ArrowRight className="h-3.5 w-3.5" />}
            onClick={() => onSelectRecording(ev.recording_id!)}
          />
        ) : (
          <Text type="supporting" color="secondary">
            –
          </Text>
        ),
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
        const statusLabel = CALENDAR_STATUS_LABELS[ev.status] || ev.status;
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
      header: 'Termin & Konferenzsystem',
      width: proportional(2, { minWidth: 220 }),
      renderCell: (ev) => (
        <HStack gap={2} vAlign="center" wrap="nowrap">
          {ev.provider && <ProviderBadge provider={ev.provider} />}
          <Text type="body" weight="semibold" color="primary" maxLines={1}>
            {ev.title || 'Kalendertermin'}
          </Text>
        </HStack>
      ),
    },
    {
      key: 'organizer',
      header: 'Eingeladen von',
      width: proportional(1.2, { minWidth: 160 }),
      renderCell: (ev) => (
        <Text type="supporting" color="secondary">
          {ev.organizer || '–'}
        </Text>
      ),
    },
    {
      key: 'starts_at',
      header: 'Geplante Zeit',
      width: pixel(190),
      renderCell: (ev) => (
        <Text type="supporting" color="secondary" hasTabularNumbers>
          {formatCalendarSlot(ev.starts_at, ev.ends_at)}
        </Text>
      ),
    },
    {
      key: 'recording_id',
      header: '',
      width: pixel(140),
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
            label="Öffnen"
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
          <VStack gap={2}>
            {onNavigateHome && (
              <Breadcrumbs variant="supporting" label="Pfadnavigation">
                <BreadcrumbItem onClick={onNavigateHome}>
                  Startseite
                </BreadcrumbItem>
                <BreadcrumbItem isCurrent>Kalender</BreadcrumbItem>
              </Breadcrumbs>
            )}
            <HStack justify="between" vAlign="center" wrap="wrap" gap={3}>
              <VStack gap={0.5}>
                <Heading level={1}>Kalender &amp; E-Mail-Einladungen</Heading>
                <Text type="supporting" color="secondary">
                  Verbinden Sie Ihren Google- oder Microsoft-365-Kalender per
                  OAuth2 (Read-Only) oder laden Sie eine Kalendereinladung hoch.
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
                      ? 'Bot-Adresse kopiert!'
                      : `Bot-Adresse: ${instance.botEmail}`
                  }
                  onClick={handleCopyMail}
                />
              )}
              <Button
                variant="primary"
                size="sm"
                icon={<CalendarPlus className="h-3.5 w-3.5" />}
                label=".ics / .eml Einladung hochladen"
                onClick={onOpenImportModal}
              />
            </HStack>
            </HStack>
          </VStack>
        </LayoutHeader>
      }
      content={
        <LayoutContent>
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
                      <StatusIndicator variant="success" weight="medium" label="Verbunden" />
                    ) : (
                      <Token size="sm" color="gray" label="calendar.readonly" />
                    )}
                  </HStack>

                  {googleConn ? (
                    <VStack gap={0.5}>
                      <Text type="body" color="primary">
                        Konto: <strong>{googleConn.account_email}</strong>
                      </Text>
                      {googleConn.last_synced_at && (
                        <Text type="supporting" color="secondary">
                          Zuletzt synchronisiert:{' '}
                          {new Date(googleConn.last_synced_at).toLocaleString(
                            'de-DE'
                          )}
                        </Text>
                      )}
                      {googleConn.sync_error && (
                        <Text type="supporting" color="secondary">
                          Sync-Fehler: {googleConn.sync_error}
                        </Text>
                      )}
                    </VStack>
                  ) : (
                    <Text type="supporting" color="secondary">
                      Synchronisiert automatisch Termine mit Google Meet-,
                      Teams- oder Webex-Link aus Ihrem primären Google-Kalender.
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
                          label="Jetzt synchronisieren"
                          onClick={() => handleSyncConnection(googleConn.id)}
                        />
                        <Button
                          variant="destructive"
                          size="sm"
                          isLoading={
                            oauthBusy === `disconnect-${googleConn.id}`
                          }
                          isDisabled={oauthBusy !== null}
                          icon={<Trash2 className="h-3.5 w-3.5" />}
                          label="Trennen"
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
                            ? 'Google Kalender verbinden'
                            : 'Google OAuth nicht konfiguriert'
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
                      <StatusIndicator variant="success" weight="medium" label="Verbunden" />
                    ) : (
                      <Token size="sm" color="gray" label="Calendars.Read" />
                    )}
                  </HStack>

                  {microsoftConn ? (
                    <VStack gap={0.5}>
                      <Text type="body" color="primary">
                        Konto: <strong>{microsoftConn.account_email}</strong>
                      </Text>
                      {microsoftConn.last_synced_at && (
                        <Text type="supporting" color="secondary">
                          Zuletzt synchronisiert:{' '}
                          {new Date(
                            microsoftConn.last_synced_at
                          ).toLocaleString('de-DE')}
                        </Text>
                      )}
                      {microsoftConn.sync_error && (
                        <Text type="supporting" color="secondary">
                          Sync-Fehler: {microsoftConn.sync_error}
                        </Text>
                      )}
                    </VStack>
                  ) : (
                    <Text type="supporting" color="secondary">
                      Synchronisiert automatisch Termine mit Microsoft Teams-,
                      Google Meet- oder Webex-Link über Microsoft Graph.
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
                          label="Jetzt synchronisieren"
                          onClick={() => handleSyncConnection(microsoftConn.id)}
                        />
                        <Button
                          variant="destructive"
                          size="sm"
                          isLoading={
                            oauthBusy === `disconnect-${microsoftConn.id}`
                          }
                          isDisabled={oauthBusy !== null}
                          icon={<Trash2 className="h-3.5 w-3.5" />}
                          label="Trennen"
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
                            ? 'Microsoft 365 Kalender verbinden'
                            : 'Microsoft OAuth nicht konfiguriert'
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
                        Synchronisierte Termine mit Konferenz-Link (
                        {syncedEvents.length})
                      </Heading>
                      <Text type="supporting" color="secondary">
                        Eigene Termine (mit bestätigten Gästen) starten
                        automatisch; externe Termine per 1-Klick-Schalter
                        zuschaltbar
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

            {/* Imported .ics / IMAP Events (shown when events exist or when no OAuth calendar is connected yet) */}
            {(events.length > 0 || (!googleConn && !microsoftConn)) && (
              <div id="calendar-list">
                <Section variant="section">
                  <VStack gap={2}>
                    <HStack justify="between" vAlign="center" wrap="wrap">
                      <Heading level={3}>
                        E-Mail- &amp; .ics-Kalendereinladungen ({events.length})
                      </Heading>
                      {instance.botEmail && (
                        <Text type="supporting" color="secondary">
                          Einladungsadresse: <code>{instance.botEmail}</code>
                        </Text>
                      )}
                    </HStack>

                    {events.length === 0 ? (
                      <EmptyState
                        isCompact
                        icon={<Mail className="h-6 w-6" />}
                        title="Noch keine Kalendereinladungen vorhanden"
                        description="Verbinden Sie oben Ihren Google- oder Microsoft-365-Kalender oder laden Sie eine .ics-Datei hoch."
                        actions={
                          <Button
                            variant="secondary"
                            size="sm"
                            icon={<CalendarPlus className="h-3.5 w-3.5" />}
                            label=".ics-Datei importieren"
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
        </LayoutContent>
      }
    />
  );
}
