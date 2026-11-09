import React from 'react';
import { BookOpen, RefreshCw } from 'lucide-react';
import { Section } from '@astryxdesign/core/Section';
import {
  MetadataList,
  MetadataListItem,
} from '@astryxdesign/core/MetadataList';
import {
  Table,
  pixel,
  proportional,
  type TableColumn,
} from '@astryxdesign/core/Table';
import { CodeBlock } from '@astryxdesign/core/CodeBlock';
import { Collapsible } from '@astryxdesign/core/Collapsible';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { HStack } from '@astryxdesign/core/HStack';
import { VStack } from '@astryxdesign/core/VStack';
import { Button } from '@astryxdesign/core/Button';
import { Divider } from '@astryxdesign/core/Divider';
import { DELIVERY_STATUS_LABELS, PROCESSING_LABELS } from '../api';
import type { AttemptInfo, RecordingDetail, TranscriptExport } from '../types';

export interface DiagnosticsTabProps {
  recording: RecordingDetail;
  transcript: TranscriptExport;
  isOperator: boolean;
  onRetryMail: () => void;
  retryingMail: boolean;
}

type AttemptRow = AttemptInfo & Record<string, unknown>;

export function DiagnosticsTab({
  recording,
  transcript,
  isOperator,
  onRetryMail,
  retryingMail,
}: DiagnosticsTabProps) {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const curlSnippet = `curl --fail -H "Authorization: Bearer $WORTLAUT_API_TOKEN" "${origin}/v1/recordings/${recording.id}/exports/json"`;

  const canRetryMail =
    isOperator &&
    recording.delivery &&
    ['failed', 'delivery_unknown'].includes(recording.delivery.status);

  const sampleCount = recording.ingest?.durable_sample_count ?? 0;
  const sampleSec = Math.round(sampleCount / 16000);
  const live = recording.live_status;

  const rawDiagPayload = {
    live_status: recording.live_status,
    attempts: recording.attempts,
    audio_streams: recording.audio,
    quality: transcript.quality,
  };

  const attemptColumns: TableColumn<AttemptRow>[] = [
    {
      key: 'id',
      header: 'Attempt-ID',
      width: pixel(140),
      renderCell: (a) => (
        <Text type="supporting" color="primary" hasTabularNumbers>
          {a.id.slice(0, 8)}…
        </Text>
      ),
    },
    {
      key: 'job_name',
      header: 'Kubernetes-Job',
      width: proportional(1.5, { minWidth: 200 }),
      renderCell: (a) => (
        <Text type="supporting" color="secondary">
          {a.job_name || '–'}
        </Text>
      ),
    },
    {
      key: 'end_reason',
      header: 'Endgrund',
      width: pixel(160),
      renderCell: (a) => (
        <Text type="supporting" color="primary">
          {a.end_reason || 'aktiv'}
        </Text>
      ),
    },
    {
      key: 'ended_at',
      header: 'Beendet',
      width: pixel(130),
      renderCell: (a) => (
        <Text type="supporting" color="secondary" hasTabularNumbers>
          {a.ended_at
            ? new Date(a.ended_at).toLocaleTimeString('de-DE')
            : 'läuft'}
        </Text>
      ),
    },
  ];

  return (
    <VStack gap={4}>
      <Section variant="section">
        <VStack gap={3}>
          <HStack justify="between" vAlign="center" wrap="wrap" gap={2}>
            <Heading level={3}>Pipeline, WebRTC &amp; Zustellung</Heading>
            {canRetryMail && (
              <span id="retry-mail-btn">
                <Button
                  variant="secondary"
                  size="sm"
                  isLoading={retryingMail}
                  icon={<RefreshCw className="h-3.5 w-3.5" />}
                  label="E-Mail erneut senden"
                  onClick={onRetryMail}
                />
              </span>
            )}
          </HStack>

          <MetadataList columns={3}>
            <MetadataListItem label="Persistierte Samples">
              {sampleCount.toLocaleString('de-DE')} ({sampleSec}s)
            </MetadataListItem>
            <MetadataListItem label="Persistierte Chunks">
              {recording.ingest?.durable_chunk_count ?? 0}
            </MetadataListItem>
            <MetadataListItem label="ASR-Jobs (offen / fertig / fehler)">
              {recording.asr?.pending ?? 0} / {recording.asr?.completed ?? 0} /{' '}
              {recording.asr?.failed ?? 0}
            </MetadataListItem>
            <MetadataListItem label="Verarbeitungsstatus">
              {PROCESSING_LABELS[recording.processing] || recording.processing}
            </MetadataListItem>
            <MetadataListItem label="Gebundene Receiver">
              {live?.bound_receivers ?? 0} / {live?.total_receivers ?? 0} (mit
              Name: {live?.bound_named_receivers ?? 0})
            </MetadataListItem>
            <MetadataListItem label="Erkannte Teilnehmer">
              {live?.dom_or_signaled_participants ?? 0} (DOM:{' '}
              {live?.dom_participants ?? 0})
            </MetadataListItem>
            <MetadataListItem label="SDP / DataChannels">
              {live?.sdp_descriptions ?? 0} / {live?.data_channel_count ?? 0}
            </MetadataListItem>
            <MetadataListItem label="Letzter Worker-Heartbeat">
              {live?.last_heartbeat_at
                ? new Date(live.last_heartbeat_at).toLocaleTimeString('de-DE')
                : '–'}
            </MetadataListItem>
            <MetadataListItem label="E-Mail-Zustellung">
              {DELIVERY_STATUS_LABELS[
                recording.delivery?.status ?? 'pending'
              ] ||
                (recording.delivery?.status ?? 'pending')}
              {recording.delivery?.error
                ? ` (${recording.delivery.error})`
                : ''}
            </MetadataListItem>
          </MetadataList>
        </VStack>
      </Section>

      {recording.attempts && recording.attempts.length > 0 && (
        <Section variant="section">
          <VStack gap={2}>
            <Heading level={3}>
              Worker-Attempts ({recording.attempts.length})
            </Heading>
            <Table<AttemptRow>
              idKey="id"
              density="compact"
              dividers="rows"
              data={recording.attempts as AttemptRow[]}
              columns={attemptColumns}
            />
          </VStack>
        </Section>
      )}

      <Divider variant="subtle" />

      <VStack gap={2}>
        <HStack justify="between" vAlign="center" wrap="wrap" gap={2}>
          <Heading level={4}>REST-API Abruf (cURL)</Heading>
          <Button
            variant="ghost"
            size="sm"
            href="/docs"
            target="_blank"
            rel="noreferrer"
            icon={<BookOpen className="h-3.5 w-3.5" />}
            label="OpenAPI-Dokumentation (/docs)"
          />
        </HStack>
        <CodeBlock
          language="bash"
          size="sm"
          hasCopyButton
          hasLineNumbers={false}
          code={curlSnippet}
        />
      </VStack>

      <Collapsible trigger="WebRTC-Receiver & Worker-Diagnose (Roh-JSON)">
        <div className="pt-2">
          <CodeBlock
            language="json"
            size="sm"
            maxHeight={320}
            hasCopyButton
            code={JSON.stringify(rawDiagPayload, null, 2)}
          />
        </div>
      </Collapsible>
    </VStack>
  );
}
