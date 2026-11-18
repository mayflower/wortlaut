import React from 'react';
import { BookOpen, RefreshCw } from 'lucide-react';
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
import {
  DELIVERY_STATUS_LABELS,
  KEYFRAME_CAPABILITY_LABELS,
  PROCESSING_LABELS,
} from '../api';
import {
  KEYFRAME_STRINGS,
  localizeDeliveryStatus,
  localizeKeyframeCapability,
  localizeProcessing,
  useI18n,
} from '../i18n';
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
  const { lang, localeTag, tr } = useI18n();
  const kStr = KEYFRAME_STRINGS[lang];
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
          {a.id ? `${String(a.id).slice(0, 8)}…` : '–'}
        </Text>
      ),
    },
    {
      key: 'job_name',
      header: tr('Kubernetes-Job', 'Kubernetes Job'),
      width: proportional(1.5, { minWidth: 200 }),
      renderCell: (a) => (
        <Text type="supporting" color="secondary">
          {a.job_name || '–'}
        </Text>
      ),
    },
    {
      key: 'end_reason',
      header: tr('Endgrund', 'End reason'),
      width: pixel(160),
      renderCell: (a) => (
        <Text type="supporting" color="primary">
          {a.end_reason || tr('aktiv', 'active')}
        </Text>
      ),
    },
    {
      key: 'ended_at',
      header: tr('Beendet', 'Ended'),
      width: pixel(130),
      renderCell: (a) => (
        <Text type="supporting" color="secondary" hasTabularNumbers>
          {a.ended_at
            ? new Date(a.ended_at).toLocaleTimeString(localeTag)
            : tr('läuft', 'running')}
        </Text>
      ),
    },
  ];

  return (
    <VStack gap={5}>
      <VStack gap={3}>
        <HStack justify="between" vAlign="center" wrap="wrap" gap={2}>
          <Heading level={2}>
            {tr('Pipeline, WebRTC & Zustellung', 'Pipeline, WebRTC & Delivery')}
          </Heading>
          {canRetryMail && (
            <span id="retry-mail-btn">
              <Button
                variant="secondary"
                size="sm"
                isLoading={retryingMail}
                icon={<RefreshCw className="h-3.5 w-3.5" />}
                label={tr('E-Mail erneut senden', 'Retry email delivery')}
                onClick={onRetryMail}
              />
            </span>
          )}
        </HStack>

        <MetadataList columns="multi">
          <MetadataListItem
            label={tr('Persistierte Samples', 'Persisted samples')}
          >
            <span className="tabular-nums">
              {sampleCount.toLocaleString(localeTag)} ({sampleSec}s)
            </span>
          </MetadataListItem>
          <MetadataListItem
            label={tr('Persistierte Chunks', 'Persisted chunks')}
          >
            <span className="tabular-nums">
              {recording.ingest?.durable_chunk_count ?? 0}
            </span>
          </MetadataListItem>
          <MetadataListItem
            label={tr(
              'ASR-Jobs (offen / fertig / Fehler)',
              'ASR jobs (pending / done / failed)'
            )}
          >
            <span className="tabular-nums">
              {recording.asr?.pending ?? 0} / {recording.asr?.completed ?? 0} /{' '}
              {recording.asr?.failed ?? 0}
            </span>
          </MetadataListItem>
          <MetadataListItem label={tr('Verarbeitung', 'Processing')}>
            {localizeProcessing(recording.processing, lang, PROCESSING_LABELS)}
          </MetadataListItem>
          <MetadataListItem
            label={tr('Gebundene Receiver', 'Bound receivers')}
          >
            <span className="tabular-nums">
              {live?.bound_receivers ?? 0} / {live?.total_receivers ?? 0} (
              {tr('benannt', 'named')}: {live?.bound_named_receivers ?? 0})
            </span>
          </MetadataListItem>
          <MetadataListItem
            label={tr('Erkannte Teilnehmer', 'Detected participants')}
          >
            <span className="tabular-nums">
              {live?.dom_or_signaled_participants ?? 0} (DOM:{' '}
              {live?.dom_participants ?? 0})
            </span>
          </MetadataListItem>
          <MetadataListItem label="SDP / DataChannels">
            <span className="tabular-nums">
              {live?.sdp_descriptions ?? 0} / {live?.data_channel_count ?? 0}
            </span>
          </MetadataListItem>
          <MetadataListItem
            label={tr('Letzter Heartbeat', 'Last worker heartbeat')}
          >
            <span className="tabular-nums">
              {live?.last_heartbeat_at
                ? new Date(live.last_heartbeat_at).toLocaleTimeString(localeTag)
                : '–'}
            </span>
          </MetadataListItem>
          <MetadataListItem label={tr('E-Mail-Zustellung', 'Email delivery')}>
            {localizeDeliveryStatus(
              recording.delivery?.status ?? 'pending',
              lang,
              DELIVERY_STATUS_LABELS
            )}
            {recording.delivery?.error ? ` (${recording.delivery.error})` : ''}
          </MetadataListItem>
        </MetadataList>
      </VStack>

      {recording.attempts && recording.attempts.length > 0 && (
        <VStack gap={2}>
          <Heading level={2}>
            {tr(
              `Worker-Versuche (${recording.attempts.length})`,
              `Worker Attempts (${recording.attempts.length})`
            )}
          </Heading>
          <Table<AttemptRow>
            idKey="id"
            density="compact"
            dividers="rows"
            data={recording.attempts as AttemptRow[]}
            columns={attemptColumns}
          />
        </VStack>
      )}

      {recording.attempts?.some((a) => Boolean(a.diagnostics?.keyframes)) && (
        <VStack gap={3}>
          <Heading level={2}>{kStr.diagHeading}</Heading>
          {recording.attempts
            .filter((a) => Boolean(a.diagnostics?.keyframes))
            .map((attempt) => {
              const kfDiag = attempt.diagnostics!.keyframes!;
              return (
                <div key={`kf-diag-${attempt.id}`} className="space-y-1.5">
                  {recording.attempts.length > 1 && (
                    <Text
                      type="supporting"
                      weight="semibold"
                      color="secondary"
                      hasTabularNumbers
                    >
                      Attempt {attempt.id.slice(0, 8)}…
                    </Text>
                  )}
                  <MetadataList columns={4}>
                    <MetadataListItem label={kStr.diagCapability}>
                      {localizeKeyframeCapability(
                        kfDiag.capability,
                        lang,
                        KEYFRAME_CAPABILITY_LABELS
                      )}
                    </MetadataListItem>
                    <MetadataListItem label={kStr.diagActiveShare}>
                      {kfDiag.active_share
                        ? tr('Ja', 'Yes')
                        : tr('Nein', 'No')}
                    </MetadataListItem>
                    <MetadataListItem label={kStr.diagEvaluatedTicks}>
                      {kfDiag.evaluated_ticks}
                    </MetadataListItem>
                    <MetadataListItem label={kStr.diagEmitted}>
                      {kfDiag.emitted}
                    </MetadataListItem>
                    <MetadataListItem label={kStr.diagUploaded}>
                      {kfDiag.uploaded}
                    </MetadataListItem>
                    <MetadataListItem label={kStr.diagDroppedUnverified}>
                      {kfDiag.dropped_unverified}
                    </MetadataListItem>
                    <MetadataListItem label={kStr.diagDroppedOptedOut}>
                      {kfDiag.dropped_opted_out}
                    </MetadataListItem>
                    <MetadataListItem label={kStr.diagDroppedQueueFull}>
                      {kfDiag.dropped_queue_full}
                    </MetadataListItem>
                  </MetadataList>
                </div>
              );
            })}
        </VStack>
      )}

      <Divider variant="subtle" />

      <VStack gap={2}>
        <HStack justify="between" vAlign="center" wrap="wrap" gap={2}>
          <Heading level={2}>
            {tr('REST-API Abruf (cURL)', 'REST API Export (cURL)')}
          </Heading>
          <Button
            variant="ghost"
            size="sm"
            href="/docs"
            target="_blank"
            rel="noreferrer"
            icon={<BookOpen className="h-3.5 w-3.5" />}
            label={tr('OpenAPI (/docs)', 'OpenAPI (/docs)')}
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

      <Collapsible
        trigger={tr(
          'WebRTC-Receiver & Worker-Diagnose (Roh-JSON)',
          'WebRTC Receiver & Worker Diagnostics (Raw JSON)'
        )}
      >
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
