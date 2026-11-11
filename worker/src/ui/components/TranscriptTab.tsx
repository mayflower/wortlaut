import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  CheckSquare,
  Copy,
  Edit3,
  FileText,
  Pause,
  Play,
  Replace,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import { HStack } from '@astryxdesign/core/HStack';
import { VStack } from '@astryxdesign/core/VStack';
import { Text } from '@astryxdesign/core/Text';
import { Heading } from '@astryxdesign/core/Heading';
import { Card } from '@astryxdesign/core/Card';
import { Avatar } from '@astryxdesign/core/Avatar';
import { Token } from '@astryxdesign/core/Token';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Selector } from '@astryxdesign/core/Selector';
import { IconButton } from '@astryxdesign/core/IconButton';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Divider } from '@astryxdesign/core/Divider';
import { Button } from '@astryxdesign/core/Button';
import { Banner } from '@astryxdesign/core/Banner';
import {
  ATTRIBUTION_STATUS_LABELS,
  fetchAudioSnippetBlobUrl,
  formatWallClockTime,
  generateRecordingSummary,
  getInstanceInfo,
  getSourceFilterKey,
  matchesSourceFilter,
  updateRecordingProtocol,
} from '../api';
import { localizeAttributionStatus, useI18n } from '../i18n';
import type {
  ParticipationState,
  ProcessingState,
  ProtocolSummary,
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
  token?: string;
  isOperator?: boolean;
  participation: ParticipationState;
  processing: ProcessingState;
  timeOriginUtc?: string | null;
  audioAvailable?: boolean;
  summary?: ProtocolSummary | null;
  termReplacements?: Record<string, string>;
  segments: TranscriptSegment[];
  sources: SourceSummary[];
  selectedSourceFilter: string;
  onSelectedSourceFilterChange: (sourceId: string) => void;
  onProtocolUpdated?: () => void;
}

interface TurnParagraph {
  id: string;
  start: number;
  end: number;
  text: string;
}

interface GroupedTurn {
  id: string;
  streamId: string;
  speakerKey: string;
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
  recordingId,
  token = '',
  isOperator = false,
  participation,
  processing,
  timeOriginUtc,
  audioAvailable = false,
  summary,
  termReplacements = {},
  segments,
  sources,
  selectedSourceFilter,
  onSelectedSourceFilterChange,
  onProtocolUpdated,
}: TranscriptTabProps) {
  const { lang, tr } = useI18n();
  const [searchQuery, setSearchQuery] = useState('');
  const [copiedTurnId, setCopiedTurnId] = useState<string | null>(null);

  // AI Summary state
  const [generatingSummary, setGeneratingSummary] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  // Audio snippet playback state
  const [playingTurnId, setPlayingTurnId] = useState<string | null>(null);
  const [loadingAudioTurnId, setLoadingAudioTurnId] = useState<string | null>(
    null
  );
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioBlobUrlRef = useRef<string | null>(null);

  // Inline turn & speaker edit state
  const [editingTurnId, setEditingTurnId] = useState<string | null>(null);
  const [editSpeakerName, setEditSpeakerName] = useState('');
  const [editTurnText, setEditTurnText] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  // Term replacement bar state
  const [showTermBar, setShowTermBar] = useState(false);
  const [termFrom, setTermFrom] = useState('');
  const [termTo, setTermTo] = useState('');
  const [savingTerm, setSavingTerm] = useState(false);

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      if (audioBlobUrlRef.current) {
        URL.revokeObjectURL(audioBlobUrlRef.current);
        audioBlobUrlRef.current = null;
      }
    };
  }, []);

  const allSpeakersLabel = tr(
    `Alle Sprecher (${sources.length})`,
    `All speakers (${sources.length})`
  );

  const sourceOptions = useMemo(() => {
    return [
      { value: 'all', label: allSpeakersLabel },
      ...sources.map((src) => ({
        value: getSourceFilterKey(src),
        label: `${src.participant_name || src.speaker_label || src.provider_source_id} (${src.segment_count})`,
      })),
    ];
  }, [sources, allSpeakersLabel]);

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

  const groupedTurns = useMemo<GroupedTurn[]>(() => {
    const turns: GroupedTurn[] = [];
    for (const seg of filteredSegments) {
      const segId = seg.segment_id || seg.id || `${seg.stream_id}-${seg.start}`;
      const segPid = seg.participant_id || seg.speaker_id;
      const segName = seg.participant_name || seg.speaker_name;
      const speakerKey = segPid || seg.speaker_label || seg.provider_source_id;
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
      if (prev && prev.id === segId) {
        prev.end = Math.max(prev.end, seg.end);
        const lastPara = prev.paragraphs[prev.paragraphs.length - 1];
        if (lastPara) {
          lastPara.end = Math.max(lastPara.end, seg.end);
          lastPara.text = `${lastPara.text} ${seg.text}`;
        }
      } else {
        turns.push({
          id: segId,
          streamId: seg.stream_id,
          speakerKey,
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

  const handlePlaySnippet = async (turn: GroupedTurn) => {
    if (!token) return;
    if (playingTurnId === turn.id && audioRef.current) {
      audioRef.current.pause();
      setPlayingTurnId(null);
      return;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (audioBlobUrlRef.current) {
      URL.revokeObjectURL(audioBlobUrlRef.current);
      audioBlobUrlRef.current = null;
    }
    setLoadingAudioTurnId(turn.id);
    try {
      const url = await fetchAudioSnippetBlobUrl(
        token,
        recordingId,
        turn.streamId,
        turn.start,
        turn.end
      );
      audioBlobUrlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => setPlayingTurnId(null);
      audio.onerror = () => setPlayingTurnId(null);
      setPlayingTurnId(turn.id);
      await audio.play();
    } catch {
      setPlayingTurnId(null);
    } finally {
      setLoadingAudioTurnId(null);
    }
  };

  const handleGenerateSummary = async () => {
    if (!token) return;
    setSummaryError(null);
    setGeneratingSummary(true);
    try {
      await generateRecordingSummary(token, recordingId);
      onProtocolUpdated?.();
    } catch (err) {
      setSummaryError(err instanceof Error ? err.message : String(err));
    } finally {
      setGeneratingSummary(false);
    }
  };

  const handleStartEditTurn = (turn: GroupedTurn) => {
    setEditingTurnId(turn.id);
    setEditSpeakerName(turn.speakerLabel);
    setEditTurnText(turn.paragraphs.map((p) => p.text).join(' '));
  };

  const handleSaveTurnEdit = async (turn: GroupedTurn) => {
    if (!token) return;
    setSavingEdit(true);
    try {
      const payload: {
        speaker_overrides?: Record<string, string>;
        segment_edits?: Record<string, string>;
      } = {};
      if (
        editSpeakerName.trim() &&
        editSpeakerName.trim() !== turn.speakerLabel
      ) {
        payload.speaker_overrides = {
          [turn.speakerKey]: editSpeakerName.trim(),
          [turn.speakerLabel]: editSpeakerName.trim(),
        };
      }
      const joinedOriginal = turn.paragraphs.map((p) => p.text).join(' ');
      if (editTurnText.trim() && editTurnText.trim() !== joinedOriginal) {
        payload.segment_edits = {
          [turn.id]: editTurnText.trim(),
        };
      }
      if (payload.speaker_overrides || payload.segment_edits) {
        await updateRecordingProtocol(token, recordingId, payload);
        onProtocolUpdated?.();
      }
      setEditingTurnId(null);
    } finally {
      setSavingEdit(false);
    }
  };

  const handleAddTermReplacement = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !termFrom.trim() || !termTo.trim()) return;
    setSavingTerm(true);
    try {
      await updateRecordingProtocol(token, recordingId, {
        term_replacements: {
          [termFrom.trim()]: termTo.trim(),
        },
      });
      setTermFrom('');
      setTermTo('');
      onProtocolUpdated?.();
    } finally {
      setSavingTerm(false);
    }
  };

  const handleRemoveTermReplacement = async (key: string) => {
    if (!token) return;
    setSavingTerm(true);
    try {
      await updateRecordingProtocol(token, recordingId, {
        term_replacements: {
          [key]: '',
        },
      });
      onProtocolUpdated?.();
    } finally {
      setSavingTerm(false);
    }
  };

  const totalSpeechSec = useMemo(() => {
    return Math.max(
      1,
      sources.reduce((acc, s) => acc + (s.speech_seconds || 0), 0)
    );
  }, [sources]);

  const activeTermEntries = Object.entries(termReplacements);
  const instance = getInstanceInfo();
  const llmSummaryEnabled = Boolean(instance.llmSummaryEnabled);

  return (
    <VStack gap={3}>
      {/* 1. Structured AI Protocol Summary & Action Items */}
      {(summary || (llmSummaryEnabled && isOperator && segments.length > 0)) && (
        <Card>
          <VStack gap={3}>
            <HStack justify="between" vAlign="center" wrap="wrap" gap={2}>
              <HStack gap={2} vAlign="center" wrap="wrap">
                <Sparkles className="h-4 w-4 text-[var(--color-text-accent)]" />
                <Heading level={4}>
                  {tr(
                    'Ergebnisprotokoll & Aufgaben',
                    'Executive Summary & Action Items'
                  )}
                </Heading>
                {(summary?.model || instance.llmModel) && (
                  <Token
                    size="sm"
                    color="green"
                    label={`${tr('Lokal', 'Local')} · ${summary?.model || instance.llmModel}`}
                  />
                )}
              </HStack>

              {llmSummaryEnabled && isOperator && segments.length > 0 && (
                <Button
                  variant={summary ? 'ghost' : 'secondary'}
                  size="sm"
                  isLoading={generatingSummary}
                  icon={<Sparkles className="h-3.5 w-3.5" />}
                  label={
                    summary
                      ? tr(
                          'Zusammenfassung aktualisieren',
                          'Regenerate summary'
                        )
                      : tr(
                          'KI-Zusammenfassung erstellen',
                          'Generate AI summary'
                        )
                  }
                  onClick={handleGenerateSummary}
                />
              )}
            </HStack>

            {summaryError && (
              <Banner status="error" container="card" title={summaryError} />
            )}

            {summary ? (
              <VStack gap={3}>
                {summary.summary && (
                  <Text type="body" color="primary">
                    {summary.summary}
                  </Text>
                )}

                {summary.topics && summary.topics.length > 0 && (
                  <VStack gap={1.5}>
                    <Text type="supporting" weight="semibold" color="secondary">
                      {tr(
                        'Besprochene Themen & Beschlüsse',
                        'Key Topics & Decisions'
                      )}
                    </Text>
                    <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                      {summary.topics.map((t, idx) => (
                        <div
                          key={idx}
                          className="rounded-md border border-[var(--color-border)] bg-[var(--color-background-muted)] p-2.5"
                        >
                          <VStack gap={0.5}>
                            <Text type="supporting" weight="semibold" color="primary">
                              {t.title}
                            </Text>
                            <Text type="supporting" color="secondary">
                              {t.details}
                            </Text>
                          </VStack>
                        </div>
                      ))}
                    </div>
                  </VStack>
                )}

                {summary.action_items && summary.action_items.length > 0 && (
                  <VStack gap={1.5}>
                    <Text type="supporting" weight="semibold" color="secondary">
                      {tr(
                        `Aufgaben & nächste Schritte (${summary.action_items.length})`,
                        `Action Items & Next Steps (${summary.action_items.length})`
                      )}
                    </Text>
                    <VStack gap={1}>
                      {summary.action_items.map((item, idx) => (
                        <HStack key={idx} gap={2} vAlign="start">
                          <CheckSquare className="h-4 w-4 shrink-0 mt-0.5 text-[var(--color-text-accent)]" />
                          <Text type="supporting" color="primary">
                            <strong className="font-semibold">
                              {item.owner}:
                            </strong>{' '}
                            {item.task}
                          </Text>
                        </HStack>
                      ))}
                    </VStack>
                  </VStack>
                )}
              </VStack>
            ) : (
              <Text type="supporting" color="secondary">
                {tr(
                  'Erstellen Sie per Klick eine strukturierte Kurzfassung, Themenübersicht und Aufgabenliste auf dem lokalen Sprachmodell.',
                  'Generate a structured executive summary, topic breakdown, and action items using your self-hosted LLM.'
                )}
              </Text>
            )}
          </VStack>
        </Card>
      )}

      {/* Interactive Speaker Filter Chips */}
      {sources.length > 0 && (
        <HStack gap={2} wrap="wrap" vAlign="center">
          <button
            type="button"
            onClick={() => onSelectedSourceFilterChange('')}
            className={`wl-speaker-chip ${!selectedSourceFilter ? 'active' : ''}`}
          >
            <span>{allSpeakersLabel}</span>
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
                <span className="opacity-70 tabular-nums">
                  ({lang === 'en' ? `${pct}%` : `${pct} %`})
                </span>
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
            label={tr('Im Transkript suchen', 'Search transcript')}
            isLabelHidden
            value={searchQuery}
            onChange={setSearchQuery}
            hasClear
            placeholder={tr(
              'Im Transkript nach Begriffen oder Sprechern suchen…',
              'Search transcript by keyword or speaker…'
            )}
            startIcon={<Search className="h-3.5 w-3.5" />}
          />
        </div>

        <HStack gap={2} vAlign="center" wrap="wrap">
          {isOperator && (
            <Button
              variant={
                showTermBar || activeTermEntries.length > 0
                  ? 'secondary'
                  : 'ghost'
              }
              size="sm"
              icon={<Replace className="h-3.5 w-3.5" />}
              label={
                activeTermEntries.length > 0
                  ? `${tr('Begriffe korrigieren', 'Replace terms')} (${activeTermEntries.length})`
                  : tr('Begriffe korrigieren', 'Replace terms')
              }
              onClick={() => setShowTermBar((v) => !v)}
            />
          )}

          {sources.length > 0 && (
            <div className="w-64">
              <Selector
                size="sm"
                label={tr('Sprecher filtern', 'Filter speaker')}
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
      </HStack>

      {/* Term Replacement Bar */}
      {isOperator && (showTermBar || activeTermEntries.length > 0) && (
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-background-muted)] p-3">
          <VStack gap={2}>
            <form
              onSubmit={handleAddTermReplacement}
              className="flex flex-wrap items-center gap-2"
            >
              <Text type="supporting" weight="semibold" color="primary">
                {tr(
                  'Fachbegriff / Name im gesamten Protokoll ersetzen:',
                  'Replace domain term or name across entire protocol:'
                )}
              </Text>
              <div className="w-44">
                <TextInput
                  size="sm"
                  label={tr('Falsch erkannt', 'Misheard term')}
                  isLabelHidden
                  value={termFrom}
                  onChange={setTermFrom}
                  placeholder={tr('z. B. OmniSA', 'e.g. OmniSA')}
                />
              </div>
              <span className="text-xs text-[var(--color-text-secondary)]">
                →
              </span>
              <div className="w-44">
                <TextInput
                  size="sm"
                  label={tr('Korrekte Schreibweise', 'Correct spelling')}
                  isLabelHidden
                  value={termTo}
                  onChange={setTermTo}
                  placeholder={tr('z. B. OmniASR', 'e.g. OmniASR')}
                />
              </div>
              <Button
                type="submit"
                variant="secondary"
                size="sm"
                isLoading={savingTerm}
                isDisabled={!termFrom.trim() || !termTo.trim()}
                label={tr('Übernehmen', 'Apply')}
              />
            </form>

            {activeTermEntries.length > 0 && (
              <HStack gap={1.5} wrap="wrap" vAlign="center">
                {activeTermEntries.map(([fromTerm, toTerm]) => (
                  <span
                    key={fromTerm}
                    className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-background-surface)] px-2.5 py-0.5 text-xs"
                  >
                    <span className="line-through opacity-70">{fromTerm}</span>
                    <span>→</span>
                    <strong className="font-semibold">{toTerm}</strong>
                    <button
                      type="button"
                      onClick={() => handleRemoveTermReplacement(fromTerm)}
                      className="ml-0.5 opacity-60 hover:opacity-100 cursor-pointer"
                      title={tr('Ersetzung entfernen', 'Remove replacement')}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </HStack>
            )}
          </VStack>
        </div>
      )}

      <Divider variant="subtle" />

      {/* Editorial Transcript Stream */}
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
                  ? tr(
                      'Hört zu — warte auf erste gesprochene Sätze…',
                      'Listening — waiting for first spoken statements…'
                    )
                  : processing === 'processing' || processing === 'pending'
                    ? tr(
                        'Spracherkennung erstellt das Wortprotokoll…',
                        'Local speech recognition is transcribing…'
                      )
                    : tr(
                        'Kein Transkript für diese Sitzung vorhanden',
                        'No transcript available for this session'
                      )
                : tr(
                    'Keine Segmente für diesen Filter gefunden',
                    'No segments match this filter'
                  )
            }
            description={
              segments.length === 0
                ? tr(
                    'Sobald im Gespräch gesprochen wird, erscheinen die Wortbeiträge hier automatisch nach Sprechern getrennt.',
                    'As soon as participants speak, statements appear here automatically separated by speaker.'
                  )
                : tr(
                    'Passen Sie den Suchbegriff oder den gewählten Sprecherfilter an.',
                    'Adjust your search query or clear the active speaker filter.'
                  )
            }
            actions={
              (searchQuery || selectedSourceFilter) && (
                <Button
                  variant="secondary"
                  size="sm"
                  label={tr('Filter zurücksetzen', 'Reset filters')}
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
              const isPlaying = playingTurnId === turn.id;
              const isLoadingAudio = loadingAudioTurnId === turn.id;
              const isEditing = editingTurnId === turn.id;

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

                          {/* Click-to-Listen Audio Snippet Playback */}
                          {audioAvailable && token && (
                            <button
                              type="button"
                              onClick={() => handlePlaySnippet(turn)}
                              disabled={isLoadingAudio}
                              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium transition-colors cursor-pointer ${
                                isPlaying
                                  ? 'bg-[var(--color-background-accent-emphasis,#059669)] text-white'
                                  : 'bg-[var(--color-background-muted)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
                              }`}
                              title={tr(
                                'Originalton dieser Stelle anhören',
                                'Listen to isolated speaker audio snippet'
                              )}
                            >
                              {isPlaying ? (
                                <Pause className="h-3 w-3" />
                              ) : (
                                <Play className="h-3 w-3" />
                              )}
                              <span>
                                {isLoadingAudio
                                  ? tr('Lädt…', 'Loading…')
                                  : isPlaying
                                    ? tr('Stopp', 'Stop')
                                    : tr('Anhören', 'Listen')}
                              </span>
                            </button>
                          )}

                          {!isBound && (
                            <Token
                              size="sm"
                              color="orange"
                              label={localizeAttributionStatus(
                                turn.attributionStatus,
                                lang,
                                ATTRIBUTION_STATUS_LABELS
                              )}
                            />
                          )}
                        </HStack>

                        <HStack
                          gap={1}
                          vAlign="center"
                          className="opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          {isOperator && (
                            <IconButton
                              variant="ghost"
                              size="sm"
                              label={tr(
                                'Sprecher oder Text korrigieren',
                                'Edit speaker or text'
                              )}
                              tooltip={tr(
                                'Sprecher oder Text korrigieren',
                                'Edit speaker or text'
                              )}
                              icon={<Edit3 className="h-3.5 w-3.5" />}
                              onClick={() => handleStartEditTurn(turn)}
                            />
                          )}
                          <IconButton
                            variant="ghost"
                            size="sm"
                            label={tr('Beitrag kopieren', 'Copy statement')}
                            tooltip={
                              isCopied
                                ? tr('Kopiert!', 'Copied!')
                                : tr('Beitrag kopieren', 'Copy statement')
                            }
                            icon={
                              isCopied ? (
                                <Check className="h-3.5 w-3.5" />
                              ) : (
                                <Copy className="h-3.5 w-3.5" />
                              )
                            }
                            onClick={() => handleCopyTurn(turn)}
                          />
                        </HStack>
                      </HStack>

                      {isEditing ? (
                        <div className="mt-2 rounded-md border border-[var(--color-border)] bg-[var(--color-background-muted)] p-3">
                          <VStack gap={2}>
                            <div className="w-72">
                              <TextInput
                                size="sm"
                                label={tr(
                                  'Sprechername (für alle Beiträge dieser Quelle)',
                                  'Speaker name (applies to all turns from this source)'
                                )}
                                value={editSpeakerName}
                                onChange={setEditSpeakerName}
                              />
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
                                {tr(
                                  'Protokolltext dieses Beitrags',
                                  'Statement text'
                                )}
                              </label>
                              <textarea
                                value={editTurnText}
                                onChange={(e) =>
                                  setEditTurnText(e.target.value)
                                }
                                rows={3}
                                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-background-surface)] p-2 text-sm text-[var(--color-text-primary)]"
                              />
                            </div>
                            <HStack gap={2}>
                              <Button
                                variant="primary"
                                size="sm"
                                isLoading={savingEdit}
                                label={tr('Speichern', 'Save')}
                                onClick={() => handleSaveTurnEdit(turn)}
                              />
                              <Button
                                variant="ghost"
                                size="sm"
                                label={tr('Abbrechen', 'Cancel')}
                                onClick={() => setEditingTurnId(null)}
                              />
                            </HStack>
                          </VStack>
                        </div>
                      ) : (
                        <VStack gap={1.5} paddingBlockStart={1}>
                          {turn.paragraphs.map((para) => (
                            <div key={para.id}>
                              <Text type="body" color="primary">
                                {renderHighlightedText(para.text, searchQuery)}
                              </Text>
                            </div>
                          ))}
                        </VStack>
                      )}
                    </div>
                  </HStack>
                </div>
              );
            })}

            {participation === 'capturing' && (
              <div className="py-3.5 px-2 flex items-center gap-2.5 text-sm text-[var(--color-text-secondary)]">
                <LiveWaveform />
                <span>
                  {tr(
                    'Hört aktiv zu — neue Wortbeiträge erscheinen hier automatisch…',
                    'Actively listening — new statements appear here automatically…'
                  )}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </VStack>
  );
}
