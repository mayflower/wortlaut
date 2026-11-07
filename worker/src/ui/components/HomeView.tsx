import React, { useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Calendar,
  ChevronDown,
  ChevronUp,
  Clock,
  FileText,
  Mic,
  Play,
  Radio,
  Sparkles,
  Video,
} from 'lucide-react';
import {
  createRecording,
  detectProviderFromUrl,
  formatDurationHuman,
  formatRecordingTitle,
  getFailureReasons,
} from '../api';
import type { CalendarEvent, RecordingSummary } from '../types';
import { Button, ProviderBadge, StatusBadge } from './ui/primitives';

export interface HomeViewProps {
  token: string;
  recordings: RecordingSummary[];
  calendarEvents: CalendarEvent[];
  onOpenRecording: (id: string) => void;
  onNavigateMeetings: () => void;
  onNavigateCalendar: () => void;
  onOpenIcsImport: () => void;
  onCreatedRecording: (id: string) => void;
}

export function HomeView({
  token,
  recordings,
  calendarEvents,
  onOpenRecording,
  onNavigateMeetings,
  onNavigateCalendar,
  onOpenIcsImport,
  onCreatedRecording,
}: HomeViewProps) {
  const [meetingUrl, setMeetingUrl] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [title, setTitle] = useState('');
  const [guestName, setGuestName] = useState('');
  const [joinMode, setJoinMode] = useState<'live' | 'scheduled'>('live');
  const [durationMin, setDurationMin] = useState('60');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const detectedProvider = detectProviderFromUrl(meetingUrl);
  const failureReasons = getFailureReasons();

  const activeRecordings = recordings.filter((r) =>
    [
      'starting',
      'preparing',
      'joining',
      'waiting_admission',
      'capturing',
    ].includes(r.participation)
  );

  const scheduledRecordings = recordings.filter(
    (r) => r.participation === 'scheduled'
  );

  const recentCompleted = recordings
    .filter((r) => r.participation === 'ended')
    .slice(0, 8);

  const handleQuickStart = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!meetingUrl.trim()) return;
    setError(null);
    setSubmitting(true);
    try {
      let startIso: string;
      let endIso: string;
      if (joinMode === 'live') {
        const mins = Number(durationMin) || 60;
        const now = new Date();
        startIso = now.toISOString();
        endIso = new Date(now.getTime() + mins * 60000).toISOString();
      } else {
        if (!startsAt || !endsAt) {
          throw new Error('Bitte Start- und Endzeit angeben.');
        }
        startIso = new Date(startsAt).toISOString();
        endIso = new Date(endsAt).toISOString();
      }
      const created = await createRecording(token, {
        meeting_url: meetingUrl.trim(),
        starts_at: startIso,
        ends_at: endIso,
        title: title.trim() || null,
        guest_name: guestName.trim() || null,
      });
      setMeetingUrl('');
      setTitle('');
      onCreatedRecording(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-8 p-6 lg:p-8">
      {/* Hero Quick-Join Card (like Otter / Fireflies top bar) */}
      <section className="rounded-2xl border border-slate-800 bg-gradient-to-b from-slate-900 to-slate-900/70 p-6 shadow-xl">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-lg font-bold text-white">
              Bot in ein Meeting schicken
            </h1>
            <p className="text-xs text-slate-400">
              Meeting-Link einfügen, um sofort live mitzuschreiben oder einen
              Termin vorab einzuplanen.
            </p>
          </div>
          {detectedProvider && <ProviderBadge provider={detectedProvider} />}
        </div>

        <form id="dispatch-form" onSubmit={handleQuickStart} className="space-y-3">
          <div className="flex flex-col gap-2.5 sm:flex-row">
            <div className="relative flex-1">
              <Video className="pointer-events-none absolute left-3.5 top-3 h-4 w-4 text-slate-400" />
              <input
                id="meeting-url"
                type="url"
                required
                value={meetingUrl}
                onChange={(e) => setMeetingUrl(e.target.value)}
                placeholder="Meeting-Link einfügen (Google Meet, Microsoft Teams oder Webex)…"
                className="w-full rounded-xl border border-slate-700 bg-slate-950 pl-10 pr-4 py-2.5 text-sm text-white placeholder-slate-500 focus:border-sky-500 focus:outline-none"
              />
            </div>
            <Button
              type="submit"
              variant="primary"
              size="lg"
              disabled={submitting}
              className="rounded-xl px-6 py-2.5 font-semibold shrink-0"
            >
              <Play className="h-4 w-4 fill-current" />
              <span>
                {submitting
                  ? 'Startet…'
                  : joinMode === 'live'
                    ? 'Jetzt aufzeichnen'
                    : 'Termin planen'}
              </span>
            </Button>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400 hover:text-sky-400 cursor-pointer"
            >
              {showAdvanced ? (
                <ChevronUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
              <span>
                Optionen: Meeting-Titel, Bot-Name oder späteren Zeitpunkt planen
              </span>
            </button>

            <button
              type="button"
              onClick={onOpenIcsImport}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-sky-400 hover:text-sky-300 cursor-pointer"
            >
              <Calendar className="h-3.5 w-3.5" />
              <span>Oder .ics-Kalendereinladung hochladen →</span>
            </button>
          </div>

          {showAdvanced && (
            <div className="mt-3 grid grid-cols-1 gap-3 rounded-xl border border-slate-800/90 bg-slate-950/60 p-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="space-y-1">
                <label
                  htmlFor="meeting-title"
                  className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400"
                >
                  Titel (optional)
                </label>
                <input
                  id="meeting-title"
                  type="text"
                  maxLength={200}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="z. B. Kunden-Workshop"
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:border-sky-500 focus:outline-none"
                />
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="guest-name"
                  className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400"
                >
                  Bot-Name (optional)
                </label>
                <input
                  id="guest-name"
                  type="text"
                  maxLength={120}
                  value={guestName}
                  onChange={(e) => setGuestName(e.target.value)}
                  placeholder="wortlaut"
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:border-sky-500 focus:outline-none"
                />
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="join-mode"
                  className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400"
                >
                  Zeitpunkt
                </label>
                <select
                  id="join-mode"
                  value={joinMode}
                  onChange={(e) =>
                    setJoinMode(e.target.value as 'live' | 'scheduled')
                  }
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-white focus:border-sky-500 focus:outline-none"
                >
                  <option value="live">Sofort beitreten (Live)</option>
                  <option value="scheduled">Für später planen</option>
                </select>
              </div>

              {joinMode === 'live' ? (
                <div className="space-y-1" id="duration-field">
                  <label
                    htmlFor="duration-min"
                    className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400"
                  >
                    Max. Dauer
                  </label>
                  <select
                    id="duration-min"
                    value={durationMin}
                    onChange={(e) => setDurationMin(e.target.value)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-white focus:border-sky-500 focus:outline-none"
                  >
                    <option value="30">30 Minuten</option>
                    <option value="60">60 Minuten</option>
                    <option value="90">90 Minuten</option>
                    <option value="120">120 Minuten</option>
                  </select>
                </div>
              ) : (
                <div className="col-span-full grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-1" id="start-field">
                    <label
                      htmlFor="starts-at"
                      className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400"
                    >
                      Startzeit
                    </label>
                    <input
                      id="starts-at"
                      type="datetime-local"
                      value={startsAt}
                      onChange={(e) => setStartsAt(e.target.value)}
                      className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-white focus:border-sky-500 focus:outline-none"
                    />
                  </div>
                  <div className="space-y-1" id="end-field">
                    <label
                      htmlFor="ends-at"
                      className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400"
                    >
                      Endzeit
                    </label>
                    <input
                      id="ends-at"
                      type="datetime-local"
                      value={endsAt}
                      onChange={(e) => setEndsAt(e.target.value)}
                      className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-white focus:border-sky-500 focus:outline-none"
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-red-800/80 bg-red-950/60 px-3.5 py-2 text-xs text-red-200">
              {error}
            </div>
          )}
        </form>
      </section>

      {/* Active / Live Meetings Section */}
      {activeRecordings.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-400 animate-ping" />
            <h2 className="text-sm font-bold uppercase tracking-wider text-emerald-300">
              Aktuell laufende Meetings ({activeRecordings.length})
            </h2>
          </div>

          <div className="grid grid-cols-1 gap-3">
            {activeRecordings.map((rec) => {
              const isLobby = rec.participation === 'waiting_admission';
              const audioSec = Math.round(
                (rec.quality?.durable_sample_count || 0) / 16000
              );
              return (
                <div
                  key={rec.id}
                  onClick={() => onOpenRecording(rec.id)}
                  className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-emerald-700/60 bg-slate-900/90 p-4 shadow-md transition-all hover:border-emerald-500 cursor-pointer"
                >
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <ProviderBadge provider={rec.provider} />
                      <span className="text-base font-bold text-white">
                        {formatRecordingTitle(rec)}
                      </span>
                      <StatusBadge
                        participation={rec.participation}
                        processing={rec.processing}
                      />
                    </div>
                    {isLobby ? (
                      <div className="flex items-center gap-1.5 text-xs font-medium text-amber-300">
                        <AlertTriangle className="h-3.5 w-3.5" />
                        <span>
                          Bot wartet im Warteraum – bitte jetzt im Meeting
                          zulassen!
                        </span>
                      </div>
                    ) : (
                      <div className="text-xs text-slate-400">
                        Erfasstes Audio: {formatDurationHuman(audioSec)} ·
                        Klicken für Live-Transkript
                      </div>
                    )}
                  </div>

                  <Button variant="primary" size="sm">
                    <span>Live-Ansicht öffnen</span>
                    <ArrowRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Upcoming / Scheduled Meetings */}
      {scheduledRecordings.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
              <Clock className="h-3.5 w-3.5 text-sky-400" />
              <span>Anstehende geplante Termine ({scheduledRecordings.length})</span>
            </h2>
            {calendarEvents.length > 0 && (
              <button
                type="button"
                onClick={onNavigateCalendar}
                className="text-xs text-sky-400 hover:underline cursor-pointer"
              >
                Kalender-Eingang ({calendarEvents.length}) →
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {scheduledRecordings.slice(0, 4).map((rec) => (
              <div
                key={rec.id}
                onClick={() => onOpenRecording(rec.id)}
                className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/70 p-3.5 hover:border-slate-700 cursor-pointer"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    <ProviderBadge provider={rec.provider} />
                    <span className="truncate text-sm font-semibold text-slate-100">
                      {formatRecordingTitle(rec)}
                    </span>
                  </div>
                  <div className="text-xs text-slate-400">
                    Start: {new Date(rec.starts_at).toLocaleString('de-DE')}
                  </div>
                </div>
                <ArrowRight className="h-4 w-4 shrink-0 text-slate-500" />
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Recent Recordings List (like Otter / Fireflies Recent Conversations) */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
            <FileText className="h-3.5 w-3.5 text-sky-400" />
            <span>Letzte Besprechungen &amp; Transkripte</span>
          </h2>
          <button
            type="button"
            onClick={onNavigateMeetings}
            className="inline-flex items-center gap-1 text-xs font-semibold text-sky-400 hover:text-sky-300 cursor-pointer"
          >
            <span>Alle Meetings durchsuchen ({recordings.length})</span>
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>

        {recentCompleted.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900/40 p-10 text-center space-y-2">
            <Mic className="mx-auto h-7 w-7 text-slate-600" />
            <div className="text-sm font-medium text-slate-300">
              Noch keine abgeschlossenen Aufzeichnungen
            </div>
            <p className="text-xs text-slate-500">
              Fügen Sie oben einen Meeting-Link ein, um Ihre erste Besprechung
              aufzuzeichnen und zu transkribieren.
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/75 divide-y divide-slate-800/80">
            {recentCompleted.map((rec) => {
              const reason = rec.participation_reason;
              const isNormalEnd =
                !reason || reason === 'normal' || reason === 'room_empty';
              const hasError =
                rec.processing === 'failed' || !isNormalEnd;
              const reasonHint =
                reason && failureReasons[reason]
                  ? failureReasons[reason]
                  : !isNormalEnd
                    ? reason
                    : null;
              const samples = rec.quality?.durable_sample_count || 0;
              const audioSec = Math.round(samples / 16000);

              return (
                <div
                  key={rec.id}
                  onClick={() => onOpenRecording(rec.id)}
                  className="flex flex-wrap items-center justify-between gap-4 px-4 py-3.5 transition-colors hover:bg-slate-800/50 cursor-pointer"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <span className="text-sm font-semibold text-slate-100">
                        {formatRecordingTitle(rec)}
                      </span>
                      <ProviderBadge provider={rec.provider} />
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
                      <span>
                        {new Date(rec.starts_at).toLocaleString('de-DE', {
                          day: '2-digit',
                          month: '2-digit',
                          year: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                      {audioSec > 0 && (
                        <span>· Dauer: {formatDurationHuman(audioSec)}</span>
                      )}
                      {reasonHint && (
                        <span className="text-red-300">· {reasonHint}</span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <StatusBadge
                      participation={rec.participation}
                      processing={rec.processing}
                      hasError={hasError}
                    />
                    <ArrowRight className="h-4 w-4 text-slate-500" />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
