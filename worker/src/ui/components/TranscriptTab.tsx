import React, { useMemo, useState } from 'react';
import {
  Check,
  CheckCircle2,
  Copy,
  FilterX,
  MessageSquareText,
  Search,
  ShieldAlert,
} from 'lucide-react';
import { formatDurationClock, formatDurationHuman } from '../api';
import type { SourceSummary, TranscriptExport, TranscriptSegment } from '../types';
import { Button, cn } from './ui/primitives';

export interface TranscriptTabProps {
  transcript: TranscriptExport;
  selectedSourceFilter: string;
  onChangeSourceFilter: (sourceId: string) => void;
}

const SPEAKER_PALETTE = [
  {
    avatar: 'bg-sky-500/20 text-sky-300 border-sky-500/40',
    chip: 'border-sky-700/80 bg-sky-950/70 text-sky-200',
    name: 'text-sky-300',
  },
  {
    avatar: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
    chip: 'border-emerald-700/80 bg-emerald-950/70 text-emerald-200',
    name: 'text-emerald-300',
  },
  {
    avatar: 'bg-violet-500/20 text-violet-300 border-violet-500/40',
    chip: 'border-violet-700/80 bg-violet-950/70 text-violet-200',
    name: 'text-violet-300',
  },
  {
    avatar: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
    chip: 'border-amber-700/80 bg-amber-950/70 text-amber-200',
    name: 'text-amber-300',
  },
  {
    avatar: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
    chip: 'border-rose-700/80 bg-rose-950/70 text-rose-200',
    name: 'text-rose-300',
  },
  {
    avatar: 'bg-teal-500/20 text-teal-300 border-teal-500/40',
    chip: 'border-teal-700/80 bg-teal-950/70 text-teal-200',
    name: 'text-teal-300',
  },
];

function speakerStyleIndex(label: string): number {
  let hash = 0;
  for (let i = 0; i < label.length; i++) {
    hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  }
  return hash % SPEAKER_PALETTE.length;
}

function speakerInitials(label: string): string {
  const cleaned = label.replace(/\(.*\)/g, '').trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '??';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

interface DialogueGroup {
  key: string;
  speakerLabel: string;
  providerSourceId: string;
  attributionStatus: string;
  start: number;
  end: number;
  segments: TranscriptSegment[];
}

export function TranscriptTab({
  transcript,
  selectedSourceFilter,
  onChangeSourceFilter,
}: TranscriptTabProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [copied, setCopied] = useState(false);

  const sources: SourceSummary[] = transcript.sources_summary || [];
  const rawSegments: TranscriptSegment[] = transcript.segments || [];

  const filteredSegments = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return rawSegments.filter((seg) => {
      if (
        selectedSourceFilter &&
        seg.provider_source_id !== selectedSourceFilter
      ) {
        return false;
      }
      if (!q) return true;
      return (
        (seg.text || '').toLowerCase().includes(q) ||
        (seg.speaker_label || '').toLowerCase().includes(q)
      );
    });
  }, [rawSegments, selectedSourceFilter, searchQuery]);

  const dialogueGroups = useMemo<DialogueGroup[]>(() => {
    const groups: DialogueGroup[] = [];
    for (const seg of filteredSegments) {
      const prev = groups[groups.length - 1];
      if (
        prev &&
        prev.speakerLabel === seg.speaker_label &&
        prev.providerSourceId === seg.provider_source_id &&
        seg.start - prev.end <= 6.0
      ) {
        prev.end = Math.max(prev.end, seg.end);
        prev.segments.push(seg);
      } else {
        groups.push({
          key: seg.segment_id,
          speakerLabel: seg.speaker_label,
          providerSourceId: seg.provider_source_id,
          attributionStatus: seg.attribution_status,
          start: seg.start,
          end: seg.end,
          segments: [seg],
        });
      }
    }
    return groups;
  }, [filteredSegments]);

  const handleCopyTranscript = async () => {
    const text = filteredSegments
      .map(
        (s) =>
          `[${formatDurationClock(s.start)} – ${formatDurationClock(s.end)}] ${s.speaker_label}: ${s.text}`
      )
      .join('\n');
    if (!text || !navigator.clipboard) return;
    await navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const quality = transcript.quality;
  const isCleanAttribution =
    !quality.attribution_unknown && quality.source_coverage === 'complete';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-950/60 px-3.5 py-2 text-xs">
        <div className="flex items-center gap-2">
          {isCleanAttribution ? (
            <>
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              <span className="text-slate-200">
                Alle Segmente sind nachgewiesenen Provider-Teilnehmersitzungen
                zugeordnet.
              </span>
            </>
          ) : (
            <>
              <ShieldAlert className="h-4 w-4 text-amber-400" />
              <span className="text-slate-300">
                Quellenabdeckung: <strong>{quality.source_coverage}</strong>
                {quality.attribution_unknown
                  ? ' · Einzelne Segmente ohne bestätigte Teilnehmerbindung'
                  : ''}
              </span>
            </>
          )}
        </div>
        <span className="text-slate-400">
          {filteredSegments.length} von {rawSegments.length} Segmenten
        </span>
      </div>

      {sources.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => onChangeSourceFilter('')}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors cursor-pointer',
              !selectedSourceFilter
                ? 'border-sky-500 bg-sky-950/90 text-sky-200'
                : 'border-slate-800 bg-slate-950/60 text-slate-400 hover:border-slate-700 hover:text-slate-200'
            )}
          >
            <span>Alle Sprecher ({rawSegments.length})</span>
          </button>

          {sources.map((src) => {
            const label =
              src.participant_name ||
              src.speaker_label ||
              src.signaled_participant_id ||
              src.provider_source_id;
            const palette = SPEAKER_PALETTE[speakerStyleIndex(label)];
            const active = selectedSourceFilter === src.provider_source_id;
            return (
              <button
                key={src.provider_source_id}
                type="button"
                onClick={() =>
                  onChangeSourceFilter(
                    active ? '' : src.provider_source_id
                  )
                }
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-all cursor-pointer',
                  active
                    ? palette.chip + ' ring-1 ring-current'
                    : 'border-slate-800 bg-slate-950/60 text-slate-300 hover:border-slate-700'
                )}
              >
                <span
                  className={cn(
                    'h-2 w-2 rounded-full',
                    palette.name.replace('text-', 'bg-')
                  )}
                />
                <span>{label}</span>
                <span className="text-[11px] opacity-75">
                  · {formatDurationHuman(src.speech_seconds)}
                </span>
              </button>
            );
          })}

          {selectedSourceFilter && (
            <Button
              variant="ghost"
              size="sm"
              id="clear-source-filter-btn"
              onClick={() => onChangeSourceFilter('')}
            >
              <FilterX className="h-3.5 w-3.5" />
              <span>Filter zurücksetzen</span>
            </Button>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-3.5 w-3.5 text-slate-500" />
          <input
            id="segment-search"
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Im Transkript nach Begriffen oder Sprechern suchen…"
            className="w-full rounded-lg border border-slate-700 bg-slate-950 pl-9 pr-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:border-sky-500 focus:outline-none"
          />
        </div>

        <Button
          variant="secondary"
          size="sm"
          id="copy-transcript-btn"
          onClick={handleCopyTranscript}
          disabled={filteredSegments.length === 0}
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5 text-emerald-400" />
              <span>Kopiert!</span>
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" />
              <span>Transkript kopieren</span>
            </>
          )}
        </Button>
      </div>

      <div className="segments max-h-[60vh] space-y-3 overflow-y-auto pr-1">
        {dialogueGroups.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-800 bg-slate-950/40 p-10 text-center space-y-2">
            <MessageSquareText className="mx-auto h-7 w-7 text-slate-600" />
            <div className="text-sm font-medium text-slate-300">
              Noch keine Transkript-Segmente vorhanden
            </div>
            <p className="text-xs text-slate-500">
              Sobald im Meeting gesprochen wird und Segmente die lokale
              Parakeet-Spracherkennung durchlaufen haben, erscheinen sie hier
              automatisch.
            </p>
          </div>
        ) : (
          dialogueGroups.map((group) => {
            const palette =
              SPEAKER_PALETTE[speakerStyleIndex(group.speakerLabel)];
            const initials = speakerInitials(group.speakerLabel);

            return (
              <div
                key={group.key}
                className="segment flex gap-3.5 rounded-xl border border-slate-800/90 bg-slate-950/75 p-4 transition-colors hover:border-slate-700/80"
              >
                <div
                  className={cn(
                    'flex h-9 w-9 shrink-0 items-center justify-center rounded-full border text-xs font-bold select-none',
                    palette.avatar
                  )}
                >
                  {initials}
                </div>

                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          'speaker-tag text-sm font-semibold',
                          palette.name
                        )}
                      >
                        {group.speakerLabel}
                      </span>
                      {group.attributionStatus !== 'bound' && (
                        <span className="rounded bg-amber-950/80 px-1.5 py-0.5 text-[10px] font-medium text-amber-300 border border-amber-800/60">
                          {group.attributionStatus}
                        </span>
                      )}
                    </div>
                    <span className="font-mono text-[11px] text-slate-500">
                      {formatDurationClock(group.start)} –{' '}
                      {formatDurationClock(group.end)}
                    </span>
                  </div>

                  <div className="space-y-1 text-sm leading-relaxed text-slate-100">
                    {group.segments.map((seg) => (
                      <p key={seg.segment_id} className="m-0">
                        {seg.text}
                      </p>
                    ))}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
