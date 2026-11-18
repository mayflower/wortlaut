import React, { useMemo } from 'react';
import { Filter, Radio } from 'lucide-react';
import {
  Table,
  pixel,
  proportional,
  type TableColumn,
} from '@astryxdesign/core/Table';
import { Avatar } from '@astryxdesign/core/Avatar';
import { Button } from '@astryxdesign/core/Button';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { formatDurationHuman, getSourceFilterKey } from '../api';
import { useI18n } from '../i18n';
import type { SourceSummary } from '../types';
import { StatusIndicator } from './ui/primitives';

export interface SourcesTabProps {
  sources: SourceSummary[];
  selectedSourceFilter: string;
  onSelectSourceForTranscript: (sourceId: string) => void;
}

type SourceRow = SourceSummary & {
  filter_key: string;
  share_pct: number;
} & Record<string, unknown>;

export function SourcesTab({
  sources,
  selectedSourceFilter,
  onSelectSourceForTranscript,
}: SourcesTabProps) {
  const { lang, tr } = useI18n();

  const totalSpeechSec = useMemo(
    () =>
      Math.max(
        1,
        sources.reduce((acc, s) => acc + (s.speech_seconds || 0), 0)
      ),
    [sources]
  );

  if (sources.length === 0) {
    return (
      <EmptyState
        headingLevel={2}
        icon={<Radio className="h-8 w-8" />}
        title={tr(
          'Noch keine Sprecher erkannt',
          'No speakers detected yet'
        )}
        description={tr(
          'Sobald Teilnehmende im Meeting sprechen, erscheinen ihre isolierten Audiospuren und Redeanteile hier.',
          'Once participants speak in the call, their isolated audio tracks and speaking shares appear here.'
        )}
      />
    );
  }

  const rows: SourceRow[] = sources.map((src) => ({
    ...src,
    filter_key: getSourceFilterKey(src),
    share_pct: Math.min(
      100,
      Math.round(((src.speech_seconds || 0) / totalSpeechSec) * 100)
    ),
  }));

  const columns: TableColumn<SourceRow>[] = [
    {
      key: 'participant_name',
      header: tr('Sprecher', 'Speaker'),
      width: proportional(2.4, { minWidth: 220 }),
      renderCell: (src) => {
        const hasName = Boolean(src.participant_name);
        const hasId = Boolean(src.signaled_participant_id);
        const displayLabel =
          src.participant_name ||
          src.speaker_label ||
          (hasId
            ? tr('Gebundener Teilnehmer', 'Bound participant')
            : tr('Unbekannte Quelle', 'Unidentified track'));
        return (
          <div className="source-row">
            <HStack gap={2} vAlign="center">
              <Avatar size="sm" shape="circle" name={displayLabel} />
              <VStack gap={0.5} hAlign="start" className="min-w-0">
                <HStack gap={2} vAlign="center">
                  <Text type="body" weight="semibold" color="primary" maxLines={1}>
                    {displayLabel}
                  </Text>
                  {!hasName && (
                    <StatusIndicator
                      variant={hasId ? 'accent' : 'warning'}
                      label={
                        hasId
                          ? tr('Sitzung gebunden', 'Session bound')
                          : tr('Ungebunden', 'Unbound')
                      }
                    />
                  )}
                </HStack>
                {src.sample_text && (
                  <div dir="auto" className="min-w-0 max-w-full">
                    <Text type="supporting" color="secondary" maxLines={1}>
                      {tr(`„${src.sample_text}“`, `“${src.sample_text}”`)}
                    </Text>
                  </div>
                )}
              </VStack>
            </HStack>
          </div>
        );
      },
    },
    {
      key: 'share_pct',
      header: tr('Redeanteil', 'Speaking share'),
      width: proportional(1.4, { minWidth: 160 }),
      renderCell: (src) => (
        <HStack gap={2} vAlign="center">
          <div
            className="w-24 overflow-hidden rounded-full"
            style={{ height: '6px', background: 'var(--color-border)' }}
          >
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.max(src.share_pct > 0 ? 5 : 0, src.share_pct)}%`,
                background: 'var(--wl-accent)',
              }}
            />
          </div>
          <Text type="supporting" color="primary" weight="semibold" hasTabularNumbers>
            {lang === 'en' ? `${src.share_pct}%` : `${src.share_pct} %`}
          </Text>
        </HStack>
      ),
    },
    {
      key: 'speech_seconds',
      header: tr('Sprechzeit', 'Active speech'),
      width: pixel(135),
      renderCell: (src) => (
        <Text type="supporting" color="primary" hasTabularNumbers>
          {formatDurationHuman(src.speech_seconds)}
        </Text>
      ),
    },
    {
      key: 'segment_count',
      header: tr('Beiträge', 'Turns'),
      width: pixel(105),
      renderCell: (src) => (
        <Text type="supporting" color="secondary" hasTabularNumbers>
          {src.segment_count}
        </Text>
      ),
    },
    {
      key: 'action',
      header: '',
      width: pixel(140),
      align: 'end',
      renderCell: (src) => {
        const isFiltered =
          selectedSourceFilter === src.filter_key ||
          selectedSourceFilter === src.provider_source_id;
        return (
          <span
            className="filter-source-btn"
            data-filter-source={src.provider_source_id}
          >
            <Button
              variant={isFiltered ? 'primary' : 'secondary'}
              size="sm"
              icon={<Filter className="h-3.5 w-3.5" />}
              label={
                isFiltered
                  ? tr('Gefiltert', 'Filtered')
                  : tr('Im Protokoll zeigen', 'Filter turns')
              }
              onClick={() => onSelectSourceForTranscript(src.filter_key)}
            />
          </span>
        );
      },
    },
  ];

  return (
    <VStack gap={3}>
      <Text type="supporting" color="secondary">
        {tr(
          'Jede Teilnehmerspur wurde vor dem Konferenz-Mix isoliert erfasst.',
          'Each participant audio track was captured in isolation prior to conference mixing.'
        )}
      </Text>

      <div className="hidden md:block">
        <Table<SourceRow>
          idKey="filter_key"
          density="balanced"
          dividers="rows"
          hasHover
          data={rows}
          columns={columns}
        />
      </div>

      <div className="md:hidden rounded-lg border border-[var(--color-border)] divide-y divide-[var(--color-border)]">
        {rows.map((src) => {
          const isFiltered = selectedSourceFilter === src.filter_key;
          const hasName = Boolean(src.participant_name);
          const hasId = Boolean(src.signaled_participant_id);
          const displayLabel =
            src.participant_name ||
            src.speaker_label ||
            (hasId
              ? tr('Gebundener Teilnehmer', 'Bound participant')
              : tr('Unbekannte Quelle', 'Unidentified track'));
          return (
            <div key={src.filter_key} className="source-row p-3.5">
              <VStack gap={2}>
                <HStack justify="between" vAlign="center" gap={2}>
                  <HStack gap={2} vAlign="center">
                    <Avatar size="sm" shape="circle" name={displayLabel} />
                    <VStack gap={0.5}>
                      <HStack gap={1.5} vAlign="center" wrap="wrap">
                        <Text type="body" weight="semibold" color="primary">
                          {displayLabel}
                        </Text>
                        {!hasName && (
                          <StatusIndicator
                            variant={hasId ? 'accent' : 'warning'}
                            label={
                              hasId
                                ? tr('Sitzung', 'Session')
                                : tr('Offen', 'Pending')
                            }
                          />
                        )}
                      </HStack>
                      <Text
                        type="supporting"
                        color="secondary"
                        hasTabularNumbers
                      >
                        {lang === 'en'
                          ? `${src.share_pct}% · ${formatDurationHuman(src.speech_seconds || 0)} · ${src.segment_count || 0} turns`
                          : `${src.share_pct} % · ${formatDurationHuman(src.speech_seconds || 0)} · ${src.segment_count || 0} Beiträge`}
                      </Text>
                    </VStack>
                  </HStack>
                  <span
                    className="filter-source-btn"
                    data-filter-source={src.provider_source_id}
                  >
                    <Button
                      variant={isFiltered ? 'primary' : 'secondary'}
                      size="sm"
                      icon={<Filter className="h-3.5 w-3.5" />}
                      label={
                        isFiltered
                          ? tr('Gefiltert', 'Filtered')
                          : tr('Filtern', 'Filter')
                      }
                      onClick={() => onSelectSourceForTranscript(src.filter_key)}
                    />
                  </span>
                </HStack>
                {src.sample_text && (
                  <div dir="auto" className="wl-break-anywhere">
                    <Text type="supporting" color="secondary" maxLines={2}>
                      {tr(`„${src.sample_text}“`, `“${src.sample_text}”`)}
                    </Text>
                  </div>
                )}
              </VStack>
            </div>
          );
        })}
      </div>
    </VStack>
  );
}
