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
  formatWallClockTime,
  getSourceFilterKey,
  matchesSourceFilter,
} from '../api';
import type {
  ParticipationState,
  ProcessingState,
  SourceSummary,
  TranscriptSegment,
} from '../types';
import { LiveWaveform } from './ui/primitives';

function renderHighlightedText(text: string, query: string): React.ReactNode {
  const q = query.trim();
  if (!q) return text;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
  return parts.map((part, idx) =>
    part.toLowerCase() === q.toLowerCase() ? (
      <mark key={idx} className="wl-search-hit">
        {part}
      </mark>
    ) : (
      part
    )
  );
}

export interface TranscriptTabProps {
  recordingId: string;
  participation: ParticipationState;
  processing: ProcessingState;
  timeOriginUtc?: string | null;
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
  filterKey: string;
  attributionStatus: string;
  start: number;
  end: number;
  paragraphs: TurnParagraph[];
}

export function TranscriptTab({
  participation,
  processing,
  timeOriginUtc,
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
        value: getSourceFilterKey(src),
        label: `${src.participant_name || src.speaker_label || src.provider_source_id} (${src.segment_count})`,
      })),
    ];
  }, [sources]);

  const filteredSegments = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return segments.filter((seg) => {
      if (
        selectedSourceFilter &&
        !matchesSourceFilter(seg, selectedSourceFilter)
      ) {
        return false;
      }
      if (!q) return true;
      const hay =
        `${seg.speaker_label} ${seg.participant_name || seg.speaker_name || ''} ${seg.text}`.toLowerCase();
      return hay.includes(q);
    });
  }, [segments, selectedSourceFilter, searchQuery]);

  // Group consecutive segments from the same speaker into a single turn,
  // splitting into sub-paragraphs when a pause exceeds 8 seconds.
  const groupedTurns = useMemo<GroupedTurn[]>(() => {
    const turns: GroupedTurn[] = [];
    for (const seg of filteredSegments) {
      const segId = seg.segment_id || seg.id || `${seg.stream_id}-${seg.start}`;
      const segPid = seg.participant_id || seg.speaker_id;
      const segName = seg.participant_name || seg.speaker_name;
      const segFilterKey = segPid
        ? `participant:${segPid}`
        : segName
          ? `name:${segName}`
          : seg.provider_source_id;
      const segAttrStatus =
        seg.attribution_status ||
        (seg.attribution_unknown
          ? 'unknown'
          : segPid
            ? 'bound'
            : 'unbound');
      const prev = turns[turns.length - 1];
      if (prev && prev.speakerLabel === seg.speaker_label) {
        prev.end = seg.end;
        const lastPara = prev.paragraphs[prev.paragraphs.length - 1];
        if (lastPara && seg.start - lastPara.end <= 20.0) {
          lastPara.end = seg.end;
          lastPara.text = `${lastPara.text} ${seg.text}`;
        } else {
          prev.paragraphs.push({
            id: segId,
            start: seg.start,
            end: seg.end,
            text: seg.text,
          });
        }
      } else {
        turns.push({
          id: segId,
          speakerLabel: seg.speaker_label,
          speakerName: segName,
          providerSourceId: seg.provider_source_id,
          filterKey: segFilterKey,
          attributionStatus: segAttrStatus,
          start: seg.start,
          end: seg.end,
          paragraphs: [
            {
              id: segId,
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
    const text = `[${formatWallClockTime(turn.start, timeOriginUtc)}] ${turn.speakerLabel}: ${turn.paragraphs.map((p) => p.text).join('\n')}`;
    await navigator.clipboard.writeText(text).catch(() => {});
    setCopiedTurnId(turn.id);
    setTimeout(() => setCopiedTurnId(null), 1600);
  };

  const totalSpeechSec = useMemo(() => {
    return Math.max(
      1,
      sources.reduce((acc, s) => acc + (s.speech_seconds || 0), 0)
    );
  }, [sources]);

  return (
    <VStack gap={3}>
      {/* Interactive Speaker Filter Chips */}
      {sources.length > 0 && (
        <HStack gap={2} wrap="wrap" vAlign="center">
          <button
            type="button"
            onClick={() => onSelectedSourceFilterChange('')}
            className={`wl-speaker-chip ${!selectedSourceFilter ? 'active' : ''}`}
          >
            <span>Alle Sprecher ({sources.length})</span>
          </button>
          {sources.map((src) => {
            const filterKey = getSourceFilterKey(src);
            const isSelected = selectedSourceFilter === filterKey;
            const pct = Math.min(
              100,
              Math.round(((src.speech_seconds || 0) / totalSpeechSec) * 100)
            );
            const name =
              src.participant_name ||
              src.speaker_label ||
              src.provider_source_id;
            return (
              <button
                key={filterKey}
                type="button"
                onClick={() =>
                  onSelectedSourceFilterChange(isSelected ? '' : filterKey)
                }
                className={`wl-speaker-chip ${isSelected ? 'active' : ''}`}
              >
                <Avatar size="sm" shape="circle" name={name} />
                <span>{name}</span>
                <span className="opacity-70 tabular-nums">({pct} %)</span>
              </button>
            );
          })}
        </HStack>
      )}

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
            icon={
              participation === 'capturing' ? (
                <LiveWaveform />
              ) : (
                <FileText className="h-8 w-8" />
              )
            }
            title={
              segments.length === 0
                ? participation === 'capturing'
                  ? 'Hört zu — warte auf erste gesprochene Sätze…'
                  : processing === 'processing' || processing === 'pending'
                    ? 'Spracherkennung erstellt das Wortprotokoll…'
                    : 'Kein Transkript für diese Sitzung vorhanden'
                : 'Keine Segmente für diesen Filter gefunden'
            }
            description={
              segments.length === 0
                ? 'Sobald im Gespräch gesprochen wird, erscheinen die Wortbeiträge hier automatisch nach Sprechern getrennt.'
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
                  className="group wl-turn-row wl-fade-in"
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
                                selectedSourceFilter === turn.filterKey
                                  ? ''
                                  : turn.filterKey
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
                            {formatWallClockTime(turn.start, timeOriginUtc)} –{' '}
                            {formatWallClockTime(turn.end, timeOriginUtc)}
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
                        {turn.paragraphs.map((para) => (
                          <div key={para.id}>
                            <Text type="body" color="primary">
                              {renderHighlightedText(para.text, searchQuery)}
                            </Text>
                          </div>
                        ))}
                      </VStack>
                    </div>
                  </HStack>
                </div>
              );
            })}

            {participation === 'capturing' && (
              <div className="py-3.5 px-2 flex items-center gap-2.5 text-sm text-[var(--color-text-secondary)]">
                <LiveWaveform />
                <span>Hört aktiv zu — neue Wortbeiträge erscheinen hier automatisch…</span>
              </div>
            )}
          </div>
        )}
      </div>
    </VStack>
  );
}
