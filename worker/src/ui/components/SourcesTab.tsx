import React from 'react';
import { Filter, Radio, UserCheck, UserX } from 'lucide-react';
import { formatDurationHuman } from '../api';
import type { SourceSummary } from '../types';
import { Button, cn } from './ui/primitives';

export interface SourcesTabProps {
  sources: SourceSummary[];
  selectedSourceFilter: string;
  onSelectSourceForTranscript: (sourceId: string) => void;
}

export function SourcesTab({
  sources,
  selectedSourceFilter,
  onSelectSourceForTranscript,
}: SourcesTabProps) {
  if (sources.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-800 bg-slate-950/50 p-10 text-center space-y-2">
        <Radio className="mx-auto h-7 w-7 text-slate-600" />
        <div className="text-sm font-medium text-slate-300">
          Noch keine empfangenen Audio-Quellen registriert
        </div>
        <p className="text-xs text-slate-500">
          Sobald WebRTC-Receiver im Meeting Audio empfangen, werden hier die
          einzelnen Streams und ihre Teilnehmerbindung aufgelistet.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="text-xs text-slate-400">
        Jede empfangene WebRTC-Audiospur wird vor dem Mix separat erfasst und an
        die nachgewiesene Provider-Teilnehmersitzung gebunden.
      </div>

      <div className="grid grid-cols-1 gap-3">
        {sources.map((src) => {
          const isFiltered = selectedSourceFilter === src.provider_source_id;
          const hasName = Boolean(src.participant_name);
          const hasId = Boolean(src.signaled_participant_id);

          return (
            <div
              key={src.provider_source_id}
              className="source-row flex flex-col justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/80 p-4 sm:flex-row sm:items-center"
            >
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-0.5 text-xs font-semibold',
                      hasName
                        ? 'border-emerald-800/80 bg-emerald-950/80 text-emerald-300'
                        : hasId
                          ? 'border-sky-800/80 bg-sky-950/80 text-sky-300'
                          : 'border-amber-800/80 bg-amber-950/80 text-amber-300'
                    )}
                  >
                    {hasName || hasId ? (
                      <UserCheck className="h-3.5 w-3.5" />
                    ) : (
                      <UserX className="h-3.5 w-3.5" />
                    )}
                    <span>
                      {src.participant_name ||
                        (src.signaled_participant_id
                          ? `Teilnehmer ${src.signaled_participant_id}`
                          : 'Zuordnung unklar')}
                    </span>
                  </span>

                  <code className="rounded bg-slate-900 px-2 py-0.5 font-mono text-xs text-sky-400 border border-slate-800">
                    {src.provider_source_id}
                  </code>
                </div>

                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
                  <span>
                    Segmente: <strong className="text-slate-200">{src.segment_count}</strong>
                  </span>
                  <span>
                    Aktive Sprache:{' '}
                    <strong className="text-slate-200">
                      {formatDurationHuman(src.speech_seconds)}
                    </strong>{' '}
                    ({formatDurationHuman(src.accepted_seconds)} Audio)
                  </span>
                  {src.signaled_participant_id && (
                    <span>
                      Session-ID:{' '}
                      <strong className="text-slate-200">
                        {src.signaled_participant_id}
                      </strong>
                    </span>
                  )}
                  {src.csi != null && (
                    <span>
                      CSI/CSRC: <strong className="text-slate-200">{src.csi}</strong>
                    </span>
                  )}
                </div>

                {src.sample_text && (
                  <div className="text-xs italic text-slate-400">
                    „{src.sample_text}“
                  </div>
                )}
              </div>

              <div className="shrink-0">
                <Button
                  variant={isFiltered ? 'primary' : 'secondary'}
                  size="sm"
                  className="filter-source-btn"
                  data-filter-source={src.provider_source_id}
                  onClick={() =>
                    onSelectSourceForTranscript(src.provider_source_id)
                  }
                >
                  <Filter className="h-3.5 w-3.5" />
                  <span>
                    {isFiltered ? 'Filter aktiv' : 'Im Transkript filtern'}
                  </span>
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
