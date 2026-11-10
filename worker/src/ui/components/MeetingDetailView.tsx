import React, { useState } from 'react';
import {
  Check,
  Copy,
  Download,
  Edit3,
  FolderOpen,
  RotateCcw,
  Share2,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import {
  Layout,
  LayoutContent,
  LayoutHeader,
  LayoutPanel,
} from '@astryxdesign/core/Layout';
import { Breadcrumbs, BreadcrumbItem } from '@astryxdesign/core/Breadcrumbs';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { HStack } from '@astryxdesign/core/HStack';
import { VStack } from '@astryxdesign/core/VStack';
import { Button } from '@astryxdesign/core/Button';
import { TextInput } from '@astryxdesign/core/TextInput';
import { DropdownMenu } from '@astryxdesign/core/DropdownMenu';
import { MoreMenu } from '@astryxdesign/core/MoreMenu';
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { TabList, Tab } from '@astryxdesign/core/TabList';
import { Banner } from '@astryxdesign/core/Banner';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import {
  cancelRecording,
  deleteRecording,
  downloadExportFile,
  formatDurationHuman,
  formatRecordingTitle,
  formatWallClockTime,
  getFailureReasons,
  getInstanceInfo,
  issueReaderToken,
  rejoinRecording,
  retryMailDelivery,
  updateRecordingProtocol,
} from '../api';
import type { AuthMode, RecordingDetail, TranscriptExport } from '../types';
import { DiagnosticsTab } from './DiagnosticsTab';
import { ParticipationStepper } from './ParticipationStepper';
import { SourcesTab } from './SourcesTab';
import { TranscriptTab } from './TranscriptTab';
import { LiveWaveform, ProviderBadge, StatusBadge } from './ui/primitives';

export interface MeetingDetailViewProps {
  authMode: AuthMode;
  recording: RecordingDetail | null;
  transcript: TranscriptExport | null;
  isLoading: boolean;
  onRefresh: () => void;
  onDeleted: () => void;
  onBackToOverview?: () => void;
  onNavigateHome?: () => void;
}

export function MeetingDetailView({
  authMode,
  recording,
  transcript,
  isLoading,
  onRefresh,
  onDeleted,
  onBackToOverview,
  onNavigateHome,
}: MeetingDetailViewProps) {
  const [activeTab, setActiveTab] = useState<
    'transcript' | 'sources' | 'diagnostics'
  >('transcript');
  const [selectedSourceFilter, setSelectedSourceFilter] = useState('');
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copiedTranscript, setCopiedTranscript] = useState(false);
  const [copiedShareLink, setCopiedShareLink] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');

  const isOperator = authMode.kind === 'operator';
  const token = authMode.kind === 'unauthenticated' ? '' : authMode.token;
  const instance = getInstanceInfo();
  const failureReasons = getFailureReasons();

  if (!recording || !transcript) {
    return (
      <Layout
        height="fill"
        content={
          <LayoutContent>
            <EmptyState
              icon={<FolderOpen className="h-8 w-8" />}
              title={
                isLoading ? 'Lade Meeting-Details…' : 'Besprechung nicht gefunden'
              }
              description={
                isLoading
                  ? 'Abruf der aktuellen Transkript- und Diagnosedaten…'
                  : 'Wählen Sie eine Aufzeichnung aus der Übersicht oder starten Sie ein neues Meeting.'
              }
              actions={
                isOperator &&
                onBackToOverview && (
                  <Button
                    variant="secondary"
                    size="sm"
                    label="Zurück zu den Aufnahmen"
                    onClick={onBackToOverview}
                  />
                )
              }
            />
          </LayoutContent>
        }
      />
    );
  }

  const canCancel =
    isOperator &&
    recording.participation !== 'ended' &&
    !recording.cancelled_at;
  const canRejoin = isOperator && recording.participation === 'ended';

  const timeOriginUtc =
    transcript.time_origin_utc || transcript.scheduled_period?.start;

  const handleCopyTranscript = async () => {
    const segs = transcript.segments || [];
    const lines = segs.map(
      (s) =>
        `[${formatWallClockTime(s.start, timeOriginUtc)} - ${formatWallClockTime(s.end, timeOriginUtc)}] ${s.speaker_label}: ${s.text}`
    );
    const headerParts: string[] = [];
    if (transcript.summary?.summary) {
      headerParts.push(`Kurzfassung:\n${transcript.summary.summary}`);
      if (transcript.summary.action_items?.length) {
        headerParts.push(
          `Aufgaben & Beschlüsse:\n${transcript.summary.action_items
            .map(
              (item) =>
                `- [${item.owner || 'Alle'}] ${item.task}${item.due ? ` (${item.due})` : ''}`
            )
            .join('\n')}`
        );
      }
      headerParts.push('---');
    }
    const body =
      lines.length > 0
        ? [...headerParts, ...lines].join('\n\n')
        : 'Noch keine transkribierten Segmente vorhanden.';
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(body).catch(() => {});
      setCopiedTranscript(true);
      setTimeout(() => setCopiedTranscript(false), 1800);
    }
  };

  const handleSaveTitle = async () => {
    if (!token || !titleDraft.trim()) return;
    setActionError(null);
    setBusyAction('title');
    try {
      await updateRecordingProtocol(token, recording.id, {
        title: titleDraft.trim(),
      });
      setIsEditingTitle(false);
      onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  const handleShareReaderLink = async () => {
    if (!token) return;
    setActionError(null);
    setBusyAction('share');
    try {
      const res = await issueReaderToken(token, recording.id);
      const shareUrl = `${window.location.origin}/ui#token=${encodeURIComponent(res.ui_token)}`;
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(shareUrl);
      }
      setCopiedShareLink(true);
      setTimeout(() => setCopiedShareLink(false), 2500);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  const handleRejoin = async () => {
    if (!token) return;
    setActionError(null);
    setBusyAction('rejoin');
    try {
      await rejoinRecording(token, recording.id);
      onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  const handleCancel = async () => {
    if (!token) return;
    setActionError(null);
    setBusyAction('cancel');
    try {
      await cancelRecording(token, recording.id);
      onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  const handleDeleteConfirmed = async () => {
    if (!token) return;
    setActionError(null);
    setBusyAction('delete');
    try {
      await deleteRecording(token, recording.id);
      setConfirmDeleteOpen(false);
      onDeleted();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  const handleRetryMail = async () => {
    if (!token) return;
    setActionError(null);
    setBusyAction('retry-mail');
    try {
      await retryMailDelivery(token, recording.id);
      onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  const handleDownload = async (format: 'txt' | 'vtt' | 'json' | 'md') => {
    if (!token) return;
    setActionError(null);
    try {
      await downloadExportFile(token, recording.id, format);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const lastAttempt =
    recording.attempts && recording.attempts.length > 0
      ? recording.attempts[recording.attempts.length - 1]
      : null;
  const reason =
    recording.participation_reason || lastAttempt?.end_reason || '';
  const sampleSec = Math.round(
    (recording.ingest?.durable_sample_count || 0) / 16000
  );
  const isNormalEnd =
    !reason ||
    reason === 'normal' ||
    reason === 'room_empty' ||
    reason === 'source_binding_unverified' ||
    ((reason === 'cancelled' || reason === 'deadline') && sampleSec > 0);
  const hasError =
    recording.processing === 'failed' ||
    ((recording.participation === 'ended' ||
      recording.participation === 'unknown') &&
      !isNormalEnd);
  const explanation = reason ? failureReasons[reason] || '' : '';
  const botName = recording.guest_name || instance.assistantName;
  const live = recording.live_status;

  const operatorMenuItems = [
    ...(canRejoin
      ? [
          {
            id: 'rejoin',
            label: 'Bot erneut ins Meeting schicken',
            icon: <RotateCcw className="h-3.5 w-3.5" />,
            onClick: handleRejoin,
          },
        ]
      : []),
    ...(canCancel
      ? [
          {
            id: 'cancel',
            label: 'Aufzeichnung beenden',
            icon: <Square className="h-3.5 w-3.5" />,
            onClick: handleCancel,
          },
        ]
      : []),
    {
      id: 'delete',
      label: 'Aufnahme & Transkript löschen…',
      variant: 'destructive' as const,
      icon: <Trash2 className="h-3.5 w-3.5" />,
      onClick: () => setConfirmDeleteOpen(true),
    },
  ];

  return (
    <>
      <Layout
        height="fill"
        header={
          <LayoutHeader hasDivider paddingBlockEnd={0}>
            <div className="wl-page-container">
            <VStack gap={2}>
              {isOperator && (onBackToOverview || onNavigateHome) && (
                <Breadcrumbs variant="supporting" label="Pfadnavigation">
                  {onNavigateHome && (
                    <BreadcrumbItem onClick={onNavigateHome}>
                      Startseite
                    </BreadcrumbItem>
                  )}
                  {onBackToOverview && (
                    <BreadcrumbItem onClick={onBackToOverview}>
                      Aufnahmen
                    </BreadcrumbItem>
                  )}
                  <BreadcrumbItem isCurrent>
                    {formatRecordingTitle(recording)}
                  </BreadcrumbItem>
                </Breadcrumbs>
              )}

              <HStack justify="between" vAlign="center" wrap="wrap" gap={3}>
                <HStack gap={2} vAlign="center" wrap="wrap">
                  {isEditingTitle ? (
                    <HStack gap={1.5} vAlign="center">
                      <div className="w-64">
                        <TextInput
                          label="Sitzungstitel"
                          isLabelHidden
                          size="sm"
                          value={titleDraft}
                          onChange={(val) => setTitleDraft(val)}
                          placeholder="Sitzungstitel"
                        />
                      </div>
                      <Button
                        variant="primary"
                        size="sm"
                        isLoading={busyAction === 'title'}
                        icon={<Check className="h-3.5 w-3.5" />}
                        label="Speichern"
                        onClick={handleSaveTitle}
                      />
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<X className="h-3.5 w-3.5" />}
                        label="Abbrechen"
                        onClick={() => setIsEditingTitle(false)}
                      />
                    </HStack>
                  ) : (
                    <>
                      <Heading level={1}>
                        {formatRecordingTitle(recording)}
                      </Heading>
                      {isOperator && (
                        <button
                          type="button"
                          onClick={() => {
                            setTitleDraft(formatRecordingTitle(recording));
                            setIsEditingTitle(true);
                          }}
                          className="rounded p-1 text-slate-400 hover:bg-slate-800/60 hover:text-slate-200 transition-colors"
                          title="Sitzungstitel bearbeiten"
                        >
                          <Edit3 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </>
                  )}
                  <ProviderBadge provider={recording.provider} />
                  <StatusBadge
                    participation={recording.participation}
                    processing={recording.processing}
                    hasError={hasError}
                  />
                </HStack>

                <HStack gap={1.5} vAlign="center" wrap="wrap">
                  <span id="copy-transcript-btn">
                    <Button
                      variant="primary"
                      size="sm"
                      icon={
                        copiedTranscript ? (
                          <Check className="h-3.5 w-3.5" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )
                      }
                      label={
                        copiedTranscript
                          ? 'Transkript kopiert!'
                          : 'Transkript kopieren'
                      }
                      onClick={handleCopyTranscript}
                    />
                  </span>

                  {isOperator && (
                    <span id="share-reader-link-btn">
                      <Button
                        variant="secondary"
                        size="sm"
                        isLoading={busyAction === 'share'}
                        icon={
                          copiedShareLink ? (
                            <Check className="h-3.5 w-3.5" />
                          ) : (
                            <Share2 className="h-3.5 w-3.5" />
                          )
                        }
                        label={
                          copiedShareLink
                            ? 'Lese-Link kopiert!'
                            : 'Lese-Link teilen'
                        }
                        onClick={handleShareReaderLink}
                      />
                    </span>
                  )}

                  <DropdownMenu
                    button={{
                      label: 'Export',
                      variant: 'secondary',
                      size: 'sm',
                      icon: <Download className="h-3.5 w-3.5" />,
                    }}
                    items={[
                      {
                        id: 'md',
                        label: 'Markdown (.md)',
                        description: 'Für Notion, Confluence, GitHub',
                        onClick: () => handleDownload('md'),
                      },
                      {
                        id: 'txt',
                        label: 'Klartext (.txt)',
                        description: 'Lesbares Protokoll mit Zeitstempeln',
                        onClick: () => handleDownload('txt'),
                      },
                      {
                        id: 'vtt',
                        label: 'WebVTT Untertitel (.vtt)',
                        description: 'Für Video-Player & Schnittprogramme',
                        onClick: () => handleDownload('vtt'),
                      },
                      {
                        id: 'json',
                        label: 'Strukturiertes JSON (.json)',
                        description: 'Alle Segmente, Quellen & Qualitätsdaten',
                        onClick: () => handleDownload('json'),
                      },
                    ]}
                  />

                  {isOperator && (
                    <>
                      {canCancel && (
                        <span id="cancel-rec-btn">
                          <Button
                            variant="destructive"
                            size="sm"
                            isLoading={busyAction === 'cancel'}
                            icon={<Square className="h-3.5 w-3.5" />}
                            label="Stopp"
                            onClick={handleCancel}
                          />
                        </span>
                      )}
                      <span id="delete-rec-btn">
                        <MoreMenu
                          size="sm"
                          variant="secondary"
                          alignment="end"
                          label="Weitere Aktionen"
                          items={operatorMenuItems}
                        />
                      </span>
                    </>
                  )}
                </HStack>
              </HStack>

              <TabList
                size="md"
                hasDivider
                isFullBleed
                value={activeTab}
                onChange={(v) =>
                  setActiveTab(v as 'transcript' | 'sources' | 'diagnostics')
                }
              >
                <Tab
                  value="transcript"
                  label={`Transkript (${transcript.segments?.length || 0})`}
                />
                <Tab
                  value="sources"
                  label={`Sprecher & Spuren (${transcript.sources_summary?.length || 0})`}
                />
                <Tab value="diagnostics" label="Technik & Diagnose" />
              </TabList>
            </VStack>
            </div>
          </LayoutHeader>
        }
        end={
          <LayoutPanel
            width={340}
            hasDivider
            isScrollable
            role="complementary"
            label="Sitzungs-Inspektor"
          >
            <ParticipationStepper
              recording={recording}
              transcript={transcript}
              isOperator={isOperator}
              onRejoin={handleRejoin}
              rejoining={busyAction === 'rejoin'}
              selectedSourceFilter={selectedSourceFilter}
              onSelectSourceFilter={(srcId) => {
                setSelectedSourceFilter(srcId);
                setActiveTab('transcript');
              }}
            />
          </LayoutPanel>
        }
        content={
          <LayoutContent>
            <div className="wl-page-container">
            <VStack gap={3}>
              {actionError && (
                <Banner
                  status="error"
                  container="card"
                  title={actionError}
                  isDismissable
                  onDismiss={() => setActionError(null)}
                />
              )}

              {(recording.participation === 'starting' ||
                recording.participation === 'preparing' ||
                recording.participation === 'joining') && (
                <div className="wl-joining-card p-3.5 wl-fade-in">
                  <VStack gap={2}>
                    <Banner
                      status="info"
                      container="card"
                      title={`Zuhörer „${botName}“ tritt dem Meeting bei (Dauer ca. 15–30 Sek.)`}
                      description="Der Konferenz-Zuhörer verbindet sich stummgeschaltet mit dem Raum. Falls ein Warteraum aktiv ist, lassen Sie ihn dort bitte kurz zu."
                    />
                    <div className="wl-shimmer-bar" />
                  </VStack>
                </div>
              )}

              {recording.participation === 'waiting_admission' && (
                <div className="wl-lobby-card p-3.5 wl-fade-in">
                  <Banner
                    status="warning"
                    container="card"
                    title={`Warteraum aktiv: Bitte „${botName}“ jetzt im Meeting zulassen`}
                    description={`Der Zuhörer wartet im Konferenz-Warteraum auf Einlass durch den Host (max. ${Math.round(instance.limits.lobbyTimeoutSeconds / 60)} Min.).`}
                  />
                </div>
              )}

              {live?.is_active && recording.participation === 'capturing' && (
                <div id="live-status-banner" className="wl-live-card p-3.5 wl-fade-in">
                  <HStack justify="between" vAlign="center" wrap="wrap" gap={3}>
                    <HStack gap={2} vAlign="center" wrap="wrap">
                      <LiveWaveform />
                      <VStack gap={0.5}>
                        <Text type="body" weight="bold">
                          Live-Aufnahme läuft — Wortprotokoll aktualisiert sich automatisch
                        </Text>
                        <Text type="supporting" color="secondary">
                          Erkannte Teilnehmende: {live.dom_or_signaled_participants ?? 0} · Zugeordnete Sprecher: {live.bound_named_receivers ?? 0}/{live.total_receivers ?? 0} · Erfasste Sprache: {formatDurationHuman(live.active_audio_seconds || 0)} ({formatDurationHuman(live.audio_seconds || 0)} gesamt)
                        </Text>
                      </VStack>
                    </HStack>
                  </HStack>
                </div>
              )}

              {(recording.participation === 'ended' ||
                recording.participation === 'unknown') &&
                !isNormalEnd &&
                (explanation || reason) && (
                <Banner
                  status="error"
                  container="card"
                  title={`Sitzungshinweis (${reason})`}
                  description={
                    explanation ||
                    'Die Sitzung wurde vorzeitig oder mit Hinweis beendet.'
                  }
                  endContent={
                    canRejoin ? (
                      <Button
                        variant="primary"
                        size="sm"
                        isLoading={busyAction === 'rejoin'}
                        icon={<RotateCcw className="h-3.5 w-3.5" />}
                        label="Jetzt erneut beitreten"
                        onClick={handleRejoin}
                      />
                    ) : undefined
                  }
                />
              )}

              {activeTab === 'transcript' && (
                <TranscriptTab
                  recordingId={recording.id}
                  token={token}
                  isOperator={isOperator}
                  participation={recording.participation}
                  processing={recording.processing}
                  timeOriginUtc={timeOriginUtc}
                  audioAvailable={Boolean(transcript.audio_available)}
                  summary={transcript.summary}
                  termReplacements={transcript.term_replacements}
                  segments={transcript.segments || []}
                  sources={transcript.sources_summary || []}
                  selectedSourceFilter={selectedSourceFilter}
                  onSelectedSourceFilterChange={setSelectedSourceFilter}
                  onProtocolUpdated={onRefresh}
                />
              )}

              {activeTab === 'sources' && (
                <SourcesTab
                  sources={transcript.sources_summary || []}
                  selectedSourceFilter={selectedSourceFilter}
                  onSelectSourceForTranscript={(sourceId) => {
                    setSelectedSourceFilter(
                      selectedSourceFilter === sourceId ? '' : sourceId
                    );
                    setActiveTab('transcript');
                  }}
                />
              )}

              {activeTab === 'diagnostics' && (
                <DiagnosticsTab
                  recording={recording}
                  transcript={transcript}
                  isOperator={isOperator}
                  onRetryMail={handleRetryMail}
                  retryingMail={busyAction === 'retry-mail'}
                />
              )}
            </VStack>
            </div>
          </LayoutContent>
        }
      />

      <AlertDialog
        isOpen={confirmDeleteOpen}
        onOpenChange={setConfirmDeleteOpen}
        title="Aufnahme & Transkript unwiderruflich löschen?"
        description={`Möchten Sie die Aufzeichnung „${formatRecordingTitle(recording)}“ inklusive aller gespeicherten Audiodaten und Transkriptsegmente wirklich dauerhaft löschen?`}
        actionLabel="Dauerhaft löschen"
        cancelLabel="Abbrechen"
        actionVariant="destructive"
        isActionLoading={busyAction === 'delete'}
        onAction={handleDeleteConfirmed}
      />
    </>
  );
}
