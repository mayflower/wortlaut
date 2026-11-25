import React, { useRef, useState } from 'react';
import {
  ArrowRight,
  Calendar,
  CalendarPlus,
  FolderOpen,
  Play,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Tag,
  Video,
} from 'lucide-react';
import { Layout, LayoutContent, LayoutHeader } from '@astryxdesign/core/Layout';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { HStack } from '@astryxdesign/core/HStack';
import { VStack } from '@astryxdesign/core/VStack';
import { Button } from '@astryxdesign/core/Button';
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
  toggleCalendarSyncedEvent,
  validateMeetingUrlClient,
} from '../api';
import { isPastCalendarSlot } from './CalendarWorkspace';
import { buildAsrLanguageOptions, useI18n, type UiLang } from '../i18n';
import {
  formatBotDisplayName,
  type CalendarConnectionInfo,
  type CalendarSyncedEventInfo,
  type RecordingSummary,
} from '../types';
import { LiveWaveform, ProviderBadge, StatusBadge } from './ui/primitives';

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
  failedRecordingsCount?: number;
  hasMoreRecordings?: boolean;
  isLoadingMoreRecordings?: boolean;
  loadMoreError?: string | null;
  onLoadMoreRecordings?: () => void;
  loadError?: string | null;
  onRetry?: () => void;
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

function formatUpcomingSlot(
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
  token = '',
  recordings,
  totalRecordingsCount,
  failedRecordingsCount = 0,
  hasMoreRecordings = false,
  isLoadingMoreRecordings = false,
  loadMoreError = null,
  onLoadMoreRecordings,
  loadError = null,
  onRetry,
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
  const { lang, localeTag, tr } = useI18n();
  const instance = getInstanceInfo();
  const failureReasons = getFailureReasons();
  const urlWrapRef = useRef<HTMLDivElement | null>(null);

  const [meetingUrl, setMeetingUrl] = useState('');
  const [showQuickOptions, setShowQuickOptions] = useState(false);
  const [title, setTitle] = useState('');
  const [quickDurationMin, setQuickDurationMin] = useState<number>(60);
  const [quickAsrLanguage, setQuickAsrLanguage] = useState<string>(() =>
    instance.defaultAsrLanguage && instance.defaultAsrLanguage !== '*'
      ? instance.defaultAsrLanguage
      : 'auto'
  );
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [quickJoinError, setQuickJoinError] = useState<string | null>(null);
  const [calendarBusyId, setCalendarBusyId] = useState<string | null>(null);

  const detectedProvider = detectProviderFromUrl(meetingUrl);

  const providerOptions = [
    {
      value: 'all',
      label: tr('Alle Systeme', 'All providers'),
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
  const showFailedFilterSegment =
    failedRecordingsCount > 0 || quickFilter === 'failed';

  const lobbyRecordings = recordings.filter(
    (r) => r.participation === 'waiting_admission'
  );

  const nowMs = Date.now();
  const allUpcomingSyncedEvents = calendarSyncedEvents
    .filter(
      (ev) =>
        ev.status !== 'cancelled' && !isPastCalendarSlot(ev.ends_at, nowMs)
    )
    .sort(
      (a, b) =>
        new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime()
    );
  const upcomingSyncedEvents = allUpcomingSyncedEvents.slice(0, 3);

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
    if (submittingRef.current || !meetingUrl.trim() || !token) return;
    const urlErr = validateMeetingUrlClient(meetingUrl);
    if (urlErr) {
      setQuickJoinError(urlErr);
      return;
    }
    submittingRef.current = true;
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
        language: quickAsrLanguage || 'auto',
      });
      setMeetingUrl('');
      setTitle('');
      setShowQuickOptions(false);
      if (onCreatedRecording) {
        onCreatedRecording(created.id);
      } else {
        onSelectRecording(created.id);
      }
    } catch (err) {
      setQuickJoinError(err instanceof Error ? err.message : String(err));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const getRowErrorState = (row: RecordingSummary) => {
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
    const hasError =
      row.processing === 'failed' || (isEndedOrUnknown && !isNormalEnd);
    const reasonHint =
      isEndedOrUnknown && !isNormalEnd && reason && failureReasons[reason]
        ? failureReasons[reason]
        : isEndedOrUnknown && reason && !isNormalEnd
          ? reason
          : null;
    return { hasError, reasonHint };
  };

  const getRowAudioSeconds = (row: RecordingSummary): number => {
    const dur = row.quality?.duration_seconds;
    if (typeof dur === 'number' && Number.isFinite(dur) && dur > 0) {
      return Math.round(dur);
    }
    const samples = row.quality?.durable_sample_count || 0;
    return Math.round(samples / 16000);
  };

  const formatRowDuration = (row: RecordingSummary): string | null => {
    const audioSec = getRowAudioSeconds(row);
    if (audioSec > 0) return formatDurationHuman(audioSec);
    const plannedMin = Math.max(
      0,
      Math.round(
        (new Date(row.ends_at).getTime() - new Date(row.starts_at).getTime()) /
          60000
      )
    );
    if (row.participation === 'scheduled' && plannedMin > 0) {
      return `${plannedMin} ${tr('Min.', 'min')}`;
    }
    return null;
  };

  const columns: TableColumn<RecordingRow>[] = [
    {
      key: 'participation',
      header: 'Status',
      width: pixel(175),
      renderCell: (row) => {
        const { hasError } = getRowErrorState(row);
        const hasSpeech =
          (row.quality?.durable_sample_count || 0) > 0 ||
          (row.quality?.duration_seconds || 0) > 0;
        return (
          <StatusBadge
            participation={row.participation}
            processing={row.processing}
            hasError={hasError}
            hasSpeech={hasSpeech}
          />
        );
      },
    },
    {
      key: 'title',
      header: tr('Besprechung', 'Meeting'),
      width: proportional(2.8, { minWidth: 240 }),
      renderCell: (row) => {
        const { reasonHint } = getRowErrorState(row);
        return (
          <VStack gap={0.5} hAlign="start">
            <button
              type="button"
              onClick={() => onSelectRecording(row.id)}
              className="text-left font-semibold text-[14px] text-[var(--color-text-primary)] wl-hover-accent cursor-pointer transition-colors"
            >
              {formatRecordingTitle(row)}
            </button>
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
      header: tr('System', 'Provider'),
      width: pixel(170),
      renderCell: (row) => <ProviderBadge provider={row.provider} />,
    },
    {
      key: 'starts_at',
      header: tr('Zeitpunkt', 'Date'),
      width: pixel(150),
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
      width: pixel(105),
      renderCell: (row) => {
        const audioSec = getRowAudioSeconds(row);
        if (audioSec > 0) {
          return (
            <Text
              type="supporting"
              color="primary"
              weight="medium"
              hasTabularNumbers
            >
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
        const dur = formatRowDuration(row);
        return (
          <Text type="supporting" color="secondary" hasTabularNumbers>
            {dur || '–'}
          </Text>
        );
      },
    },
  ];

  const upcomingColumns: TableColumn<UpcomingSyncedRow>[] = [
    {
      key: 'auto_record',
      header: tr('Aufnahme', 'Record'),
      width: pixel(115),
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
      header: tr('Termin', 'Meeting'),
      width: proportional(3, { minWidth: 260 }),
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
      key: 'starts_at',
      header: tr('Zeitfenster', 'Time'),
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
      width: pixel(110),
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

  return (
    <Layout
      height="fill"
      header={
        <LayoutHeader hasDivider>
          <div className="wl-page-container">
            <HStack gap={2} vAlign="center" id="welcome-intro">
              <Heading level={1}>{tr('Aufnahmen', 'Recordings')}</Heading>
              <Token size="sm" color="gray" label={String(totalCount)} />
            </HStack>
          </div>
        </LayoutHeader>
      }
      content={
        <LayoutContent>
          <div className="wl-page-container">
            <VStack gap={5} id="recordings-list">
              {token && (
                <form
                  id="dispatch-form"
                  onSubmit={handleQuickStart}
                  className="wl-dispatch-bar"
                >
                  <VStack gap={2}>
                    <HStack gap={2} vAlign="center" wrap="wrap">
                      <div
                        ref={urlWrapRef}
                        className="flex-1 min-w-[220px]"
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
                            'Meeting-Link einfügen (Meet, Teams, Webex, Zoom)…',
                            'Paste meeting URL (Meet, Teams, Webex, Zoom)…'
                          )}
                          startIcon={<Video className="h-3.5 w-3.5" />}
                          hasClear
                        />
                      </div>

                      {detectedProvider && (
                        <ProviderBadge provider={detectedProvider} size="sm" />
                      )}

                      <Button
                        type="button"
                        variant={showQuickOptions ? 'secondary' : 'ghost'}
                        size="sm"
                        icon={<SlidersHorizontal className="h-3.5 w-3.5" />}
                        label={tr('Optionen', 'Options')}
                        onClick={() => setShowQuickOptions((v) => !v)}
                      />

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

                    {showQuickOptions && (
                      <HStack
                        gap={2}
                        vAlign="center"
                        wrap="wrap"
                        className="pt-2 border-t border-[var(--color-border)]"
                      >
                        <div className="flex-1 min-w-[180px]">
                          <TextInput
                            type="text"
                            size="sm"
                            label={tr('Titel (optional)', 'Title (optional)')}
                            isLabelHidden
                            value={title}
                            onChange={setTitle}
                            placeholder={tr(
                              'Titel (optional)',
                              'Title (optional)'
                            )}
                            startIcon={<Tag className="h-3.5 w-3.5" />}
                          />
                        </div>
                        <div className="w-52 max-w-full" id="quick-asr-language-wrap">
                          <Selector
                            size="sm"
                            label={tr(
                              'Transkriptionssprache',
                              'Transcription language'
                            )}
                            isLabelHidden
                            options={buildAsrLanguageOptions(
                              lang,
                              quickAsrLanguage
                            )}
                            value={quickAsrLanguage}
                            onChange={setQuickAsrLanguage}
                          />
                        </div>
                        <SegmentedControl
                          size="sm"
                          label={tr('Aufnahmedauer', 'Duration')}
                          value={String(quickDurationMin)}
                          onChange={(v) => setQuickDurationMin(Number(v) || 60)}
                        >
                          <SegmentedControlItem value="30" label="30m" />
                          <SegmentedControlItem value="60" label="60m" />
                          <SegmentedControlItem value="90" label="90m" />
                        </SegmentedControl>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          icon={<CalendarPlus className="h-3.5 w-3.5" />}
                          label={tr('.ics importieren', 'Import .ics')}
                          onClick={onOpenIcsImport || onOpenNewRecording}
                        />
                      </HStack>
                    )}

                    {quickJoinError && (
                      <Banner
                        status="error"
                        container="card"
                        title={quickJoinError}
                        isDismissable
                        onDismiss={() => setQuickJoinError(null)}
                      />
                    )}
                  </VStack>
                </form>
              )}

              {lobbyRecordings.map((rec) => (
                <div key={rec.id} className="wl-lobby-card p-3.5">
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
                          `„${formatBotDisplayName(rec, instance.assistantName)}“ wartet im Warteraum — bitte im Meeting zulassen.`,
                          `“${formatBotDisplayName(rec, instance.assistantName)}” is waiting in the lobby — please admit in the meeting.`
                        )}
                      </Text>
                    </VStack>
                    <Button
                      variant="primary"
                      size="sm"
                      label={tr('Öffnen', 'Open')}
                      endContent={<ArrowRight className="h-3.5 w-3.5" />}
                      onClick={() => onSelectRecording(rec.id)}
                    />
                  </HStack>
                </div>
              ))}

              {!hasActiveFilter && upcomingSyncedEvents.length > 0 && (
                <VStack gap={2} id="upcoming-calendar-section">
                  <HStack justify="between" vAlign="center" wrap="wrap" gap={2}>
                    <Heading level={2}>
                      {tr('Anstehende Kalendertermine', 'Upcoming Calendar')}
                    </Heading>
                    {onNavigateCalendar && (
                      <Button
                        variant="ghost"
                        size="sm"
                        label={tr(
                          `Kalender (${allUpcomingSyncedEvents.length})`,
                          `Calendar (${allUpcomingSyncedEvents.length})`
                        )}
                        endContent={<ArrowRight className="h-3.5 w-3.5" />}
                        onClick={onNavigateCalendar}
                      />
                    )}
                  </HStack>

                  {/* Mobile stacked rows (< md) */}
                  <div className="md:hidden divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)] bg-[var(--color-background-surface)]">
                    {upcomingSyncedEvents.map((ev) => {
                      const toggleBusy = calendarBusyId === `toggle-${ev.id}`;
                      return (
                        <div key={ev.id} className="p-3">
                          <HStack justify="between" vAlign="start" gap={3}>
                            <VStack gap={1} className="min-w-0 flex-1">
                              <Text type="body" weight="semibold" color="primary">
                                {ev.title || tr('Kalendertermin', 'Calendar event')}
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
                                  {formatUpcomingSlot(
                                    ev.starts_at,
                                    ev.ends_at,
                                    lang
                                  )}
                                </Text>
                              </HStack>
                            </VStack>
                            <Switch
                              size="sm"
                              value={ev.auto_record}
                              isLoading={toggleBusy}
                              isDisabled={calendarBusyId !== null}
                              label={
                                ev.auto_record ? tr('An', 'On') : tr('Aus', 'Off')
                              }
                              onChange={(checked) =>
                                handleToggleUpcomingEvent(ev, checked)
                              }
                            />
                          </HStack>
                        </div>
                      );
                    })}
                  </div>

                  {/* Desktop table (md+) */}
                  <div className="hidden md:block">
                    <Table<UpcomingSyncedRow>
                      idKey="id"
                      density="compact"
                      dividers="rows"
                      hasHover
                      data={upcomingSyncedEvents as UpcomingSyncedRow[]}
                      columns={upcomingColumns}
                    />
                  </div>
                </VStack>
              )}

              <VStack gap={3}>
                {(totalCount > 0 || hasActiveFilter) && (
                  <HStack justify="between" vAlign="center" wrap="wrap" gap={2}>
                    <div id="participation-filter">
                      <SegmentedControl
                        size="sm"
                        label={tr('Status-Filter', 'Status filter')}
                        value={quickFilter}
                        onChange={(v) =>
                          onQuickFilterChange(v as QuickStatusFilter)
                        }
                      >
                        <SegmentedControlItem
                          value="all"
                          label={tr('Alle', 'All')}
                        />
                        <SegmentedControlItem value="active" label="Live" />
                        <SegmentedControlItem
                          value="scheduled"
                          label={tr('Geplant', 'Scheduled')}
                        />
                        <SegmentedControlItem
                          value="completed"
                          label={tr('Fertig', 'Ready')}
                        />
                        {showFailedFilterSegment && (
                          <SegmentedControlItem
                            value="failed"
                            label={
                              failedRecordingsCount > 0
                                ? `${tr('Hinweis', 'Issues')} (${failedRecordingsCount})`
                                : tr('Hinweis', 'Issues')
                            }
                          />
                        )}
                      </SegmentedControl>
                    </div>

                    <HStack gap={2} vAlign="center" wrap="wrap">
                      <div id="provider-filter" className="w-44 max-w-full">
                        <Selector
                          size="sm"
                          label={tr('System filtern', 'Filter provider')}
                          isLabelHidden
                          options={providerOptions}
                          value={providerFilter || 'all'}
                          onChange={(val) =>
                            onProviderFilterChange(val === 'all' ? '' : val)
                          }
                        />
                      </div>
                      <div id="title-search" className="w-60 max-w-full">
                        <TextInput
                          type="search"
                          size="sm"
                          label={tr('Suche', 'Search')}
                          isLabelHidden
                          value={titleSearch}
                          onChange={onTitleSearchChange}
                          hasClear
                          placeholder={tr(
                            'Titel, Sprecher oder Text…',
                            'Title, speaker, or text…'
                          )}
                          startIcon={<Search className="h-3.5 w-3.5" />}
                        />
                      </div>
                    </HStack>
                  </HStack>
                )}

                {loadError && (
                  <Banner
                    status="error"
                    container="card"
                    title={loadError}
                    endContent={
                      onRetry ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          icon={<RefreshCw className="h-3.5 w-3.5" />}
                          label={tr('Erneut versuchen', 'Retry')}
                          onClick={onRetry}
                        />
                      ) : undefined
                    }
                  />
                )}

                {isLoading && recordings.length === 0 ? (
                  <Text type="supporting" color="secondary">
                    {tr('Lade Aufnahmen…', 'Loading recordings…')}
                  </Text>
                ) : recordings.length === 0 ? (
                  loadError ? null : (
                  <EmptyState
                    headingLevel={2}
                    icon={<FolderOpen className="h-8 w-8" />}
                    title={
                      hasActiveFilter
                        ? tr(
                            'Keine passenden Aufnahmen gefunden',
                            'No matching recordings'
                          )
                        : tr(
                            'Noch keine Besprechungen aufgezeichnet',
                            'No meetings recorded yet'
                          )
                    }
                    description={
                      hasActiveFilter
                        ? tr(
                            'Passen Sie den Suchbegriff an oder setzen Sie die Filter zurück.',
                            'Adjust your search query or reset the active filters.'
                          )
                        : tr(
                            'Fügen Sie oben einen Konferenz-Link ein oder verbinden Sie Ihren Kalender für automatische Protokolle.',
                            'Paste a meeting link above or connect your calendar for automatic protocols.'
                          )
                    }
                    actions={
                      <HStack gap={2}>
                        {hasActiveFilter ? (
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
                        ) : (
                          <>
                            <Button
                              variant="primary"
                              size="sm"
                              icon={<Video className="h-3.5 w-3.5" />}
                              label={tr('Link einfügen', 'Paste link')}
                              onClick={focusQuickJoinInput}
                            />
                            {onNavigateCalendar && !hasConnectedCalendar && (
                              <Button
                                variant="secondary"
                                size="sm"
                                icon={<Calendar className="h-3.5 w-3.5" />}
                                label={tr(
                                  'Kalender verbinden',
                                  'Connect calendar'
                                )}
                                onClick={onNavigateCalendar}
                              />
                            )}
                          </>
                        )}
                      </HStack>
                    }
                  />
                  )
                ) : (
                  <>
                    {/* Mobile responsive list (< md): full untruncated titles */}
                    <div className="md:hidden divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)] bg-[var(--color-background-surface)]">
                      {recordings.map((row) => {
                        const { hasError, reasonHint } = getRowErrorState(row);
                        const dur = formatRowDuration(row);
                        const dateStr = new Date(row.starts_at).toLocaleString(
                          localeTag,
                          {
                            day: '2-digit',
                            month: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit',
                            hour12: false,
                          }
                        );
                        return (
                          <button
                            key={row.id}
                            type="button"
                            onClick={() => onSelectRecording(row.id)}
                            className="w-full p-3.5 text-left hover:bg-[var(--color-background-muted)] transition-colors cursor-pointer block"
                          >
                            <VStack gap={1.5} hAlign="start" className="min-w-0">
                              <div dir="auto" className="wl-break-anywhere">
                                <Text
                                  type="body"
                                  weight="semibold"
                                  color="primary"
                                >
                                  {formatRecordingTitle(row)}
                                </Text>
                              </div>
                              <HStack gap={2} vAlign="center" wrap="wrap">
                                <StatusBadge
                                  participation={row.participation}
                                  processing={row.processing}
                                  hasError={hasError}
                                  hasSpeech={
                                    (row.quality?.durable_sample_count || 0) >
                                      0 ||
                                    (row.quality?.duration_seconds || 0) > 0
                                  }
                                />
                                <ProviderBadge
                                  provider={row.provider}
                                  size="sm"
                                />
                                <Text
                                  type="supporting"
                                  color="secondary"
                                  hasTabularNumbers
                                >
                                  {dateStr}
                                  {dur ? ` · ${dur}` : ''}
                                </Text>
                              </HStack>
                              {reasonHint && (
                                <Text type="supporting" color="secondary">
                                  {reasonHint}
                                </Text>
                              )}
                            </VStack>
                          </button>
                        );
                      })}
                    </div>

                    {/* Desktop table (md+) */}
                    <div className="hidden md:block">
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
                    </div>
                  </>
                )}

                {loadMoreError && (
                  <Banner
                    status="error"
                    container="card"
                    title={loadMoreError}
                  />
                )}

                {hasMoreRecordings && onLoadMoreRecordings && (
                  <HStack justify="center">
                    <Button
                      variant="secondary"
                      size="sm"
                      isDisabled={isLoadingMoreRecordings}
                      label={
                        isLoadingMoreRecordings
                          ? tr('Lade weitere…', 'Loading more…')
                          : tr('Weitere laden', 'Load more')
                      }
                      onClick={onLoadMoreRecordings}
                    />
                  </HStack>
                )}
              </VStack>
            </VStack>
          </div>
        </LayoutContent>
      }
    />
  );
}
