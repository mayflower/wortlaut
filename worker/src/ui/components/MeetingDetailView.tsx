import React, { useState } from 'react';
import {
  Check,
  Copy,
  Download,
  Edit3,
  FolderOpen,
  Link2,
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
import { Token } from '@astryxdesign/core/Token';
import { Banner } from '@astryxdesign/core/Banner';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import {
  cancelRecording,
  deleteRecording,
  downloadExportFile,
  fetchExportText,
  formatDurationHuman,
  formatRecordingTitle,
  formatWallClockTime,
  getFailureReasons,
  getInstanceInfo,
  issueReaderToken,
  linkRecordingInCalendar,
  rejoinRecording,
  retryMailDelivery,
  updateRecordingProtocol,
} from '../api';
import { useI18n } from '../i18n';
import {
  formatBotDisplayName,
  type AuthMode,
  type RecordingDetail,
  type TranscriptExport,
} from '../types';
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
  const { tr } = useI18n();
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
                isLoading
                  ? tr('Lade Meeting-Details…', 'Loading meeting details…')
                  : tr('Besprechung nicht gefunden', 'Meeting not found')
              }
              description={
                isLoading
                  ? tr(
                      'Abruf der aktuellen Transkript- und Diagnosedaten…',
                      'Fetching transcript and diagnostic data…'
                    )
                  : tr(
                      'Wählen Sie eine Aufzeichnung aus der Übersicht oder starten Sie ein neues Meeting.',
                      'Select a recording from the overview or start a new meeting.'
                    )
              }
              actions={
                isOperator &&
                onBackToOverview && (
                  <Button
                    variant="secondary"
                    size="sm"
                    label={tr('Zurück zu den Aufnahmen', 'Back to recordings')}
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
    if (!navigator.clipboard) return;
    setActionError(null);
    const singleLine = (val?: string | null) =>
      (val || '').replace(/\s+/g, ' ').trim();
    let body: string;
    if (
      token &&
      (recording.processing === 'completed' ||
        recording.processing === 'failed')
    ) {
      try {
        body = await fetchExportText(token, recording.id, 'md');
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
        return;
      }
    } else {
      const mdLines: string[] = [
        `# ${singleLine(formatRecordingTitle(recording))}`,
        '',
      ];
      const sum = transcript.summary;
      const sumText = sum?.summary?.trim() || '';
      const sumTopics = (sum?.topics || []).filter(
        (t) => singleLine(t.title) || singleLine(t.details)
      );
      const sumActions = (sum?.action_items || []).filter((a) =>
        singleLine(a.task)
      );
      if (sumText || sumTopics.length > 0) {
        mdLines.push(`## ${tr('Zusammenfassung', 'Summary')}`, '');
        if (sumText) {
          mdLines.push(sumText, '');
        }
        if (sumTopics.length > 0) {
          mdLines.push(
            `### ${tr('Besprochene Themen & Ergebnisse', 'Key Topics & Decisions')}`,
            ''
          );
          for (const t of sumTopics) {
            const titlePart = singleLine(t.title) || tr('Thema', 'Topic');
            const detailPart = singleLine(t.details);
            mdLines.push(
              detailPart
                ? `- **${titlePart}:** ${detailPart}`
                : `- **${titlePart}**`
            );
          }
          mdLines.push('');
        }
      }
      if (sumText || sumTopics.length > 0 || sumActions.length > 0) {
        mdLines.push(`## ${tr('To-Do-Liste', 'To-Do List')}`, '');
        if (sumActions.length > 0) {
          for (const item of sumActions) {
            const owner = singleLine(item.owner) || tr('Team', 'Team');
            const dueVal = singleLine(item.due);
            const dueSuffix = dueVal
              ? ` _(${tr('Fällig', 'Due')}: ${dueVal})_`
              : '';
            mdLines.push(
              `- [ ] **${owner}:** ${singleLine(item.task)}${dueSuffix}`
            );
          }
        } else {
          mdLines.push(
            tr(
              '_Keine offenen Aufgaben vereinbart._',
              '_No open action items recorded._'
            )
          );
        }
        mdLines.push('');
      }
      mdLines.push(`## ${tr('Transkript', 'Transcript')}`, '');
      const segs = transcript.segments || [];
      if (segs.length === 0) {
        mdLines.push(
          tr(
            '_Noch keine transkribierten Segmente vorhanden._',
            '_No transcribed segments yet._'
          )
        );
      } else {
        for (const s of segs) {
          mdLines.push(
            `**${singleLine(s.speaker_label)}** (\`${formatWallClockTime(s.start, timeOriginUtc)} – ${formatWallClockTime(s.end, timeOriginUtc)}\`): ${singleLine(s.text)}`,
            ''
          );
        }
      }
      body = mdLines.join('\n').trimEnd() + '\n';
    }
    try {
      await navigator.clipboard.writeText(body);
      setCopiedTranscript(true);
      setTimeout(() => setCopiedTranscript(false), 1800);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
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

  const handleLinkInCalendar = async () => {
    if (!token) return;
    setActionError(null);
    setBusyAction('calendar-link');
    try {
      await linkRecordingInCalendar(token, recording.id);
      onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
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
  const botName = formatBotDisplayName(recording, instance.assistantName);
  const live = recording.live_status;

  const operatorMenuItems = [
    ...(isOperator && recording.processing === 'completed'
      ? [
          {
            id: 'calendar-link',
            label: transcript.calendar_link_synced_at
              ? tr(
                  'Kalender-Link im Termin aktualisieren',
                  'Update transcript link in calendar'
                )
              : tr(
                  'Protokoll im Kalendertermin verlinken',
                  'Link transcript in calendar event'
                ),
            icon: <Link2 className="h-3.5 w-3.5" />,
            onClick: handleLinkInCalendar,
          },
        ]
      : []),
    ...(canRejoin
      ? [
          {
            id: 'rejoin',
            label: tr(
              'Bot erneut ins Meeting schicken',
              'Send bot back into meeting'
            ),
            icon: <RotateCcw className="h-3.5 w-3.5" />,
            onClick: handleRejoin,
          },
        ]
      : []),
    ...(canCancel
      ? [
          {
            id: 'cancel',
            label: tr('Aufzeichnung beenden', 'Stop recording'),
            icon: <Square className="h-3.5 w-3.5" />,
            onClick: handleCancel,
          },
        ]
      : []),
    {
      id: 'delete',
      label: tr(
        'Aufnahme & Transkript löschen…',
        'Delete recording & transcript…'
      ),
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
                <Breadcrumbs
                  variant="supporting"
                  label={tr('Pfadnavigation', 'Breadcrumb')}
                >
                  {onNavigateHome && (
                    <BreadcrumbItem onClick={onNavigateHome}>
                      {tr('Startseite', 'Home')}
                    </BreadcrumbItem>
                  )}
                  {onBackToOverview && (
                    <BreadcrumbItem onClick={onBackToOverview}>
                      {tr('Aufnahmen', 'Recordings')}
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
                          label={tr('Sitzungstitel', 'Meeting title')}
                          isLabelHidden
                          size="sm"
                          value={titleDraft}
                          onChange={(val) => setTitleDraft(val)}
                          placeholder={tr('Sitzungstitel', 'Meeting title')}
                        />
                      </div>
                      <Button
                        variant="primary"
                        size="sm"
                        isLoading={busyAction === 'title'}
                        icon={<Check className="h-3.5 w-3.5" />}
                        label={tr('Speichern', 'Save')}
                        onClick={handleSaveTitle}
                      />
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<X className="h-3.5 w-3.5" />}
                        label={tr('Abbrechen', 'Cancel')}
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
                          title={tr(
                            'Sitzungstitel bearbeiten',
                            'Edit meeting title'
                          )}
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
                  {transcript.calendar_link_synced_at && (
                    <Token
                      size="sm"
                      color="green"
                      label={tr(
                        'Im Kalender verlinkt',
                        'Linked in calendar'
                      )}
                    />
                  )}
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
                          ? tr('Markdown kopiert!', 'Markdown copied!')
                          : tr('Markdown kopieren', 'Copy Markdown')
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
                            ? tr('Lese-Link kopiert!', 'Share link copied!')
                            : tr('Lese-Link teilen', 'Share read-only link')
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
                        description: tr(
                          'Mit Zusammenfassung, To-Do-Liste & Transkript',
                          'With summary, to-do list & transcript'
                        ),
                        onClick: () => handleDownload('md'),
                      },
                      {
                        id: 'txt',
                        label: tr('Klartext (.txt)', 'Plain text (.txt)'),
                        description: tr(
                          'Mit Zusammenfassung, To-Do-Liste & Zeitstempeln',
                          'With summary, to-do list & timestamps'
                        ),
                        onClick: () => handleDownload('txt'),
                      },
                      {
                        id: 'vtt',
                        label: tr(
                          'WebVTT Untertitel (.vtt)',
                          'WebVTT captions (.vtt)'
                        ),
                        description: tr(
                          'Für Video-Player & Schnittprogramme',
                          'For video players & editors'
                        ),
                        onClick: () => handleDownload('vtt'),
                      },
                      {
                        id: 'json',
                        label: tr(
                          'Strukturiertes JSON (.json)',
                          'Structured JSON (.json)'
                        ),
                        description: tr(
                          'Alle Segmente, Quellen & Qualitätsdaten',
                          'All segments, tracks & quality metadata'
                        ),
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
                            label={tr('Stopp', 'Stop')}
                            onClick={handleCancel}
                          />
                        </span>
                      )}
                      <span id="delete-rec-btn">
                        <MoreMenu
                          size="sm"
                          variant="secondary"
                          alignment="end"
                          label={tr('Weitere Aktionen', 'More actions')}
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
                  label={`${tr('Transkript', 'Transcript')} (${transcript.segments?.length || 0})`}
                />
                <Tab
                  value="sources"
                  label={`${tr('Sprecher & Spuren', 'Speakers & Tracks')} (${transcript.sources_summary?.length || 0})`}
                />
                <Tab
                  value="diagnostics"
                  label={tr('Technik & Diagnose', 'Diagnostics')}
                />
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
            label={tr('Sitzungs-Inspektor', 'Session inspector')}
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
                      title={tr(
                        `Zuhörer „${botName}“ tritt dem Meeting bei (Dauer ca. 15–30 Sek.)`,
                        `Assistant “${botName}” is joining the meeting (~15–30s)`
                      )}
                      description={tr(
                        'Der Konferenz-Zuhörer verbindet sich stummgeschaltet mit dem Raum. Falls ein Warteraum aktiv ist, lassen Sie ihn dort bitte kurz zu.',
                        'The assistant connects muted to the room. If a waiting room is active, please admit it in the meeting window.'
                      )}
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
                    title={tr(
                      `Warteraum aktiv: Bitte „${botName}“ jetzt im Meeting zulassen`,
                      `Waiting room active: Please admit “${botName}” in the meeting`
                    )}
                    description={tr(
                      `Der Zuhörer wartet im Konferenz-Warteraum auf Einlass durch den Host (max. ${Math.round(instance.limits.lobbyTimeoutSeconds / 60)} Min.).`,
                      `The assistant is waiting in the lobby for host admission (timeout ${Math.round(instance.limits.lobbyTimeoutSeconds / 60)} min).`
                    )}
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
                          {tr(
                            'Live-Aufnahme läuft — Wortprotokoll aktualisiert sich automatisch',
                            'Recording live — transcript updates automatically'
                          )}
                        </Text>
                        <Text type="supporting" color="secondary">
                          {tr(
                            `Erkannte Teilnehmende: ${live.dom_or_signaled_participants ?? 0} · Zugeordnete Sprecher: ${live.bound_named_receivers ?? 0}/${live.total_receivers ?? 0} · Erfasste Sprache: ${formatDurationHuman(live.active_audio_seconds || 0)} (${formatDurationHuman(live.audio_seconds || 0)} gesamt)`,
                            `Participants: ${live.dom_or_signaled_participants ?? 0} · Bound speakers: ${live.bound_named_receivers ?? 0}/${live.total_receivers ?? 0} · Speech: ${formatDurationHuman(live.active_audio_seconds || 0)} (${formatDurationHuman(live.audio_seconds || 0)} total)`
                          )}
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
                  title={tr(
                    `Sitzungshinweis (${reason})`,
                    `Session notice (${reason})`
                  )}
                  description={
                    explanation ||
                    tr(
                      'Die Sitzung wurde vorzeitig oder mit Hinweis beendet.',
                      'The session ended early or with a diagnostic notice.'
                    )
                  }
                  endContent={
                    canRejoin ? (
                      <Button
                        variant="primary"
                        size="sm"
                        isLoading={busyAction === 'rejoin'}
                        icon={<RotateCcw className="h-3.5 w-3.5" />}
                        label={tr(
                          'Jetzt erneut beitreten',
                          'Rejoin meeting now'
                        )}
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
        title={tr(
          'Aufnahme & Transkript unwiderruflich löschen?',
          'Permanently delete recording & transcript?'
        )}
        description={tr(
          `Möchten Sie die Aufzeichnung „${formatRecordingTitle(recording)}“ inklusive aller gespeicherten Audiodaten und Transkriptsegmente wirklich dauerhaft löschen?`,
          `Are you sure you want to permanently delete “${formatRecordingTitle(recording)}” including all stored audio tracks and transcript segments?`
        )}
        actionLabel={tr('Dauerhaft löschen', 'Delete permanently')}
        cancelLabel={tr('Abbrechen', 'Cancel')}
        actionVariant="destructive"
        isActionLoading={busyAction === 'delete'}
        onAction={handleDeleteConfirmed}
      />
    </>
  );
}
