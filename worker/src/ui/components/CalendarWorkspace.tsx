import React from 'react';
import {
  ArrowRight,
  Calendar,
  CalendarPlus,
  CheckCircle2,
  Mail,
  XCircle,
} from 'lucide-react';
import type { CalendarEvent } from '../types';
import { Button, ProviderBadge, cn } from './ui/primitives';

export interface CalendarWorkspaceProps {
  events: CalendarEvent[];
  onSelectRecording: (recordingId: string) => void;
  onOpenImportModal: () => void;
}

export function CalendarWorkspace({
  events,
  onSelectRecording,
  onOpenImportModal,
}: CalendarWorkspaceProps) {
  return (
    <section
      id="calendar-details"
      className="mx-auto max-w-6xl space-y-4 p-4 sm:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/80 p-5">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-lg font-bold text-white">
            <Calendar className="h-5 w-5 text-sky-400" />
            <span>Kalender- &amp; E-Mail-Einladungen</span>
          </h1>
          <p className="text-xs text-slate-400">
            Übersicht aller per IMAP/DKIM oder Datei-Upload importierten
            Termin- und Soforteinladungen.
          </p>
        </div>
        <Button variant="primary" size="md" onClick={onOpenImportModal}>
          <CalendarPlus className="h-4 w-4" />
          <span>.ics / .eml Einladung importieren</span>
        </Button>
      </div>

      <div
        id="calendar-list"
        className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/75"
      >
        {events.length === 0 ? (
          <div className="p-12 text-center space-y-3">
            <Mail className="mx-auto h-8 w-8 text-slate-600" />
            <div className="text-sm font-medium text-slate-200">
              Noch keine Kalendereinladungen importiert
            </div>
            <p className="mx-auto max-w-md text-xs text-slate-400">
              Laden Sie die Bot-Adresse direkt in Ihrem Kalender zu einem Google
              Meet-, Microsoft Teams- oder Webex-Termin ein oder importieren Sie
              hier eine <code>.ics</code>-Datei.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-800 bg-slate-950/80 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Titel &amp; Provider</th>
                  <th className="px-4 py-3">Organisator</th>
                  <th className="px-4 py-3">Terminzeit</th>
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
                  const startStr = ev.starts_at
                    ? new Date(ev.starts_at).toLocaleString('de-DE')
                    : 'Serientermin / Regel';

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
                          {ev.status}
                        </span>
                        {ev.reason && (
                          <div className="mt-1 text-[11px] text-red-300">
                            {ev.reason}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {ev.provider && (
                            <ProviderBadge provider={ev.provider} />
                          )}
                          <span className="font-semibold text-slate-100">
                            {ev.title || ev.uid}
                          </span>
                        </div>
                        <div className="mt-0.5 text-[11px] text-slate-500">
                          UID: {ev.uid.slice(0, 28)} · Seq #{ev.sequence}
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
                            <span>Zur Aufnahme</span>
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
