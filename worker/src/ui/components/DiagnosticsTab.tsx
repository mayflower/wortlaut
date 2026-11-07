import React, { useState } from 'react';
import {
  Activity,
  Check,
  Copy,
  Cpu,
  Mail,
  RefreshCw,
  Server,
} from 'lucide-react';
import type { RecordingDetail, TranscriptExport } from '../types';
import { Button } from './ui/primitives';

export interface DiagnosticsTabProps {
  recording: RecordingDetail;
  transcript: TranscriptExport;
  isOperator: boolean;
  onRetryMail: () => void;
  retryingMail: boolean;
}

export function DiagnosticsTab({
  recording,
  transcript,
  isOperator,
  onRetryMail,
  retryingMail,
}: DiagnosticsTabProps) {
  const [copiedJson, setCopiedJson] = useState(false);
  const [copiedCurl, setCopiedCurl] = useState(false);

  const origin =
    typeof window !== 'undefined' ? window.location.origin : '';
  const curlSnippet = `curl --fail -H "Authorization: Bearer $WORTLAUT_TOKEN" "${origin}/v1/recordings/${recording.id}/exports/json"`;

  const handleCopyCurl = async () => {
    if (!navigator.clipboard) return;
    await navigator.clipboard.writeText(curlSnippet).catch(() => {});
    setCopiedCurl(true);
    setTimeout(() => setCopiedCurl(false), 1800);
  };

  const canRetryMail =
    isOperator &&
    recording.delivery &&
    ['failed', 'delivery_unknown'].includes(recording.delivery.status);

  const sampleCount = recording.ingest?.durable_sample_count ?? 0;
  const sampleSec = Math.round(sampleCount / 16000);
  const live = recording.live_status;

  const rawDiagPayload = {
    live_status: recording.live_status,
    attempts: recording.attempts,
    audio_streams: recording.audio,
    quality: transcript.quality,
  };

  const handleCopyJson = async () => {
    if (!navigator.clipboard) return;
    await navigator.clipboard
      .writeText(JSON.stringify(rawDiagPayload, null, 2))
      .catch(() => {});
    setCopiedJson(true);
    setTimeout(() => setCopiedJson(false), 1800);
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div className="rounded-xl border border-slate-800 bg-slate-950/75 p-4 space-y-2">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
            <Cpu className="h-4 w-4 text-sky-400" />
            <span>Ingest &amp; ASR-Pipeline</span>
          </div>
          <div className="space-y-1 text-xs text-slate-300">
            <div className="flex justify-between">
              <span className="text-slate-400">Persistierte Samples:</span>
              <span className="font-mono font-semibold">
                {sampleCount.toLocaleString('de-DE')} ({sampleSec}s)
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Persistierte Chunks:</span>
              <span className="font-mono font-semibold">
                {recording.ingest?.durable_chunk_count ?? 0}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">
                ASR-Jobs (offen / fertig / fehler):
              </span>
              <span className="font-mono font-semibold">
                {recording.asr?.pending ?? 0} / {recording.asr?.completed ?? 0}{' '}
                / {recording.asr?.failed ?? 0}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Verarbeitungsstatus:</span>
              <span className="font-semibold">{recording.processing}</span>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-950/75 p-4 space-y-2">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
            <Activity className="h-4 w-4 text-emerald-400" />
            <span>WebRTC &amp; Signaling</span>
          </div>
          <div className="space-y-1 text-xs text-slate-300">
            <div className="flex justify-between">
              <span className="text-slate-400">Gebundene Receiver:</span>
              <span className="font-mono font-semibold">
                {live?.bound_receivers ?? 0} / {live?.total_receivers ?? 0} (mit
                Name: {live?.bound_named_receivers ?? 0})
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Erkannte Teilnehmer:</span>
              <span className="font-mono font-semibold">
                {live?.dom_or_signaled_participants ?? 0} (DOM:{' '}
                {live?.dom_participants ?? 0})
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">SDP / DataChannels:</span>
              <span className="font-mono font-semibold">
                {live?.sdp_descriptions ?? 0} / {live?.data_channel_count ?? 0}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Letzter Worker-Heartbeat:</span>
              <span className="font-mono">
                {live?.last_heartbeat_at
                  ? new Date(live.last_heartbeat_at).toLocaleTimeString('de-DE')
                  : '–'}
              </span>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-950/75 p-4 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
              <Mail className="h-4 w-4 text-violet-400" />
              <span>E-Mail-Zustellung</span>
            </div>
            {canRetryMail && (
              <Button
                variant="secondary"
                size="sm"
                id="retry-mail-btn"
                onClick={onRetryMail}
                disabled={retryingMail}
              >
                <RefreshCw className="h-3 w-3" />
                <span>Mail erneut senden</span>
              </Button>
            )}
          </div>
          <div className="space-y-1 text-xs text-slate-300">
            <div className="flex justify-between">
              <span className="text-slate-400">Status:</span>
              <span className="font-semibold">
                {recording.delivery?.status ?? 'pending'}
              </span>
            </div>
            {recording.delivery?.attempts != null && (
              <div className="flex justify-between">
                <span className="text-slate-400">Zustellversuche:</span>
                <span className="font-mono">{recording.delivery.attempts}</span>
              </div>
            )}
            {recording.delivery?.error && (
              <div className="text-red-300">
                Fehler: {recording.delivery.error}
              </div>
            )}
            {recording.delivery?.accepted_recipients &&
              recording.delivery.accepted_recipients.length > 0 && (
                <div className="truncate text-[11px] text-slate-400">
                  Empfänger: {recording.delivery.accepted_recipients.join(', ')}
                </div>
              )}
          </div>
        </div>
      </div>

      {recording.attempts && recording.attempts.length > 0 && (
        <div className="rounded-xl border border-slate-800 bg-slate-950/75 p-4 space-y-3">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
            <Server className="h-4 w-4 text-sky-400" />
            <span>Worker-Attempts ({recording.attempts.length})</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-800 text-[11px] text-slate-400">
                <tr>
                  <th className="pb-2 pr-3">Attempt-ID</th>
                  <th className="pb-2 pr-3">Kubernetes-Job</th>
                  <th className="pb-2 pr-3">Endgrund</th>
                  <th className="pb-2">Beendet</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-mono text-[11px]">
                {recording.attempts.map((a) => (
                  <tr key={a.id}>
                    <td className="py-2 pr-3 text-slate-300">
                      {a.id.slice(0, 8)}…
                    </td>
                    <td className="py-2 pr-3 text-slate-400">
                      {a.job_name || '–'}
                    </td>
                    <td className="py-2 pr-3 text-slate-200">
                      {a.end_reason || 'aktiv'}
                    </td>
                    <td className="py-2 text-slate-400">
                      {a.ended_at
                        ? new Date(a.ended_at).toLocaleTimeString('de-DE')
                        : 'läuft'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-slate-800 bg-slate-950/75 p-4 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            REST-API / Integrations-Abruf (cURL)
          </span>
          <Button variant="secondary" size="sm" onClick={handleCopyCurl}>
            {copiedCurl ? (
              <>
                <Check className="h-3.5 w-3.5 text-emerald-400" />
                <span>cURL kopiert</span>
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                <span>cURL kopieren</span>
              </>
            )}
          </Button>
        </div>
        <pre className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-900/90 p-3 font-mono text-[11px] text-sky-300">
          {curlSnippet}
        </pre>
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-950/75 p-4 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            WebRTC-Receiver &amp; Worker-Diagnose (JSON)
          </span>
          <Button variant="secondary" size="sm" onClick={handleCopyJson}>
            {copiedJson ? (
              <>
                <Check className="h-3.5 w-3.5 text-emerald-400" />
                <span>JSON kopiert</span>
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                <span>JSON kopieren</span>
              </>
            )}
          </Button>
        </div>
        <pre className="max-h-80 overflow-auto rounded-lg border border-slate-800 bg-slate-900/90 p-3 font-mono text-[11px] text-slate-300">
          {JSON.stringify(rawDiagPayload, null, 2)}
        </pre>
      </div>
    </div>
  );
}
