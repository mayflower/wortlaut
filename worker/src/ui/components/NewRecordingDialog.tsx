import React, { useState } from 'react';
import { CalendarPlus, Link2, Upload, Video } from 'lucide-react';
import {
  createRecording,
  detectProviderFromUrl,
  importCalendarPayload,
} from '../api';
import type { RecordingSummary } from '../types';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  ProviderBadge,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from './ui/primitives';

export interface NewRecordingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  token: string;
  onCreatedRecording: (recordingId: string) => void;
  onImportedCalendar: (recordingId: string | null) => void;
}

export function NewRecordingDialog({
  open,
  onOpenChange,
  token,
  onCreatedRecording,
  onImportedCalendar,
}: NewRecordingDialogProps) {
  const [tab, setTab] = useState<'link' | 'ics'>('link');
  const [meetingUrl, setMeetingUrl] = useState('');
  const [title, setTitle] = useState('');
  const [guestName, setGuestName] = useState('');
  const [joinMode, setJoinMode] = useState<'live' | 'scheduled'>('live');
  const [durationMin, setDurationMin] = useState('60');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [icsText, setIcsText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const detectedProvider = detectProviderFromUrl(meetingUrl);

  const handleDispatchSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
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
      const created: RecordingSummary = await createRecording(token, {
        meeting_url: meetingUrl.trim(),
        starts_at: startIso,
        ends_at: endIso,
        title: title.trim() || null,
        guest_name: guestName.trim() || null,
      });
      setMeetingUrl('');
      setTitle('');
      onCreatedRecording(created.id);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleIcsSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!icsText.trim()) {
      setError('Bitte eine .ics- oder .eml-Einladung einfügen oder auswählen.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const result = await importCalendarPayload(token, icsText);
      const firstAccepted = (result.events || []).find((ev) => ev.recording_id);
      setIcsText('');
      onImportedCalendar(firstAccepted?.recording_id || null);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setIcsText(text);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg font-semibold text-white">
            <Video className="h-5 w-5 text-sky-400" />
            <span>Bot in ein Meeting schicken</span>
          </DialogTitle>
          <DialogDescription className="text-xs text-slate-400">
            Starten Sie einen Bot sofort per Meeting-Link oder importieren Sie
            eine Kalendereinladung (.ics / .eml).
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as 'link' | 'ics')}>
          <TabsList className="mb-4 w-full justify-start">
            <TabsTrigger value="link" className="flex-1 justify-center">
              <Link2 className="h-3.5 w-3.5" />
              <span>Meeting-Link (Ad-hoc / Geplant)</span>
            </TabsTrigger>
            <TabsTrigger value="ics" className="flex-1 justify-center">
              <CalendarPlus className="h-3.5 w-3.5" />
              <span>Kalendereinladung (.ics / .eml)</span>
            </TabsTrigger>
          </TabsList>

          {error && (
            <div className="mb-4 rounded-lg border border-red-800/80 bg-red-950/60 p-3 text-xs text-red-200">
              {error}
            </div>
          )}

          <TabsContent value="link">
            <form
              id="dispatch-form"
              onSubmit={handleDispatchSubmit}
              className="space-y-4"
            >
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label
                    htmlFor="meeting-url"
                    className="text-xs font-semibold uppercase tracking-wider text-slate-400"
                  >
                    Meeting-Link (Meet, Teams oder Webex)
                  </label>
                  {detectedProvider && (
                    <ProviderBadge provider={detectedProvider} />
                  )}
                </div>
                <input
                  id="meeting-url"
                  type="url"
                  required
                  value={meetingUrl}
                  onChange={(e) => setMeetingUrl(e.target.value)}
                  placeholder="https://meet.google.com/... oder https://teams.microsoft.com/meet/..."
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-sky-500 focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label
                    htmlFor="meeting-title"
                    className="block text-xs font-semibold uppercase tracking-wider text-slate-400"
                  >
                    Meeting-Titel (optional)
                  </label>
                  <input
                    id="meeting-title"
                    type="text"
                    maxLength={200}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="z. B. Architektur-Sync"
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-sky-500 focus:outline-none"
                  />
                </div>
                <div className="space-y-1.5">
                  <label
                    htmlFor="guest-name"
                    className="block text-xs font-semibold uppercase tracking-wider text-slate-400"
                  >
                    Bot-Anzeigename (optional)
                  </label>
                  <input
                    id="guest-name"
                    type="text"
                    maxLength={120}
                    value={guestName}
                    onChange={(e) => setGuestName(e.target.value)}
                    placeholder="wortlaut"
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-sky-500 focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label
                    htmlFor="join-mode"
                    className="block text-xs font-semibold uppercase tracking-wider text-slate-400"
                  >
                    Start-Modus
                  </label>
                  <select
                    id="join-mode"
                    value={joinMode}
                    onChange={(e) =>
                      setJoinMode(e.target.value as 'live' | 'scheduled')
                    }
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus:border-sky-500 focus:outline-none"
                  >
                    <option value="live">Sofort beitreten (Live)</option>
                    <option value="scheduled">Zeitfenster planen</option>
                  </select>
                </div>

                {joinMode === 'live' && (
                  <div className="space-y-1.5" id="duration-field">
                    <label
                      htmlFor="duration-min"
                      className="block text-xs font-semibold uppercase tracking-wider text-slate-400"
                    >
                      Maximale Aufnahmedauer
                    </label>
                    <select
                      id="duration-min"
                      value={durationMin}
                      onChange={(e) => setDurationMin(e.target.value)}
                      className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus:border-sky-500 focus:outline-none"
                    >
                      <option value="30">30 Minuten</option>
                      <option value="60">60 Minuten</option>
                      <option value="90">90 Minuten</option>
                      <option value="120">120 Minuten</option>
                    </select>
                  </div>
                )}
              </div>

              {joinMode === 'scheduled' && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5" id="start-field">
                    <label
                      htmlFor="starts-at"
                      className="block text-xs font-semibold uppercase tracking-wider text-slate-400"
                    >
                      Startzeit
                    </label>
                    <input
                      id="starts-at"
                      type="datetime-local"
                      value={startsAt}
                      onChange={(e) => setStartsAt(e.target.value)}
                      className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus:border-sky-500 focus:outline-none"
                    />
                  </div>
                  <div className="space-y-1.5" id="end-field">
                    <label
                      htmlFor="ends-at"
                      className="block text-xs font-semibold uppercase tracking-wider text-slate-400"
                    >
                      Endzeit
                    </label>
                    <input
                      id="ends-at"
                      type="datetime-local"
                      value={endsAt}
                      onChange={(e) => setEndsAt(e.target.value)}
                      className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus:border-sky-500 focus:outline-none"
                    />
                  </div>
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => onOpenChange(false)}
                >
                  Abbrechen
                </Button>
                <Button type="submit" variant="primary" disabled={submitting}>
                  {submitting ? 'Wird gestartet…' : 'Bot starten'}
                </Button>
              </div>
            </form>
          </TabsContent>

          <TabsContent value="ics">
            <form onSubmit={handleIcsSubmit} className="space-y-4">
              <div className="space-y-2">
                <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-slate-700 bg-slate-950/60 p-4 text-center hover:border-sky-500/80">
                  <Upload className="mb-1.5 h-5 w-5 text-sky-400" />
                  <span className="text-xs font-medium text-slate-200">
                    .ics- oder .eml-Datei auswählen
                  </span>
                  <span className="text-[11px] text-slate-400">
                    Oder Inhalt direkt in das Textfeld unten einfügen
                  </span>
                  <input
                    type="file"
                    accept=".ics,.eml,text/calendar,message/rfc822"
                    onChange={handleFileChange}
                    className="hidden"
                  />
                </label>

                <textarea
                  rows={6}
                  value={icsText}
                  onChange={(e) => setIcsText(e.target.value)}
                  placeholder="BEGIN:VCALENDAR..."
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 font-mono text-xs text-slate-200 placeholder-slate-500 focus:border-sky-500 focus:outline-none"
                />
              </div>

              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => onOpenChange(false)}
                >
                  Abbrechen
                </Button>
                <Button type="submit" variant="primary" disabled={submitting}>
                  {submitting ? 'Importiere…' : 'Einladung importieren'}
                </Button>
              </div>
            </form>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
