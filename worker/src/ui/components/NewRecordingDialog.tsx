import React, { useEffect, useState } from 'react';
import { CalendarPlus, Link2, Upload, Video } from 'lucide-react';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
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
import { useI18n } from '../i18n';
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

export function NewRecordingDialog({
  open,
  onOpenChange,
  token,
  initialTab = 'link',
  onCreatedRecording,
  onImportedCalendar,
}: NewRecordingDialogProps) {
  const { tr } = useI18n();
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

  const joinModeOptions = [
    {
      value: 'live',
      label: tr('Sofort beitreten (Live)', 'Join immediately (live)'),
    },
    {
      value: 'scheduled',
      label: tr('Zeitfenster planen', 'Schedule time window'),
    },
  ];

  const durationOptions = [
    { value: '30', label: tr('30 Minuten', '30 minutes') },
    { value: '60', label: tr('60 Minuten', '60 minutes') },
    { value: '90', label: tr('90 Minuten', '90 minutes') },
    { value: '120', label: tr('120 Minuten', '120 minutes') },
  ];

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
          throw new Error(
            tr(
              'Bitte Start- und Endzeit angeben.',
              'Please specify both start and end times.'
            )
          );
        }
        const startDate = new Date(startsAt);
        const endDate = new Date(endsAt);
        if (endDate <= startDate) {
          throw new Error(
            tr(
              'Die Endzeit muss nach der Startzeit liegen.',
              'End time must be after start time.'
            )
          );
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
      setError(
        tr(
          'Bitte eine .ics- oder .eml-Einladung einfügen oder auswählen.',
          'Please paste or select an .ics or .eml calendar invitation.'
        )
      );
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
      <Layout
        height="auto"
        header={
          <DialogHeader
            title={tr(
              'Bot in ein Meeting schicken',
              'Send Bot to a Meeting'
            )}
            subtitle={tr(
              'Starten Sie einen Bot sofort per Meeting-Link oder importieren Sie eine Kalendereinladung (.ics / .eml).',
              'Dispatch an assistant immediately via meeting URL or import a calendar invitation (.ics / .eml).'
            )}
            onOpenChange={onOpenChange}
          />
        }
        content={
          <LayoutContent>
            <VStack gap={3}>
              <SegmentedControl
                size="sm"
                layout="fill"
                label={tr('Startmethode', 'Dispatch mode')}
                value={tab}
                onChange={(v) => setTab(v as 'link' | 'ics')}
              >
                <SegmentedControlItem
                  value="link"
                  label={tr(
                    'Meeting-Link (Ad-hoc / Geplant)',
                    'Meeting URL (Ad-hoc / Scheduled)'
                  )}
                  icon={<Link2 className="h-3.5 w-3.5" />}
                />
                <SegmentedControlItem
                  value="ics"
                  label={tr(
                    'Kalendereinladung (.ics / .eml)',
                    'Calendar invite (.ics / .eml)'
                  )}
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
                        label={tr(
                          'Meeting-Link (Google Meet, Microsoft Teams, Webex oder Zoom)',
                          'Meeting URL (Google Meet, Microsoft Teams, Webex, or Zoom)'
                        )}
                        isRequired
                        value={meetingUrl}
                        onChange={setMeetingUrl}
                        placeholder="https://meet.google.com/..., https://teams.microsoft.com/... / https://zoom.us/j/..."
                        startIcon={<Video className="h-4 w-4" />}
                      />
                      {detectedProvider && (
                        <HStack gap={1.5} vAlign="center">
                          <Text type="supporting" color="secondary">
                            {tr('Erkanntes System:', 'Detected provider:')}
                          </Text>
                          <ProviderBadge provider={detectedProvider} />
                        </HStack>
                      )}
                    </VStack>

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <TextInput
                        type="text"
                        label={tr('Meeting-Titel', 'Meeting title')}
                        isOptional
                        value={title}
                        onChange={setTitle}
                        placeholder={tr(
                          'z. B. Architektur-Sync',
                          'e.g. Architecture Sync'
                        )}
                      />
                      <TextInput
                        type="text"
                        label={tr('Bot-Anzeigename', 'Bot display name')}
                        isOptional
                        value={guestName}
                        onChange={setGuestName}
                        placeholder={instance.assistantName}
                      />
                    </div>

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <Selector
                        label={tr('Start-Modus', 'Join mode')}
                        options={joinModeOptions}
                        value={joinMode}
                        onChange={(v) => setJoinMode(v as 'live' | 'scheduled')}
                      />
                      {joinMode === 'live' && (
                        <div id="modal-duration-field">
                          <Selector
                            label={tr(
                              'Maximale Aufnahmedauer',
                              'Maximum recording duration'
                            )}
                            options={durationOptions}
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
                            {tr('Startzeit', 'Start time')}
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
                            {tr('Endzeit', 'End time')}
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
                        label={tr('Abbrechen', 'Cancel')}
                        onClick={() => onOpenChange(false)}
                      />
                      <Button
                        type="submit"
                        variant="primary"
                        isLoading={submitting}
                        label={
                          submitting
                            ? tr('Wird gestartet…', 'Starting…')
                            : tr('Bot starten', 'Start bot')
                        }
                      />
                    </HStack>
                  </FormLayout>
                </form>
              ) : (
                <form onSubmit={handleIcsSubmit}>
                  <FormLayout direction="vertical">
                    {instance.mail.allowedDomains.length > 0 && (
                      <Text type="supporting" color="secondary">
                        {tr(
                          `Hinweis: Der in der .ics-Datei eingetragene ORGANIZER muss zu einer freigeschalteten Domain gehören (${instance.mail.allowedDomains.map((d) => `@${d}`).join(', ')}). Für externe Termine nutzen Sie bitte den Reiter Meeting-Link.`,
                          `Note: The ORGANIZER in the .ics file must belong to an allowed domain (${instance.mail.allowedDomains.map((d) => `@${d}`).join(', ')}). For external calls, use the Meeting URL tab.`
                        )}
                      </Text>
                    )}

                    <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-background-muted)]/40 p-4 text-center hover:border-[var(--color-text-accent)] transition-colors">
                      <Upload className="mb-1.5 h-5 w-5 text-[var(--color-text-accent)]" />
                      <Text type="supporting" weight="medium" color="primary">
                        {tr(
                          '.ics- oder .eml-Datei auswählen',
                          'Select .ics or .eml file'
                        )}
                      </Text>
                      <Text type="supporting" color="secondary">
                        {tr(
                          'Oder Inhalt direkt in das Textfeld unten einfügen',
                          'Or paste the content directly into the field below'
                        )}
                      </Text>
                      <input
                        type="file"
                        accept=".ics,.eml,text/calendar,message/rfc822"
                        onChange={handleFileChange}
                        className="hidden"
                      />
                    </label>

                    <TextArea
                      label={tr(
                        'iCalendar / E-Mail-Inhalt',
                        'iCalendar / Email payload'
                      )}
                      rows={6}
                      value={icsText}
                      onChange={setIcsText}
                      placeholder="BEGIN:VCALENDAR..."
                    />

                    <HStack justify="end" gap={2}>
                      <Button
                        type="button"
                        variant="ghost"
                        label={tr('Abbrechen', 'Cancel')}
                        onClick={() => onOpenChange(false)}
                      />
                      <Button
                        type="submit"
                        variant="primary"
                        isLoading={submitting}
                        label={
                          submitting
                            ? tr('Importiere…', 'Importing…')
                            : tr('Einladung importieren', 'Import invite')
                        }
                      />
                    </HStack>
                  </FormLayout>
                </form>
              )}
            </VStack>
          </LayoutContent>
        }
      />
    </Dialog>
  );
}
