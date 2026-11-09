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
import { StatusDot } from '@astryxdesign/core/StatusDot';
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
      header: 'Besprechung',
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
      header: 'Hinweis / Abbruchgrund',
      width: proportional(2, { minWidth: 220 }),
      renderCell: (row) => {
        const reason = row.participation_reason;
        const reasonText =
          reason && failureReasons[reason]
            ? failureReasons[reason]
            : reason || 'Verarbeitungsfehler';
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
          label="Öffnen"
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
          <VStack gap={2}>
            {onNavigateHome && (
              <Breadcrumbs variant="supporting" label="Pfadnavigation">
                <BreadcrumbItem onClick={onNavigateHome}>
                  Startseite
                </BreadcrumbItem>
                <BreadcrumbItem isCurrent>System &amp; Hilfe</BreadcrumbItem>
              </Breadcrumbs>
            )}
            <HStack justify="between" vAlign="center" wrap="wrap" gap={3}>
              <VStack gap={0.5}>
                <Heading level={1}>Hilfe &amp; Systemstatus</Heading>
              <Text type="supporting" color="secondary">
                Ablauf einer Aufzeichnung, Datenschutzgarantien, konfigurierte
                Konferenz-Provider und Systembereitschaft.
              </Text>
            </VStack>

            <HStack gap={2} vAlign="center" wrap="wrap">
              <Button
                variant="secondary"
                size="sm"
                href="/privacy"
                target="_blank"
                rel="noreferrer"
                label="Datenschutzhinweis (/privacy)"
              />
              <Button
                variant="secondary"
                size="sm"
                href="/docs"
                target="_blank"
                rel="noreferrer"
                icon={<BookOpen className="h-3.5 w-3.5" />}
                label="REST-API (/docs)"
              />
              <Button
                variant="secondary"
                size="sm"
                icon={<KeyRound className="h-3.5 w-3.5" />}
                label="Zugang & Konto"
                onClick={onOpenAuthDialog}
              />
            </HStack>
          </HStack>
          </VStack>
        </LayoutHeader>
      }
      content={
        <LayoutContent>
          <VStack gap={4}>
            {/* User Guide: How wortlaut works */}
            <Section variant="section">
              <VStack gap={3}>
                <Heading level={3}>
                  So funktioniert {instance.assistantName} im Konferenzalltag
                </Heading>
                <MetadataList columns={3}>
                  <MetadataListItem label="1. Einladen & Warteraum">
                    Der Bot tritt automatisch zum geplanten Termin oder nach
                    Link-Eingabe als Gast „{instance.assistantName}“ bei. Bitte
                    lassen Sie ihn im Konferenzfenster aus dem Warteraum zu.
                  </MetadataListItem>
                  <MetadataListItem label="2. Echte Sprechertrennung">
                    Jede empfangene Teilnehmerspur wird direkt über die
                    WebRTC-Sitzung getrennt erfasst (keine Stimmprofile /
                    Voiceprints, keine Videoaufzeichnung).
                  </MetadataListItem>
                  <MetadataListItem label="3. 100 % Self-Hosted & Löschfristen">
                    Die Spracherkennung (lokales NVIDIA-Parakeet-Modell) läuft
                    im eigenen Cluster. Roh-Audio wird nach{' '}
                    {instance.retention.audioHours}h, Protokolle nach{' '}
                    {instance.retention.transcriptDays}d gelöscht.
                  </MetadataListItem>
                </MetadataList>
              </VStack>
            </Section>

            {/* Platform Status & Limits */}
            <Section variant="section">
              <VStack gap={3}>
                <Heading level={3}>Plattform- &amp; Kapazitätsstatus</Heading>
                <MetadataList columns={4}>
                  <MetadataListItem label="API & Datenbank">
                    <StatusIndicator
                      variant={healthy ? 'success' : 'warning'}
                      weight="medium"
                      label={
                        healthy ? 'Bereit (/health/ready)' : 'Prüfe Verbindung…'
                      }
                    />
                  </MetadataListItem>
                  <MetadataListItem label="Aktive Meeting-Bots">
                    {activeJobs.length} / {instance.limits.maxActiveMeetings}{' '}
                    max.
                  </MetadataListItem>
                  <MetadataListItem label="Parakeet-ASR-Queue">
                    {asrJobs.length} Aufnahmen in GPU-Erkennung
                  </MetadataListItem>
                  <MetadataListItem label="Aufbewahrungsfristen">
                    {instance.retention.audioHours}h Roh-Audio ·{' '}
                    {instance.retention.transcriptDays}d Transkript
                  </MetadataListItem>
                </MetadataList>
              </VStack>
            </Section>

            {/* Providers & Mail Configuration */}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Section variant="section">
                <VStack gap={2}>
                  <Heading level={3}>Konferenz-Provider</Heading>
                  <List hasDividers edge="flush">
                    <ListItem
                      label="Google Meet"
                      description={
                        instance.providers.google_meet_auth_session
                          ? 'Playwright/Chromium WebRTC · Gespeicherte Google-Session aktiv'
                          : 'Playwright/Chromium WebRTC · Gast-Modus'
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
                              ? 'Aktiviert'
                              : 'Deaktiviert'
                          }
                        />
                      }
                    />
                    <ListItem
                      label="Microsoft Teams"
                      description="Playwright/Chromium Web-Client · Gast-Beitritt"
                      endContent={
                        <StatusIndicator
                          variant={
                            instance.providers.teams ? 'success' : 'neutral'
                          }
                          weight="medium"
                          label={
                            instance.providers.teams
                              ? 'Aktiviert'
                              : 'Deaktiviert'
                          }
                        />
                      }
                    />
                    <ListItem
                      label="Cisco Webex"
                      description="Playwright/Chromium Web-Client / Service-Token"
                      endContent={
                        <StatusIndicator
                          variant={
                            instance.providers.webex ? 'success' : 'neutral'
                          }
                          weight="medium"
                          label={
                            instance.providers.webex
                              ? 'Aktiviert'
                              : 'Kein Zugang hinterlegt'
                          }
                        />
                      }
                    />
                    <ListItem
                      label="Zoom"
                      description={
                        instance.providers.zoom_auth_session
                          ? 'Playwright/Chromium Web-Client · Gespeicherte Zoom-Session aktiv'
                          : 'Playwright/Chromium Web-Client · Anonymer Gast-Beitritt'
                      }
                      endContent={
                        <StatusIndicator
                          variant={
                            instance.providers.zoom ? 'success' : 'neutral'
                          }
                          weight="medium"
                          label={
                            instance.providers.zoom
                              ? 'Aktiviert'
                              : 'Deaktiviert'
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
                    Kalender-Synchronisation &amp; E-Mail
                  </Heading>
                  <MetadataList columns="single">
                    <MetadataListItem label="Bot-Einladungsadresse">
                      {instance.botEmail || 'Nicht konfiguriert'}
                    </MetadataListItem>
                    <MetadataListItem label="Google Calendar OAuth2">
                      {instance.calendarOAuth?.googleEnabled
                        ? 'Aktiviert (calendar.readonly)'
                        : 'Nicht konfiguriert'}
                    </MetadataListItem>
                    <MetadataListItem label="Microsoft 365 OAuth2">
                      {instance.calendarOAuth?.microsoftEnabled
                        ? 'Aktiviert (Calendars.Read)'
                        : 'Nicht konfiguriert'}
                    </MetadataListItem>
                    <MetadataListItem label="IMAP / SMTP">
                      IMAP: {instance.mail.imapEnabled ? 'Aktiv' : 'Aus'} ·
                      SMTP: {instance.mail.smtpEnabled ? 'Aktiv' : 'Aus'}
                    </MetadataListItem>
                    <MetadataListItem label="Timeouts (Lobby / Leerer Raum)">
                      {Math.round(instance.limits.lobbyTimeoutSeconds / 60)}{' '}
                      Min. /{' '}
                      {Math.round(instance.limits.emptyRoomTimeoutSeconds / 60)}{' '}
                      Min.
                    </MetadataListItem>
                  </MetadataList>
                </VStack>
              </Section>
            </div>

            {/* Problem / Error Recordings */}
            <Section variant="section">
              <VStack gap={2}>
                <Heading level={3}>
                  Aufzeichnungen mit Hinweis oder Abbruch (
                  {problemRecordings.length})
                </Heading>

                {problemRecordings.length === 0 ? (
                  <EmptyState
                    isCompact
                    icon={<CheckCircle2 className="h-6 w-6" />}
                    title="Keine fehlgeschlagenen Aufzeichnungen"
                    description="Alle angezeigten Aufzeichnungen wurden regulär abgeschlossen oder befinden sich im geplanten Ablauf."
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
        </LayoutContent>
      }
    />
  );
}
