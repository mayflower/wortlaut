import React, { useRef, useState } from 'react';
import {
  ArrowRight,
  Calendar,
  CalendarPlus,
  Check,
  Copy,
  FolderOpen,
  HelpCircle,
  Link2,
  Mail,
  Play,
  Plus,
  Search,
  Sparkles,
  Tag,
  Video,
  X,
} from 'lucide-react';
import { Layout, LayoutContent, LayoutHeader } from '@astryxdesign/core/Layout';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { HStack } from '@astryxdesign/core/HStack';
import { VStack } from '@astryxdesign/core/VStack';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Section } from '@astryxdesign/core/Section';
import { Switch } from '@astryxdesign/core/Switch';
import { Token } from '@astryxdesign/core/Token';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Selector } from '@astryxdesign/core/Selector';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@astryxdesign/core/SegmentedControl';
import {
  Table,
  pixel,
  proportional,
  type TableColumn,
} from '@astryxdesign/core/Table';
import { Banner } from '@astryxdesign/core/Banner';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import {
  createRecording,
  detectProviderFromUrl,
  formatDurationHuman,
  formatRecordingTitle,
  getFailureReasons,
  getInstanceInfo,
  startCalendarOAuthConnect,
  toggleCalendarSyncedEvent,
} from '../api';
import type {
  CalendarConnectionInfo,
  CalendarSyncedEventInfo,
  RecordingSummary,
} from '../types';
import { ProviderBadge, StatusBadge, StatusIndicator } from './ui/primitives';

export type QuickStatusFilter =
  | 'all'
  | 'active'
  | 'scheduled'
  | 'completed'
  | 'failed';

export interface RecordingSidebarProps {
  token?: string;
  recordings: RecordingSummary[];
  totalRecordingsCount?: number;
  calendarConnections?: CalendarConnectionInfo[];
  calendarSyncedEvents?: CalendarSyncedEventInfo[];
  selectedId: string | null;
  onSelectRecording: (id: string) => void;
  providerFilter: string;
  onProviderFilterChange: (provider: string) => void;
  quickFilter: QuickStatusFilter;
  onQuickFilterChange: (filter: QuickStatusFilter) => void;
  titleSearch: string;
  onTitleSearchChange: (q: string) => void;
  onOpenNewRecording: () => void;
  onOpenIcsImport?: () => void;
  onNavigateCalendar?: () => void;
  onRefreshCalendar?: () => void;
  onCreatedRecording?: (id: string) => void;
  isLoading: boolean;
}

type RecordingRow = RecordingSummary & Record<string, unknown>;
type UpcomingSyncedRow = CalendarSyncedEventInfo & Record<string, unknown>;

const PROVIDER_OPTIONS = [
  { value: 'all', label: 'Alle Konferenzsysteme' },
  { value: 'google_meet', label: 'Google Meet' },
  { value: 'teams', label: 'Microsoft Teams' },
  { value: 'webex', label: 'Cisco Webex' },
  { value: 'zoom', label: 'Zoom' },
];

const ONBOARDING_DISMISSED_KEY = 'wortlaut_onboarding_dismissed_v1';

function formatUpcomingSlot(
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

export function RecordingSidebar({
  token = '',
  recordings,
  totalRecordingsCount,
  calendarConnections = [],
  calendarSyncedEvents = [],
  onSelectRecording,
  providerFilter,
  onProviderFilterChange,
  quickFilter,
  onQuickFilterChange,
  titleSearch,
  onTitleSearchChange,
  onOpenNewRecording,
  onOpenIcsImport,
  onNavigateCalendar,
  onRefreshCalendar,
  onCreatedRecording,
  isLoading,
}: RecordingSidebarProps) {
  const instance = getInstanceInfo();
  const failureReasons = getFailureReasons();
  const urlWrapRef = useRef<HTMLDivElement | null>(null);

  const [meetingUrl, setMeetingUrl] = useState('');
  const [title, setTitle] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [quickJoinError, setQuickJoinError] = useState<string | null>(null);
  const [copiedMail, setCopiedMail] = useState(false);
  const [calendarBusyId, setCalendarBusyId] = useState<string | null>(null);
  const [guideDismissed, setGuideDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(ONBOARDING_DISMISSED_KEY) === '1';
    } catch {
      return false;
    }
  });

  const detectedProvider = detectProviderFromUrl(meetingUrl);

  const hasActiveFilter =
    Boolean(providerFilter) ||
    quickFilter !== 'all' ||
    Boolean(titleSearch.trim());

  const totalCount =
    typeof totalRecordingsCount === 'number'
      ? totalRecordingsCount
      : recordings.length;

  const hasConnectedCalendar = calendarConnections.length > 0;
  const isFirstTimeOrUnconfigured =
    totalCount === 0 || !hasConnectedCalendar;
  const showOnboardingGuide =
    totalCount === 0 || (!guideDismissed && isFirstTimeOrUnconfigured);
  const showFilterToolbar = totalCount >= 3 || hasActiveFilter;

  const lobbyRecordings = recordings.filter(
    (r) => r.participation === 'waiting_admission'
  );

  // Upcoming synced calendar meetings (not cancelled, ending in the future)
  const upcomingSyncedEvents = calendarSyncedEvents
    .filter((ev) => {
      if (ev.status === 'cancelled') return false;
      const endMs = ev.ends_at
        ? new Date(ev.ends_at).getTime()
        : ev.starts_at
          ? new Date(ev.starts_at).getTime() + 3600000
          : Date.now() + 3600000;
      return endMs >= Date.now() - 15 * 60000;
    })
    .slice(0, 3);

  const handleToggleGuide = (nextDismissed: boolean) => {
    setGuideDismissed(nextDismissed);
    try {
      if (nextDismissed) {
        localStorage.setItem(ONBOARDING_DISMISSED_KEY, '1');
      } else {
        localStorage.removeItem(ONBOARDING_DISMISSED_KEY);
      }
    } catch {
      // ignore storage errors
    }
  };

  const handleCopyBotMail = async () => {
    if (!instance.botEmail || !navigator.clipboard) return;
    await navigator.clipboard.writeText(instance.botEmail).catch(() => {});
    setCopiedMail(true);
    setTimeout(() => setCopiedMail(false), 1800);
  };

  const handleConnectCalendar = async (provider: 'google' | 'microsoft') => {
    setQuickJoinError(null);
    setCalendarBusyId(`connect-${provider}`);
    try {
      await startCalendarOAuthConnect(provider);
    } catch (err) {
      setQuickJoinError(err instanceof Error ? err.message : String(err));
      setCalendarBusyId(null);
    }
  };

  const handleToggleUpcomingEvent = async (
    ev: CalendarSyncedEventInfo,
    enabled: boolean
  ) => {
    if (!token) return;
    setCalendarBusyId(`toggle-${ev.id}`);
    try {
      await toggleCalendarSyncedEvent(token, ev.id, enabled);
      onRefreshCalendar?.();
    } catch (err) {
      setQuickJoinError(err instanceof Error ? err.message : String(err));
    } finally {
      setCalendarBusyId(null);
    }
  };

  const focusQuickJoinInput = () => {
    const input = urlWrapRef.current?.querySelector('input');
    if (input) {
      input.focus();
      input.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  const handleQuickStart = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!meetingUrl.trim() || !token) return;
    setQuickJoinError(null);
    setSubmitting(true);
    try {
      const now = new Date();
      const startIso = now.toISOString();
      const endIso = new Date(now.getTime() + 60 * 60000).toISOString();
      const created = await createRecording(token, {
        meeting_url: meetingUrl.trim(),
        starts_at: startIso,
        ends_at: endIso,
        title: title.trim() || null,
        guest_name: null,
      });
      setMeetingUrl('');
      setTitle('');
      if (onCreatedRecording) {
        onCreatedRecording(created.id);
      } else {
        onSelectRecording(created.id);
      }
    } catch (err) {
      setQuickJoinError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const columns: TableColumn<RecordingRow>[] = [
    {
      key: 'participation',
      header: 'Status',
      width: pixel(185),
      renderCell: (row) => {
        const reason = row.participation_reason;
        const samples = row.quality?.durable_sample_count || 0;
        const isNormalEnd =
          !reason ||
          reason === 'normal' ||
          reason === 'room_empty' ||
          ((reason === 'cancelled' || reason === 'deadline') && samples > 0);
        const hasError =
          row.processing === 'failed' ||
          (row.participation === 'ended' && !isNormalEnd);
        return (
          <StatusBadge
            participation={row.participation}
            processing={row.processing}
            hasError={hasError}
          />
        );
      },
    },
    {
      key: 'title',
      header: 'Besprechung',
      width: proportional(2.5, { minWidth: 240 }),
      renderCell: (row) => {
        const reason = row.participation_reason;
        const samples = row.quality?.durable_sample_count || 0;
        const isNormalEnd =
          !reason ||
          reason === 'normal' ||
          reason === 'room_empty' ||
          ((reason === 'cancelled' || reason === 'deadline') && samples > 0);
        const reasonHint =
          !isNormalEnd && reason && failureReasons[reason]
            ? failureReasons[reason]
            : reason && !isNormalEnd
              ? reason
              : null;

        return (
          <VStack gap={0.5} hAlign="start">
            <button
              type="button"
              onClick={() => onSelectRecording(row.id)}
              className="text-left font-semibold text-[var(--color-text-primary)] hover:text-[var(--color-text-accent)] cursor-pointer transition-colors"
            >
              {formatRecordingTitle(row)}
            </button>
            {row.participation === 'waiting_admission' && (
              <Text type="supporting" color="secondary">
                Wartet im Warteraum — bitte Bot im Meeting zulassen
              </Text>
            )}
            {reasonHint && (
              <Text type="supporting" color="secondary">
                {reasonHint}
              </Text>
            )}
          </VStack>
        );
      },
    },
    {
      key: 'provider',
      header: 'Konferenzsystem',
      width: pixel(150),
      renderCell: (row) => <ProviderBadge provider={row.provider} />,
    },
    {
      key: 'starts_at',
      header: 'Zeitpunkt',
      width: pixel(155),
      renderCell: (row) => (
        <Text type="supporting" color="secondary" hasTabularNumbers>
          {new Date(row.starts_at).toLocaleString('de-DE', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </Text>
      ),
    },
    {
      key: 'duration',
      header: 'Dauer',
      width: pixel(115),
      renderCell: (row) => {
        const samples = row.quality?.durable_sample_count || 0;
        const audioSec = Math.round(samples / 16000);
        if (audioSec > 0) {
          return (
            <Text type="supporting" color="primary" weight="medium" hasTabularNumbers>
              {formatDurationHuman(audioSec)}
            </Text>
          );
        }
        if (row.participation === 'capturing') {
          return (
            <Text type="supporting" color="primary" weight="medium">
              Live
            </Text>
          );
        }
        const plannedMin = Math.max(
          0,
          Math.round(
            (new Date(row.ends_at).getTime() -
              new Date(row.starts_at).getTime()) /
              60000
          )
        );
        if (row.participation === 'scheduled' && plannedMin > 0) {
          return (
            <Text type="supporting" color="secondary" hasTabularNumbers>
              {plannedMin} Min.
            </Text>
          );
        }
        const reason = row.participation_reason;
        const isFailedEmpty =
          row.participation === 'ended' &&
          Boolean(reason) &&
          reason !== 'normal';
        if (!isFailedEmpty && plannedMin > 0) {
          return (
            <Text type="supporting" color="secondary" hasTabularNumbers>
              {plannedMin} Min.
            </Text>
          );
        }
        return (
          <Text type="supporting" color="secondary">
            –
          </Text>
        );
      },
    },
    {
      key: 'actions',
      header: '',
      width: pixel(135),
      align: 'end',
      renderCell: (row) => (
        <Button
          variant="ghost"
          size="sm"
          label="Öffnen"
          endContent={<ArrowRight className="h-3.5 w-3.5" />}
          onClick={() => onSelectRecording(row.id)}
        />
      ),
    },
  ];

  const upcomingColumns: TableColumn<UpcomingSyncedRow>[] = [
    {
      key: 'auto_record',
      header: 'Aufzeichnen',
      width: pixel(145),
      renderCell: (ev) => {
        const toggleBusy = calendarBusyId === `toggle-${ev.id}`;
        return (
          <Switch
            size="sm"
            value={ev.auto_record}
            isLoading={toggleBusy}
            isDisabled={calendarBusyId !== null}
            label={ev.auto_record ? 'An' : 'Aus'}
            onChange={(checked) => handleToggleUpcomingEvent(ev, checked)}
          />
        );
      },
    },
    {
      key: 'title',
      header: 'Anstehender Termin',
      width: proportional(2.2, { minWidth: 230 }),
      renderCell: (ev) => (
        <HStack gap={2} vAlign="center" wrap="nowrap">
          <span className="shrink-0">
            <ProviderBadge provider={ev.meeting_provider} />
          </span>
          <Text type="body" weight="semibold" color="primary" maxLines={1}>
            {ev.title || 'Kalendertermin'}
          </Text>
        </HStack>
      ),
    },
    {
      key: 'role',
      header: 'Regel',
      width: pixel(190),
      renderCell: (ev) =>
        ev.is_self_organized ? (
          <Token size="sm" color="blue" label="Organisator (Auto-Join)" />
        ) : (
          <Token size="sm" color="orange" label="Gast (Manuell zuschaltbar)" />
        ),
    },
    {
      key: 'starts_at',
      header: 'Zeitfenster',
      width: pixel(185),
      renderCell: (ev) => (
        <Text type="supporting" color="secondary" hasTabularNumbers>
          {formatUpcomingSlot(ev.starts_at, ev.ends_at)}
        </Text>
      ),
    },
    {
      key: 'recording_id',
      header: '',
      width: pixel(135),
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
            {ev.auto_record ? 'Eingeplant' : '–'}
          </Text>
        ),
    },
  ];

  const googleConn =
    calendarConnections.find((c) => c.provider === 'google') || null;
  const microsoftConn =
    calendarConnections.find((c) => c.provider === 'microsoft') || null;
  const calOAuth = instance.calendarOAuth;

  return (
    <Layout
      height="fill"
      header={
        <LayoutHeader hasDivider>
          <VStack gap={3}>
            <HStack justify="between" vAlign="center" wrap="wrap" gap={2}>
              <VStack gap={0.5}>
                <Heading level={1}>Übersicht &amp; Aufnahmen</Heading>
                <Text type="supporting" color="secondary">
                  Lassen Sie geplante Kalendertermine automatisch protokollieren
                  oder holen Sie den Bot „{instance.assistantName}“ spontan per
                  Link in ein laufendes Meeting.
                </Text>
              </VStack>

              {!showOnboardingGuide && (
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<HelpCircle className="h-3.5 w-3.5" />}
                  label="Kurzanleitung einblenden"
                  onClick={() => handleToggleGuide(false)}
                />
              )}
            </HStack>

            {/* Primary Action: Inline Ad-hoc Join Bar + 3-Step Mental Model */}
            {token && (
              <form id="dispatch-form" onSubmit={handleQuickStart}>
                <VStack gap={2}>
                  <HStack gap={2} vAlign="center" wrap="wrap">
                    <div
                      ref={urlWrapRef}
                      className="flex-1 min-w-[260px]"
                      id="meeting-url-wrap"
                    >
                      <TextInput
                        type="url"
                        size="sm"
                        label="Meeting-Link"
                        isLabelHidden
                        value={meetingUrl}
                        onChange={setMeetingUrl}
                        placeholder="Sofort-Start: Meeting-Link hier einfügen (Google Meet, Teams, Webex oder Zoom)…"
                        startIcon={<Video className="h-3.5 w-3.5" />}
                        hasClear
                      />
                    </div>
                    <div className="w-56">
                      <TextInput
                        type="text"
                        size="sm"
                        label="Titel (optional)"
                        isLabelHidden
                        value={title}
                        onChange={setTitle}
                        placeholder="Titel (optional, z. B. Weekly)"
                        startIcon={<Tag className="h-3.5 w-3.5" />}
                      />
                    </div>
                    {detectedProvider && (
                      <ProviderBadge provider={detectedProvider} />
                    )}
                    <Button
                      type="submit"
                      variant="primary"
                      size="sm"
                      isLoading={submitting}
                      isDisabled={!meetingUrl.trim()}
                      icon={<Play className="h-3.5 w-3.5" />}
                      label="Jetzt beitreten (60 Min.)"
                    />
                  </HStack>

                  {/* 3-Step Mental Model + Secondary Schedule Link */}
                  <HStack
                    justify="between"
                    vAlign="center"
                    wrap="wrap"
                    gap={2}
                  >
                    <HStack gap={2} vAlign="center" wrap="wrap">
                      <Token size="sm" color="gray" label="1. Link einfügen oder Kalender verbinden" />
                      <Text type="supporting" color="secondary">
                        →
                      </Text>
                      <Token
                        size="sm"
                        color="orange"
                        label={`2. Bot „${instance.assistantName}“ im Meeting-Warteraum zulassen`}
                      />
                      <Text type="supporting" color="secondary">
                        →
                      </Text>
                      <Token
                        size="sm"
                        color="green"
                        label="3. Sprechergetrenntes Protokoll hier & per E-Mail erhalten"
                      />
                    </HStack>

                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<CalendarPlus className="h-3.5 w-3.5" />}
                      label="Für später planen / .ics importieren"
                      onClick={onOpenIcsImport || onOpenNewRecording}
                    />
                  </HStack>
                </VStack>

                {quickJoinError && (
                  <div className="mt-2">
                    <Banner
                      status="error"
                      container="card"
                      title={quickJoinError}
                      isDismissable
                      onDismiss={() => setQuickJoinError(null)}
                    />
                  </div>
                )}
              </form>
            )}
          </VStack>
        </LayoutHeader>
      }
      content={
        <LayoutContent>
          <VStack gap={4} id="recordings-list">
            {/* Active Waiting Room Admission Alerts */}
            {lobbyRecordings.map((rec) => (
              <Banner
                key={rec.id}
                status="warning"
                container="card"
                title={`Bot „${rec.guest_name || instance.assistantName}“ wartet im Warteraum: ${formatRecordingTitle(rec)}`}
                description="Bitte lassen Sie den Bot jetzt im Konferenzfenster zu, damit die Aufzeichnung starten kann."
                endContent={
                  <Button
                    variant="primary"
                    size="sm"
                    label="Live-Ansicht öffnen"
                    onClick={() => onSelectRecording(rec.id)}
                  />
                }
              />
            ))}

            {/* 1. First-Time User Orientation / 3-Way Setup Guide */}
            {showOnboardingGuide && (
              <div id="onboarding-guide">
                <Section variant="section">
                  <VStack gap={3}>
                    <HStack justify="between" vAlign="center" wrap="wrap" gap={2}>
                      <HStack gap={2} vAlign="center" wrap="wrap">
                        <Sparkles className="h-4 w-4 text-[var(--color-text-accent)]" />
                        <Heading level={3}>
                          Erste Schritte: Drei Wege, wie {instance.assistantName}{' '}
                          Ihre Besprechungen protokolliert
                        </Heading>
                      </HStack>
                      {totalCount > 0 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={<X className="h-3.5 w-3.5" />}
                          label="Hinweis ausblenden"
                          onClick={() => handleToggleGuide(true)}
                        />
                      )}
                    </HStack>

                    <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
                      {/* Way 1: Automatic Calendar Sync (Recommended) */}
                      <Card>
                        <VStack gap={3} justify="between" height="fill">
                          <VStack gap={1.5}>
                            <HStack justify="between" vAlign="center">
                              <Heading level={4}>
                                1. Kalender-Automatik
                              </Heading>
                              {hasConnectedCalendar ? (
                                <StatusIndicator
                                  variant="success"
                                  weight="medium"
                                  label="Verbunden"
                                />
                              ) : (
                                <Token
                                  size="sm"
                                  color="blue"
                                  label="Empfohlen für den Alltag"
                                />
                              )}
                            </HStack>
                            <Text type="supporting" color="secondary">
                              Verbinden Sie einmalig Ihren Google- oder
                              Microsoft-365-Kalender (Read-Only). Eigene
                              Besprechungen starten automatisch; externe Termine
                              schalten Sie per 1-Klick-Schalter zu.
                            </Text>
                          </VStack>

                          <HStack gap={1.5} wrap="wrap">
                            {!googleConn && calOAuth?.googleEnabled && (
                              <Button
                                variant="primary"
                                size="sm"
                                isLoading={calendarBusyId === 'connect-google'}
                                icon={<Link2 className="h-3.5 w-3.5" />}
                                label="Google Kalender verbinden"
                                onClick={() => handleConnectCalendar('google')}
                              />
                            )}
                            {!microsoftConn && calOAuth?.microsoftEnabled && (
                              <Button
                                variant="secondary"
                                size="sm"
                                isLoading={
                                  calendarBusyId === 'connect-microsoft'
                                }
                                icon={<Link2 className="h-3.5 w-3.5" />}
                                label="Microsoft 365 verbinden"
                                onClick={() =>
                                  handleConnectCalendar('microsoft')
                                }
                              />
                            )}
                            {onNavigateCalendar && (
                              <Button
                                variant="secondary"
                                size="sm"
                                icon={<Calendar className="h-3.5 w-3.5" />}
                                label={
                                  hasConnectedCalendar
                                    ? 'Kalender verwalten'
                                    : 'Zur Kalender-Einrichtung'
                                }
                                onClick={onNavigateCalendar}
                              />
                            )}
                          </HStack>
                        </VStack>
                      </Card>

                      {/* Way 2: Ad-hoc Link */}
                      <Card>
                        <VStack gap={3} justify="between" height="fill">
                          <VStack gap={1.5}>
                            <HStack justify="between" vAlign="center">
                              <Heading level={4}>
                                2. Spontan per Meeting-Link
                              </Heading>
                              <Token
                                size="sm"
                                color="green"
                                label="Sofort-Start (~15 Sek.)"
                              />
                            </HStack>
                            <Text type="supporting" color="secondary">
                              Kopieren Sie den Link Ihres laufenden Google Meet-,
                              Teams- oder Webex-Meetings oben in die Leiste. Der
                              Bot tritt als Gast „{instance.assistantName}“ bei —{' '}
                              <strong>
                                bitte im Konferenzfenster aus dem Warteraum
                                zulassen
                              </strong>
                              .
                            </Text>
                          </VStack>

                          <HStack gap={1.5} wrap="wrap">
                            <Button
                              variant="secondary"
                              size="sm"
                              icon={<Video className="h-3.5 w-3.5" />}
                              label="Link-Eingabe oben fokussieren"
                              onClick={focusQuickJoinInput}
                            />
                          </HStack>
                        </VStack>
                      </Card>

                      {/* Way 3: Email / .ics Invite */}
                      <Card>
                        <VStack gap={3} justify="between" height="fill">
                          <VStack gap={1.5}>
                            <HStack justify="between" vAlign="center">
                              <Heading level={4}>
                                3. Per E-Mail oder .ics
                              </Heading>
                              <Token
                                size="sm"
                                color="gray"
                                label="Ohne Kalender-OAuth"
                              />
                            </HStack>
                            <Text type="supporting" color="secondary">
                              Laden Sie{' '}
                              <code>
                                {instance.botEmail || 'robot@wortlaut.cloud'}
                              </code>{' '}
                              einfach als Teilnehmer in einen beliebigen
                              Kalendertermin ein oder laden Sie eine{' '}
                              <code>.ics</code>-Einladungsdatei direkt hoch.
                            </Text>
                          </VStack>

                          <HStack gap={1.5} wrap="wrap">
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
                                    ? 'Adresse kopiert!'
                                    : `${instance.botEmail} kopieren`
                                }
                                onClick={handleCopyBotMail}
                              />
                            )}
                            <Button
                              variant="secondary"
                              size="sm"
                              icon={<Mail className="h-3.5 w-3.5" />}
                              label=".ics-Datei hochladen"
                              onClick={onOpenIcsImport || onOpenNewRecording}
                            />
                          </HStack>
                        </VStack>
                      </Card>
                    </div>
                  </VStack>
                </Section>
              </div>
            )}

            {/* 2. Upcoming Calendar Meetings right on the Start View */}
            {upcomingSyncedEvents.length > 0 && (
              <div id="upcoming-calendar-section">
                <Section variant="section">
                  <VStack gap={3}>
                    <HStack justify="between" vAlign="center" wrap="wrap" gap={2}>
                      <HStack gap={2} vAlign="center" wrap="wrap">
                        <Heading level={3}>
                          Als Nächstes in Ihrem Kalender
                        </Heading>
                        <StatusIndicator
                          variant="success"
                          weight="medium"
                          label="Kalender-Sync aktiv"
                        />
                      </HStack>
                      {onNavigateCalendar && (
                        <Button
                          variant="ghost"
                          size="sm"
                          label={`Alle Kalendertermine (${calendarSyncedEvents.length})`}
                          endContent={<ArrowRight className="h-3.5 w-3.5" />}
                          onClick={onNavigateCalendar}
                        />
                      )}
                    </HStack>

                    <Table<UpcomingSyncedRow>
                      idKey="id"
                      density="compact"
                      dividers="rows"
                      hasHover
                      data={upcomingSyncedEvents as UpcomingSyncedRow[]}
                      columns={upcomingColumns}
                    />
                  </VStack>
                </Section>
              </div>
            )}

            {/* 3. Recordings Archive with Progressive Filter Disclosure */}
            <VStack gap={3}>
              <HStack justify="between" vAlign="center" wrap="wrap" gap={2}>
                <HStack gap={2} vAlign="center">
                  <Heading level={3}>
                    Aufgezeichnete &amp; geplante Besprechungen
                  </Heading>
                  <Token size="sm" color="gray" label={String(recordings.length)} />
                </HStack>

                {!hasConnectedCalendar && onNavigateCalendar && totalCount > 0 && (
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<Calendar className="h-3.5 w-3.5" />}
                    label="Kalender-Automatik einrichten"
                    onClick={onNavigateCalendar}
                  />
                )}
              </HStack>

              {/* Filter & Search Toolbar (only shown when >= 3 recordings or when a filter is active) */}
              <div className={showFilterToolbar ? '' : 'sr-only'}>
                <HStack justify="between" vAlign="center" wrap="wrap" gap={2}>
                  <div id="participation-filter">
                    <SegmentedControl
                      size="sm"
                      label="Status-Schnellfilter"
                      value={quickFilter}
                      onChange={(v) =>
                        onQuickFilterChange(v as QuickStatusFilter)
                      }
                    >
                      <SegmentedControlItem value="all" label="Alle" />
                      <SegmentedControlItem
                        value="active"
                        label="Live & Warteraum"
                      />
                      <SegmentedControlItem value="scheduled" label="Geplant" />
                      <SegmentedControlItem value="completed" label="Fertig" />
                      <SegmentedControlItem value="failed" label="Hinweis" />
                    </SegmentedControl>
                  </div>

                  <HStack gap={2} vAlign="center" wrap="wrap">
                    <div id="provider-filter" className="w-56">
                      <Selector
                        size="sm"
                        label="Konferenzsystem filtern"
                        isLabelHidden
                        options={PROVIDER_OPTIONS}
                        value={providerFilter || 'all'}
                        onChange={(val) =>
                          onProviderFilterChange(val === 'all' ? '' : val)
                        }
                      />
                    </div>
                    <div id="title-search" className="w-64">
                      <TextInput
                        type="search"
                        size="sm"
                        label="Suche"
                        isLabelHidden
                        value={titleSearch}
                        onChange={onTitleSearchChange}
                        hasClear
                        placeholder="Titel, Sprecher oder Text suchen…"
                        startIcon={<Search className="h-3.5 w-3.5" />}
                      />
                    </div>
                  </HStack>
                </HStack>
              </div>

              {isLoading && recordings.length === 0 ? (
                <Text type="body" color="secondary">
                  Lade Aufnahmen…
                </Text>
              ) : recordings.length === 0 ? (
                <EmptyState
                  icon={<FolderOpen className="h-8 w-8" />}
                  title={
                    hasActiveFilter
                      ? 'Keine Aufnahmen für diesen Filter gefunden'
                      : 'Noch keine Besprechungen aufgezeichnet'
                  }
                  description={
                    hasActiveFilter
                      ? 'Setzen Sie die Filter zurück oder passen Sie Ihren Suchbegriff an.'
                      : 'Starten Sie oben rechts sofort per Meeting-Link oder verbinden Sie Ihren Kalender für automatische Protokolle.'
                  }
                  actions={
                    <HStack gap={2}>
                      {hasActiveFilter && (
                        <Button
                          variant="secondary"
                          size="sm"
                          label="Filter zurücksetzen"
                          onClick={() => {
                            onProviderFilterChange('');
                            onQuickFilterChange('all');
                            onTitleSearchChange('');
                          }}
                        />
                      )}
                      <Button
                        variant="primary"
                        size="sm"
                        icon={<Video className="h-3.5 w-3.5" />}
                        label="Jetzt per Link testen"
                        onClick={focusQuickJoinInput}
                      />
                      {onNavigateCalendar && !hasConnectedCalendar && (
                        <Button
                          variant="secondary"
                          size="sm"
                          icon={<Calendar className="h-3.5 w-3.5" />}
                          label="Kalender verbinden"
                          onClick={onNavigateCalendar}
                        />
                      )}
                    </HStack>
                  }
                />
              ) : (
                <Table<RecordingRow>
                  idKey="id"
                  density="balanced"
                  dividers="rows"
                  hasHover
                  data={recordings as RecordingRow[]}
                  columns={columns}
                  plugins={{
                    rowClick: {
                      transformBodyRow: (props, item) => ({
                        ...props,
                        htmlProps: {
                          ...props.htmlProps,
                          onClick: (e) => {
                            props.htmlProps.onClick?.(e);
                            onSelectRecording(item.id);
                          },
                          style: {
                            ...props.htmlProps.style,
                            cursor: 'pointer',
                          },
                        },
                      }),
                    },
                  }}
                />
              )}
            </VStack>
          </VStack>
        </LayoutContent>
      }
    />
  );
}
