import React from 'react';
import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  KeyRound,
} from 'lucide-react';
import { Layout, LayoutContent, LayoutHeader } from '@astryxdesign/core/Layout';
import { Breadcrumbs, BreadcrumbItem } from '@astryxdesign/core/Breadcrumbs';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { HStack } from '@astryxdesign/core/HStack';
import { VStack } from '@astryxdesign/core/VStack';
import { Section } from '@astryxdesign/core/Section';
import {
  MetadataList,
  MetadataListItem,
} from '@astryxdesign/core/MetadataList';
import { List, ListItem } from '@astryxdesign/core/List';
import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import {
  Table,
  pixel,
  proportional,
  type TableColumn,
} from '@astryxdesign/core/Table';
import {
  formatRecordingTitle,
  getFailureReasons,
  getInstanceInfo,
} from '../api';
import { useI18n } from '../i18n';
import type { AuthMode, RecordingSummary } from '../types';
import { ProviderBadge, StatusBadge, StatusIndicator } from './ui/primitives';

export interface SystemViewProps {
  healthy: boolean;
  authMode: AuthMode;
  recordings: RecordingSummary[];
  livePoll: boolean;
  onToggleLivePoll: (next: boolean) => void;
  onManualRefresh: () => void;
  onOpenAuthDialog: () => void;
  onSelectRecording: (id: string) => void;
  onNavigateHome?: () => void;
}

type ProblemRow = RecordingSummary & Record<string, unknown>;

export function SystemView({
  healthy,
  recordings,
  onOpenAuthDialog,
  onSelectRecording,
  onNavigateHome,
}: SystemViewProps) {
  const { lang, tr } = useI18n();
  const failureReasons = getFailureReasons();
  const instance = getInstanceInfo();

  const activeJobs = recordings.filter((r) =>
    [
      'starting',
      'preparing',
      'joining',
      'waiting_admission',
      'capturing',
    ].includes(r.participation)
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
      reason === 'source_binding_unverified' ||
      ((reason === 'cancelled' || reason === 'deadline') && samples > 0);
    return (
      r.processing === 'failed' || (r.participation === 'ended' && !cleanStop)
    );
  });

  const problemColumns: TableColumn<ProblemRow>[] = [
    {
      key: 'participation',
      header: 'Status',
      width: pixel(175),
      renderCell: (row) => (
        <StatusBadge
          participation={row.participation}
          processing={row.processing}
          hasError={true}
        />
      ),
    },
    {
      key: 'title',
      header: tr('Besprechung', 'Meeting'),
      width: proportional(1.6, { minWidth: 200 }),
      renderCell: (row) => (
        <HStack gap={2} vAlign="center" wrap="nowrap">
          <ProviderBadge provider={row.provider} />
          <Text type="body" weight="semibold" color="primary" maxLines={1}>
            {formatRecordingTitle(row)}
          </Text>
        </HStack>
      ),
    },
    {
      key: 'participation_reason',
      header: tr('Hinweis / Abbruchgrund', 'Notice / End reason'),
      width: proportional(2, { minWidth: 220 }),
      renderCell: (row) => {
        const reason = row.participation_reason;
        const reasonText =
          reason && failureReasons[reason]
            ? failureReasons[reason]
            : reason || tr('Verarbeitungsfehler', 'Processing error');
        return (
          <Text type="supporting" color="secondary" maxLines={1}>
            {reasonText}
          </Text>
        );
      },
    },
    {
      key: 'action',
      header: '',
      width: pixel(135),
      align: 'end',
      renderCell: (row) => (
        <Button
          variant="ghost"
          size="sm"
          label={tr('Öffnen', 'Open')}
          endContent={<ArrowRight className="h-3.5 w-3.5" />}
          onClick={() => onSelectRecording(row.id)}
        />
      ),
    },
  ];

  return (
    <Layout
      height="fill"
      header={
        <LayoutHeader hasDivider>
          <div className="wl-page-container">
          <VStack gap={2}>
            {onNavigateHome && (
              <Breadcrumbs
                variant="supporting"
                label={tr('Pfadnavigation', 'Breadcrumb')}
              >
                <BreadcrumbItem onClick={onNavigateHome}>
                  {tr('Startseite', 'Home')}
                </BreadcrumbItem>
                <BreadcrumbItem isCurrent>
                  {tr('System & Hilfe', 'System & Help')}
                </BreadcrumbItem>
              </Breadcrumbs>
            )}
            <HStack justify="between" vAlign="center" wrap="wrap" gap={3}>
              <VStack gap={0.5}>
                <Heading level={1}>
                  {tr('Hilfe & Systemstatus', 'Help & System Status')}
                </Heading>
                <Text type="supporting" color="secondary">
                  {tr(
                    'Ablauf einer Aufzeichnung, Datenschutzgarantien, konfigurierte Konferenz-Provider und Systembereitschaft.',
                    'Recording lifecycle, privacy guarantees, configured conference providers, and runtime readiness.'
                  )}
                </Text>
              </VStack>

              <HStack gap={2} vAlign="center" wrap="wrap">
                <Button
                  variant="secondary"
                  size="sm"
                  href={`/privacy?lang=${lang}`}
                  target="_blank"
                  rel="noreferrer"
                  label={tr(
                    'Datenschutzhinweis (/privacy)',
                    'Privacy notice (/privacy)'
                  )}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  href="/docs"
                  target="_blank"
                  rel="noreferrer"
                  icon={<BookOpen className="h-3.5 w-3.5" />}
                  label="REST API (/docs)"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<KeyRound className="h-3.5 w-3.5" />}
                  label={tr('Zugang & Konto', 'Account & Access')}
                  onClick={onOpenAuthDialog}
                />
              </HStack>
            </HStack>
          </VStack>
          </div>
        </LayoutHeader>
      }
      content={
        <LayoutContent>
          <div className="wl-page-container">
          <VStack gap={4}>
            <Section variant="section">
              <VStack gap={3}>
                <Heading level={3}>
                  {tr(
                    `So funktioniert ${instance.assistantName} im Konferenzalltag`,
                    `How ${instance.assistantName} works in daily meetings`
                  )}
                </Heading>
                <MetadataList columns={3}>
                  <MetadataListItem
                    label={tr(
                      '1. Einladen & Warteraum',
                      '1. Invite & Lobby Admission'
                    )}
                  >
                    {tr(
                      `Der Bot tritt automatisch zum geplanten Termin oder nach Link-Eingabe als Gast „${instance.assistantName}“ bei. Bitte lassen Sie ihn im Konferenzfenster aus dem Warteraum zu.`,
                      `The assistant joins automatically at the scheduled time or via URL as “${instance.assistantName}”. Please admit it from the conference lobby.`
                    )}
                  </MetadataListItem>
                  <MetadataListItem
                    label={tr(
                      '2. Echte Sprechertrennung',
                      '2. True Speaker Attribution'
                    )}
                  >
                    {tr(
                      'Jede empfangene Teilnehmerspur wird direkt über die WebRTC-Sitzung getrennt erfasst (keine Stimmprofile / Voiceprints, keine Videoaufzeichnung).',
                      'Every participant audio stream is captured directly from the WebRTC session before mixing (no biometric voiceprints, no video recording).'
                    )}
                  </MetadataListItem>
                  <MetadataListItem
                    label={tr(
                      '3. 100 % Self-Hosted & Löschfristen',
                      '3. 100% Self-Hosted & Retention'
                    )}
                  >
                    {tr(
                      `Die Spracherkennung (lokales NVIDIA-Parakeet-Modell) läuft im eigenen Cluster. Roh-Audio wird nach ${instance.retention.audioHours}h, Protokolle nach ${instance.retention.transcriptDays}d gelöscht.`,
                      `Speech recognition (local NVIDIA Parakeet GPU model) runs on your infrastructure. Raw audio is purged after ${instance.retention.audioHours}h, transcripts after ${instance.retention.transcriptDays}d.`
                    )}
                  </MetadataListItem>
                </MetadataList>
              </VStack>
            </Section>

            <Section variant="section">
              <VStack gap={3}>
                <Heading level={3}>
                  {tr(
                    'Plattform- & Kapazitätsstatus',
                    'Platform & Capacity Status'
                  )}
                </Heading>
                <MetadataList columns={4}>
                  <MetadataListItem label={tr('API & Datenbank', 'API & Database')}>
                    <StatusIndicator
                      variant={healthy ? 'success' : 'warning'}
                      weight="medium"
                      label={
                        healthy
                          ? tr('Bereit (/health/ready)', 'Ready (/health/ready)')
                          : tr('Prüfe Verbindung…', 'Checking connection…')
                      }
                    />
                  </MetadataListItem>
                  <MetadataListItem
                    label={tr('Aktive Meeting-Bots', 'Active Meeting Bots')}
                  >
                    {activeJobs.length} / {instance.limits.maxActiveMeetings}{' '}
                    max.
                  </MetadataListItem>
                  <MetadataListItem label="Parakeet ASR Queue">
                    {tr(
                      `${asrJobs.length} Aufnahmen in GPU-Erkennung`,
                      `${asrJobs.length} recordings in GPU queue`
                    )}
                  </MetadataListItem>
                  <MetadataListItem
                    label={tr('Aufbewahrungsfristen', 'Retention Policy')}
                  >
                    {instance.retention.audioHours}h{' '}
                    {tr('Roh-Audio', 'raw audio')} ·{' '}
                    {instance.retention.transcriptDays}d{' '}
                    {tr('Transkript', 'transcript')}
                  </MetadataListItem>
                </MetadataList>
              </VStack>
            </Section>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Section variant="section">
                <VStack gap={2}>
                  <Heading level={3}>
                    {tr('Konferenz-Provider', 'Conference Providers')}
                  </Heading>
                  <List hasDividers edge="flush">
                    <ListItem
                      label="Google Meet"
                      description={
                        instance.providers.google_meet_auth_session
                          ? tr(
                              'Playwright/Chromium WebRTC · Gespeicherte Google-Session aktiv',
                              'Playwright/Chromium WebRTC · Authenticated Google session active'
                            )
                          : tr(
                              'Playwright/Chromium WebRTC · Gast-Modus',
                              'Playwright/Chromium WebRTC · Guest mode'
                            )
                      }
                      endContent={
                        <StatusIndicator
                          variant={
                            instance.providers.google_meet
                              ? 'success'
                              : 'neutral'
                          }
                          weight="medium"
                          label={
                            instance.providers.google_meet
                              ? tr('Aktiviert', 'Enabled')
                              : tr('Deaktiviert', 'Disabled')
                          }
                        />
                      }
                    />
                    <ListItem
                      label="Microsoft Teams"
                      description={tr(
                        'Playwright/Chromium Web-Client · Gast-Beitritt',
                        'Playwright/Chromium Web Client · Guest join'
                      )}
                      endContent={
                        <StatusIndicator
                          variant={
                            instance.providers.teams ? 'success' : 'neutral'
                          }
                          weight="medium"
                          label={
                            instance.providers.teams
                              ? tr('Aktiviert', 'Enabled')
                              : tr('Deaktiviert', 'Disabled')
                          }
                        />
                      }
                    />
                    <ListItem
                      label="Cisco Webex"
                      description={tr(
                        'Playwright/Chromium Web-Client / Service-Token',
                        'Playwright/Chromium Web Client / Service token'
                      )}
                      endContent={
                        <StatusIndicator
                          variant={
                            instance.providers.webex ? 'success' : 'neutral'
                          }
                          weight="medium"
                          label={
                            instance.providers.webex
                              ? tr('Aktiviert', 'Enabled')
                              : tr('Kein Zugang hinterlegt', 'Not configured')
                          }
                        />
                      }
                    />
                    <ListItem
                      label="Zoom"
                      description={
                        instance.providers.zoom_auth_session
                          ? tr(
                              'Playwright/Chromium Web-Client · Gespeicherte Zoom-Session aktiv',
                              'Playwright/Chromium Web Client · Authenticated Zoom session active'
                            )
                          : tr(
                              'Playwright/Chromium Web-Client · Anonymer Gast-Beitritt',
                              'Playwright/Chromium Web Client · Guest join'
                            )
                      }
                      endContent={
                        <StatusIndicator
                          variant={
                            instance.providers.zoom ? 'success' : 'neutral'
                          }
                          weight="medium"
                          label={
                            instance.providers.zoom
                              ? tr('Aktiviert', 'Enabled')
                              : tr('Deaktiviert', 'Disabled')
                          }
                        />
                      }
                    />
                  </List>
                </VStack>
              </Section>

              <Section variant="section">
                <VStack gap={2}>
                  <Heading level={3}>
                    {tr(
                      'Kalender-Synchronisation & E-Mail',
                      'Calendar Sync & Email'
                    )}
                  </Heading>
                  <MetadataList columns="single">
                    <MetadataListItem
                      label={tr('Bot-Einladungsadresse', 'Bot invite address')}
                    >
                      {instance.botEmail || tr('Nicht konfiguriert', 'Not configured')}
                    </MetadataListItem>
                    <MetadataListItem label="Google Calendar OAuth2">
                      {instance.calendarOAuth?.googleEnabled
                        ? tr('Aktiviert (calendar.events)', 'Enabled (calendar.events)')
                        : tr('Nicht konfiguriert', 'Not configured')}
                    </MetadataListItem>
                    <MetadataListItem label="Microsoft 365 OAuth2">
                      {instance.calendarOAuth?.microsoftEnabled
                        ? tr(
                            'Aktiviert (Calendars.ReadWrite)',
                            'Enabled (Calendars.ReadWrite)'
                          )
                        : tr('Nicht konfiguriert', 'Not configured')}
                    </MetadataListItem>
                    <MetadataListItem label="IMAP / SMTP">
                      IMAP: {instance.mail.imapEnabled ? tr('Aktiv', 'On') : tr('Aus', 'Off')} ·
                      SMTP: {instance.mail.smtpEnabled ? tr('Aktiv', 'On') : tr('Aus', 'Off')}
                    </MetadataListItem>
                    <MetadataListItem
                      label={tr(
                        'Timeouts (Lobby / Leerer Raum)',
                        'Timeouts (Lobby / Empty room)'
                      )}
                    >
                      {Math.round(instance.limits.lobbyTimeoutSeconds / 60)}{' '}
                      min /{' '}
                      {Math.round(instance.limits.emptyRoomTimeoutSeconds / 60)}{' '}
                      min
                    </MetadataListItem>
                  </MetadataList>
                </VStack>
              </Section>
            </div>

            <Section variant="section">
              <VStack gap={2}>
                <Heading level={3}>
                  {tr(
                    `Aufzeichnungen mit Hinweis oder Abbruch (${problemRecordings.length})`,
                    `Recordings with Notice or Early Exit (${problemRecordings.length})`
                  )}
                </Heading>

                {problemRecordings.length === 0 ? (
                  <EmptyState
                    isCompact
                    icon={<CheckCircle2 className="h-6 w-6" />}
                    title={tr(
                      'Keine fehlgeschlagenen Aufzeichnungen',
                      'No failed recordings'
                    )}
                    description={tr(
                      'Alle angezeigten Aufzeichnungen wurden regulär abgeschlossen oder befinden sich im geplanten Ablauf.',
                      'All listed recordings completed normally or are progressing as scheduled.'
                    )}
                  />
                ) : (
                  <Table<ProblemRow>
                    idKey="id"
                    density="compact"
                    dividers="rows"
                    hasHover
                    data={problemRecordings.slice(0, 12) as ProblemRow[]}
                    columns={problemColumns}
                  />
                )}
              </VStack>
            </Section>
          </VStack>
          </div>
        </LayoutContent>
      }
    />
  );
}
