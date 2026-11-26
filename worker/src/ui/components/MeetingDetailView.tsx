import React, { useRef, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  Edit3,
  FolderOpen,
  Globe,
  Link2,
  Pause,
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
} from '@astryxdesign/core/Layout';
import { Breadcrumbs, BreadcrumbItem } from '@astryxdesign/core/Breadcrumbs';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { HStack } from '@astryxdesign/core/HStack';
import { VStack } from '@astryxdesign/core/VStack';
import { Button } from '@astryxdesign/core/Button';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Selector } from '@astryxdesign/core/Selector';
import { DropdownMenu } from '@astryxdesign/core/DropdownMenu';
import { MoreMenu } from '@astryxdesign/core/MoreMenu';
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { TabList, Tab } from '@astryxdesign/core/TabList';
import { Token } from '@astryxdesign/core/Token';
import { Banner } from '@astryxdesign/core/Banner';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import {
  ApiError,
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
  startCalendarOAuthConnect,
  updateRecordingProtocol,
} from '../api';
import {
  buildAsrLanguageOptions,
  formatAsrLanguageLabel,
  useI18n,
} from '../i18n';
import {
  formatBotDisplayName,
  type AuthMode,
  type CalendarConnectionInfo,
  type RecordingDetail,
  type TranscriptExport,
} from '../types';
import { DiagnosticsTab } from './DiagnosticsTab';
import { SourcesTab } from './SourcesTab';
import { TranscriptTab } from './TranscriptTab';
import { LiveWaveform, ProviderBadge, StatusBadge } from './ui/primitives';

export interface MeetingDetailViewProps {
  authMode: AuthMode;
  recording: RecordingDetail | null;
  transcript: TranscriptExport | null;
  calendarConnections?: CalendarConnectionInfo[];
  focusKeyframeId?: string | null;
  focusTimestampSeconds?: number | null;
  isLoading: boolean;
  loadError?: unknown;
  onRefresh: () => void;
  onDeleted: () => void;
  onBackToOverview?: () => void;
  onOpenCalendar?: () => void;
  onOpenGlossary?: () => void;
  onGlossaryUpdated?: () => void;
}

export function MeetingDetailView({
  authMode,
  recording,
  transcript,
  calendarConnections = [],
  focusKeyframeId,
  focusTimestampSeconds,
  isLoading,
  loadError,
  onRefresh,
  onDeleted,
  onBackToOverview,
  onOpenCalendar,
  onOpenGlossary,
  onGlossaryUpdated,
}: MeetingDetailViewProps) {
  const { lang, localeTag, tr } = useI18n();
  const [activeTab, setActiveTab] = useState<
    'transcript' | 'sources' | 'diagnostics'
  >('transcript');
  const [selectedSourceFilter, setSelectedSourceFilter] = useState('');
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const busyActionRef = useRef(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dismissedCalendarScopeNotice, setDismissedCalendarScopeNotice] =
    useState(false);
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
    const isNotFound = loadError instanceof ApiError && loadError.status === 404;
    const errText =
      loadError instanceof Error
        ? loadError.message
        : loadError
          ? String(loadError)
          : null;
    return (
      <Layout
        height="fill"
        content={
          <LayoutContent>
            <EmptyState
              headingLevel={1}
              icon={
                isLoading ? (
                  <LiveWaveform />
                ) : (
                  <FolderOpen className="h-8 w-8" />
                )
              }
              title={
                isLoading
                  ? tr('Lade Protokoll…', 'Loading protocol…')
                  : isNotFound || !loadError
                    ? tr('Besprechung nicht gefunden', 'Meeting not found')
                    : tr(
                        'Protokoll konnte nicht geladen werden',
                        'Failed to load protocol'
                      )
              }
              description={
                isLoading
                  ? tr(
                      'Abruf der aktuellen Transkriptdaten…',
                      'Fetching transcript data…'
                    )
                  : !isNotFound && errText
                    ? errText
                    : tr(
                        'Das Protokoll ist nicht verfügbar oder Ihre Berechtigung ist abgelaufen.',
                        'This protocol is unavailable or your access has expired.'
                      )
              }
              actions={
                !isLoading ? (
                  <HStack gap={2} wrap="wrap" justify="center">
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<RotateCcw className="h-3.5 w-3.5" />}
                      label={tr('Erneut laden', 'Retry')}
                      onClick={onRefresh}
                    />
                    {isOperator && onBackToOverview && (
                      <Button
                        variant="ghost"
                        size="sm"
                        label={tr(
                          'Zurück zu den Aufnahmen',
                          'Back to recordings'
                        )}
                        onClick={onBackToOverview}
                      />
                    )}
                  </HStack>
                ) : undefined
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
      const protocolViewUrl = `${window.location.origin}/ui#view=meetings&id=${encodeURIComponent(recording.id)}`;
      const formatMdCitation = (item: {
        timestamp?: string;
        offset_seconds?: number;
      }): string => {
        const tsVal = singleLine(item.timestamp);
        if (!tsVal) return '';
        if (
          typeof item.offset_seconds === 'number' &&
          Number.isFinite(item.offset_seconds)
        ) {
          return ` · [\`${tsVal}\`](${protocolViewUrl}&t=${Math.max(0, Math.round(item.offset_seconds))})`;
        }
        return ` · \`${tsVal}\``;
      };
      const sum = transcript.summary;
      const sumText = sum?.summary?.trim() || '';
      const sumDecisions = (sum?.decisions || []).filter((d) =>
        singleLine(d.text)
      );
      const sumTopics = (sum?.topics || []).filter(
        (t) => singleLine(t.title) || singleLine(t.details)
      );
      const sumActions = (sum?.action_items || []).filter((a) =>
        singleLine(a.task)
      );
      if (sumText || sumDecisions.length > 0 || sumTopics.length > 0) {
        mdLines.push(`## ${tr('Zusammenfassung', 'Summary')}`, '');
        if (sumText) {
          mdLines.push(sumText, '');
        }
        if (sumDecisions.length > 0) {
          mdLines.push(`### ${tr('Entscheidungen', 'Decisions')}`, '');
          for (const d of sumDecisions) {
            mdLines.push(`- ${singleLine(d.text)}${formatMdCitation(d)}`);
          }
          mdLines.push('');
        }
        if (sumTopics.length > 0) {
          mdLines.push(
            `### ${tr('Besprochene Themen & Ergebnisse', 'Key Topics & Outcomes')}`,
            ''
          );
          for (const t of sumTopics) {
            const titlePart = singleLine(t.title) || tr('Thema', 'Topic');
            const detailPart = singleLine(t.details);
            const citeSuffix = formatMdCitation(t);
            mdLines.push(
              detailPart
                ? `- **${titlePart}:** ${detailPart}${citeSuffix}`
                : `- **${titlePart}**${citeSuffix}`
            );
          }
          mdLines.push('');
        }
      }
      if (sumActions.length > 0) {
        mdLines.push(`## ${tr('To-Do-Liste', 'To-Do List')}`, '');
        for (const item of sumActions) {
          const owner = singleLine(item.owner) || tr('Team', 'Team');
          const dueVal = singleLine(item.due);
          const dueSuffix = dueVal ? ` _(${tr('Fällig', 'Due')}: ${dueVal})_` : '';
          mdLines.push(
            `- [ ] **${owner}:** ${singleLine(item.task)}${dueSuffix}${formatMdCitation(item)}`
          );
        }
        mdLines.push('');
      }
      const notesVal = (transcript.notes || '').trim();
      if (notesVal) {
        mdLines.push(`## ${tr('Notizen', 'Notes')}`, '', notesVal, '');
      }
      mdLines.push(`## ${tr('Transkript', 'Transcript')}`, '');
      const segs = transcript.segments || [];
      const kfs = transcript.keyframes || [];
      const pauses = transcript.pause_windows || [];
      const optOuts = transcript.opted_out_windows || [];
      if (
        segs.length === 0 &&
        kfs.length === 0 &&
        pauses.length === 0 &&
        optOuts.length === 0
      ) {
        mdLines.push(
          tr(
            '_Noch keine transkribierten Segmente vorhanden._',
            '_No transcribed segments yet._'
          )
        );
      } else {
        const timeline = [
          ...pauses.map((pw) => {
            const startLbl = formatWallClockTime(
              pw.offset_seconds,
              timeOriginUtc
            );
            const endLbl =
              pw.end_offset_seconds != null
                ? formatWallClockTime(pw.end_offset_seconds, timeOriginUtc)
                : tr('laufend', 'ongoing');
            const bySuffix = singleLine(pw.by) ? ` (${singleLine(pw.by)})` : '';
            return {
              offset: pw.offset_seconds,
              rank: 0,
              line: `> **[${startLbl} – ${endLbl}] ${tr('Off-the-Record-Pause', 'Off-the-Record Pause')}${bySuffix}:** ${tr('Aufnahme im Chat pausiert.', 'Recording paused via chat.')}`,
            };
          }),
          ...optOuts.map((ow) => {
            const startLbl = formatWallClockTime(
              ow.offset_seconds,
              timeOriginUtc
            );
            const endLbl =
              ow.end_offset_seconds != null
                ? formatWallClockTime(ow.end_offset_seconds, timeOriginUtc)
                : tr('laufend', 'ongoing');
            return {
              offset: ow.offset_seconds,
              rank: 1,
              line: `> **[${startLbl} – ${endLbl}] (OPTED OUT COMMENT):** ${tr('Beitrag aufgrund von Opt-out nicht aufgezeichnet.', 'Contribution omitted due to opt-out.')}`,
            };
          }),
          ...kfs.map((kf, idx) => {
            const kfTarget = kf.id
              ? `${protocolViewUrl}&keyframe=${encodeURIComponent(kf.id)}`
              : protocolViewUrl;
            const slideSuffix =
              kfs.length > 1
                ? ` _(${tr('Folie', 'Slide')} ${idx + 1}/${kfs.length})_`
                : '';
            return {
              offset: kf.offset_seconds,
              rank: 1,
              line: `> **[${formatWallClockTime(kf.offset_seconds, timeOriginUtc)}] ${tr('Bildschirmfreigabe', 'Screen share')} (${singleLine(kf.presenter)}):** [${protocolViewUrl}](${kfTarget})${slideSuffix}`,
            };
          }),
          ...segs.map((s) => ({
            offset: s.start,
            rank: 2,
            line: `**${singleLine(s.speaker_label)}** (\`${formatWallClockTime(s.start, timeOriginUtc)} – ${formatWallClockTime(s.end, timeOriginUtc)}\`): ${singleLine(s.text)}`,
          })),
        ].sort((a, b) => a.offset - b.offset || a.rank - b.rank);
        for (const item of timeline) {
          mdLines.push(item.line, '');
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

  const runExclusiveAction = async (
    actionKey: string,
    fn: () => Promise<void>
  ) => {
    if (!token || busyActionRef.current) return;
    busyActionRef.current = true;
    setActionError(null);
    setBusyAction(actionKey);
    try {
      await fn();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      busyActionRef.current = false;
      setBusyAction(null);
    }
  };

  const handleSwitchAsrLanguage = async (nextLang: string) => {
    if (!nextLang) return;
    await runExclusiveAction('language', async () => {
      await updateRecordingProtocol(token, recording.id, {
        language: nextLang,
      });
      onRefresh();
    });
  };

  const handleSaveTitle = async () => {
    if (!titleDraft.trim()) return;
    await runExclusiveAction('title', async () => {
      await updateRecordingProtocol(token, recording.id, {
        title: titleDraft.trim().slice(0, 240),
      });
      setIsEditingTitle(false);
      onRefresh();
    });
  };

  const handleShareReaderLink = async () => {
    await runExclusiveAction('share', async () => {
      const res = await issueReaderToken(token, recording.id);
      const shareUrl = `${window.location.origin}/ui#token=${encodeURIComponent(res.ui_token)}`;
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(shareUrl);
      }
      setCopiedShareLink(true);
      setTimeout(() => setCopiedShareLink(false), 2500);
    });
  };

  const handleRejoin = async () => {
    await runExclusiveAction('rejoin', async () => {
      await rejoinRecording(token, recording.id);
      onRefresh();
    });
  };

  const handleCancel = async () => {
    await runExclusiveAction('cancel', async () => {
      await cancelRecording(token, recording.id);
      onRefresh();
    });
  };

  const handleDeleteConfirmed = async () => {
    await runExclusiveAction('delete', async () => {
      await deleteRecording(token, recording.id);
      setConfirmDeleteOpen(false);
      onDeleted();
    });
  };

  const handleRetryMail = async () => {
    await runExclusiveAction('retry-mail', async () => {
      await retryMailDelivery(token, recording.id);
      onRefresh();
    });
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
    await runExclusiveAction('calendar-link', async () => {
      await linkRecordingInCalendar(token, recording.id);
      onRefresh();
    });
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
  const timelineDurationSec = (() => {
    const ingestDur = recording.ingest?.duration_seconds;
    if (typeof ingestDur === 'number' && Number.isFinite(ingestDur) && ingestDur > 0) {
      return Math.round(ingestDur);
    }
    if (transcript.time_origin_utc && transcript.last_known_audio_utc) {
      const span = Math.round(
        (Date.parse(transcript.last_known_audio_utc) -
          Date.parse(transcript.time_origin_utc)) /
          1000
      );
      if (Number.isFinite(span) && span > 0) return span;
    }
    return sampleSec;
  })();
  const isNormalEnd =
    !reason ||
    reason === 'normal' ||
    reason === 'room_empty' ||
    reason === 'source_binding_unverified' ||
    ((reason === 'cancelled' || reason === 'deadline') &&
      (sampleSec > 0 || timelineDurationSec > 0));
  const hasError =
    recording.processing === 'failed' ||
    ((recording.participation === 'ended' ||
      recording.participation === 'unknown') &&
      !isNormalEnd);
  const explanation = reason ? failureReasons[reason] || '' : '';
  const botName = formatBotDisplayName(recording, instance.assistantName);
  const live = recording.live_status;

  const startFormatted = new Date(recording.starts_at).toLocaleString(
    localeTag,
    {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }
  );

  const operatorMenuItems = [
    ...(isOperator && recording.processing === 'completed'
      ? [
          {
            id: 'calendar-link',
            label: transcript.calendar_link_synced_at
              ? tr(
                  'Kalender-Link aktualisieren',
                  'Update calendar link'
                )
              : tr(
                  'Im Kalendertermin verlinken',
                  'Link in calendar event'
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
      label: tr('Aufnahme löschen…', 'Delete recording…'),
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
                {isOperator && onBackToOverview && (
                  <Breadcrumbs
                    variant="supporting"
                    label={tr('Pfadnavigation', 'Breadcrumb')}
                  >
                    <BreadcrumbItem onClick={onBackToOverview}>
                      {tr('Aufnahmen', 'Recordings')}
                    </BreadcrumbItem>
                    <BreadcrumbItem isCurrent>
                      {formatRecordingTitle(recording)}
                    </BreadcrumbItem>
                  </Breadcrumbs>
                )}

                <HStack justify="between" vAlign="start" wrap="wrap" gap={3}>
                  <VStack gap={1.5} className="min-w-0">
                    {isEditingTitle ? (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          handleSaveTitle();
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') {
                            setIsEditingTitle(false);
                          }
                        }}
                      >
                        <HStack gap={1.5} vAlign="center" wrap="wrap">
                          <div className="w-64 max-w-full">
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
                            type="submit"
                            variant="primary"
                            size="sm"
                            isLoading={busyAction === 'title'}
                            icon={<Check className="h-3.5 w-3.5" />}
                            label={tr('Speichern', 'Save')}
                          />
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            icon={<X className="h-3.5 w-3.5" />}
                            label={tr('Abbrechen', 'Cancel')}
                            onClick={() => setIsEditingTitle(false)}
                          />
                        </HStack>
                      </form>
                    ) : (
                      <div
                        className="flex items-start gap-2 min-w-0 max-w-full"
                        dir="auto"
                      >
                        <div className="min-w-0 flex-1 wl-break-anywhere">
                          <Heading level={1}>
                            {formatRecordingTitle(recording)}
                          </Heading>
                        </div>
                        {isOperator && (
                          <button
                            type="button"
                            onClick={() => {
                              setTitleDraft(formatRecordingTitle(recording));
                              setIsEditingTitle(true);
                            }}
                            className="shrink-0 rounded p-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-background-muted)] hover:text-[var(--color-text-primary)] transition-colors cursor-pointer"
                            aria-label={tr('Titel bearbeiten', 'Edit title')}
                            title={tr(
                              'Titel bearbeiten',
                              'Edit title'
                            )}
                          >
                            <Edit3 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    )}
                    <HStack gap={2} vAlign="center" wrap="wrap">
                      <ProviderBadge provider={recording.provider} />
                      <StatusBadge
                        participation={recording.participation}
                        processing={recording.processing}
                        hasError={hasError}
                        hasSpeech={
                          transcript.segments.length > 0 ||
                          sampleSec > 0 ||
                          timelineDurationSec > 0
                        }
                      />
                    </HStack>
                  </VStack>

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
                              ? tr('Link kopiert!', 'Link copied!')
                              : tr('Teilen', 'Share')
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
                          onClick: () => handleDownload('md'),
                        },
                        {
                          id: 'txt',
                          label: tr('Klartext (.txt)', 'Plain text (.txt)'),
                          onClick: () => handleDownload('txt'),
                        },
                        {
                          id: 'vtt',
                          label: 'WebVTT (.vtt)',
                          onClick: () => handleDownload('vtt'),
                        },
                        {
                          id: 'json',
                          label: 'JSON (.json)',
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

                {/* Compact single-line session metadata */}
                <HStack gap={2} vAlign="center" wrap="wrap">
                  <Text
                    type="supporting"
                    color="secondary"
                    hasTabularNumbers
                  >
                    {startFormatted}
                    {timelineDurationSec > 0
                      ? ` · ${formatDurationHuman(timelineDurationSec)}`
                      : ''}
                  </Text>

                  {isOperator ? (
                    <div
                      id="recording-asr-language-switcher"
                      className="w-48 max-w-full"
                      title={tr(
                        'Transkriptionssprache wechseln',
                        'Switch transcription language'
                      )}
                    >
                      <Selector
                        size="sm"
                        label={tr(
                          'Transkriptionssprache',
                          'Transcription language'
                        )}
                        isLabelHidden
                        isDisabled={busyAction === 'language'}
                        options={buildAsrLanguageOptions(
                          lang,
                          transcript.language || recording.language || 'auto'
                        )}
                        value={
                          transcript.language || recording.language || 'auto'
                        }
                        onChange={handleSwitchAsrLanguage}
                      />
                    </div>
                  ) : (
                    <Token
                      size="sm"
                      icon={<Globe className="h-3 w-3" />}
                      label={formatAsrLanguageLabel(
                        transcript.language || recording.language || 'auto',
                        lang,
                        true
                      )}
                    />
                  )}

                  {transcript.detected_languages &&
                    transcript.detected_languages.length > 0 && (
                      <Text type="supporting" color="secondary">
                        {`${tr('Erkannt', 'Detected')}: ${transcript.detected_languages
                          .map((dl) => formatAsrLanguageLabel(dl, lang, true))
                          .join(', ')}`}
                      </Text>
                    )}

                  {transcript.calendar_link_synced_at && (
                    <Text type="supporting" color="secondary">
                      · {tr('Im Kalender verlinkt', 'Linked in calendar')}
                    </Text>
                  )}
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
                    label={`${tr('Protokoll', 'Protocol')} (${transcript.segments?.length || 0})`}
                  />
                  <Tab
                    value="sources"
                    label={`${tr('Sprecher', 'Speakers')} (${transcript.sources_summary?.length || 0})`}
                  />
                  <Tab
                    value="diagnostics"
                    label={tr('Diagnose', 'Diagnostics')}
                  />
                </TabList>
              </VStack>
            </div>
          </LayoutHeader>
        }
        content={
          <LayoutContent>
            <div className="wl-page-container">
              <VStack gap={4}>
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
                  <Banner
                    status="info"
                    container="card"
                    title={tr(
                      `„${botName}“ tritt dem Meeting bei…`,
                      `“${botName}” is joining the meeting…`
                    )}
                    description={tr(
                      'Falls ein Warteraum aktiv ist, lassen Sie den Zuhörer bitte im Meeting-Fenster zu.',
                      'If a waiting room is active, please admit the assistant in the meeting window.'
                    )}
                  />
                )}

                {recording.participation === 'waiting_admission' && (
                  <Banner
                    status="warning"
                    container="card"
                    title={tr(
                      `Warteraum aktiv: Bitte „${botName}“ jetzt im Meeting zulassen`,
                      `Waiting room active: Please admit “${botName}” in the meeting`
                    )}
                    description={tr(
                      `Timeout nach ${Math.round(instance.limits.lobbyTimeoutSeconds / 60)} Min.`,
                      `Timeout after ${Math.round(instance.limits.lobbyTimeoutSeconds / 60)} min.`
                    )}
                  />
                )}

                {live?.is_active && recording.participation === 'capturing' && (
                  <div
                    id="live-status-banner"
                    className={`${live.paused ? 'wl-lobby-card' : 'wl-live-card'} p-3.5`}
                  >
                    <HStack justify="between" vAlign="center" wrap="wrap" gap={3}>
                      <HStack
                        gap={3}
                        vAlign="start"
                        wrap="nowrap"
                      >
                        {live.paused ? (
                          <span className="mt-0.5 shrink-0 inline-flex h-7 w-7 items-center justify-center rounded-full wl-warn-badge">
                            <Pause className="h-3.5 w-3.5" />
                          </span>
                        ) : (
                          <span className="mt-1 shrink-0 inline-flex">
                            <LiveWaveform active={Boolean(live.speech_active)} />
                          </span>
                        )}
                        <VStack gap={0.5} className="min-w-0 flex-1">
                          <HStack gap={2} vAlign="center" wrap="wrap">
                            <Text type="body" weight="bold">
                              {live.paused
                                ? tr(
                                    'Off the Record — Aufnahme im Konferenz-Chat pausiert',
                                    'Off the Record — Recording paused via meeting chat'
                                  )
                                : live.speech_active
                                  ? tr(
                                      'Ton wird aufgezeichnet — Sprachaktivität erkannt',
                                      'Recording audio — voice activity detected'
                                    )
                                  : tr(
                                      'Live-Aufnahme bereit — warte auf Sprache',
                                      'Live capture ready — waiting for speech'
                                    )}
                            </Text>
                            {!live.paused &&
                              live.speech_active &&
                              (live.active_speakers?.length ?? 0) > 0 && (
                                <Token
                                  size="sm"
                                  color="green"
                                  label={live.active_speakers!.join(', ')}
                                />
                              )}
                          </HStack>
                          <Text type="supporting" color="secondary">
                            {live.paused
                              ? tr(
                                  'Im Konferenz-Chat „#resume“ oder „#weiter“ senden, um fortzufahren.',
                                  'Type "#resume" in the meeting chat to continue recording.'
                                )
                              : tr(
                                  `Audiospuren zugeordnet: ${live.bound_named_receivers ?? 0}/${live.total_receivers ?? 0} · Sprache: ${formatDurationHuman(live.active_audio_seconds || 0)} · Chat: „no“ (Opt-out), „#pause“ (Pause)`,
                                  `Bound audio tracks: ${live.bound_named_receivers ?? 0}/${live.total_receivers ?? 0} · Speech: ${formatDurationHuman(live.active_audio_seconds || 0)} · Chat: “no” (opt-out), “#pause” (pause)`
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
                          'Die Sitzung wurde vorzeitig beendet.',
                          'The session ended early.'
                        )
                      }
                      endContent={
                        canRejoin ? (
                          <span id="rejoin-rec-btn">
                            <Button
                              variant="primary"
                              size="sm"
                              isLoading={busyAction === 'rejoin'}
                              icon={<RotateCcw className="h-3.5 w-3.5" />}
                              label={tr('Erneut beitreten', 'Rejoin meeting')}
                              onClick={handleRejoin}
                            />
                          </span>
                        ) : undefined
                      }
                    />
                  )}

                {isOperator &&
                  !dismissedCalendarScopeNotice &&
                  !transcript.calendar_link_synced_at &&
                  transcript.calendar_link_error ===
                    'insufficient_calendar_write_scope' && (() => {
                    const reconnectProvider: 'google' | 'microsoft' | null =
                      transcript.calendar_link_provider === 'google' ||
                      transcript.calendar_link_provider === 'microsoft'
                        ? transcript.calendar_link_provider
                        : calendarConnections.length === 1
                          ? calendarConnections[0].provider
                          : recording.provider === 'google_meet' &&
                              calendarConnections.some(
                                (c) => c.provider === 'google'
                              )
                            ? 'google'
                            : recording.provider === 'teams' &&
                                calendarConnections.some(
                                  (c) => c.provider === 'microsoft'
                                )
                              ? 'microsoft'
                              : null;
                    const reconnectLabel =
                      reconnectProvider === 'google'
                        ? tr(
                            'Google Kalender neu verbinden',
                            'Reconnect Google Calendar'
                          )
                        : reconnectProvider === 'microsoft'
                          ? tr(
                              'Microsoft 365 neu verbinden',
                              'Reconnect Microsoft 365'
                            )
                          : null;
                    return (
                      <Banner
                        status="warning"
                        container="card"
                        isDismissable
                        onDismiss={() => setDismissedCalendarScopeNotice(true)}
                        title={tr(
                          'Protokoll-Link konnte nicht automatisch im Kalender eingetragen werden',
                          'Protocol link could not be written back to your calendar automatically'
                        )}
                        description={tr(
                          'Ihre Kalender-Verbindung nutzt noch eine ältere Nur-Lesen-Berechtigung. Nach einmaligem Neuverbinden trägt Wortlaut den Protokoll-Link automatisch nach.',
                          'Your calendar connection still uses read-only permissions. Reconnecting once automatically writes the protocol link back into the event.'
                        )}
                        endContent={
                          reconnectProvider && reconnectLabel ? (
                            <Button
                              variant="secondary"
                              size="sm"
                              isLoading={busyAction === 'reconnect-calendar'}
                              isDisabled={busyAction !== null}
                              icon={<Link2 className="h-3.5 w-3.5" />}
                              label={reconnectLabel}
                              onClick={() => {
                                void runExclusiveAction(
                                  'reconnect-calendar',
                                  async () => {
                                    await startCalendarOAuthConnect(
                                      reconnectProvider,
                                      recording.id
                                    );
                                  }
                                );
                              }}
                            />
                          ) : onOpenCalendar ? (
                            <Button
                              variant="secondary"
                              size="sm"
                              icon={<Link2 className="h-3.5 w-3.5" />}
                              label={tr('Zum Kalender', 'Open Calendar')}
                              onClick={onOpenCalendar}
                            />
                          ) : undefined
                        }
                      />
                    );
                  })()}

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
                    keyframes={transcript.keyframes ?? []}
                    focusKeyframeId={focusKeyframeId}
                    focusTimestampSeconds={focusTimestampSeconds}
                    pauseWindows={transcript.pause_windows ?? []}
                    optedOutWindows={transcript.opted_out_windows ?? []}
                    sources={transcript.sources_summary || []}
                    selectedSourceFilter={selectedSourceFilter}
                    onSelectedSourceFilterChange={setSelectedSourceFilter}
                    onProtocolUpdated={onRefresh}
                    onOpenGlossary={onOpenGlossary}
                    onGlossaryUpdated={onGlossaryUpdated}
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
          'Aufnahme unwiderruflich löschen?',
          'Permanently delete recording?'
        )}
        description={tr(
          `Möchten Sie „${formatRecordingTitle(recording)}“ inklusive aller Audiodaten und Transkriptsegmente dauerhaft löschen?`,
          `Are you sure you want to permanently delete “${formatRecordingTitle(recording)}” including all audio tracks and transcript segments?`
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
