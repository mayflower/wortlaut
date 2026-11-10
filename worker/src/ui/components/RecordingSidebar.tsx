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
import { Breadcrumbs, BreadcrumbItem } from '@astryxdesign/core/Breadcrumbs';
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
import { useI18n, type UiLang } from '../i18n';
import {
  formatBotDisplayName,
  type CalendarConnectionInfo,
  type CalendarSyncedEventInfo,
  type RecordingSummary,
} from '../types';
import {
  LiveWaveform,
  ProviderBadge,
  StatusBadge,
  StatusIndicator,
} from './ui/primitives';

export type QuickStatusFilter =
  | 'all'
  | 'active'
  | 'scheduled'
  | 'completed'
  | 'failed';

export interface RecordingSidebarProps {
  mode?: 'home' | 'meetings';
  userName?: string | null;
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
  onNavigateHome?: () => void;
  onNavigateMeetings?: () => void;
  onNavigateCalendar?: () => void;
  onRefreshCalendar?: () => void;
  onCreatedRecording?: (id: string) => void;
  isLoading: boolean;
}

type RecordingRow = RecordingSummary & Record<string, unknown>;
type UpcomingSyncedRow = CalendarSyncedEventInfo & Record<string, unknown>;

const ONBOARDING_DISMISSED_KEY = 'wortlaut_onboarding_dismissed_v1';

function formatUpcomingSlot(
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

export function RecordingSidebar({
  mode = 'home',
  userName,
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
  onNavigateHome,
  onNavigateMeetings,
  onNavigateCalendar,
  onRefreshCalendar,
  onCreatedRecording,
  isLoading,
}: RecordingSidebarProps) {
  const { lang, localeTag, tr } = useI18n();
  const instance = getInstanceInfo();
  const failureReasons = getFailureReasons();
  const urlWrapRef = useRef<HTMLDivElement | null>(null);

  const [meetingUrl, setMeetingUrl] = useState('');
  const [title, setTitle] = useState('');
  const [quickDurationMin, setQuickDurationMin] = useState<number>(60);
  const [submitting, setSubmitting] = useState(false);
  const [quickJoinError, setQuickJoinError] = useState<string | null>(null);
  const [copiedMail, setCopiedMail] = useState(false);
  const [calendarBusyId, setCalendarBusyId] = useState<string | null>(null);
  const [guideOpenManual, setGuideOpenManual] = useState<boolean>(false);

  const detectedProvider = detectProviderFromUrl(meetingUrl);

  const providerOptions = [
    {
      value: 'all',
      label: tr('Alle Konferenzsysteme', 'All conference providers'),
    },
    { value: 'google_meet', label: 'Google Meet' },
    { value: 'teams', label: 'Microsoft Teams' },
    { value: 'webex', label: 'Cisco Webex' },
    { value: 'zoom', label: 'Zoom' },
  ];

  const hasActiveFilter =
    Boolean(providerFilter) ||
    quickFilter !== 'all' ||
    Boolean(titleSearch.trim());

  const totalCount =
    typeof totalRecordingsCount === 'number'
      ? totalRecordingsCount
      : recordings.length;

  const hasConnectedCalendar = calendarConnections.length > 0;
  const isHomeView = mode === 'home';
  const showOnboardingGuide =
    isHomeView && (totalCount === 0 || guideOpenManual);
  const showFilterToolbar = !isHomeView || hasActiveFilter;
  const firstName = userName ? userName.trim().split(/\s+/)[0] : null;
  const displayedRecordings =
    isHomeView && !hasActiveFilter ? recordings.slice(0, 8) : recordings;

  const lobbyRecordings = recordings.filter(
    (r) => r.participation === 'waiting_admission'
  );
  const activeCapturingRecordings = recordings.filter(
    (r) =>
      r.participation === 'capturing' ||
      r.participation === 'starting' ||
      r.participation === 'preparing' ||
      r.participation === 'joining'
  );

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

  const handleToggleGuide = (dismissed: boolean) => {
    setGuideOpenManual(!dismissed);
    try {
      if (dismissed) {
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
      const endIso = new Date(
        now.getTime() + quickDurationMin * 60000
      ).toISOString();
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
          reason === 'source_binding_unverified' ||
          ((reason === 'cancelled' || reason === 'deadline') && samples > 0);
        const hasError =
          row.processing === 'failed' ||
          ((row.participation === 'ended' || row.participation === 'unknown') &&
            !isNormalEnd);
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
      header: tr('Besprechung', 'Meeting'),
      width: proportional(2.5, { minWidth: 240 }),
      renderCell: (row) => {
        const reason = row.participation_reason;
        const samples = row.quality?.durable_sample_count || 0;
        const isNormalEnd =
          !reason ||
          reason === 'normal' ||
          reason === 'room_empty' ||
          reason === 'source_binding_unverified' ||
          ((reason === 'cancelled' || reason === 'deadline') && samples > 0);
        const isEndedOrUnknown =
          row.participation === 'ended' || row.participation === 'unknown';
        const reasonHint =
          isEndedOrUnknown && !isNormalEnd && reason && failureReasons[reason]
            ? failureReasons[reason]
            : isEndedOrUnknown && reason && !isNormalEnd
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
                {tr(
                  'Wartet im Warteraum — bitte Bot im Meeting zulassen',
                  'Waiting in lobby — please admit assistant in the meeting'
                )}
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
      header: tr('Konferenzsystem', 'Provider'),
      width: pixel(150),
      renderCell: (row) => <ProviderBadge provider={row.provider} />,
    },
    {
      key: 'starts_at',
      header: tr('Zeitpunkt', 'Started'),
      width: pixel(155),
      renderCell: (row) => (
        <Text type="supporting" color="secondary" hasTabularNumbers>
          {new Date(row.starts_at).toLocaleString(localeTag, {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          })}
        </Text>
      ),
    },
    {
      key: 'duration',
      header: tr('Dauer', 'Duration'),
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
            <HStack gap={1.5} vAlign="center">
              <LiveWaveform />
              <Text type="supporting" color="primary" weight="semibold">
                Live
              </Text>
            </HStack>
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
              {plannedMin} {tr('Min.', 'min')}
            </Text>
          );
        }
        const reason = row.participation_reason;
        const isFailedEmpty =
          row.participation === 'ended' &&
          Boolean(reason) &&
          reason !== 'normal' &&
          reason !== 'source_binding_unverified';
        if (!isFailedEmpty && plannedMin > 0) {
          return (
            <Text type="supporting" color="secondary" hasTabularNumbers>
              {plannedMin} {tr('Min.', 'min')}
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
          label={tr('Öffnen', 'Open')}
          endContent={<ArrowRight className="h-3.5 w-3.5" />}
          onClick={() => onSelectRecording(row.id)}
        />
      ),
    },
  ];

  const upcomingColumns: TableColumn<UpcomingSyncedRow>[] = [
    {
      key: 'auto_record',
      header: tr('Aufzeichnen', 'Auto-record'),
      width: pixel(145),
      renderCell: (ev) => {
        const toggleBusy = calendarBusyId === `toggle-${ev.id}`;
        return (
          <Switch
            size="sm"
            value={ev.auto_record}
            isLoading={toggleBusy}
            isDisabled={calendarBusyId !== null}
            label={ev.auto_record ? tr('An', 'On') : tr('Aus', 'Off')}
            onChange={(checked) => handleToggleUpcomingEvent(ev, checked)}
          />
        );
      },
    },
    {
      key: 'title',
      header: tr('Anstehender Termin', 'Upcoming meeting'),
      width: proportional(2.2, { minWidth: 230 }),
      renderCell: (ev) => (
        <HStack gap={2} vAlign="center" wrap="nowrap">
          <span className="shrink-0">
            <ProviderBadge provider={ev.meeting_provider} />
          </span>
          <Text type="body" weight="semibold" color="primary" maxLines={1}>
            {ev.title || tr('Kalendertermin', 'Calendar event')}
          </Text>
        </HStack>
      ),
    },
    {
      key: 'role',
      header: tr('Regel', 'Policy'),
      width: pixel(190),
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
            label={tr('Gast (Manuell zuschaltbar)', 'Attendee (1-click opt-in)')}
          />
        ),
    },
    {
      key: 'starts_at',
      header: tr('Zeitfenster', 'Time slot'),
      width: pixel(185),
      renderCell: (ev) => (
        <Text type="supporting" color="secondary" hasTabularNumbers>
          {formatUpcomingSlot(ev.starts_at, ev.ends_at, lang)}
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
            label={tr('Öffnen', 'Open')}
            endContent={<ArrowRight className="h-3.5 w-3.5" />}
            onClick={() => onSelectRecording(ev.recording_id!)}
          />
        ) : (
          <Text type="supporting" color="secondary">
            {ev.auto_record ? tr('Eingeplant', 'Scheduled') : '–'}
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
          <div className="wl-page-container">
            <VStack gap={2}>
              {!isHomeView && onNavigateHome && (
                <Breadcrumbs
                  variant="supporting"
                  label={tr('Pfadnavigation', 'Breadcrumb')}
                >
                  <BreadcrumbItem onClick={onNavigateHome}>
                    {tr('Startseite', 'Home')}
                  </BreadcrumbItem>
                  <BreadcrumbItem isCurrent>
                    {tr('Aufnahmen', 'Recordings')}
                  </BreadcrumbItem>
                </Breadcrumbs>
              )}

              <HStack justify="between" vAlign="center" wrap="wrap" gap={2}>
                <VStack gap={0.5} id="welcome-intro">
                  <Heading level={1}>
                    {isHomeView
                      ? firstName
                        ? tr(`Guten Tag, ${firstName}`, `Welcome back, ${firstName}`)
                        : tr('Übersicht', 'Overview')
                      : tr('Aufnahmen', 'Recordings')}
                  </Heading>
                  <Text type="supporting" color="secondary">
                    {isHomeView
                      ? tr(
                          'Spontan per Konferenz-Link starten oder geplante Besprechungen verwalten.',
                          'Start an ad-hoc meeting via link or manage upcoming calendar recordings.'
                        )
                      : tr(
                          'Alle aufgezeichneten, laufenden und geplanten Besprechungen durchsuchen und exportieren.',
                          'Search, inspect, and export all recorded, live, and scheduled meetings.'
                        )}
                  </Text>
                </VStack>

                <HStack gap={2} vAlign="center" wrap="wrap">
                  {isHomeView && !showOnboardingGuide && (
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<HelpCircle className="h-3.5 w-3.5" />}
                      label={tr('Kurzanleitung', 'Quick guide')}
                      onClick={() => handleToggleGuide(false)}
                    />
                  )}
                  {isHomeView ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<CalendarPlus className="h-3.5 w-3.5" />}
                      label={tr('Termin planen / .ics', 'Schedule / .ics')}
                      onClick={onOpenIcsImport || onOpenNewRecording}
                    />
                  ) : (
                    <Button
                      variant="primary"
                      size="sm"
                      icon={<Plus className="h-3.5 w-3.5" />}
                      label={tr('Neue Aufnahme', 'New recording')}
                      onClick={onOpenNewRecording}
                    />
                  )}
                </HStack>
              </HStack>
            </VStack>
          </div>
        </LayoutHeader>
      }
      content={
        <LayoutContent>
          <div className="wl-page-container">
            <VStack gap={5} id="recordings-list">
              {token && isHomeView && (
                <form
                  id="dispatch-form"
                  onSubmit={handleQuickStart}
                  className="wl-dispatch-hero wl-fade-in"
                >
                  <VStack gap={3}>
                    <HStack justify="between" vAlign="center" wrap="wrap" gap={2}>
                      <HStack gap={2} vAlign="center" wrap="wrap">
                        <Heading level={3}>
                          {tr(
                            'Sofort-Aufnahme starten',
                            'Instant Meeting Capture'
                          )}
                        </Heading>
                        {detectedProvider && (
                          <span className="wl-fade-in">
                            <ProviderBadge provider={detectedProvider} size="sm" />
                          </span>
                        )}
                      </HStack>
                      <SegmentedControl
                        size="sm"
                        label={tr('Aufnahmedauer', 'Duration')}
                        value={String(quickDurationMin)}
                        onChange={(v) => setQuickDurationMin(Number(v) || 60)}
                      >
                        <SegmentedControlItem
                          value="30"
                          label={tr('30 Min.', '30 min')}
                        />
                        <SegmentedControlItem
                          value="60"
                          label={tr('60 Min.', '60 min')}
                        />
                        <SegmentedControlItem
                          value="90"
                          label={tr('90 Min.', '90 min')}
                        />
                      </SegmentedControl>
                    </HStack>

                    <HStack gap={2} vAlign="center" wrap="wrap">
                      <div
                        ref={urlWrapRef}
                        className="flex-1 min-w-[260px]"
                        id="meeting-url-wrap"
                      >
                        <TextInput
                          type="url"
                          size="sm"
                          label={tr('Meeting-Link', 'Meeting URL')}
                          isLabelHidden
                          value={meetingUrl}
                          onChange={setMeetingUrl}
                          placeholder={tr(
                            'Meeting-Link einfügen (Google Meet, Teams, Webex oder Zoom)…',
                            'Paste meeting URL (Google Meet, Teams, Webex, or Zoom)…'
                          )}
                          startIcon={<Video className="h-3.5 w-3.5" />}
                          hasClear
                        />
                      </div>
                      <div className="w-56">
                        <TextInput
                          type="text"
                          size="sm"
                          label={tr('Titel (optional)', 'Title (optional)')}
                          isLabelHidden
                          value={title}
                          onChange={setTitle}
                          placeholder={tr(
                            'Titel (optional, z. B. Jour Fixe)',
                            'Title (optional, e.g. Weekly Sync)'
                          )}
                          startIcon={<Tag className="h-3.5 w-3.5" />}
                        />
                      </div>
                      <Button
                        type="submit"
                        variant="primary"
                        size="sm"
                        isLoading={submitting}
                        isDisabled={!meetingUrl.trim()}
                        icon={<Play className="h-3.5 w-3.5" />}
                        label={tr('Jetzt aufzeichnen', 'Start capture')}
                      />
                    </HStack>

                    <Text type="supporting" color="secondary">
                      {tr(
                        `Tritt als Zuhörer „${instance.assistantName}“ bei — bitte im Konferenz-Warteraum kurz zulassen.`,
                        `Joins muted as “${instance.assistantName}” — please admit from the conference lobby.`
                      )}
                    </Text>
                  </VStack>

                  {quickJoinError && (
                    <div className="mt-2.5">
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

              {lobbyRecordings.map((rec) => (
                <div key={rec.id} className="wl-lobby-card p-3.5 wl-fade-in">
                  <HStack justify="between" vAlign="center" wrap="wrap" gap={3}>
                    <VStack gap={0.5}>
                      <HStack gap={2} vAlign="center" wrap="wrap">
                        <ProviderBadge provider={rec.provider} size="sm" />
                        <StatusBadge participation={rec.participation} />
                        <Text type="body" weight="bold">
                          {formatRecordingTitle(rec)}
                        </Text>
                      </HStack>
                      <Text type="supporting" color="secondary">
                        {tr(
                          `Zuhörer „${formatBotDisplayName(rec, instance.assistantName)}“ wartet im Konferenz-Warteraum — bitte jetzt im Meeting-Fenster zulassen.`,
                          `Assistant “${formatBotDisplayName(rec, instance.assistantName)}” is waiting in the lobby — please admit in the meeting window.`
                        )}
                      </Text>
                    </VStack>
                    <Button
                      variant="primary"
                      size="sm"
                      label={tr('Live-Ansicht öffnen', 'Open live view')}
                      endContent={<ArrowRight className="h-3.5 w-3.5" />}
                      onClick={() => onSelectRecording(rec.id)}
                    />
                  </HStack>
                </div>
              ))}

              {activeCapturingRecordings.map((rec) => {
                const isCapturing = rec.participation === 'capturing';
                const audioSec = Math.round(
                  (rec.quality?.durable_sample_count || 0) / 16000
                );
                return (
                  <div
                    key={rec.id}
                    className={
                      isCapturing
                        ? 'wl-live-card p-3.5 wl-fade-in'
                        : 'wl-joining-card p-3.5 wl-fade-in'
                    }
                  >
                    <VStack gap={2}>
                      <HStack justify="between" vAlign="center" wrap="wrap" gap={3}>
                        <VStack gap={0.5}>
                          <HStack gap={2} vAlign="center" wrap="wrap">
                            <ProviderBadge provider={rec.provider} size="sm" />
                            <StatusBadge participation={rec.participation} />
                            <Text type="body" weight="bold">
                              {formatRecordingTitle(rec)}
                            </Text>
                          </HStack>
                          <Text type="supporting" color="secondary">
                            {isCapturing
                              ? tr(
                                  `Live im Gespräch · ${audioSec > 0 ? `${formatDurationHuman(audioSec)} Audio erfasst` : 'Hört zu & transkribiert in Echtzeit'}`,
                                  `Live in meeting · ${audioSec > 0 ? `${formatDurationHuman(audioSec)} captured` : 'Listening & transcribing in real time'}`
                                )
                              : tr(
                                  `Zuhörer „${formatBotDisplayName(rec, instance.assistantName)}“ verbindet sich mit dem Konferenzraum…`,
                                  `Assistant “${formatBotDisplayName(rec, instance.assistantName)}” is connecting to the room…`
                                )}
                          </Text>
                        </VStack>
                        <Button
                          variant="secondary"
                          size="sm"
                          label={tr('Live-Protokoll öffnen', 'Open live transcript')}
                          endContent={<ArrowRight className="h-3.5 w-3.5" />}
                          onClick={() => onSelectRecording(rec.id)}
                        />
                      </HStack>
                      {!isCapturing && <div className="wl-shimmer-bar" />}
                    </VStack>
                  </div>
                );
              })}

              {showOnboardingGuide && (
                <div id="onboarding-guide">
                  <Section variant="section">
                    <VStack gap={3}>
                      <HStack justify="between" vAlign="center" wrap="wrap" gap={2}>
                        <HStack gap={2} vAlign="center" wrap="wrap">
                          <Sparkles className="h-4 w-4 text-[var(--color-text-accent)]" />
                          <Heading level={3}>
                            {tr(
                              `Erste Schritte: Drei Wege, wie ${instance.assistantName} Ihre Besprechungen protokolliert`,
                              `Getting Started: Three Ways ${instance.assistantName} Captures Your Meetings`
                            )}
                          </Heading>
                        </HStack>
                        {totalCount > 0 && (
                          <Button
                            variant="ghost"
                            size="sm"
                            icon={<X className="h-3.5 w-3.5" />}
                            label={tr('Hinweis ausblenden', 'Dismiss guide')}
                            onClick={() => handleToggleGuide(true)}
                          />
                        )}
                      </HStack>

                      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
                        <Card>
                          <VStack gap={3} justify="between" height="fill">
                            <VStack gap={1.5}>
                              <HStack justify="between" vAlign="center">
                                <Heading level={4}>
                                  {tr(
                                    '1. Kalender-Automatik',
                                    '1. Calendar Automation'
                                  )}
                                </Heading>
                                {hasConnectedCalendar ? (
                                  <StatusIndicator
                                    variant="success"
                                    weight="medium"
                                    label={tr('Verbunden', 'Connected')}
                                  />
                                ) : (
                                  <Token
                                    size="sm"
                                    color="blue"
                                    label={tr(
                                      'Empfohlen für den Alltag',
                                      'Recommended'
                                    )}
                                  />
                                )}
                              </HStack>
                              <Text type="supporting" color="secondary">
                                {tr(
                                  'Verbinden Sie einmalig Ihren Google- oder Microsoft-365-Kalender. Eigene Besprechungen starten automatisch; externe Termine schalten Sie per 1-Klick-Schalter zu.',
                                  'Connect Google Calendar or Microsoft 365 once. Self-organized calls auto-join; external invites can be toggled on with 1 click.'
                                )}
                              </Text>
                            </VStack>

                            <HStack gap={1.5} wrap="wrap">
                              {!googleConn && calOAuth?.googleEnabled && (
                                <Button
                                  variant="primary"
                                  size="sm"
                                  isLoading={calendarBusyId === 'connect-google'}
                                  icon={<Link2 className="h-3.5 w-3.5" />}
                                  label={tr(
                                    'Google Kalender verbinden',
                                    'Connect Google Calendar'
                                  )}
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
                                  label={tr(
                                    'Microsoft 365 verbinden',
                                    'Connect Microsoft 365'
                                  )}
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
                                      ? tr(
                                          'Kalender verwalten',
                                          'Manage calendar'
                                        )
                                      : tr(
                                          'Zur Kalender-Einrichtung',
                                          'Open calendar setup'
                                        )
                                  }
                                  onClick={onNavigateCalendar}
                                />
                              )}
                            </HStack>
                          </VStack>
                        </Card>

                        <Card>
                          <VStack gap={3} justify="between" height="fill">
                            <VStack gap={1.5}>
                              <HStack justify="between" vAlign="center">
                                <Heading level={4}>
                                  {tr(
                                    '2. Spontan per Meeting-Link',
                                    '2. Ad-hoc Meeting URL'
                                  )}
                                </Heading>
                                <Token
                                  size="sm"
                                  color="green"
                                  label={tr(
                                    'Sofort-Start (~15 Sek.)',
                                    'Instant (~15s)'
                                  )}
                                />
                              </HStack>
                              <Text type="supporting" color="secondary">
                                {tr(
                                  `Kopieren Sie den Link Ihres laufenden Google Meet-, Teams-, Webex- oder Zoom-Meetings oben in die Leiste. Der Bot tritt als Gast „${instance.assistantName}“ bei — bitte im Konferenzfenster aus dem Warteraum zulassen.`,
                                  `Paste the URL of a live Google Meet, Teams, Webex, or Zoom call into the bar above. The assistant joins muted as “${instance.assistantName}” — simply admit it from the lobby.`
                                )}
                              </Text>
                            </VStack>

                            <HStack gap={1.5} wrap="wrap">
                              <Button
                                variant="secondary"
                                size="sm"
                                icon={<Video className="h-3.5 w-3.5" />}
                                label={tr(
                                  'Link-Eingabe oben fokussieren',
                                  'Focus URL input above'
                                )}
                                onClick={focusQuickJoinInput}
                              />
                            </HStack>
                          </VStack>
                        </Card>

                        <Card>
                          <VStack gap={3} justify="between" height="fill">
                            <VStack gap={1.5}>
                              <HStack justify="between" vAlign="center">
                                <Heading level={4}>
                                  {tr(
                                    '3. Per E-Mail oder .ics',
                                    '3. Email or .ics Invite'
                                  )}
                                </Heading>
                                <Token
                                  size="sm"
                                  color="gray"
                                  label={tr(
                                    'Ohne Kalender-OAuth',
                                    'No OAuth required'
                                  )}
                                />
                              </HStack>
                              <Text type="supporting" color="secondary">
                                {lang === 'en' ? (
                                  <>
                                    Invite{' '}
                                    <code>
                                      {instance.botEmail ||
                                        'wortlaut@wortlaut.example.org'}
                                    </code>{' '}
                                    as an attendee to any calendar invite or
                                    upload an <code>.ics</code> file directly.
                                  </>
                                ) : (
                                  <>
                                    Laden Sie{' '}
                                    <code>
                                      {instance.botEmail ||
                                        'wortlaut@wortlaut.example.org'}
                                    </code>{' '}
                                    einfach als Teilnehmer in einen beliebigen
                                    Kalendertermin ein oder laden Sie eine{' '}
                                    <code>.ics</code>-Einladungsdatei direkt
                                    hoch.
                                  </>
                                )}
                              </Text>
                            </VStack>

                            <HStack gap={1.5} wrap="wrap">
                              {instance.botEmail && (
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  icon={
                                    copiedMail ? (
                                      <Check className="h-3 w-3" />
                                    ) : (
                                      <Copy className="h-3.5 w-3.5" />
                                    )
                                  }
                                  label={
                                    copiedMail
                                      ? tr(
                                          'Adresse kopiert!',
                                          'Address copied!'
                                        )
                                      : `${instance.botEmail}`
                                  }
                                  onClick={handleCopyBotMail}
                                />
                              )}
                              <Button
                                variant="secondary"
                                size="sm"
                                icon={<Mail className="h-3.5 w-3.5" />}
                                label={tr(
                                  '.ics-Datei hochladen',
                                  'Upload .ics file'
                                )}
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

              {isHomeView && upcomingSyncedEvents.length > 0 && (
                <div id="upcoming-calendar-section">
                  <Section variant="section">
                    <VStack gap={3}>
                      <HStack justify="between" vAlign="center" wrap="wrap" gap={2}>
                        <HStack gap={2} vAlign="center" wrap="wrap">
                          <Heading level={3}>
                            {tr(
                              'Als Nächstes in Ihrem Kalender',
                              'Up Next in Your Calendar'
                            )}
                          </Heading>
                          <StatusIndicator
                            variant="success"
                            weight="medium"
                            label={tr('Kalender-Sync aktiv', 'Calendar sync active')}
                          />
                        </HStack>
                        {onNavigateCalendar && (
                          <Button
                            variant="ghost"
                            size="sm"
                            label={tr(
                              `Alle Kalendertermine (${calendarSyncedEvents.length})`,
                              `All calendar events (${calendarSyncedEvents.length})`
                            )}
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

              <VStack gap={3}>
                <HStack justify="between" vAlign="center" wrap="wrap" gap={2}>
                  <HStack gap={2} vAlign="center">
                    <Heading level={3}>
                      {isHomeView && !hasActiveFilter
                        ? tr(
                            'Letzte Aufnahmen & geplante Besprechungen',
                            'Recent Recordings & Scheduled Meetings'
                          )
                        : tr(
                            'Aufgezeichnete & geplante Besprechungen',
                            'Recorded & Scheduled Meetings'
                          )}
                    </Heading>
                    <Token size="sm" color="gray" label={String(recordings.length)} />
                  </HStack>

                  <HStack gap={2} vAlign="center" wrap="wrap">
                    {!hasConnectedCalendar && onNavigateCalendar && totalCount > 0 && (
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<Calendar className="h-3.5 w-3.5" />}
                        label={tr('Kalender verbinden', 'Connect calendar')}
                        onClick={onNavigateCalendar}
                      />
                    )}
                    {isHomeView && onNavigateMeetings && recordings.length > 0 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        label={tr(
                          `Alle Aufnahmen durchsuchen (${totalCount})`,
                          `Browse all recordings (${totalCount})`
                        )}
                        endContent={<ArrowRight className="h-3.5 w-3.5" />}
                        onClick={onNavigateMeetings}
                      />
                    )}
                  </HStack>
                </HStack>

                <div className={showFilterToolbar ? '' : 'sr-only'}>
                  <HStack justify="between" vAlign="center" wrap="wrap" gap={2}>
                    <div id="participation-filter">
                      <SegmentedControl
                        size="sm"
                        label={tr('Status-Schnellfilter', 'Status filter')}
                        value={quickFilter}
                        onChange={(v) =>
                          onQuickFilterChange(v as QuickStatusFilter)
                        }
                      >
                        <SegmentedControlItem
                          value="all"
                          label={tr('Alle', 'All')}
                        />
                        <SegmentedControlItem
                          value="active"
                          label={tr('Live & Warteraum', 'Live & Lobby')}
                        />
                        <SegmentedControlItem
                          value="scheduled"
                          label={tr('Geplant', 'Scheduled')}
                        />
                        <SegmentedControlItem
                          value="completed"
                          label={tr('Fertig', 'Ready')}
                        />
                        <SegmentedControlItem
                          value="failed"
                          label={tr('Hinweis', 'Issues')}
                        />
                      </SegmentedControl>
                    </div>

                    <HStack gap={2} vAlign="center" wrap="wrap">
                      <div id="provider-filter" className="w-56">
                        <Selector
                          size="sm"
                          label={tr(
                            'Konferenzsystem filtern',
                            'Filter provider'
                          )}
                          isLabelHidden
                          options={providerOptions}
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
                          label={tr('Suche', 'Search')}
                          isLabelHidden
                          value={titleSearch}
                          onChange={onTitleSearchChange}
                          hasClear
                          placeholder={tr(
                            'Titel, Sprecher oder Text suchen…',
                            'Search title, speaker, or text…'
                          )}
                          startIcon={<Search className="h-3.5 w-3.5" />}
                        />
                      </div>
                    </HStack>
                  </HStack>
                </div>

                {isLoading && recordings.length === 0 ? (
                  <Text type="body" color="secondary">
                    {tr('Lade Aufnahmen…', 'Loading recordings…')}
                  </Text>
                ) : recordings.length === 0 ? (
                  <EmptyState
                    icon={<FolderOpen className="h-8 w-8" />}
                    title={
                      hasActiveFilter
                        ? tr(
                            'Keine Aufnahmen für diesen Filter gefunden',
                            'No recordings match this filter'
                          )
                        : tr(
                            'Noch keine Besprechungen aufgezeichnet',
                            'No meetings recorded yet'
                          )
                    }
                    description={
                      hasActiveFilter
                        ? tr(
                            'Setzen Sie die Filter zurück oder passen Sie Ihren Suchbegriff an.',
                            'Reset your filters or adjust your search query.'
                          )
                        : tr(
                            'Starten Sie oben sofort per Meeting-Link oder verbinden Sie Ihren Kalender für automatische Protokolle.',
                            'Start immediately via meeting URL above or connect your calendar for automatic meeting protocols.'
                          )
                    }
                    actions={
                      <HStack gap={2}>
                        {hasActiveFilter && (
                          <Button
                            variant="secondary"
                            size="sm"
                            label={tr('Filter zurücksetzen', 'Reset filters')}
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
                          label={tr('Jetzt per Link testen', 'Try with a link')}
                          onClick={focusQuickJoinInput}
                        />
                        {onNavigateCalendar && !hasConnectedCalendar && (
                          <Button
                            variant="secondary"
                            size="sm"
                            icon={<Calendar className="h-3.5 w-3.5" />}
                            label={tr('Kalender verbinden', 'Connect calendar')}
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
                    data={displayedRecordings as RecordingRow[]}
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
          </div>
        </LayoutContent>
      }
    />
  );
}
