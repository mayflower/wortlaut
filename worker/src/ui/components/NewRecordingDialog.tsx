import React, { useEffect, useState } from 'react';
import { CalendarPlus, Link2, Upload, Video } from 'lucide-react';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@astryxdesign/core/SegmentedControl';
import { TextInput } from '@astryxdesign/core/TextInput';
import { TextArea } from '@astryxdesign/core/TextArea';
import { Selector } from '@astryxdesign/core/Selector';
import { Button } from '@astryxdesign/core/Button';
import { Banner } from '@astryxdesign/core/Banner';
import { HStack } from '@astryxdesign/core/HStack';
import { VStack } from '@astryxdesign/core/VStack';
import { Text } from '@astryxdesign/core/Text';
import {
  createRecording,
  detectProviderFromUrl,
  getInstanceInfo,
  importCalendarPayload,
} from '../api';
import type { RecordingSummary } from '../types';
import { ProviderBadge } from './ui/primitives';

export interface NewRecordingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  token: string;
  initialTab?: 'link' | 'ics';
  onCreatedRecording: (recordingId: string) => void;
  onImportedCalendar: (recordingId: string | null) => void;
}

const JOIN_MODE_OPTIONS = [
  { value: 'live', label: 'Sofort beitreten (Live)' },
  { value: 'scheduled', label: 'Zeitfenster planen' },
];

const DURATION_OPTIONS = [
  { value: '30', label: '30 Minuten' },
  { value: '60', label: '60 Minuten' },
  { value: '90', label: '90 Minuten' },
  { value: '120', label: '120 Minuten' },
];

export function NewRecordingDialog({
  open,
  onOpenChange,
  token,
  initialTab = 'link',
  onCreatedRecording,
  onImportedCalendar,
}: NewRecordingDialogProps) {
  const [tab, setTab] = useState<'link' | 'ics'>(initialTab);

  useEffect(() => {
    if (open) {
      setTab(initialTab);
    }
  }, [open, initialTab]);

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
  const instance = getInstanceInfo();

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
        const startDate = new Date(startsAt);
        const endDate = new Date(endsAt);
        if (endDate <= startDate) {
          throw new Error('Die Endzeit muss nach der Startzeit liegen.');
        }
        startIso = startDate.toISOString();
        endIso = endDate.toISOString();
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
    <Dialog
      isOpen={open}
      onOpenChange={onOpenChange}
      width={560}
      purpose="form"
    >
      <DialogHeader
        title="Bot in ein Meeting schicken"
        subtitle="Starten Sie einen Bot sofort per Meeting-Link oder importieren Sie eine Kalendereinladung (.ics / .eml)."
        onOpenChange={onOpenChange}
      />

      <VStack gap={3}>
        <SegmentedControl
          size="sm"
          layout="fill"
          label="Startmethode"
          value={tab}
          onChange={(v) => setTab(v as 'link' | 'ics')}
        >
          <SegmentedControlItem
            value="link"
            label="Meeting-Link (Ad-hoc / Geplant)"
            icon={<Link2 className="h-3.5 w-3.5" />}
          />
          <SegmentedControlItem
            value="ics"
            label="Kalendereinladung (.ics / .eml)"
            icon={<CalendarPlus className="h-3.5 w-3.5" />}
          />
        </SegmentedControl>

        {error && (
          <Banner
            status="error"
            container="card"
            title={error}
            isDismissable
            onDismiss={() => setError(null)}
          />
        )}

        {tab === 'link' ? (
          <form id="modal-dispatch-form" onSubmit={handleDispatchSubmit}>
            <FormLayout direction="vertical">
              <VStack gap={1}>
                <TextInput
                  type="url"
                  label="Meeting-Link (Google Meet, Microsoft Teams oder Webex)"
                  isRequired
                  value={meetingUrl}
                  onChange={setMeetingUrl}
                  placeholder="https://meet.google.com/... oder https://teams.microsoft.com/..."
                  startIcon={<Video className="h-4 w-4" />}
                />
                {detectedProvider && (
                  <HStack gap={1.5} vAlign="center">
                    <Text type="supporting" color="secondary">
                      Erkanntes System:
                    </Text>
                    <ProviderBadge provider={detectedProvider} />
                  </HStack>
                )}
              </VStack>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <TextInput
                  type="text"
                  label="Meeting-Titel"
                  isOptional
                  value={title}
                  onChange={setTitle}
                  placeholder="z. B. Architektur-Sync"
                />
                <TextInput
                  type="text"
                  label="Bot-Anzeigename"
                  isOptional
                  value={guestName}
                  onChange={setGuestName}
                  placeholder={instance.assistantName}
                />
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Selector
                  label="Start-Modus"
                  options={JOIN_MODE_OPTIONS}
                  value={joinMode}
                  onChange={(v) => setJoinMode(v as 'live' | 'scheduled')}
                />
                {joinMode === 'live' && (
                  <div id="modal-duration-field">
                    <Selector
                      label="Maximale Aufnahmedauer"
                      options={DURATION_OPTIONS}
                      value={durationMin}
                      onChange={setDurationMin}
                    />
                  </div>
                )}
              </div>

              {joinMode === 'scheduled' && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <VStack gap={1} id="modal-start-field">
                    <Text as="label" type="supporting" weight="semibold">
                      Startzeit
                    </Text>
                    <input
                      id="modal-starts-at"
                      type="datetime-local"
                      value={startsAt}
                      onChange={(e) => setStartsAt(e.target.value)}
                      className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-background-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)]"
                    />
                  </VStack>
                  <VStack gap={1} id="modal-end-field">
                    <Text as="label" type="supporting" weight="semibold">
                      Endzeit
                    </Text>
                    <input
                      id="modal-ends-at"
                      type="datetime-local"
                      value={endsAt}
                      onChange={(e) => setEndsAt(e.target.value)}
                      className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-background-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)]"
                    />
                  </VStack>
                </div>
              )}

              <HStack justify="end" gap={2}>
                <Button
                  type="button"
                  variant="ghost"
                  label="Abbrechen"
                  onClick={() => onOpenChange(false)}
                />
                <Button
                  type="submit"
                  variant="primary"
                  isLoading={submitting}
                  label={submitting ? 'Wird gestartet…' : 'Bot starten'}
                />
              </HStack>
            </FormLayout>
          </form>
        ) : (
          <form onSubmit={handleIcsSubmit}>
            <FormLayout direction="vertical">
              {instance.mail.allowedDomains.length > 0 && (
                <Text type="supporting" color="secondary">
                  Hinweis: Der in der <code>.ics</code>-Datei eingetragene{' '}
                  <code>ORGANIZER</code> muss zu einer freigeschalteten Domain
                  gehören (
                  {instance.mail.allowedDomains.map((d) => `@${d}`).join(', ')}
                  ). Für externe Kundentermine nutzen Sie bitte den Reiter{' '}
                  <strong>Meeting-Link</strong>.
                </Text>
              )}

              <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-background-muted)]/40 p-4 text-center hover:border-[var(--color-text-accent)] transition-colors">
                <Upload className="mb-1.5 h-5 w-5 text-[var(--color-text-accent)]" />
                <Text type="supporting" weight="medium" color="primary">
                  .ics- oder .eml-Datei auswählen
                </Text>
                <Text type="supporting" color="secondary">
                  Oder Inhalt direkt in das Textfeld unten einfügen
                </Text>
                <input
                  type="file"
                  accept=".ics,.eml,text/calendar,message/rfc822"
                  onChange={handleFileChange}
                  className="hidden"
                />
              </label>

              <TextArea
                label="iCalendar / E-Mail-Inhalt"
                rows={6}
                value={icsText}
                onChange={setIcsText}
                placeholder="BEGIN:VCALENDAR..."
              />

              <HStack justify="end" gap={2}>
                <Button
                  type="button"
                  variant="ghost"
                  label="Abbrechen"
                  onClick={() => onOpenChange(false)}
                />
                <Button
                  type="submit"
                  variant="primary"
                  isLoading={submitting}
                  label={
                    submitting ? 'Importiere…' : 'Einladung importieren'
                  }
                />
              </HStack>
            </FormLayout>
          </form>
        )}
      </VStack>
    </Dialog>
  );
}
