import React, { useMemo, useState } from 'react';
import { Check, Copy, FileText, Search } from 'lucide-react';
import { HStack } from '@astryxdesign/core/HStack';
import { VStack } from '@astryxdesign/core/VStack';
import { Text } from '@astryxdesign/core/Text';
import { Avatar } from '@astryxdesign/core/Avatar';
import { Token } from '@astryxdesign/core/Token';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Selector } from '@astryxdesign/core/Selector';
import { IconButton } from '@astryxdesign/core/IconButton';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Divider } from '@astryxdesign/core/Divider';
import { Button } from '@astryxdesign/core/Button';
import {
  ATTRIBUTION_STATUS_LABELS,
  formatDurationClock,
} from '../api';
import type {
  ParticipationState,
  ProcessingState,
  SourceSummary,
  TranscriptSegment,
} from '../types';

export interface TranscriptTabProps {
  recordingId: string;
  participation: ParticipationState;
  processing: ProcessingState;
  segments: TranscriptSegment[];
  sources: SourceSummary[];
  selectedSourceFilter: string;
  onSelectedSourceFilterChange: (sourceId: string) => void;
}

interface TurnParagraph {
  id: string;
  start: number;
  end: number;
  text: string;
}

interface GroupedTurn {
  id: string;
  speakerLabel: string;
  speakerName: string | null;
  providerSourceId: string;
  attributionStatus: string;
  start: number;
  end: number;
  paragraphs: TurnParagraph[];
}

export function TranscriptTab({
  participation,
  processing,
  segments,
  sources,
  selectedSourceFilter,
  onSelectedSourceFilterChange,
}: TranscriptTabProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [copiedTurnId, setCopiedTurnId] = useState<string | null>(null);

  const sourceOptions = useMemo(() => {
    return [
      { value: 'all', label: `Alle Sprecher (${sources.length})` },
      ...sources.map((src) => ({
        value: src.provider_source_id,
        label: `${src.participant_name || src.speaker_label || src.provider_source_id} (${src.segment_count})`,
      })),
    ];
  }, [sources]);

  const filteredSegments = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return segments.filter((seg) => {
      if (
        selectedSourceFilter &&
        seg.provider_source_id !== selectedSourceFilter
      ) {
        return false;
      }
      if (!q) return true;
      const hay =
        `${seg.speaker_label} ${seg.speaker_name || ''} ${seg.text}`.toLowerCase();
      return hay.includes(q);
    });
  }, [segments, selectedSourceFilter, searchQuery]);

  // Group consecutive segments from the same speaker into a single turn,
  // splitting into sub-paragraphs when a pause exceeds 8 seconds.
  const groupedTurns = useMemo<GroupedTurn[]>(() => {
    const turns: GroupedTurn[] = [];
    for (const seg of filteredSegments) {
      const prev = turns[turns.length - 1];
      if (
        prev &&
        prev.providerSourceId === seg.provider_source_id &&
        prev.speakerLabel === seg.speaker_label
      ) {
        prev.end = seg.end;
        const lastPara = prev.paragraphs[prev.paragraphs.length - 1];
        if (lastPara && seg.start - lastPara.end <= 8.0) {
          lastPara.end = seg.end;
          lastPara.text = `${lastPara.text} ${seg.text}`;
        } else {
          prev.paragraphs.push({
            id: seg.segment_id,
            start: seg.start,
            end: seg.end,
            text: seg.text,
          });
        }
      } else {
        turns.push({
          id: seg.segment_id,
          speakerLabel: seg.speaker_label,
          speakerName: seg.speaker_name,
          providerSourceId: seg.provider_source_id,
          attributionStatus: seg.attribution_status,
          start: seg.start,
          end: seg.end,
          paragraphs: [
            {
              id: seg.segment_id,
              start: seg.start,
              end: seg.end,
              text: seg.text,
            },
          ],
        });
      }
    }
    return turns;
  }, [filteredSegments]);

  const handleCopyTurn = async (turn: GroupedTurn) => {
    if (!navigator.clipboard) return;
    const text = `[${formatDurationClock(turn.start)}] ${turn.speakerLabel}: ${turn.paragraphs.map((p) => p.text).join('\n')}`;
    await navigator.clipboard.writeText(text).catch(() => {});
    setCopiedTurnId(turn.id);
    setTimeout(() => setCopiedTurnId(null), 1600);
  };

  return (
    <VStack gap={3}>
      {/* Sticky Filter & Search Toolbar */}
      <HStack justify="between" vAlign="center" wrap="wrap" gap={2}>
        <div id="segment-search" className="flex-1 min-w-[240px]">
          <TextInput
            type="search"
            size="sm"
            label="Im Transkript suchen"
            isLabelHidden
            value={searchQuery}
            onChange={setSearchQuery}
            hasClear
            placeholder="Im Transkript nach Begriffen oder Sprechern suchen…"
            startIcon={<Search className="h-3.5 w-3.5" />}
          />
        </div>

        {sources.length > 0 && (
          <div className="w-64">
            <Selector
              size="sm"
              label="Sprecher filtern"
              isLabelHidden
              options={sourceOptions}
              value={selectedSourceFilter || 'all'}
              onChange={(v) =>
                onSelectedSourceFilterChange(v === 'all' ? '' : v)
              }
            />
          </div>
        )}
      </HStack>

      <Divider variant="subtle" />

      {/* Editorial Transcript Stream (no Card soup around individual turns) */}
      <div id="transcript-view">
        {groupedTurns.length === 0 ? (
          <EmptyState
            icon={<FileText className="h-8 w-8" />}
            title={
              segments.length === 0
                ? participation === 'capturing'
                  ? 'Warte auf erste gesprochene Sätze…'
                  : processing === 'processing' || processing === 'pending'
                    ? 'Spracherkennung verarbeitet die Audiospuren…'
                    : 'Kein Transkript für diese Sitzung vorhanden'
                : 'Keine Segmente für diesen Filter gefunden'
            }
            description={
              segments.length === 0
                ? 'Sobald auf einer gebundenen Teilnehmer-Audiospur Sprache erkannt wird, erscheinen die Beiträge hier chronologisch.'
                : 'Passen Sie den Suchbegriff oder den gewählten Sprecherfilter an.'
            }
            actions={
              (searchQuery || selectedSourceFilter) && (
                <Button
                  variant="secondary"
                  size="sm"
                  label="Filter zurücksetzen"
                  onClick={() => {
                    setSearchQuery('');
                    onSelectedSourceFilterChange('');
                  }}
                />
              )
            }
          />
        ) : (
          <div className="divide-y divide-[var(--color-border)]">
            {groupedTurns.map((turn) => {
              const isCopied = copiedTurnId === turn.id;
              const isBound = turn.attributionStatus === 'bound';

              return (
                <div
                  key={turn.id}
                  id={`seg-${turn.id}`}
                  className="group py-3.5"
                >
                  <HStack gap={3} vAlign="start">
                    <Avatar
                      size="sm"
                      shape="circle"
                      name={turn.speakerLabel}
                    />
                    <div className="min-w-0 flex-1">
                      <HStack
                        justify="between"
                        vAlign="center"
                        wrap="wrap"
                        gap={2}
                      >
                        <HStack gap={2} vAlign="center" wrap="wrap">
                          <button
                            type="button"
                            onClick={() =>
                              onSelectedSourceFilterChange(
                                selectedSourceFilter === turn.providerSourceId
                                  ? ''
                                  : turn.providerSourceId
                              )
                            }
                            className="font-semibold text-sm text-[var(--color-text-primary)] hover:text-[var(--color-text-accent)] cursor-pointer"
                          >
                            {turn.speakerLabel}
                          </button>
                          <Text
                            type="supporting"
                            color="secondary"
                            hasTabularNumbers
                          >
                            {formatDurationClock(turn.start)} –{' '}
                            {formatDurationClock(turn.end)}
                          </Text>
                          {!isBound && (
                            <Token
                              size="sm"
                              color="orange"
                              label={
                                ATTRIBUTION_STATUS_LABELS[
                                  turn.attributionStatus
                                ] || turn.attributionStatus
                              }
                            />
                          )}
                        </HStack>

                        <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                          <IconButton
                            variant="ghost"
                            size="sm"
                            label="Beitrag kopieren"
                            tooltip={isCopied ? 'Kopiert!' : 'Beitrag kopieren'}
                            icon={
                              isCopied ? (
                                <Check className="h-3.5 w-3.5" />
                              ) : (
                                <Copy className="h-3.5 w-3.5" />
                              )
                            }
                            onClick={() => handleCopyTurn(turn)}
                          />
                        </div>
                      </HStack>

                      <VStack gap={1.5} paddingBlockStart={1}>
                        {turn.paragraphs.map((para, idx) => (
                          <div key={para.id}>
                            {idx > 0 && (
                              <Text
                                type="supporting"
                                color="secondary"
                                hasTabularNumbers
                              >
                                [{formatDurationClock(para.start)}]
                              </Text>
                            )}
                            <Text type="body" color="primary">
                              {para.text}
                            </Text>
                          </div>
                        ))}
                      </VStack>
                    </div>
                  </HStack>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </VStack>
  );
}
