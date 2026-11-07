import React from 'react';
import {
  AlertTriangle,
  Check,
  Loader2,
  Mic,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  Users,
} from 'lucide-react';
import { formatDurationHuman, getFailureReasons } from '../api';
import type { RecordingDetail } from '../types';
import { Button, cn } from './ui/primitives';

export interface ParticipationStepperProps {
  recording: RecordingDetail;
  isOperator: boolean;
  onRejoin: () => void;
  rejoining: boolean;
}

const STEPS = [
  { key: 'scheduled', label: '1. Eingeplant' },
  { key: 'joining', label: '2. Browser startet' },
  { key: 'lobby', label: '3. Warteraum / Einlass' },
  { key: 'capturing', label: '4. Zeichnet auf' },
  { key: 'completed', label: '5. Transkript bereit' },
];

export function ParticipationStepper({
  recording,
  isOperator,
  onRejoin,
  rejoining,
}: ParticipationStepperProps) {
  const failureReasons = getFailureReasons();
  const lastAttempt =
    recording.attempts && recording.attempts.length > 0
      ? recording.attempts[recording.attempts.length - 1]
      : null;
  const reason =
    recording.participation_reason || lastAttempt?.end_reason || '';
  const explanation = reason ? failureReasons[reason] || '' : '';
  const live = recording.live_status;
  const sampleSec = Math.round(
    (recording.ingest?.durable_sample_count || 0) / 16000
  );

  let activeIndex = 0;
  if (recording.participation === 'scheduled') {
    activeIndex = 0;
  } else if (
    recording.participation === 'starting' ||
    recording.participation === 'preparing' ||
    recording.participation === 'joining'
  ) {
    activeIndex = 1;
  } else if (recording.participation === 'waiting_admission') {
    activeIndex = 2;
  } else if (recording.participation === 'capturing') {
    activeIndex = 3;
  } else if (recording.participation === 'ended') {
    activeIndex = 4;
  }

  const isFailedJoin =
    recording.participation === 'ended' &&
    sampleSec === 0 &&
    Boolean(reason) &&
    reason !== 'normal';

  return (
    <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/75 p-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {STEPS.map((step, idx) => {
          const isPast = idx < activeIndex && !isFailedJoin;
          const isCurrent = idx === activeIndex;
          const isCompletedEnd =
            idx === 4 &&
            recording.participation === 'ended' &&
            recording.processing === 'completed' &&
            !isFailedJoin;

          return (
            <div
              key={step.key}
              className={cn(
                'flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium transition-all',
                isCompletedEnd || isPast
                  ? 'border-emerald-800/70 bg-emerald-950/40 text-emerald-300'
                  : isCurrent && isFailedJoin
                    ? 'border-red-800/80 bg-red-950/50 text-red-200'
                    : isCurrent &&
                        recording.participation === 'waiting_admission'
                      ? 'border-amber-600/90 bg-amber-950/70 text-amber-200 shadow-xs'
                      : isCurrent
                        ? 'border-sky-600/80 bg-sky-950/60 text-sky-200'
                        : 'border-slate-800/80 bg-slate-900/40 text-slate-500'
              )}
            >
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-current text-[10px]">
                {isCompletedEnd || isPast ? (
                  <Check className="h-3 w-3" />
                ) : isCurrent &&
                  (recording.participation === 'joining' ||
                    recording.participation === 'capturing' ||
                    (recording.participation === 'ended' &&
                      recording.processing !== 'completed' &&
                      recording.processing !== 'failed')) ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  idx + 1
                )}
              </span>
              <span className="truncate">{step.label}</span>
            </div>
          );
        })}
      </div>

      {recording.participation === 'waiting_admission' && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-600/80 bg-amber-950/60 px-4 py-3 text-xs text-amber-100">
          <div className="flex items-center gap-2.5">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
            <div>
              <strong>Warteraum aktiv:</strong> Der Bot wartet im
              Meeting-Warteraum auf Einlass durch den Host. Bitte lassen Sie{' '}
              <strong>{recording.guest_name || 'wortlaut'}</strong> jetzt im
              Meeting-Fenster zu.
            </div>
          </div>
        </div>
      )}

      {live?.is_active && recording.participation === 'capturing' && (
        <div
          id="live-status-banner"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-800/80 bg-emerald-950/40 px-4 py-2.5 text-xs text-emerald-200"
        >
          <div className="flex flex-wrap items-center gap-4">
            <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-300">
              <Mic className="h-3.5 w-3.5 animate-pulse" />
              Live-Aufnahme läuft
            </span>
            <span className="inline-flex items-center gap-1">
              <Users className="h-3.5 w-3.5 text-emerald-400" />
              Teilnehmer:{' '}
              <strong>{live.dom_or_signaled_participants ?? 0}</strong> (gebundene
              Sprecher: <strong>{live.bound_named_receivers ?? 0}</strong>/
              {live.total_receivers ?? 0})
            </span>
            <span>
              Aktive Sprache:{' '}
              <strong>{formatDurationHuman(live.active_audio_seconds || 0)}</strong>{' '}
              ({formatDurationHuman(live.audio_seconds || 0)} Audio gesamt)
            </span>
          </div>
          <span className="text-[11px] text-emerald-300/80">
            Streams: {live.active_streams ?? 0} · ASR offen:{' '}
            {recording.asr?.pending ?? 0}
          </span>
        </div>
      )}

      {(explanation || (reason && reason !== 'normal')) && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-800/80 bg-red-950/50 px-4 py-3 text-xs text-red-200">
          <div className="flex items-start gap-2.5">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
            <div>
              <strong className="text-red-100">{reason}:</strong>{' '}
              {explanation ||
                'Die Sitzung wurde vorzeitig oder mit Hinweis beendet.'}
            </div>
          </div>
          {isOperator && recording.participation === 'ended' && (
            <Button
              variant="primary"
              size="sm"
              onClick={onRejoin}
              disabled={rejoining}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span>{rejoining ? 'Plane ein…' : 'Jetzt erneut beitreten'}</span>
            </Button>
          )}
        </div>
      )}

      {recording.participation === 'ended' &&
        recording.processing !== 'completed' &&
        recording.processing !== 'failed' && (
          <div className="flex items-center gap-2 rounded-lg border border-sky-800/70 bg-sky-950/40 px-4 py-2.5 text-xs text-sky-200">
            <Sparkles className="h-4 w-4 text-sky-400 animate-pulse" />
            <span>
              <strong>Spracherkennung arbeitet:</strong> Noch{' '}
              {recording.asr?.pending ?? 0} Segmente in Verarbeitung (
              {Math.round(recording.asr?.pending_source_seconds ?? 0)}s Audio).
            </span>
          </div>
        )}
    </div>
  );
}
