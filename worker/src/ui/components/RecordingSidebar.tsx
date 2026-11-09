import React, { useState } from 'react';
import {
  ArrowRight,
  CalendarPlus,
  FolderOpen,
  Play,
  Plus,
  Search,
  Tag,
  Video,
} from 'lucide-react';
import { Layout, LayoutContent, LayoutHeader } from '@astryxdesign/core/Layout';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { HStack } from '@astryxdesign/core/HStack';
import { VStack } from '@astryxdesign/core/VStack';
import { Button } from '@astryxdesign/core/Button';
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
import { Divider } from '@astryxdesign/core/Divider';
import {
  createRecording,
  detectProviderFromUrl,
  formatDurationHuman,
  formatRecordingTitle,
  getFailureReasons,
  getInstanceInfo,
} from '../api';
import type { RecordingSummary } from '../types';
import { ProviderBadge, StatusBadge } from './ui/primitives';

export type QuickStatusFilter =
  | 'all'
  | 'active'
  | 'scheduled'
  | 'completed'
  | 'failed';

export interface RecordingSidebarProps {
  token?: string;
  recordings: RecordingSummary[];
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
  onCreatedRecording?: (id: string) => void;
  isLoading: boolean;
}

type RecordingRow = RecordingSummary & Record<string, unknown>;

const PROVIDER_OPTIONS = [
  { value: 'all', label: 'Alle Konferenzsysteme' },
  { value: 'google_meet', label: 'Google Meet' },
  { value: 'teams', label: 'Microsoft Teams' },
  { value: 'webex', label: 'Cisco Webex' },
];

export function RecordingSidebar({
  token = '',
  recordings,
  onSelectRecording,
  providerFilter,
  onProviderFilterChange,
  quickFilter,
  onQuickFilterChange,
  titleSearch,
  onTitleSearchChange,
  onOpenNewRecording,
  onOpenIcsImport,
  onCreatedRecording,
  isLoading,
}: RecordingSidebarProps) {
  const instance = getInstanceInfo();
  const failureReasons = getFailureReasons();

  const [meetingUrl, setMeetingUrl] = useState('');
  const [title, setTitle] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [quickJoinError, setQuickJoinError] = useState<string | null>(null);

  const detectedProvider = detectProviderFromUrl(meetingUrl);

  const hasActiveFilter =
    Boolean(providerFilter) ||
    quickFilter !== 'all' ||
    Boolean(titleSearch.trim());

  const lobbyRecordings = recordings.filter(
    (r) => r.participation === 'waiting_admission'
  );

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
      header: 'Audio',
      width: pixel(95),
      renderCell: (row) => {
        const samples = row.quality?.durable_sample_count || 0;
        const audioSec = Math.round(samples / 16000);
        return (
          <Text type="supporting" color="secondary" hasTabularNumbers>
            {audioSec > 0 ? formatDurationHuman(audioSec) : '–'}
          </Text>
        );
      },
    },
    {
      key: 'actions',
      header: '',
      width: pixel(110),
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

  return (
    <Layout
      height="fill"
      header={
        <LayoutHeader hasDivider>
          <VStack gap={3}>
            <HStack justify="between" vAlign="center" wrap="wrap" gap={2}>
              <VStack gap={0.5}>
                <Heading level={1}>Aufnahmen</Heading>
                <Text type="supporting" color="secondary">
                  Sofort-Aufzeichnung per Meeting-Link sowie Übersicht aller
                  laufenden, geplanten und transkribierten Besprechungen (Bot: „
                  {instance.assistantName}“).
                </Text>
              </VStack>

              <HStack gap={1.5} vAlign="center" wrap="wrap">
                {onOpenIcsImport && (
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<CalendarPlus className="h-3.5 w-3.5" />}
                    label=".ics / .eml importieren"
                    onClick={onOpenIcsImport}
                  />
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<Plus className="h-3.5 w-3.5" />}
                  label="Erweitert planen…"
                  onClick={onOpenNewRecording}
                />
              </HStack>
            </HStack>

            {/* Inline Quick-Join Bar */}
            {token && (
              <form id="dispatch-form" onSubmit={handleQuickStart}>
                <HStack gap={2} vAlign="center" wrap="wrap">
                  <div className="flex-1 min-w-[260px]" id="meeting-url-wrap">
                    <TextInput
                      type="url"
                      size="sm"
                      label="Meeting-Link"
                      isLabelHidden
                      value={meetingUrl}
                      onChange={setMeetingUrl}
                      placeholder="Meeting-Link einfügen (https://meet.google.com/… oder Teams / Webex)…"
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
                    label="Jetzt aufzeichnen (60 Min.)"
                  />
                </HStack>
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

            <Divider variant="subtle" />

            {/* Filter & Search Toolbar */}
            <HStack justify="between" vAlign="center" wrap="wrap" gap={2}>
              <div id="participation-filter">
                <SegmentedControl
                  size="sm"
                  label="Status-Schnellfilter"
                  value={quickFilter}
                  onChange={(v) => onQuickFilterChange(v as QuickStatusFilter)}
                >
                  <SegmentedControlItem value="all" label="Alle" />
                  <SegmentedControlItem value="active" label="Live & Warteraum" />
                  <SegmentedControlItem value="scheduled" label="Geplant" />
                  <SegmentedControlItem value="completed" label="Fertig" />
                  <SegmentedControlItem value="failed" label="Hinweis" />
                </SegmentedControl>
              </div>

              <HStack gap={2} vAlign="center" wrap="wrap">
                <div id="provider-filter" className="w-48">
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
          </VStack>
        </LayoutHeader>
      }
      content={
        <LayoutContent>
          <VStack gap={3} id="recordings-list">
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
                    : 'Fügen Sie oben einen Google Meet-, Microsoft Teams- oder Webex-Link ein oder verbinden Sie Ihren Kalender.'
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
                      icon={<Plus className="h-3.5 w-3.5" />}
                      label="Meeting aufzeichnen"
                      onClick={onOpenNewRecording}
                    />
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
              />
            )}
          </VStack>
        </LayoutContent>
      }
    />
  );
}
