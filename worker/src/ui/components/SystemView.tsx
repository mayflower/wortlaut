import React from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Cpu,
  KeyRound,
  Mail,
  Server,
  ShieldCheck,
  Video,
  XCircle,
} from 'lucide-react';
import {
  formatRecordingTitle,
  getFailureReasons,
  getInstanceInfo,
} from '../api';
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
  const instance = getInstanceInfo();

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
    const samples = r.quality?.durable_sample_count || 0;
    const cleanStop =
      !reason ||
      reason === 'normal' ||
      reason === 'room_empty' ||
      ((reason === 'cancelled' || reason === 'deadline') && samples > 0);
    return (
      r.processing === 'failed' || (r.participation === 'ended' && !cleanStop)
    );
  });

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-white">
            System &amp; Diagnose
          </h1>
          <p className="text-xs text-slate-400">
            Plattformstatus, konfigurierte Konferenz-Provider, Kapazitätsgrenzen
            und Aufzeichnungen mit Handlungsbedarf.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <a
            href="/docs"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs font-medium text-slate-100 hover:bg-slate-700 transition-colors"
          >
            <BookOpen className="h-3.5 w-3.5 text-sky-400" />
            <span>OpenAPI / REST-Doku (/docs)</span>
          </a>

          <Button variant="secondary" size="sm" onClick={onOpenAuthDialog}>
            <KeyRound className="h-3.5 w-3.5" />
            <span>Zugang &amp; Konto</span>
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
            PostgreSQL, S3-Speicher &amp; Prometheus <code>/metrics</code>
          </p>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/75 p-4 space-y-1.5">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Aktive Meeting-Bots</span>
            <Activity className="h-4 w-4 text-emerald-400" />
          </div>
          <div className="text-xl font-bold text-white">
            {activeJobs.length}{' '}
            <span className="text-sm font-normal text-slate-400">
              / {instance.limits.maxActiveMeetings} max.
            </span>
          </div>
          <p className="text-[11px] text-slate-500">
            Kurzlebige Playwright/WebRTC-Kubernetes-Jobs
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
            <span>Aufbewahrungsfristen</span>
            <ShieldCheck className="h-4 w-4 text-sky-400" />
          </div>
          <div className="text-base font-bold text-white">
            {instance.retention.audioHours}h Audio ·{' '}
            {instance.retention.transcriptDays}d Text
          </div>
          <p className="text-[11px] text-slate-500">
            Bot-Standardname: „{instance.assistantName}“
          </p>
        </div>
      </div>

      {/* Configured Providers & Mail Readiness */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-800 bg-slate-900/75 p-5 space-y-3">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
            <Video className="h-4 w-4 text-sky-400" />
            <span>Konfigurierte Konferenz-Provider</span>
          </div>
          <div className="divide-y divide-slate-800/80 rounded-lg border border-slate-800 bg-slate-950/60">
            <div className="flex items-center justify-between px-4 py-3 text-xs">
              <div>
                <div className="font-semibold text-white">Google Meet</div>
                <div className="text-[11px] text-slate-400">
                  Playwright/Chromium WebRTC ·{' '}
                  {instance.providers.google_meet_auth_session
                    ? 'Gespeicherte Google-Session aktiv'
                    : 'Gast-Modus (ohne Login-Session)'}
                </div>
              </div>
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold border',
                  instance.providers.google_meet
                    ? 'border-emerald-800 bg-emerald-950 text-emerald-300'
                    : 'border-slate-700 bg-slate-900 text-slate-400'
                )}
              >
                {instance.providers.google_meet ? (
                  <CheckCircle2 className="h-3 w-3" />
                ) : (
                  <XCircle className="h-3 w-3" />
                )}
                {instance.providers.google_meet ? 'Aktiviert' : 'Deaktiviert'}
              </span>
            </div>

            <div className="flex items-center justify-between px-4 py-3 text-xs">
              <div>
                <div className="font-semibold text-white">Microsoft Teams</div>
                <div className="text-[11px] text-slate-400">
                  Playwright/Chromium Web-Client · Gast-Beitritt
                </div>
              </div>
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold border',
                  instance.providers.teams
                    ? 'border-emerald-800 bg-emerald-950 text-emerald-300'
                    : 'border-slate-700 bg-slate-900 text-slate-400'
                )}
              >
                {instance.providers.teams ? (
                  <CheckCircle2 className="h-3 w-3" />
                ) : (
                  <XCircle className="h-3 w-3" />
                )}
                {instance.providers.teams ? 'Aktiviert' : 'Deaktiviert'}
              </span>
            </div>

            <div className="flex items-center justify-between px-4 py-3 text-xs">
              <div>
                <div className="font-semibold text-white">Cisco Webex</div>
                <div className="text-[11px] text-slate-400">
                  Browser-SDK / Service-Token
                </div>
              </div>
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold border',
                  instance.providers.webex
                    ? 'border-emerald-800 bg-emerald-950 text-emerald-300'
                    : 'border-slate-700 bg-slate-900 text-slate-400'
                )}
              >
                {instance.providers.webex ? (
                  <CheckCircle2 className="h-3 w-3" />
                ) : (
                  <XCircle className="h-3 w-3" />
                )}
                {instance.providers.webex
                  ? 'Aktiviert'
                  : 'Kein Zugang hinterlegt'}
              </span>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/75 p-5 space-y-3">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
            <Mail className="h-4 w-4 text-emerald-400" />
            <span>Kalender-Postfach &amp; E-Mail-Versand</span>
          </div>
          <div className="divide-y divide-slate-800/80 rounded-lg border border-slate-800 bg-slate-950/60 text-xs">
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-slate-300">Bot-Einladungsadresse</span>
              <code className="font-mono text-slate-100">
                {instance.botEmail || 'Nicht konfiguriert'}
              </code>
            </div>
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-slate-300">
                IMAP-Kalenderempfang / SMTP-Ergebnisversand
              </span>
              <span className="font-medium text-slate-200">
                IMAP: {instance.mail.imapEnabled ? 'Aktiv' : 'Aus'} · SMTP:{' '}
                {instance.mail.smtpEnabled ? 'Aktiv' : 'Aus'}
              </span>
            </div>
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-slate-300">
                Warteraum-Timeout / Leerer-Raum-Timeout
              </span>
              <span className="font-medium text-slate-200">
                {Math.round(instance.limits.lobbyTimeoutSeconds / 60)} Min. /{' '}
                {Math.round(instance.limits.emptyRoomTimeoutSeconds / 60)} Min.
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Problem / Error Recordings */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/75 p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-400" />
            <h2 className="text-sm font-bold text-white">
              Aufzeichnungen mit Hinweis oder Abbruch (
              {problemRecordings.length})
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
