import React, { useState } from 'react';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Copy,
  FileJson,
  FileText,
  RotateCcw,
  Settings2,
  Share2,
  ShieldCheck,
  Square,
  Subtitles,
  Trash2,
  Users,
} from 'lucide-react';
import {
  formatDurationHuman,
  formatRecordingTitle,
  getInstanceInfo,
} from '../api';
import type { RecordingDetail, TranscriptExport } from '../types';
import { DiagnosticsTab } from './DiagnosticsTab';
import { ParticipationStepper } from './ParticipationStepper';
import { SourcesTab } from './SourcesTab';
import { TranscriptTab } from './TranscriptTab';
import { Button, ProviderBadge, StatusBadge, cn } from './ui/primitives';

export interface MeetingDetailViewProps {
  recording: RecordingDetail;
  transcript: TranscriptExport;
  isOperator: boolean;
  backLabel?: string;
  onBack?: () => void;
  onRejoin: () => void;
  onCancel: () => void;
  onDelete?: () => void;
  onRetryMail: () => void;
  onShareReaderLink?: () => Promise<string | null>;
  onDownload: (format: 'txt' | 'vtt' | 'json' | 'md') => void;
  actionBusy: boolean;
  actionError: string | null;
}

const SPEAKER_BAR_COLORS = [
  'bg-sky-500',
  'bg-emerald-500',
  'bg-violet-500',
  'bg-amber-500',
  'bg-rose-500',
  'bg-teal-500',
];

export function MeetingDetailView({
  recording,
  transcript,
  isOperator,
  backLabel = 'Alle Meetings',
  onBack,
  onRejoin,
  onCancel,
  onDelete,
  onRetryMail,
  onShareReaderLink,
  onDownload,
  actionBusy,
  actionError,
}: MeetingDetailViewProps) {
  const [selectedSourceFilter, setSelectedSourceFilter] = useState<string>('');
  const [showTechDetails, setShowTechDetails] = useState<boolean>(false);
  const [confirmCancel, setConfirmCancel] = useState<boolean>(false);
  const [confirmDelete, setConfirmDelete] = useState<boolean>(false);
  const [copiedId, setCopiedId] = useState<boolean>(false);
  const [copiedShareLink, setCopiedShareLink] = useState<boolean>(false);
  const instance = getInstanceInfo();

  const canCancel =
    isOperator &&
    recording.participation !== 'ended' &&
    !recording.cancelled_at;
  const canRejoin = isOperator && recording.participation === 'ended';
  const canDelete =
    isOperator &&
    Boolean(onDelete) &&
    (recording.participation === 'ended' ||
      recording.participation === 'scheduled' ||
      Boolean(recording.cancelled_at));
  const exportsReady =
    recording.processing === 'completed' || recording.processing === 'failed';

  const audioSeconds = Math.round(
    (recording.ingest?.durable_sample_count || 0) / 16000
  );
  const sources = transcript.sources_summary || [];
  const totalSpeechSeconds = Math.max(
    1,
    sources.reduce((acc, s) => acc + (s.speech_seconds || 0), 0)
  );

  // Only show the bot stepper if the meeting is NOT a normal completed transcript
  const reason =
    recording.participation_reason ||
    recording.attempts?.[recording.attempts.length - 1]?.end_reason ||
    '';
  const isCleanCompleted =
    recording.participation === 'ended' &&
    recording.processing === 'completed' &&
    audioSeconds > 0 &&
    (!reason ||
      reason === 'normal' ||
      reason === 'room_empty' ||
      reason === 'cancelled' ||
      reason === 'deadline');

  const handleCopyId = async () => {
    if (!navigator.clipboard) return;
    await navigator.clipboard.writeText(recording.id).catch(() => {});
    setCopiedId(true);
    setTimeout(() => setCopiedId(false), 1500);
  };

  const handleShareClick = async () => {
    if (!onShareReaderLink) return;
    const url = await onShareReaderLink();
    if (url && navigator.clipboard) {
      await navigator.clipboard.writeText(url).catch(() => {});
      setCopiedShareLink(true);
      setTimeout(() => setCopiedShareLink(false), 2200);
    }
  };

  return (
    <div id="detail-panel" className="mx-auto max-w-6xl space-y-6">
      {/* Top Breadcrumb & Action Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-400 hover:text-white cursor-pointer"
          >
            <ArrowLeft className="h-4 w-4" />
            <span>{backLabel}</span>
          </button>
        ) : (
          <div />
        )}

        <div className="flex flex-wrap items-center gap-2">
          {isOperator && exportsReady && onShareReaderLink && (
            <Button
              variant="secondary"
              size="sm"
              id="share-reader-link-btn"
              disabled={actionBusy}
              onClick={handleShareClick}
              title="Erzeugt einen schreibgeschützten Direktlink nur für dieses Meeting"
            >
              {copiedShareLink ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                  <span>Lese-Link kopiert!</span>
                </>
              ) : (
                <>
                  <Share2 className="h-3.5 w-3.5 text-sky-400" />
                  <span>Lese-Link teilen</span>
                </>
              )}
            </Button>
          )}

          {canRejoin && (
            <Button
              variant="secondary"
              size="sm"
              id="rejoin-rec-btn"
              disabled={actionBusy}
              onClick={onRejoin}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span>Erneut beitreten</span>
            </Button>
          )}

          {canCancel && !confirmCancel && (
            <Button
              variant="danger"
              size="sm"
              id="cancel-rec-btn"
              disabled={actionBusy}
              onClick={() => {
                if (recording.participation === 'scheduled') {
                  onCancel();
                } else {
                  setConfirmCancel(true);
                }
              }}
            >
              <Square className="h-3.5 w-3.5" />
              <span>
                {recording.participation === 'scheduled'
                  ? 'Termin stornieren'
                  : 'Aufnahme beenden'}
              </span>
            </Button>
          )}

          {canCancel && confirmCancel && (
            <div className="inline-flex items-center gap-1.5 rounded-lg border border-red-800/80 bg-red-950/70 px-2.5 py-1 text-xs">
              <span className="font-medium text-red-200">
                Laufende Aufnahme wirklich beenden?
              </span>
              <Button
                variant="danger"
                size="sm"
                id="confirm-cancel-rec-btn"
                disabled={actionBusy}
                onClick={() => {
                  setConfirmCancel(false);
                  onCancel();
                }}
              >
                <span>Ja, beenden</span>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={actionBusy}
                onClick={() => setConfirmCancel(false)}
              >
                <span>Abbrechen</span>
              </Button>
            </div>
          )}

          {canDelete && !confirmDelete && (
            <Button
              variant="danger"
              size="sm"
              id="delete-rec-btn"
              disabled={actionBusy}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>Löschen</span>
            </Button>
          )}

          {canDelete && confirmDelete && (
            <div className="inline-flex items-center gap-1.5 rounded-lg border border-red-800/80 bg-red-950/70 px-2.5 py-1 text-xs">
              <span className="font-medium text-red-200">
                Aufnahme &amp; Transkript endgültig löschen?
              </span>
              <Button
                variant="danger"
                size="sm"
                id="confirm-delete-rec-btn"
                disabled={actionBusy}
                onClick={() => {
                  setConfirmDelete(false);
                  onDelete?.();
                }}
              >
                <span>Endgültig löschen</span>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={actionBusy}
                onClick={() => setConfirmDelete(false)}
              >
                <span>Abbrechen</span>
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Meeting Title Header (Clean, Document-style like Otter / Fireflies) */}
      <div className="border-b border-slate-800 pb-5 space-y-2.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <ProviderBadge provider={recording.provider} />
          <StatusBadge
            participation={recording.participation}
            processing={recording.processing}
            hasError={
              recording.processing === 'failed' ||
              (recording.participation === 'ended' &&
                audioSeconds === 0 &&
                Boolean(reason && reason !== 'normal'))
            }
          />
          <button
            type="button"
            onClick={handleCopyId}
            title={`Vollständige Aufnahme-ID für API kopieren: ${recording.id}`}
            className="inline-flex items-center gap-1.5 rounded border border-slate-800 bg-slate-900 px-2.5 py-0.5 font-mono text-[11px] text-slate-400 hover:border-slate-700 hover:text-slate-200 cursor-pointer"
          >
            {copiedId ? (
              <>
                <Check className="h-3 w-3 text-emerald-400" />
                <span className="font-sans text-emerald-300">ID kopiert</span>
              </>
            ) : (
              <>
                <Copy className="h-3 w-3" />
                <span>Aufnahme-ID: {recording.id.slice(0, 8)}…</span>
              </>
            )}
          </button>
        </div>

        <h1 className="text-2xl font-bold tracking-tight text-white">
          {formatRecordingTitle(recording)}
        </h1>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-slate-400">
          <span className="inline-flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5 text-slate-500" />
            {new Date(recording.starts_at).toLocaleString('de-DE', {
              weekday: 'short',
              day: '2-digit',
              month: '2-digit',
              year: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}{' '}
            – {new Date(recording.ends_at).toLocaleTimeString('de-DE', {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
          {audioSeconds > 0 && (
            <span>Aufnahmedauer: {formatDurationHuman(audioSeconds)}</span>
          )}
          <span className="inline-flex items-center gap-1">
            <Users className="h-3.5 w-3.5 text-slate-500" />
            {sources.length} {sources.length === 1 ? 'Sprecher' : 'Sprecher'}
          </span>
          {recording.guest_name && (
            <span>Bot-Name: {recording.guest_name}</span>
          )}
        </div>
      </div>

      {actionError && (
        <div className="rounded-lg border border-red-800/80 bg-red-950/60 px-4 py-3 text-xs text-red-200">
          {actionError}
        </div>
      )}

      {/* Live / Error Stepper Banner ONLY when meeting is in progress, processing, or failed */}
      {!isCleanCompleted && (
        <ParticipationStepper
          recording={recording}
          isOperator={isOperator}
          onRejoin={onRejoin}
          rejoining={actionBusy}
        />
      )}

      {/* Main 2-Column Content: Left (70%) Transcript, Right (30%) Speakers & Exports Sidebar */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px] items-start">
        {/* Left: Main Conversation Transcript */}
        <div className="rounded-2xl border border-slate-800/90 bg-slate-900/60 p-5">
          <TranscriptTab
            transcript={transcript}
            selectedSourceFilter={selectedSourceFilter}
            onChangeSourceFilter={setSelectedSourceFilter}
          />
        </div>

        {/* Right: Speakers Talk-Time Breakdown & Exports Sidebar */}
        <aside className="space-y-4 lg:sticky lg:top-6">
          {/* Speaker Talk-Time Breakdown Card */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/75 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400">
                Sprecher &amp; Redeanteil
              </h2>
              {selectedSourceFilter && (
                <button
                  type="button"
                  onClick={() => setSelectedSourceFilter('')}
                  className="text-[11px] font-medium text-sky-400 hover:underline cursor-pointer"
                >
                  Alle zeigen
                </button>
              )}
            </div>

            {sources.length === 0 ? (
              <p className="text-xs text-slate-500">
                Noch keine Sprecher-Segmente erkannt.
              </p>
            ) : (
              <div className="space-y-2.5">
                {sources.map((src, idx) => {
                  const pct = Math.round(
                    ((src.speech_seconds || 0) / totalSpeechSeconds) * 100
                  );
                  const filterKey =
                    src.signaled_participant_id || src.provider_source_id;
                  const isActive =
                    selectedSourceFilter === filterKey ||
                    selectedSourceFilter === src.provider_source_id;
                  const barColor =
                    SPEAKER_BAR_COLORS[idx % SPEAKER_BAR_COLORS.length];
                  const name =
                    src.participant_name ||
                    src.speaker_label ||
                    src.signaled_participant_id ||
                    'Unbekannt';

                  return (
                    <button
                      key={`${src.provider_source_id}:${filterKey}`}
                      type="button"
                      onClick={() =>
                        setSelectedSourceFilter((prev) =>
                          prev === filterKey ? '' : filterKey
                        )
                      }
                      className={cn(
                        'w-full rounded-xl border p-2.5 text-left transition-all cursor-pointer',
                        isActive
                          ? 'border-sky-500 bg-sky-950/50'
                          : 'border-slate-800/80 bg-slate-950/60 hover:border-slate-700'
                      )}
                    >
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-semibold text-slate-100 truncate">
                          {name}
                        </span>
                        <span className="font-mono text-[11px] text-slate-400 shrink-0 ml-2">
                          {pct}% ({formatDurationHuman(src.speech_seconds)})
                        </span>
                      </div>
                      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                        <div
                          className={cn('h-full rounded-full', barColor)}
                          style={{ width: `${Math.max(4, pct)}%` }}
                        />
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Exports & Downloads Card */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/75 p-4 space-y-3">
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400">
              Transkript exportieren
            </h2>
            <div className="space-y-2">
              <button
                type="button"
                data-export="md"
                disabled={!exportsReady}
                onClick={() => onDownload('md')}
                className="flex w-full items-center justify-between rounded-xl border border-slate-800 bg-slate-950/80 px-3.5 py-2.5 text-xs font-medium text-slate-200 hover:border-slate-700 hover:bg-slate-800/70 disabled:opacity-40 disabled:pointer-events-none cursor-pointer"
              >
                <span className="inline-flex items-center gap-2">
                  <FileText className="h-4 w-4 text-violet-400" />
                  <span>Markdown-Protokoll (.md)</span>
                </span>
                <span className="text-[11px] text-slate-400">Download</span>
              </button>

              <button
                type="button"
                data-export="txt"
                disabled={!exportsReady}
                onClick={() => onDownload('txt')}
                className="flex w-full items-center justify-between rounded-xl border border-slate-800 bg-slate-950/80 px-3.5 py-2.5 text-xs font-medium text-slate-200 hover:border-slate-700 hover:bg-slate-800/70 disabled:opacity-40 disabled:pointer-events-none cursor-pointer"
              >
                <span className="inline-flex items-center gap-2">
                  <FileText className="h-4 w-4 text-sky-400" />
                  <span>Text-Protokoll (.txt)</span>
                </span>
                <span className="text-[11px] text-slate-400">Download</span>
              </button>

              <button
                type="button"
                data-export="vtt"
                disabled={!exportsReady}
                onClick={() => onDownload('vtt')}
                className="flex w-full items-center justify-between rounded-xl border border-slate-800 bg-slate-950/80 px-3.5 py-2.5 text-xs font-medium text-slate-200 hover:border-slate-700 hover:bg-slate-800/70 disabled:opacity-40 disabled:pointer-events-none cursor-pointer"
              >
                <span className="inline-flex items-center gap-2">
                  <Subtitles className="h-4 w-4 text-emerald-400" />
                  <span>Untertitel (.vtt)</span>
                </span>
                <span className="text-[11px] text-slate-400">Download</span>
              </button>

              <button
                type="button"
                data-export="json"
                disabled={!exportsReady}
                onClick={() => onDownload('json')}
                className="flex w-full items-center justify-between rounded-xl border border-slate-800 bg-slate-950/80 px-3.5 py-2.5 text-xs font-medium text-slate-200 hover:border-slate-700 hover:bg-slate-800/70 disabled:opacity-40 disabled:pointer-events-none cursor-pointer"
              >
                <span className="inline-flex items-center gap-2">
                  <FileJson className="h-4 w-4 text-amber-400" />
                  <span>Struktur- &amp; Qualitätsdaten (.json)</span>
                </span>
                <span className="text-[11px] text-slate-400">Download</span>
              </button>
            </div>
          </div>

          {/* Privacy & Retention Card (for Dr. Thomas & Compliance) */}
          <div className="rounded-2xl border border-slate-800/80 bg-slate-900/60 p-4 space-y-2 text-xs">
            <div className="flex items-center gap-1.5 font-bold uppercase tracking-wider text-emerald-400">
              <ShieldCheck className="h-3.5 w-3.5" />
              <span>Datenschutz &amp; Aufbewahrung</span>
            </div>
            <ul className="space-y-1 text-[11px] text-slate-400">
              <li>
                • <strong className="text-slate-300">Sprecherbindung:</strong>{' '}
                Nachgewiesene Provider-Sitzung (keine Stimmprofile/Voiceprints)
              </li>
              <li>
                • <strong className="text-slate-300">Roh-Audio:</strong>{' '}
                {recording.audio_deleted_at
                  ? `Gelöscht am ${new Date(recording.audio_deleted_at).toLocaleString('de-DE')}`
                  : `Automatische Löschung nach ${instance.retention.audioHours} Std.`}
              </li>
              <li>
                • <strong className="text-slate-300">Transkript:</strong>{' '}
                Automatische Löschung nach {instance.retention.transcriptDays}{' '}
                Tagen
              </li>
            </ul>
          </div>

          {/* Subtle Operator Technical Disclosure Toggle */}
          {isOperator && (
            <button
              type="button"
              onClick={() => setShowTechDetails((v) => !v)}
              className="flex w-full items-center justify-between rounded-xl border border-slate-800/70 bg-slate-950/40 px-4 py-2.5 text-xs text-slate-400 hover:text-slate-200 cursor-pointer"
            >
              <span className="inline-flex items-center gap-2">
                <Settings2 className="h-3.5 w-3.5 text-slate-500" />
                <span>Technische Diagnose &amp; WebRTC-Quellen</span>
              </span>
              {showTechDetails ? (
                <ChevronUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
            </button>
          )}
        </aside>
      </div>

      {/* Collapsible Technical Details Section (Only visible when expanded) */}
      {showTechDetails && (
        <section className="space-y-6 rounded-2xl border border-slate-800 bg-slate-900/70 p-6">
          <h2 className="text-sm font-bold text-white">
            Technische Diagnose &amp; WebRTC-Empfängerbindung
          </h2>
          <SourcesTab
            sources={sources}
            selectedSourceFilter={selectedSourceFilter}
            onSelectSourceForTranscript={(sid) =>
              setSelectedSourceFilter((prev) => (prev === sid ? '' : sid))
            }
          />
          <DiagnosticsTab
            recording={recording}
            transcript={transcript}
            isOperator={isOperator}
            onRetryMail={onRetryMail}
            retryingMail={actionBusy}
          />
        </section>
      )}
    </div>
  );
}
