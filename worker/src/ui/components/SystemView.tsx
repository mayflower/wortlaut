import React from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Cpu,
  KeyRound,
  RefreshCw,
  Server,
  ShieldCheck,
} from 'lucide-react';
import { formatRecordingTitle, getFailureReasons } from '../api';
import type { AuthMode, RecordingSummary } from '../types';
import { Button, ProviderBadge, StatusBadge, cn } from './ui/primitives';

export interface SystemViewProps {
  healthy: boolean;
  authMode: AuthMode;
  recordings: RecordingSummary[];
  livePoll: boolean;
  onToggleLivePoll: (next: boolean) => void;
  onManualRefresh: () => void;
  onOpenAuthDialog: () => void;
  onSelectRecording: (id: string) => void;
}

export function SystemView({
  healthy,
  authMode,
  recordings,
  livePoll,
  onToggleLivePoll,
  onManualRefresh,
  onOpenAuthDialog,
  onSelectRecording,
}: SystemViewProps) {
  const failureReasons = getFailureReasons();

  const activeJobs = recordings.filter(
    (r) =>
      r.participation === 'starting' ||
      r.participation === 'preparing' ||
      r.participation === 'joining' ||
      r.participation === 'waiting_admission' ||
      r.participation === 'capturing'
  );

  const asrJobs = recordings.filter(
    (r) =>
      r.processing === 'processing' ||
      (r.participation === 'ended' && r.processing === 'pending')
  );

  const problemRecordings = recordings.filter((r) => {
    const reason = r.participation_reason;
    const abnormal = Boolean(
      reason && reason !== 'normal' && reason !== 'room_empty'
    );
    return r.processing === 'failed' || (r.participation === 'ended' && abnormal);
  });

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-white">
            System &amp; Diagnose
          </h1>
          <p className="text-xs text-slate-400">
            Plattformstatus, aktive Kubernetes-Worker, Parakeet-ASR-Queue und
            Aufzeichnungen mit Handlungsbedarf.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900 px-3 py-1.5 text-xs text-slate-300 cursor-pointer select-none">
            <input
              id="auto-refresh"
              type="checkbox"
              checked={livePoll}
              onChange={(e) => onToggleLivePoll(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-slate-700 bg-slate-950 text-sky-500 focus:ring-sky-500"
            />
            <span>Live-Polling (3s)</span>
          </label>

          <Button
            variant="secondary"
            size="sm"
            id="refresh-btn"
            onClick={onManualRefresh}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>Jetzt aktualisieren</span>
          </Button>

          <Button variant="secondary" size="sm" onClick={onOpenAuthDialog}>
            <KeyRound className="h-3.5 w-3.5" />
            <span>Token verwalten</span>
          </Button>
        </div>
      </div>

      {/* System Metrics Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-800 bg-slate-900/75 p-4 space-y-1.5">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>API &amp; Datenbank</span>
            <Server className="h-4 w-4 text-sky-400" />
          </div>
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'h-2.5 w-2.5 rounded-full',
                healthy ? 'bg-emerald-400' : 'bg-amber-400'
              )}
            />
            <span className="text-base font-bold text-white">
              {healthy ? 'Bereit (/health/ready)' : 'Prüfe Verbindung…'}
            </span>
          </div>
          <p className="text-[11px] text-slate-500">
            Meeting-Dienst, PostgreSQL und S3-Speicher
          </p>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/75 p-4 space-y-1.5">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Aktive Meeting-Bots</span>
            <Activity className="h-4 w-4 text-emerald-400" />
          </div>
          <div className="text-xl font-bold text-white">
            {activeJobs.length}
          </div>
          <p className="text-[11px] text-slate-500">
            Laufende Playwright/WebRTC-Worker-Jobs
          </p>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/75 p-4 space-y-1.5">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Parakeet-ASR-Queue</span>
            <Cpu className="h-4 w-4 text-violet-400" />
          </div>
          <div className="text-xl font-bold text-white">{asrJobs.length}</div>
          <p className="text-[11px] text-slate-500">
            Aufnahmen in lokaler GPU-Spracherkennung
          </p>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/75 p-4 space-y-1.5">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Sitzungs-Authentifizierung</span>
            <ShieldCheck className="h-4 w-4 text-sky-400" />
          </div>
          <div className="text-base font-bold text-white">
            {authMode.kind === 'operator'
              ? 'Operator-Vollzugriff'
              : authMode.kind === 'reader'
                ? 'Lese-Token'
                : 'Nicht verbunden'}
          </div>
          <p className="text-[11px] text-slate-500">
            Prometheus-Metriken unter <code>/metrics</code>
          </p>
        </div>
      </div>

      {/* Problem / Error Recordings */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/75 p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-400" />
            <h2 className="text-sm font-bold text-white">
              Aufzeichnungen mit Hinweis oder Abbruch ({problemRecordings.length}
              )
            </h2>
          </div>
        </div>

        {problemRecordings.length === 0 ? (
          <div className="flex items-center gap-2 rounded-lg border border-slate-800/80 bg-slate-950/50 px-4 py-3 text-xs text-emerald-300">
            <CheckCircle2 className="h-4 w-4 text-emerald-400" />
            <span>
              Keine fehlgeschlagenen oder abgebrochenen Aufzeichnungen in der
              aktuellen Ansicht.
            </span>
          </div>
        ) : (
          <div className="divide-y divide-slate-800/80 rounded-lg border border-slate-800 bg-slate-950/60">
            {problemRecordings.slice(0, 10).map((item) => {
              const reason = item.participation_reason;
              const reasonText =
                reason && failureReasons[reason]
                  ? failureReasons[reason]
                  : reason || 'Verarbeitungsfehler';
              return (
                <div
                  key={item.id}
                  onClick={() => onSelectRecording(item.id)}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-slate-900 cursor-pointer transition-colors"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-2">
                      <ProviderBadge provider={item.provider} />
                      <span className="text-xs font-semibold text-white">
                        {formatRecordingTitle(item)}
                      </span>
                      <span className="font-mono text-[11px] text-slate-500">
                        {item.id.slice(0, 8)}
                      </span>
                    </div>
                    <p className="text-xs text-red-300">{reasonText}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge
                      participation={item.participation}
                      processing={item.processing}
                      hasError={true}
                    />
                    <ArrowRight className="h-4 w-4 text-slate-500" />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
