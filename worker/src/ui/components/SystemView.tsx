import React from 'react';
import { ArrowRight, BookOpen, KeyRound } from 'lucide-react';
import { Layout, LayoutContent, LayoutHeader } from '@astryxdesign/core/Layout';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { HStack } from '@astryxdesign/core/HStack';
import { VStack } from '@astryxdesign/core/VStack';
import {
  MetadataList,
  MetadataListItem,
} from '@astryxdesign/core/MetadataList';
import { List, ListItem } from '@astryxdesign/core/List';
import { Button } from '@astryxdesign/core/Button';
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
  isProblemRecording,
} from '../api';
import { useI18n } from '../i18n';
import type { AuthMode, RecordingSummary } from '../types';
import { ProviderBadge, StatusBadge, StatusIndicator } from './ui/primitives';

export interface SystemViewProps {
  healthy: boolean;
  authMode: AuthMode;
  recordings: RecordingSummary[];
  onOpenAuthDialog: () => void;
  onSelectRecording: (id: string) => void;
}

type ProblemRow = RecordingSummary & Record<string, unknown>;

export function SystemView({
  healthy,
  recordings,
  onOpenAuthDialog,
  onSelectRecording,
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

  const problemRecordings = recordings.filter(isProblemRecording);

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
      header: tr('Hinweis', 'Reason'),
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
      width: pixel(120),
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

  const asrQueueLabel =
    asrJobs.length === 1
      ? tr('1 Aufnahme aktiv', '1 recording active')
      : tr(`${asrJobs.length} Aufnahmen aktiv`, `${asrJobs.length} recordings active`);

  return (
    <Layout
      height="fill"
      header={
        <LayoutHeader hasDivider>
          <div className="wl-page-container">
            <HStack justify="between" vAlign="center" wrap="wrap" gap={3}>
              <Heading level={1}>System</Heading>

              <HStack gap={2} vAlign="center" wrap="wrap">
                <Button
                  variant="ghost"
                  size="sm"
                  href={`/privacy?lang=${lang}`}
                  target="_blank"
                  rel="noreferrer"
                  label={tr('Datenschutz', 'Privacy')}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  href="/docs"
                  target="_blank"
                  rel="noreferrer"
                  icon={<BookOpen className="h-3.5 w-3.5" />}
                  label="API (/docs)"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<KeyRound className="h-3.5 w-3.5" />}
                  label={tr('Konto & Zugang', 'Account & Access')}
                  onClick={onOpenAuthDialog}
                />
              </HStack>
            </HStack>
          </div>
        </LayoutHeader>
      }
      content={
        <LayoutContent>
          <div className="wl-page-container">
            <VStack gap={6}>
              <VStack gap={2}>
                <Heading level={2}>
                  {tr('Laufzeit & Kapazität', 'Runtime & Capacity')}
                </Heading>
                <MetadataList columns="multi">
                  <MetadataListItem
                    label={tr('API & Datenbank', 'API & Database')}
                  >
                    <StatusIndicator
                      variant={healthy ? 'success' : 'warning'}
                      weight="medium"
                      label={
                        healthy
                          ? tr('Bereit', 'Ready')
                          : tr('Verbinde…', 'Connecting…')
                      }
                    />
                  </MetadataListItem>
                  <MetadataListItem
                    label={tr('Aktive Bots', 'Active Bots')}
                  >
                    <span className="tabular-nums">
                      {activeJobs.length} / {instance.limits.maxActiveMeetings}
                    </span>
                  </MetadataListItem>
                  <MetadataListItem label="ASR (GPU)">
                    {asrQueueLabel}
                  </MetadataListItem>
                  <MetadataListItem
                    label={tr('Aufbewahrung', 'Retention')}
                  >
                    <span className="tabular-nums">
                      {instance.retention.audioHours}h Audio ·{' '}
                      {instance.retention.transcriptDays}d{' '}
                      {tr('Protokoll', 'Protocol')}
                    </span>
                  </MetadataListItem>
                </MetadataList>
              </VStack>

              <div className="grid grid-cols-1 gap-8 lg:grid-cols-2 items-start">
                <VStack gap={2}>
                  <Heading level={2}>
                    {tr('Konferenzsysteme', 'Conference Providers')}
                  </Heading>
                  <List hasDividers edge="flush">
                    <ListItem
                      label="Google Meet"
                      description={
                        instance.providers.google_meet_auth_session
                          ? tr(
                              'Authentifizierte Session',
                              'Authenticated session'
                            )
                          : tr('Gast-Beitritt', 'Guest join')
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
                              ? tr('Aktiv', 'Enabled')
                              : tr('Aus', 'Disabled')
                          }
                        />
                      }
                    />
                    <ListItem
                      label="Microsoft Teams"
                      description={tr('Gast-Beitritt', 'Guest join')}
                      endContent={
                        <StatusIndicator
                          variant={
                            instance.providers.teams ? 'success' : 'neutral'
                          }
                          weight="medium"
                          label={
                            instance.providers.teams
                              ? tr('Aktiv', 'Enabled')
                              : tr('Aus', 'Disabled')
                          }
                        />
                      }
                    />
                    <ListItem
                      label="Cisco Webex"
                      description={tr(
                        'Web-Client / Service-Token',
                        'Web Client / Service token'
                      )}
                      endContent={
                        <StatusIndicator
                          variant={
                            instance.providers.webex ? 'success' : 'neutral'
                          }
                          weight="medium"
                          label={
                            instance.providers.webex
                              ? tr('Aktiv', 'Enabled')
                              : tr('Nicht konfiguriert', 'Not configured')
                          }
                        />
                      }
                    />
                    <ListItem
                      label="Zoom"
                      description={
                        instance.providers.zoom_auth_session
                          ? tr(
                              'Authentifizierte Session',
                              'Authenticated session'
                            )
                          : tr('Gast-Beitritt', 'Guest join')
                      }
                      endContent={
                        <StatusIndicator
                          variant={
                            instance.providers.zoom ? 'success' : 'neutral'
                          }
                          weight="medium"
                          label={
                            instance.providers.zoom
                              ? tr('Aktiv', 'Enabled')
                              : tr('Aus', 'Disabled')
                          }
                        />
                      }
                    />
                  </List>
                </VStack>

                <VStack gap={2}>
                  <Heading level={2}>
                    {tr('Integrationen', 'Integrations')}
                  </Heading>
                  <MetadataList columns="single">
                    <MetadataListItem
                      label={tr('Bot-E-Mail', 'Bot email')}
                    >
                      {instance.botEmail ||
                        tr('Nicht konfiguriert', 'Not configured')}
                    </MetadataListItem>
                    <MetadataListItem label="Google Calendar OAuth2">
                      {instance.calendarOAuth?.googleEnabled
                        ? tr('Aktiv', 'Enabled')
                        : tr('Nicht konfiguriert', 'Not configured')}
                    </MetadataListItem>
                    <MetadataListItem label="Microsoft 365 OAuth2">
                      {instance.calendarOAuth?.microsoftEnabled
                        ? tr('Aktiv', 'Enabled')
                        : tr('Nicht konfiguriert', 'Not configured')}
                    </MetadataListItem>
                    <MetadataListItem label="IMAP / SMTP">
                      IMAP:{' '}
                      {instance.mail.imapEnabled
                        ? tr('An', 'On')
                        : tr('Aus', 'Off')}{' '}
                      · SMTP:{' '}
                      {instance.mail.smtpEnabled
                        ? tr('An', 'On')
                        : tr('Aus', 'Off')}
                    </MetadataListItem>
                    <MetadataListItem
                      label={tr('Folien-Standbilder', 'Slide snapshots')}
                    >
                      {instance.enable_keyframes !== false
                        ? tr('Aktiv (keine Kamera)', 'Enabled (no camera)')
                        : tr('Aus', 'Disabled')}
                    </MetadataListItem>
                    <MetadataListItem
                      label={tr('KI-Zusammenfassung', 'AI summary')}
                    >
                      {instance.llmSummaryEnabled
                        ? instance.llmModel || 'Ollama'
                        : tr('Aus', 'Disabled')}
                    </MetadataListItem>
                    <MetadataListItem
                      label={tr(
                        'Timeouts (Lobby / Leer)',
                        'Timeouts (Lobby / Empty)'
                      )}
                    >
                      <span className="tabular-nums">
                        {Math.round(instance.limits.lobbyTimeoutSeconds / 60)}m
                        / {Math.round(instance.limits.emptyRoomTimeoutSeconds / 60)}m
                      </span>
                    </MetadataListItem>
                  </MetadataList>
                </VStack>
              </div>

              {problemRecordings.length > 0 && (
                <VStack gap={2}>
                  <Heading level={2}>
                    {tr(
                      `Hinweise & Abbrüche (${problemRecordings.length})`,
                      `Notices & Early Exits (${problemRecordings.length})`
                    )}
                  </Heading>
                  <div className="hidden md:block">
                    <Table<ProblemRow>
                      idKey="id"
                      density="compact"
                      dividers="rows"
                      hasHover
                      data={problemRecordings.slice(0, 12) as ProblemRow[]}
                      columns={problemColumns}
                    />
                  </div>
                  <div className="md:hidden rounded-lg border border-[var(--color-border)] divide-y divide-[var(--color-border)]">
                    {problemRecordings.slice(0, 12).map((row) => {
                      const reason = row.participation_reason;
                      const reasonText =
                        reason && failureReasons[reason]
                          ? failureReasons[reason]
                          : reason ||
                            tr('Verarbeitungsfehler', 'Processing error');
                      return (
                        <div key={row.id} className="p-3.5">
                          <VStack gap={1.5}>
                            <Text
                              type="body"
                              weight="semibold"
                              color="primary"
                            >
                              {formatRecordingTitle(row)}
                            </Text>
                            <Text type="supporting" color="secondary">
                              {reasonText}
                            </Text>
                            <HStack
                              justify="between"
                              vAlign="center"
                              wrap="wrap"
                              gap={2}
                            >
                              <HStack gap={2} vAlign="center" wrap="wrap">
                                <StatusBadge
                                  participation={row.participation}
                                  processing={row.processing}
                                  hasError={true}
                                />
                                <ProviderBadge provider={row.provider} />
                              </HStack>
                              <Button
                                variant="ghost"
                                size="sm"
                                label={tr('Öffnen', 'Open')}
                                endContent={
                                  <ArrowRight className="h-3.5 w-3.5" />
                                }
                                onClick={() => onSelectRecording(row.id)}
                              />
                            </HStack>
                          </VStack>
                        </div>
                      );
                    })}
                  </div>
                </VStack>
              )}
            </VStack>
          </div>
        </LayoutContent>
      }
    />
  );
}
