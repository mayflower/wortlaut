import React, { useState } from 'react';
import {
  ArrowRight,
  Calendar,
  CalendarPlus,
  Check,
  CheckCircle2,
  Copy,
  Mail,
  XCircle,
} from 'lucide-react';
import { getFailureReasons, getInstanceInfo } from '../api';
import type { CalendarEvent } from '../types';
import { Button, ProviderBadge, cn } from './ui/primitives';

export interface CalendarWorkspaceProps {
  events: CalendarEvent[];
  onSelectRecording: (recordingId: string) => void;
  onOpenImportModal: () => void;
}

const CALENDAR_STATUS_LABELS: Record<string, string> = {
  accepted: 'Eingeplant',
  cancelled: 'Abgesagt',
  rejected: 'Abgelehnt',
  ignored: 'Ignoriert',
};

export function CalendarWorkspace({
  events,
  onSelectRecording,
  onOpenImportModal,
}: CalendarWorkspaceProps) {
  const instance = getInstanceInfo();
  const failureReasons = getFailureReasons();
  const [copiedMail, setCopiedMail] = useState(false);

  const handleCopyMail = async () => {
    if (!instance.botEmail || !navigator.clipboard) return;
    await navigator.clipboard.writeText(instance.botEmail).catch(() => {});
    setCopiedMail(true);
    setTimeout(() => setCopiedMail(false), 1800);
  };

  return (
    <section id="calendar-details" className="mx-auto max-w-6xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-white">
            <Calendar className="h-5 w-5 text-sky-400" />
            <span>Kalender &amp; E-Mail-Einladungen</span>
          </h1>
          <p className="text-xs text-slate-400">
            Automatische Teilnahme an Einzel- und Serienterminen per
            Kalendereinladung oder <code>.ics</code>-Import.
          </p>
        </div>
        <Button variant="primary" size="md" onClick={onOpenImportModal}>
          <CalendarPlus className="h-4 w-4" />
          <span>.ics / .eml Einladung hochladen</span>
        </Button>
      </div>

      {/* Onboarding / How-To Card for Mara */}
      <div className="grid grid-cols-1 gap-4 rounded-xl border border-slate-800 bg-slate-900/80 p-5 md:grid-cols-2">
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-sky-400">
            <Mail className="h-4 w-4" />
            <span>Option 1: Direkt im Kalender als Gast einladen</span>
          </div>
          {instance.botEmail ? (
            <>
              <p className="text-xs leading-relaxed text-slate-300">
                Fügen Sie in Google Calendar, Outlook oder Apple Kalender
                folgende Bot-Adresse als Teilnehmer zu Ihrem Termin hinzu:
              </p>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <code className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 font-mono text-xs font-semibold text-white">
                  {instance.botEmail}
                </code>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleCopyMail}
                >
                  {copiedMail ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-emerald-400" />
                      <span>Kopiert!</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5" />
                      <span>Adresse kopieren</span>
                    </>
                  )}
                </Button>
              </div>
            </>
          ) : (
            <p className="text-xs leading-relaxed text-slate-400">
              Sobald ein IMAP-Postfach konfiguriert ist, können Sie den Bot
              direkt per E-Mail-Einladung zu Terminen hinzufügen. Nutzen Sie
              bis dahin den manuellen Datei-Import rechts.
            </p>
          )}
        </div>

        <div className="space-y-2 border-t border-slate-800/80 pt-3 md:border-t-0 md:border-l md:pl-5 md:pt-0">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-emerald-400">
            <CalendarPlus className="h-4 w-4" />
            <span>Option 2: .ics- oder .eml-Datei hochladen</span>
          </div>
          <p className="text-xs leading-relaxed text-slate-300">
            Laden Sie eine gespeicherte Kalendereinladung (<code>.ics</code>)
            oder weitergeleitete E-Mail (<code>.eml</code>) direkt hier im
            Browser hoch. Terminverschiebungen und Absagen werden automatisch
            synchronisiert.
          </p>
        </div>
      </div>

      <div
        id="calendar-list"
        className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/75"
      >
        {events.length === 0 ? (
          <div className="p-12 text-center space-y-3">
            <Mail className="mx-auto h-8 w-8 text-slate-600" />
            <div className="text-sm font-medium text-slate-200">
              Noch keine Kalendereinladungen vorhanden
            </div>
            <p className="mx-auto max-w-md text-xs text-slate-400">
              Laden Sie oben eine <code>.ics</code>-Einladung hoch oder fügen
              Sie die Bot-Adresse zu einem Termin mit Google Meet-, Microsoft
              Teams- oder Webex-Link hinzu.
            </p>
            <Button variant="secondary" size="sm" onClick={onOpenImportModal}>
              <CalendarPlus className="h-3.5 w-3.5" />
              <span>Erste .ics-Datei importieren</span>
            </Button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-800 bg-slate-950/80 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Termin &amp; Konferenzsystem</th>
                  <th className="px-4 py-3">Eingeladen von</th>
                  <th className="px-4 py-3">Geplante Zeit</th>
                  <th className="px-4 py-3 text-right">Aufnahme</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {events.map((ev, idx) => {
                  const recId =
                    ev.recording_id ||
                    (ev.recording_ids && ev.recording_ids[0]) ||
                    null;
                  const isAccepted = ev.status === 'accepted';
                  const statusLabel =
                    CALENDAR_STATUS_LABELS[ev.status] || ev.status;
                  const reasonText =
                    ev.reason && failureReasons[ev.reason]
                      ? failureReasons[ev.reason]
                      : ev.reason;
                  const startStr = ev.starts_at
                    ? new Date(ev.starts_at).toLocaleString('de-DE', {
                        day: '2-digit',
                        month: '2-digit',
                        year: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                    : 'Serientermin';

                  return (
                    <tr
                      key={`${ev.uid}-${ev.recurrence_id}-${idx}`}
                      className="hover:bg-slate-800/40 transition-colors"
                    >
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span
                          className={cn(
                            'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold border',
                            isAccepted
                              ? 'border-emerald-800/80 bg-emerald-950/80 text-emerald-300'
                              : 'border-red-800/80 bg-red-950/80 text-red-300'
                          )}
                        >
                          {isAccepted ? (
                            <CheckCircle2 className="h-3 w-3" />
                          ) : (
                            <XCircle className="h-3 w-3" />
                          )}
                          {statusLabel}
                        </span>
                        {reasonText && (
                          <div className="mt-1 text-[11px] text-red-300 max-w-xs whitespace-normal">
                            {reasonText}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          {ev.provider && (
                            <ProviderBadge provider={ev.provider} />
                          )}
                          <span
                            className="font-semibold text-slate-100"
                            title={`iCal-UID: ${ev.uid} (Sequenz #${ev.sequence})`}
                          >
                            {ev.title || 'Kalendertermin'}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-slate-300">
                        {ev.organizer || '–'}
                      </td>
                      <td className="px-4 py-3 text-slate-300 whitespace-nowrap">
                        {startStr}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        {recId ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => onSelectRecording(recId)}
                          >
                            <span>Meeting öffnen</span>
                            <ArrowRight className="h-3.5 w-3.5" />
                          </Button>
                        ) : (
                          <span className="text-slate-500">–</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
