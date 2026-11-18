import React, { useEffect, useRef, useState } from 'react';
import { CalendarPlus, Check, Link2, Upload, Video } from 'lucide-react';
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
  validateMeetingUrlClient,
} from '../api';
import { buildAsrLanguageOptions, useI18n } from '../i18n';
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

function toLocalDateTimeValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function buildDefaultScheduleRange(): { start: string; end: string; min: string } {
  const now = new Date();
  const nextSlot = new Date(now);
  nextSlot.setSeconds(0, 0);
  const mins = nextSlot.getMinutes();
  nextSlot.setMinutes(mins < 30 ? 30 : 60);
  const endSlot = new Date(nextSlot.getTime() + 60 * 60000);
  return {
    start: toLocalDateTimeValue(nextSlot),
    end: toLocalDateTimeValue(endSlot),
    min: toLocalDateTimeValue(now),
  };
}

export function NewRecordingDialog({
  open,
  onOpenChange,
  token,
  initialTab = 'link',
  onCreatedRecording,
  onImportedCalendar,
}: NewRecordingDialogProps) {
  const { lang, tr } = useI18n();
  const [tab, setTab] = useState<'link' | 'ics'>(initialTab);
  const instance = getInstanceInfo();
  const defaultAsrLang =
    instance.defaultAsrLanguage && instance.defaultAsrLanguage !== '*'
      ? instance.defaultAsrLanguage
      : 'auto';

  const [meetingUrl, setMeetingUrl] = useState('');
  const [title, setTitle] = useState('');
  const [guestName, setGuestName] = useState('');
  const [asrLanguage, setAsrLanguage] = useState<string>(defaultAsrLang);
  const [joinMode, setJoinMode] = useState<'live' | 'scheduled'>('live');
  const [durationMin, setDurationMin] = useState('60');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [minDateTime, setMinDateTime] = useState('');
  const [icsText, setIcsText] = useState('');
  const [icsFileName, setIcsFileName] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setTab(initialTab);
      setError(null);
      const defaults = buildDefaultScheduleRange();
      setMinDateTime(defaults.min);
      if (!startsAt) setStartsAt(defaults.start);
      if (!endsAt) setEndsAt(defaults.end);
    }
  }, [open, initialTab]);

  const handleChangeJoinMode = (next: 'live' | 'scheduled') => {
    setJoinMode(next);
    if (next === 'scheduled' && (!startsAt || !endsAt)) {
      const defaults = buildDefaultScheduleRange();
      setMinDateTime(defaults.min);
      setStartsAt(defaults.start);
      setEndsAt(defaults.end);
    }
  };

  const detectedProvider = detectProviderFromUrl(meetingUrl);
  const asrLanguageOptions = buildAsrLanguageOptions(lang, asrLanguage);

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
    if (submittingRef.current) return;
    const urlErr = validateMeetingUrlClient(meetingUrl);
    if (urlErr) {
      setError(urlErr);
      return;
    }
    submittingRef.current = true;
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
        if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
          throw new Error(
            tr(
              'Bitte ein gültiges Start- und Enddatum angeben.',
              'Please enter valid start and end dates.'
            )
          );
        }
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
        title: title.trim().slice(0, 240) || null,
        guest_name: guestName.trim().slice(0, 120) || null,
        language: asrLanguage || 'auto',
      });
      setMeetingUrl('');
      setTitle('');
      onCreatedRecording(created.id);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const handleIcsSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current) return;
    if (!icsText.trim()) {
      setError(
        tr(
          'Bitte eine .ics- oder .eml-Einladung einfügen oder auswählen.',
          'Please paste or select an .ics or .eml calendar invitation.'
        )
      );
      return;
    }
    submittingRef.current = true;
    setError(null);
    setSubmitting(true);
    try {
      const result = await importCalendarPayload(token, icsText);
      const firstAccepted = (result.events || []).find((ev) => ev.recording_id);
      setIcsText('');
      setIcsFileName(null);
      onImportedCalendar(firstAccepted?.recording_id || null);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setError(
        tr(
          'Die ausgewählte Datei ist größer als 2 MB. Bitte eine gültige .ics- oder .eml-Einladung wählen.',
          'The selected file exceeds 2 MB. Please choose a valid .ics or .eml invitation.'
        )
      );
      e.target.value = '';
      return;
    }
    setError(null);
    setIcsFileName(file.name);
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
            title={tr('Neue Aufnahme', 'New Recording')}
            subtitle={tr(
              'Per Konferenz-Link starten/planen oder eine .ics-Einladung importieren.',
              'Start/schedule via meeting URL or import an .ics invitation.'
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
                    'Meeting-Link (Sofort / Geplant)',
                    'Meeting URL (Live / Scheduled)'
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
                          'Meeting-Link (Meet, Teams, Webex oder Zoom)',
                          'Meeting URL (Meet, Teams, Webex, or Zoom)'
                        )}
                        isRequired
                        value={meetingUrl}
                        onChange={setMeetingUrl}
                        placeholder="https://meet.google.com/… · https://teams.microsoft.com/… · https://zoom.us/j/…"
                        startIcon={<Video className="h-4 w-4" />}
                      />
                      {detectedProvider && (
                        <HStack gap={1.5} vAlign="center">
                          <Text type="supporting" color="secondary">
                            {tr('Erkannt:', 'Detected:')}
                          </Text>
                          <ProviderBadge provider={detectedProvider} />
                        </HStack>
                      )}
                    </VStack>

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <TextInput
                        type="text"
                        label={tr('Titel', 'Title')}
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
                        label={tr('Bot-Name', 'Bot name')}
                        isOptional
                        value={guestName}
                        onChange={setGuestName}
                        placeholder={instance.assistantName}
                      />
                    </div>

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <Selector
                        label={tr('Zeitpunkt', 'Timing')}
                        options={joinModeOptions}
                        value={joinMode}
                        onChange={(v) =>
                          handleChangeJoinMode(v as 'live' | 'scheduled')
                        }
                      />
                      {joinMode === 'live' && (
                        <div id="modal-duration-field">
                          <Selector
                            label={tr('Aufnahmedauer', 'Duration')}
                            options={durationOptions}
                            value={durationMin}
                            onChange={setDurationMin}
                          />
                        </div>
                      )}
                    </div>

                    <div id="modal-asr-language-field">
                      <Selector
                        label={tr(
                          'Sprache (Qwen3-ASR · 30 Sprachen)',
                          'Language (Qwen3-ASR · 30 languages)'
                        )}
                        options={asrLanguageOptions}
                        value={asrLanguage}
                        onChange={setAsrLanguage}
                      />
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
                            min={minDateTime || undefined}
                            value={startsAt}
                            onChange={(e) => {
                              const nextStart = e.target.value;
                              setStartsAt(nextStart);
                              if (nextStart && (!endsAt || endsAt <= nextStart)) {
                                const d = new Date(nextStart);
                                if (!Number.isNaN(d.getTime())) {
                                  setEndsAt(
                                    toLocalDateTimeValue(
                                      new Date(d.getTime() + 60 * 60000)
                                    )
                                  );
                                }
                              }
                            }}
                            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-background-surface)] px-3 py-2 text-[16px] md:text-[14px] tabular-nums text-[var(--color-text-primary)] wl-focus-accent"
                          />
                        </VStack>
                        <VStack gap={1} id="modal-end-field">
                          <Text as="label" type="supporting" weight="semibold">
                            {tr('Endzeit', 'End time')}
                          </Text>
                          <input
                            id="modal-ends-at"
                            type="datetime-local"
                            min={startsAt || minDateTime || undefined}
                            value={endsAt}
                            onChange={(e) => setEndsAt(e.target.value)}
                            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-background-surface)] px-3 py-2 text-[16px] md:text-[14px] tabular-nums text-[var(--color-text-primary)] wl-focus-accent"
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
                            ? tr('Wird gespeichert…', 'Saving…')
                            : joinMode === 'scheduled'
                              ? tr('Termin einplanen', 'Schedule recording')
                              : tr('Jetzt starten', 'Start now')
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
                          `Hinweis: ORGANIZER muss zu ${instance.mail.allowedDomains.map((d) => `@${d}`).join(', ')} gehören. Für externe Termine bitte den Reiter Meeting-Link nutzen.`,
                          `Note: ORGANIZER must belong to ${instance.mail.allowedDomains.map((d) => `@${d}`).join(', ')}. For external calls, use the Meeting URL tab.`
                        )}
                      </Text>
                    )}

                    <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-background-muted)]/40 p-4 text-center hover:border-[var(--wl-accent)] transition-colors">
                      {icsFileName ? (
                        <Check className="mb-1.5 h-5 w-5 wl-text-accent" />
                      ) : (
                        <Upload className="mb-1.5 h-5 w-5 wl-text-accent" />
                      )}
                      <Text type="supporting" weight="semibold" color="primary">
                        {icsFileName
                          ? `${icsFileName}`
                          : tr(
                              '.ics- oder .eml-Datei auswählen',
                              'Select .ics or .eml file'
                            )}
                      </Text>
                      <Text type="supporting" color="secondary">
                        {icsFileName
                          ? tr(
                              'Datei geladen — bereit zum Importieren (Klicken zum Ändern)',
                              'File loaded — ready to import (click to change)'
                            )
                          : tr(
                              'Oder Inhalt direkt unten einfügen',
                              'Or paste content directly below'
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
                      rows={5}
                      value={icsText}
                      onChange={(val) => {
                        setIcsText(val);
                        if (!val.trim()) setIcsFileName(null);
                      }}
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
