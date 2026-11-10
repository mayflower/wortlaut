import React from 'react';
import { RotateCcw } from 'lucide-react';
import { Stepper, Step } from '@astryxdesign/core/Stepper';
import {
  MetadataList,
  MetadataListItem,
} from '@astryxdesign/core/MetadataList';
import { Divider } from '@astryxdesign/core/Divider';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { HStack } from '@astryxdesign/core/HStack';
import { Button } from '@astryxdesign/core/Button';
import { Token } from '@astryxdesign/core/Token';
import {
  DELIVERY_STATUS_LABELS,
  SOURCE_COVERAGE_LABELS,
  formatDurationHuman,
  getFailureReasons,
  getInstanceInfo,
  getSourceFilterKey,
} from '../api';
import {
  formatBotDisplayName,
  type RecordingDetail,
  type SourceSummary,
  type TranscriptExport,
} from '../types';

export interface ParticipationStepperProps {
  recording: RecordingDetail;
  transcript?: TranscriptExport;
  isOperator: boolean;
  onRejoin: () => void;
  rejoining: boolean;
  selectedSourceFilter?: string;
  onSelectSourceFilter?: (sourceId: string) => void;
}

export function ParticipationStepper({
  recording,
  transcript,
  isOperator,
  onRejoin,
  rejoining,
  selectedSourceFilter = '',
  onSelectSourceFilter,
}: ParticipationStepperProps) {
  const failureReasons = getFailureReasons();
  const instance = getInstanceInfo();
  const botName = formatBotDisplayName(recording, instance.assistantName);
  const lastAttempt =
    recording.attempts && recording.attempts.length > 0
      ? recording.attempts[recording.attempts.length - 1]
      : null;
  const reason =
    recording.participation_reason || lastAttempt?.end_reason || '';
  const explanation = reason ? failureReasons[reason] || '' : '';
  const sampleSec = Math.round(
    (recording.ingest?.durable_sample_count || 0) / 16000
  );

  const isFailedJoin =
    recording.participation === 'ended' &&
    sampleSec === 0 &&
    Boolean(reason) &&
    reason !== 'normal' &&
    reason !== 'source_binding_unverified';

  let activeIndex = 0;
  if (recording.participation === 'scheduled') {
    activeIndex = 0;
  } else if (
    recording.participation === 'starting' ||
    recording.participation === 'preparing' ||
    recording.participation === 'joining'
  ) {
    activeIndex = 1;
  } else if (recording.participation === 'waiting_admission') {
    activeIndex = 2;
  } else if (recording.participation === 'capturing') {
    activeIndex = 3;
  } else if (recording.participation === 'ended') {
    activeIndex =
      recording.processing === 'completed' && !isFailedJoin ? 5 : 4;
  }

  const sources: SourceSummary[] = transcript?.sources_summary || [];
  const totalSpeechSec = Math.max(
    1,
    sources.reduce((acc, s) => acc + (s.speech_seconds || 0), 0)
  );

  const startFormatted = new Date(recording.starts_at).toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  const endFormatted = new Date(recording.ends_at).toLocaleTimeString('de-DE', {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <VStack gap={4}>
      <VStack gap={2}>
        <Heading level={4}>Ablauf &amp; Status</Heading>
        <Stepper
          orientation="vertical"
          density="compact"
          activeStep={activeIndex}
          label="Aufzeichnungsfortschritt"
        >
          <Step
            step={0}
            label="Eingeplant"
            description={`${startFormatted} – ${endFormatted}`}
          />
          <Step
            step={1}
            label="Tritt dem Meeting bei"
            description={`Stiller Beitritt als „${botName}“`}
          />
          <Step
            step={2}
            label="Warteraum / Einlass"
            status={
              recording.participation === 'waiting_admission'
                ? 'warning'
                : undefined
            }
            description={
              recording.participation === 'waiting_admission'
                ? 'Bitte im Meeting-Fenster zulassen'
                : 'Zugang zum Konferenzraum'
            }
          />
          <Step
            step={3}
            label="Zeichnet Gespräche auf"
            status={
              recording.participation === 'capturing' ? 'success' : undefined
            }
            description={
              sampleSec > 0
                ? `${formatDurationHuman(sampleSec)} Gespräch erfasst`
                : 'Sprechergetrennte Tonaufnahme'
            }
          />
          <Step
            step={4}
            label="Wortprotokoll bereit"
            status={
              isFailedJoin || recording.processing === 'failed'
                ? 'error'
                : recording.participation === 'ended' &&
                    recording.processing === 'completed'
                  ? 'success'
                  : undefined
            }
            description={
              isFailedJoin
                ? explanation || reason
                : recording.processing === 'completed'
                  ? `${transcript?.segments?.length || 0} Wortbeiträge fertig`
                  : 'Lokale Spracherkennung läuft'
            }
          />
        </Stepper>

        {isOperator && recording.participation === 'ended' && (
          <span id="rejoin-rec-btn" className="contents">
            <Button
              variant="secondary"
              size="sm"
              width="fill"
              isLoading={rejoining}
              icon={<RotateCcw className="h-3.5 w-3.5" />}
              label="Bot erneut ins Meeting schicken"
              onClick={onRejoin}
            />
          </span>
        )}
      </VStack>

      <Divider variant="subtle" />

      <VStack gap={2}>
        <Heading level={4}>Sitzungsdaten</Heading>
        <MetadataList columns="single">
          <MetadataListItem label="Zeitfenster">
            {startFormatted} – {endFormatted}
          </MetadataListItem>
          <MetadataListItem label="Bot-Name">{botName}</MetadataListItem>
          <MetadataListItem label="Erfasstes Audio">
            {formatDurationHuman(sampleSec)}
          </MetadataListItem>
          {transcript?.quality?.source_coverage && (
            <MetadataListItem label="Sprecher-Zuordnung">
              {SOURCE_COVERAGE_LABELS[transcript.quality.source_coverage] ||
                transcript.quality.source_coverage}
            </MetadataListItem>
          )}
          {recording.delivery?.status && (
            <MetadataListItem label="E-Mail-Versand">
              {DELIVERY_STATUS_LABELS[recording.delivery.status] ||
                recording.delivery.status}
            </MetadataListItem>
          )}
          {recording.participation === 'ended' &&
            reason &&
            reason !== 'normal' &&
            reason !== 'source_binding_unverified' && (
            <MetadataListItem label="Endgrund">
              <Token size="sm" color="orange" label={reason} />
            </MetadataListItem>
          )}
        </MetadataList>
      </VStack>

      {sources.length > 0 && (
        <>
          <Divider variant="subtle" />
          <VStack gap={2}>
            <HStack justify="between" vAlign="center">
              <Heading level={4}>Sprecheranteile ({sources.length})</Heading>
              {selectedSourceFilter && onSelectSourceFilter && (
                <Button
                  variant="ghost"
                  size="sm"
                  label="Alle zeigen"
                  onClick={() => onSelectSourceFilter('')}
                />
              )}
            </HStack>

            <VStack gap={2}>
              {sources.map((src, idx) => {
                const filterKey = getSourceFilterKey(src);
                const isSelected = selectedSourceFilter === filterKey;
                const pct = Math.min(
                  100,
                  Math.round(((src.speech_seconds || 0) / totalSpeechSec) * 100)
                );
                const speakerName =
                  src.participant_name ||
                  src.speaker_label ||
                  src.provider_source_id;
                const barPalette = [
                  '#10b981',
                  '#3b82f6',
                  '#8b5cf6',
                  '#f59e0b',
                  '#ec4899',
                  '#14b8a6',
                ];
                const barColor = isSelected
                  ? 'var(--color-background-accent-emphasis, #059669)'
                  : barPalette[idx % barPalette.length];

                return (
                  <div
                    key={filterKey}
                    onClick={() =>
                      onSelectSourceFilter?.(isSelected ? '' : filterKey)
                    }
                    className={`cursor-pointer rounded-md p-2 transition-colors hover:bg-[var(--color-background-muted)] ${
                      isSelected
                        ? 'bg-[var(--color-background-muted)] ring-1 ring-[var(--color-border-accent)]'
                        : ''
                    }`}
                  >
                    <HStack justify="between" vAlign="center" gap={2}>
                      <HStack gap={1.5} vAlign="center" className="min-w-0">
                        <span
                          className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ background: barColor }}
                        />
                        <Text
                          type="supporting"
                          weight={isSelected ? 'semibold' : 'medium'}
                          color="primary"
                        >
                          {speakerName}
                        </Text>
                      </HStack>
                      <Text
                        type="supporting"
                        color="secondary"
                        hasTabularNumbers
                      >
                        <strong className="text-[var(--color-text-primary)] font-semibold">
                          {pct} %
                        </strong>{' '}
                        · {formatDurationHuman(src.speech_seconds)}
                      </Text>
                    </HStack>
                    <div
                      className="mt-1.5 w-full overflow-hidden rounded-full"
                      style={{
                        height: '7px',
                        background: 'var(--color-border)',
                      }}
                    >
                      <div
                        className="h-full rounded-full transition-all duration-300"
                        style={{
                          width: `${Math.max(pct > 0 ? 4 : 0, pct)}%`,
                          background: barColor,
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </VStack>
          </VStack>
        </>
      )}
    </VStack>
  );
}
