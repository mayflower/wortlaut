import React from 'react';
import { Filter, Radio } from 'lucide-react';
import {
  Table,
  pixel,
  proportional,
  type TableColumn,
} from '@astryxdesign/core/Table';
import { Token } from '@astryxdesign/core/Token';
import { Button } from '@astryxdesign/core/Button';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { formatDurationHuman } from '../api';
import type { SourceSummary } from '../types';
import { StatusIndicator } from './ui/primitives';

export interface SourcesTabProps {
  sources: SourceSummary[];
  selectedSourceFilter: string;
  onSelectSourceForTranscript: (sourceId: string) => void;
}

type SourceRow = SourceSummary & Record<string, unknown>;

export function SourcesTab({
  sources,
  selectedSourceFilter,
  onSelectSourceForTranscript,
}: SourcesTabProps) {
  if (sources.length === 0) {
    return (
      <EmptyState
        icon={<Radio className="h-8 w-8" />}
        title="Noch keine empfangenen Audio-Quellen registriert"
        description="Sobald WebRTC-Receiver im Meeting Audio empfangen, werden hier die einzelnen Streams und ihre Teilnehmerbindung aufgelistet."
      />
    );
  }

  const columns: TableColumn<SourceRow>[] = [
    {
      key: 'participant_name',
      header: 'Sprecher & Bindung',
      width: proportional(1.8, { minWidth: 220 }),
      renderCell: (src) => {
        const hasName = Boolean(src.participant_name);
        const hasId = Boolean(src.signaled_participant_id);
        return (
          <div className="source-row">
            <VStack gap={0.5} hAlign="start">
              <StatusIndicator
                variant={hasName ? 'success' : hasId ? 'accent' : 'warning'}
                weight="semibold"
                label={
                  src.participant_name ||
                  (src.signaled_participant_id
                    ? `Teilnehmer ${src.signaled_participant_id}`
                    : 'Zuordnung offen')
                }
              />
              {src.sample_text && (
                <Text type="supporting" color="secondary" maxLines={1}>
                  „{src.sample_text}“
                </Text>
              )}
            </VStack>
          </div>
        );
      },
    },
    {
      key: 'provider_source_id',
      header: 'WebRTC-Quelle / Session',
      width: proportional(1.5, { minWidth: 190 }),
      renderCell: (src) => (
        <VStack gap={0.5} hAlign="start">
          <Token size="sm" color="blue" label={src.provider_source_id} />
          <Text type="supporting" color="secondary" maxLines={1}>
            {src.signaled_participant_id
              ? `Session: ${src.signaled_participant_id}`
              : 'Keine Session-ID'}
            {src.csi != null ? ` · CSI: ${src.csi}` : ''}
          </Text>
        </VStack>
      ),
    },
    {
      key: 'speech_seconds',
      header: 'Aktive Sprache',
      width: pixel(155),
      renderCell: (src) => (
        <Text type="supporting" color="primary" hasTabularNumbers>
          <strong>{formatDurationHuman(src.speech_seconds)}</strong> (
          {formatDurationHuman(src.accepted_seconds)} Audio)
        </Text>
      ),
    },
    {
      key: 'segment_count',
      header: 'Segmente',
      width: pixel(105),
      renderCell: (src) => (
        <Text type="supporting" color="primary" hasTabularNumbers>
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
        const isFiltered = selectedSourceFilter === src.provider_source_id;
        return (
          <span
            className="filter-source-btn"
            data-filter-source={src.provider_source_id}
          >
            <Button
              variant={isFiltered ? 'primary' : 'secondary'}
              size="sm"
              icon={<Filter className="h-3.5 w-3.5" />}
              label={isFiltered ? 'Aktiv' : 'Filtern'}
              onClick={() =>
                onSelectSourceForTranscript(src.provider_source_id)
              }
            />
          </span>
        );
      },
    },
  ];

  return (
    <VStack gap={3}>
      <Text type="supporting" color="secondary">
        Jede empfangene WebRTC-Audiospur wird vor dem Mix separat erfasst und an
        die nachgewiesene Provider-Teilnehmersitzung gebunden.
      </Text>

      <Table<SourceRow>
        idKey="provider_source_id"
        density="balanced"
        dividers="rows"
        hasHover
        data={sources as SourceRow[]}
        columns={columns}
      />
    </VStack>
  );
}
