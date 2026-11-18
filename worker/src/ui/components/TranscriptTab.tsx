import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  CheckSquare,
  Copy,
  Edit3,
  FileText,
  Maximize2,
  MonitorUp,
  Pause,
  Play,
  Plus,
  Replace,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { HStack } from '@astryxdesign/core/HStack';
import { VStack } from '@astryxdesign/core/VStack';
import { Text } from '@astryxdesign/core/Text';
import { Heading } from '@astryxdesign/core/Heading';
import { Avatar } from '@astryxdesign/core/Avatar';
import { Token } from '@astryxdesign/core/Token';
import { TextInput } from '@astryxdesign/core/TextInput';
import { IconButton } from '@astryxdesign/core/IconButton';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Button } from '@astryxdesign/core/Button';
import { Banner } from '@astryxdesign/core/Banner';
import {
  ATTRIBUTION_STATUS_LABELS,
  deleteRecordingKeyframe,
  fetchAudioSnippetBlobUrl,
  fetchKeyframeBlobUrl,
  formatWallClockTime,
  generateRecordingSummary,
  getInstanceInfo,
  getSourceFilterKey,
  matchesKeyframeSourceFilter,
  matchesSourceFilter,
  updateRecordingProtocol,
} from '../api';
import { KEYFRAME_STRINGS, localizeAttributionStatus, useI18n } from '../i18n';
import type {
  ParticipationState,
  PauseWindow,
  ProcessingState,
  ProtocolSummary,
  RecordingKeyframe,
  SourceSummary,
  TranscriptSegment,
} from '../types';
import { LiveWaveform } from './ui/primitives';

function foldSearchText(raw: string): string {
  // Preserve U+200C (ZWNJ) while normalizing Arabic/Persian Yeh & Kaf variants
  return raw
    .replace(/\u064a/g, '\u06cc')
    .replace(/\u0643/g, '\u06a9')
    .toLowerCase();
}

function renderHighlightedText(text: string, query: string): React.ReactNode {
  const q = query.trim();
  if (!q) return text;
  const escaped = q
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/[\u064a\u06cc]/g, '[\u064a\u06cc]')
    .replace(/[\u0643\u06a9]/g, '[\u0643\u06a9]');
  const foldedQuery = foldSearchText(q);
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
  return parts.map((part, idx) =>
    foldSearchText(part) === foldedQuery ? (
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
  keyframes?: RecordingKeyframe[];
  focusKeyframeId?: string | null;
  pauseWindows?: PauseWindow[];
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

type TimelineItem =
  | { kind: 'turn'; offset: number; turn: GroupedTurn }
  | { kind: 'keyframe'; offset: number; keyframe: RecordingKeyframe }
  | { kind: 'pause'; offset: number; pause: PauseWindow; index: number };

interface KeyframeTimelineCardProps {
  keyframe: RecordingKeyframe;
  blobUrl?: string;
  hasError?: boolean;
  timeLabel: string;
  badgeLabel: string;
  altLabel: string;
  loadingLabel: string;
  unavailableLabel: string;
  openPreviewLabel: string;
  deleteLabel: string;
  isOperator: boolean;
  isActiveFilter: boolean;
  onToggleFilter: () => void;
  onRequestLoad: (kf: RecordingKeyframe) => void;
  onOpenPreview: (kf: RecordingKeyframe) => void;
  onRequestDelete: (kf: RecordingKeyframe) => void;
}

function KeyframeTimelineCard({
  keyframe,
  blobUrl,
  hasError,
  timeLabel,
  badgeLabel,
  altLabel,
  loadingLabel,
  unavailableLabel,
  openPreviewLabel,
  deleteLabel,
  isOperator,
  isActiveFilter,
  onToggleFilter,
  onRequestLoad,
  onOpenPreview,
  onRequestDelete,
}: KeyframeTimelineCardProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (blobUrl || hasError) return;
    const node = containerRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      onRequestLoad(keyframe);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          onRequestLoad(keyframe);
          observer.disconnect();
        }
      },
      { rootMargin: '240px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [keyframe, blobUrl, hasError, onRequestLoad]);

  return (
    <div
      ref={containerRef}
      id={`keyframe-${keyframe.id}`}
      className="group wl-turn-row"
    >
      <HStack gap={3} vAlign="start">
        <Avatar size="sm" shape="circle" name={keyframe.presenter} />
        <div className="min-w-0 flex-1">
          <HStack justify="between" vAlign="center" wrap="wrap" gap={2}>
            <HStack gap={2} vAlign="center" wrap="wrap">
              <button
                type="button"
                onClick={onToggleFilter}
                className={`font-semibold text-[14px] leading-snug cursor-pointer ${
                  isActiveFilter
                    ? 'wl-text-accent'
                    : 'text-[var(--color-text-primary)] wl-hover-accent'
                }`}
              >
                {keyframe.presenter}
              </button>
              <Text type="supporting" color="secondary" hasTabularNumbers>
                {timeLabel}
              </Text>
              <Token size="sm" color="blue" label={badgeLabel} />
            </HStack>

            <HStack
              gap={1}
              vAlign="center"
              className="wl-row-actions"
            >
              {blobUrl && (
                <IconButton
                  variant="ghost"
                  size="sm"
                  label={openPreviewLabel}
                  tooltip={openPreviewLabel}
                  icon={<Maximize2 className="h-3.5 w-3.5" />}
                  onClick={() => onOpenPreview(keyframe)}
                />
              )}
              {isOperator && (
                <IconButton
                  variant="ghost"
                  size="sm"
                  label={deleteLabel}
                  tooltip={deleteLabel}
                  icon={<Trash2 className="h-3.5 w-3.5" />}
                  onClick={() => onRequestDelete(keyframe)}
                />
              )}
            </HStack>
          </HStack>

          <div className="mt-2">
            {blobUrl ? (
              <button
                type="button"
                onClick={() => onOpenPreview(keyframe)}
                className="block overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-background-muted)] hover:border-[var(--color-border-accent,var(--color-text-accent))] transition-colors cursor-zoom-in max-w-md"
                title={openPreviewLabel}
              >
                <img
                  src={blobUrl}
                  alt={`${altLabel} — ${keyframe.presenter} (${timeLabel})`}
                  width={keyframe.width}
                  height={keyframe.height}
                  className="max-h-56 w-auto object-contain block"
                />
              </button>
            ) : (
              <div className="inline-flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-background-muted)] px-3.5 py-2.5 text-[13px] text-[var(--color-text-secondary)]">
                <MonitorUp className="h-4 w-4 shrink-0" />
                <span>{hasError ? unavailableLabel : loadingLabel}</span>
              </div>
            )}
          </div>
        </div>
      </HStack>
    </div>
  );
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
  keyframes = [],
  focusKeyframeId = null,
  pauseWindows = [],
  sources,
  selectedSourceFilter,
  onSelectedSourceFilterChange,
  onProtocolUpdated,
}: TranscriptTabProps) {
  const { lang, tr } = useI18n();
  const kStr = KEYFRAME_STRINGS[lang];
  const [searchQuery, setSearchQuery] = useState('');
  const [copiedTurnId, setCopiedTurnId] = useState<string | null>(null);

  // AI Summary & manual To-Do editor state
  const [generatingSummary, setGeneratingSummary] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [editingSummary, setEditingSummary] = useState(false);
  const [summaryDraft, setSummaryDraft] = useState('');
  const [topicsDraft, setTopicsDraft] = useState<
    Array<{ title: string; details: string }>
  >([]);
  const [actionItemsDraft, setActionItemsDraft] = useState<
    Array<{ owner: string; task: string; due: string }>
  >([]);
  const [savingSummary, setSavingSummary] = useState(false);

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

  // Screen-share keyframe blob URLs, preview modal & operator deletion state
  const [keyframeBlobUrls, setKeyframeBlobUrls] = useState<
    Record<string, string>
  >({});
  const [keyframeErrors, setKeyframeErrors] = useState<Record<string, boolean>>(
    {}
  );
  const createdKeyframeUrlsRef = useRef<Map<string, string>>(new Map());
  const inflightKeyframeIdsRef = useRef<Set<string>>(new Set());
  const keyframeErrorsRef = useRef<Set<string>>(new Set());
  const [previewKeyframe, setPreviewKeyframe] =
    useState<RecordingKeyframe | null>(null);
  const [confirmDeleteKeyframe, setConfirmDeleteKeyframe] =
    useState<RecordingKeyframe | null>(null);
  const [deletingKeyframeId, setDeletingKeyframeId] = useState<string | null>(
    null
  );

  useEffect(() => {
    setEditingSummary(false);
    setSummaryError(null);
    setEditingTurnId(null);
    setPreviewKeyframe(null);
    setConfirmDeleteKeyframe(null);
    for (const url of createdKeyframeUrlsRef.current.values()) {
      URL.revokeObjectURL(url);
    }
    createdKeyframeUrlsRef.current.clear();
    inflightKeyframeIdsRef.current.clear();
    keyframeErrorsRef.current.clear();
    setKeyframeBlobUrls({});
    setKeyframeErrors({});
  }, [recordingId]);

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
      for (const url of createdKeyframeUrlsRef.current.values()) {
        URL.revokeObjectURL(url);
      }
      createdKeyframeUrlsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!previewKeyframe) return;
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        setPreviewKeyframe(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [previewKeyframe]);

  const requestKeyframeImage = useCallback(
    (kf: RecordingKeyframe) => {
      if (
        createdKeyframeUrlsRef.current.has(kf.id) ||
        inflightKeyframeIdsRef.current.has(kf.id) ||
        keyframeErrorsRef.current.has(kf.id)
      ) {
        return;
      }
      inflightKeyframeIdsRef.current.add(kf.id);
      void fetchKeyframeBlobUrl(kf.image_path, token)
        .then((blobUrl) => {
          createdKeyframeUrlsRef.current.set(kf.id, blobUrl);
          setKeyframeBlobUrls((prev) => ({ ...prev, [kf.id]: blobUrl }));
        })
        .catch(() => {
          keyframeErrorsRef.current.add(kf.id);
          setKeyframeErrors((prev) => ({ ...prev, [kf.id]: true }));
        })
        .finally(() => {
          inflightKeyframeIdsRef.current.delete(kf.id);
        });
    },
    [token]
  );

  useEffect(() => {
    if (!focusKeyframeId || keyframes.length === 0) return;
    const target = keyframes.find((k) => k.id === focusKeyframeId);
    if (!target) return;
    requestKeyframeImage(target);
    const frame = window.requestAnimationFrame(() => {
      const el = document.getElementById(`keyframe-${focusKeyframeId}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusKeyframeId, keyframes, requestKeyframeImage]);

  const handleConfirmDeleteKeyframe = async () => {
    if (!confirmDeleteKeyframe || !token) return;
    const target = confirmDeleteKeyframe;
    setDeletingKeyframeId(target.id);
    try {
      await deleteRecordingKeyframe(token, recordingId, target.id);
      const existingUrl = createdKeyframeUrlsRef.current.get(target.id);
      if (existingUrl) {
        URL.revokeObjectURL(existingUrl);
        createdKeyframeUrlsRef.current.delete(target.id);
      }
      setKeyframeBlobUrls((prev) => {
        const next = { ...prev };
        delete next[target.id];
        return next;
      });
      if (previewKeyframe?.id === target.id) {
        setPreviewKeyframe(null);
      }
      setConfirmDeleteKeyframe(null);
      onProtocolUpdated?.();
    } catch (err) {
      setSummaryError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingKeyframeId(null);
    }
  };

  const allSpeakersLabel = tr(
    `Alle (${sources.length})`,
    `All (${sources.length})`
  );

  const filteredKeyframes = useMemo(() => {
    const q = foldSearchText(searchQuery.trim());
    return keyframes.filter((kf) => {
      if (
        selectedSourceFilter &&
        !matchesKeyframeSourceFilter(kf, selectedSourceFilter)
      ) {
        return false;
      }
      if (!q) return true;
      const hay = foldSearchText(
        `${kf.presenter} ${kf.provider_source_id} bildschirmfreigabe screen share folie slide`
      );
      return hay.includes(q);
    });
  }, [keyframes, selectedSourceFilter, searchQuery]);

  const filteredSegments = useMemo(() => {
    const q = foldSearchText(searchQuery.trim());
    return segments.filter((seg) => {
      if (
        selectedSourceFilter &&
        !matchesSourceFilter(seg, selectedSourceFilter)
      ) {
        return false;
      }
      if (!q) return true;
      const hay = foldSearchText(
        `${seg.speaker_label} ${seg.participant_name || seg.speaker_name || ''} ${seg.text}`
      );
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

  const filteredPauseWindows = useMemo(() => {
    if (selectedSourceFilter && selectedSourceFilter !== 'all') return [];
    const q = searchQuery.trim().toLowerCase();
    if (!q) return pauseWindows;
    return pauseWindows.filter((pw) => {
      const hay =
        `${pw.by || ''} pause off the record off-the-record pausiert`.toLowerCase();
      return hay.includes(q);
    });
  }, [pauseWindows, selectedSourceFilter, searchQuery]);

  const timelineItems = useMemo<TimelineItem[]>(() => {
    const items: TimelineItem[] = [
      ...groupedTurns.map(
        (turn): TimelineItem => ({ kind: 'turn', offset: turn.start, turn })
      ),
      ...filteredKeyframes.map(
        (kf): TimelineItem => ({
          kind: 'keyframe',
          offset: kf.offset_seconds,
          keyframe: kf,
        })
      ),
      ...filteredPauseWindows.map(
        (pause, index): TimelineItem => ({
          kind: 'pause',
          offset: pause.offset_seconds,
          pause,
          index,
        })
      ),
    ];
    const kindRank: Record<TimelineItem['kind'], number> = {
      pause: 0,
      keyframe: 1,
      turn: 2,
    };
    items.sort((a, b) => {
      if (a.offset !== b.offset) return a.offset - b.offset;
      return kindRank[a.kind] - kindRank[b.kind];
    });
    return items;
  }, [
    groupedTurns,
    filteredKeyframes,
    filteredPauseWindows,
  ]);

  const handleCopyTurn = async (turn: GroupedTurn) => {
    if (!navigator.clipboard) return;
    const text = `[${formatWallClockTime(turn.start, timeOriginUtc)}] ${turn.speakerLabel}: ${turn.paragraphs.map((p) => p.text).join('\n')}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedTurnId(turn.id);
      setTimeout(() => setCopiedTurnId(null), 1600);
    } catch (err) {
      setSummaryError(err instanceof Error ? err.message : String(err));
    }
  };

  const handlePlaySnippet = async (turn: GroupedTurn) => {
    if (!token || loadingAudioTurnId) return;
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
    const targetRecId = recordingId;
    setSummaryError(null);
    setLoadingAudioTurnId(turn.id);
    try {
      const url = await fetchAudioSnippetBlobUrl(
        token,
        targetRecId,
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
    } catch (err) {
      setPlayingTurnId(null);
      if (err && typeof err === 'object' && 'name' in err && err.name === 'AbortError') {
        return;
      }
      setSummaryError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingAudioTurnId(null);
    }
  };

  const handleGenerateSummary = async () => {
    if (!token || generatingSummary) return;
    setSummaryError(null);
    setGeneratingSummary(true);
    try {
      await generateRecordingSummary(token, recordingId);
      setEditingSummary(false);
      onProtocolUpdated?.();
    } catch (err) {
      setSummaryError(err instanceof Error ? err.message : String(err));
    } finally {
      setGeneratingSummary(false);
    }
  };

  const handleStartEditSummary = () => {
    setSummaryError(null);
    setSummaryDraft(summary?.summary || '');
    setTopicsDraft(
      (summary?.topics || []).map((t) => ({
        title: t.title || '',
        details: t.details || '',
      }))
    );
    const existingItems = (summary?.action_items || []).map((item) => ({
      owner: item.owner || 'Team',
      task: item.task || '',
      due: item.due || '',
    }));
    setActionItemsDraft(
      existingItems.length > 0
        ? existingItems
        : [{ owner: 'Team', task: '', due: '' }]
    );
    setEditingSummary(true);
  };

  const handleSaveSummaryDraft = async () => {
    if (!token || savingSummary) return;
    setSummaryError(null);
    setSavingSummary(true);
    try {
      const cleanedTopics = topicsDraft
        .map((t) => ({
          title: t.title.replace(/\s+/g, ' ').trim(),
          details: t.details.replace(/\s+/g, ' ').trim(),
        }))
        .filter((t) => t.title.length > 0 || t.details.length > 0);
      const cleanedActions = actionItemsDraft
        .filter((a) => a.task.trim().length > 0)
        .map((a) => ({
          owner: a.owner.replace(/\s+/g, ' ').trim() || 'Team',
          task: a.task.replace(/\s+/g, ' ').trim(),
          ...(a.due.replace(/\s+/g, ' ').trim()
            ? { due: a.due.replace(/\s+/g, ' ').trim() }
            : {}),
        }));
      await updateRecordingProtocol(token, recordingId, {
        summary: {
          summary: summaryDraft.trim(),
          topics: cleanedTopics,
          action_items: cleanedActions,
        },
      });
      setEditingSummary(false);
      onProtocolUpdated?.();
    } catch (err) {
      setSummaryError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingSummary(false);
    }
  };

  const handleStartEditTurn = (turn: GroupedTurn) => {
    setEditingTurnId(turn.id);
    setEditSpeakerName(turn.speakerLabel);
    setEditTurnText(turn.paragraphs.map((p) => p.text).join(' '));
  };

  const handleSaveTurnEdit = async (turn: GroupedTurn) => {
    if (!token || savingEdit) return;
    setSummaryError(null);
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
    } catch (err) {
      setSummaryError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingEdit(false);
    }
  };

  const handleAddTermReplacement = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || savingTerm || !termFrom.trim() || !termTo.trim()) return;
    setSummaryError(null);
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
    } catch (err) {
      setSummaryError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingTerm(false);
    }
  };

  const handleRemoveTermReplacement = async (key: string) => {
    if (!token || savingTerm) return;
    setSummaryError(null);
    setSavingTerm(true);
    try {
      await updateRecordingProtocol(token, recordingId, {
        term_replacements: {
          [key]: '',
        },
      });
      onProtocolUpdated?.();
    } catch (err) {
      setSummaryError(err instanceof Error ? err.message : String(err));
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
    <VStack gap={4}>
      {summaryError && (
        <Banner
          status="error"
          container="card"
          title={summaryError}
          isDismissable
          onDismiss={() => setSummaryError(null)}
        />
      )}

      {/* 1. Flat Editorial Summary & Action Items (no nested cards) */}
      {(summary || (isOperator && segments.length > 0)) && (
        <section className="pb-4 border-b border-[var(--color-border)]">
          <VStack gap={3}>
            <HStack justify="between" vAlign="center" wrap="wrap" gap={2}>
              <Heading level={2}>
                {tr('Zusammenfassung', 'Summary')}
              </Heading>

              {isOperator && !editingSummary && (
                <HStack gap={1.5} vAlign="center" wrap="wrap">
                  {llmSummaryEnabled && segments.length > 0 && (
                    <Button
                      variant={summary ? 'ghost' : 'secondary'}
                      size="sm"
                      isLoading={generatingSummary}
                      icon={<Sparkles className="h-3.5 w-3.5" />}
                      label={
                        summary
                          ? tr('Neu erstellen', 'Regenerate')
                          : tr('KI-Zusammenfassung', 'AI summary')
                      }
                      onClick={handleGenerateSummary}
                    />
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Edit3 className="h-3.5 w-3.5" />}
                    label={
                      summary
                        ? tr('Bearbeiten', 'Edit')
                        : tr('Manuell anlegen', 'Add manually')
                    }
                    onClick={handleStartEditSummary}
                  />
                </HStack>
              )}
            </HStack>

            {editingSummary ? (
              <VStack gap={3}>
                <VStack gap={1}>
                  <Text type="supporting" weight="semibold" color="secondary">
                    {tr('Überblick', 'Overview')}
                  </Text>
                  <textarea
                    rows={3}
                    dir="auto"
                    value={summaryDraft}
                    onChange={(e) => setSummaryDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                        e.preventDefault();
                        void handleSaveSummaryDraft();
                      }
                    }}
                    placeholder={tr(
                      'Prägnante Zusammenfassung des Gesprächs…',
                      'Concise executive summary…'
                    )}
                    className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-background-surface)] px-3 py-2 text-[16px] md:text-[14px] leading-relaxed text-[var(--color-text-primary)] wl-focus-accent"
                  />
                </VStack>

                <VStack gap={2}>
                  <HStack justify="between" vAlign="center">
                    <Text type="supporting" weight="semibold" color="secondary">
                      {tr('Themen & Beschlüsse', 'Topics & Decisions')}
                    </Text>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<Plus className="h-3.5 w-3.5" />}
                      label={tr('Thema hinzufügen', 'Add topic')}
                      onClick={() =>
                        setTopicsDraft((prev) => [
                          ...prev,
                          { title: '', details: '' },
                        ])
                      }
                    />
                  </HStack>

                  {topicsDraft.map((topic, idx) => (
                    <div
                      key={idx}
                      className="grid grid-cols-1 gap-2 sm:grid-cols-12 items-center"
                    >
                      <div className="sm:col-span-4">
                        <TextInput
                          label={tr('Thema', 'Topic')}
                          isLabelHidden
                          size="sm"
                          value={topic.title}
                          onChange={(val) =>
                            setTopicsDraft((prev) =>
                              prev.map((row, i) =>
                                i === idx ? { ...row, title: val } : row
                              )
                            )
                          }
                          placeholder={tr('Thema', 'Topic')}
                        />
                      </div>
                      <div className="sm:col-span-7">
                        <TextInput
                          label={tr('Ergebnis', 'Decision')}
                          isLabelHidden
                          size="sm"
                          value={topic.details}
                          onChange={(val) =>
                            setTopicsDraft((prev) =>
                              prev.map((row, i) =>
                                i === idx ? { ...row, details: val } : row
                              )
                            )
                          }
                          placeholder={tr(
                            'Ergebnis / Beschluss',
                            'Decision / details'
                          )}
                        />
                      </div>
                      <div className="sm:col-span-1 flex justify-end">
                        <IconButton
                          variant="ghost"
                          size="sm"
                          label={tr('Entfernen', 'Remove')}
                          icon={<Trash2 className="h-3.5 w-3.5" />}
                          onClick={() =>
                            setTopicsDraft((prev) =>
                              prev.filter((_, i) => i !== idx)
                            )
                          }
                        />
                      </div>
                    </div>
                  ))}
                </VStack>

                <VStack gap={2}>
                  <HStack justify="between" vAlign="center">
                    <Text type="supporting" weight="semibold" color="secondary">
                      {tr('Aufgaben', 'Action Items')}
                    </Text>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<Plus className="h-3.5 w-3.5" />}
                      label={tr('Aufgabe hinzufügen', 'Add item')}
                      onClick={() =>
                        setActionItemsDraft((prev) => [
                          ...prev,
                          { owner: 'Team', task: '', due: '' },
                        ])
                      }
                    />
                  </HStack>

                  {actionItemsDraft.map((item, idx) => (
                    <div
                      key={idx}
                      className="grid grid-cols-1 gap-2 sm:grid-cols-12 items-center"
                    >
                      <div className="sm:col-span-3">
                        <TextInput
                          label={tr('Person', 'Owner')}
                          isLabelHidden
                          size="sm"
                          value={item.owner}
                          onChange={(val) =>
                            setActionItemsDraft((prev) =>
                              prev.map((row, i) =>
                                i === idx ? { ...row, owner: val } : row
                              )
                            )
                          }
                          placeholder={tr('Person / Team', 'Owner / Team')}
                        />
                      </div>
                      <div className="sm:col-span-6">
                        <TextInput
                          label={tr('Aufgabe', 'Task')}
                          isLabelHidden
                          size="sm"
                          value={item.task}
                          onChange={(val) =>
                            setActionItemsDraft((prev) =>
                              prev.map((row, i) =>
                                i === idx ? { ...row, task: val } : row
                              )
                            )
                          }
                          placeholder={tr('Aufgabe', 'Task')}
                        />
                      </div>
                      <div className="sm:col-span-2">
                        <TextInput
                          label={tr('Fällig', 'Due')}
                          isLabelHidden
                          size="sm"
                          value={item.due}
                          onChange={(val) =>
                            setActionItemsDraft((prev) =>
                              prev.map((row, i) =>
                                i === idx ? { ...row, due: val } : row
                              )
                            )
                          }
                          placeholder={tr('Frist', 'Due')}
                        />
                      </div>
                      <div className="sm:col-span-1 flex justify-end">
                        <IconButton
                          variant="ghost"
                          size="sm"
                          label={tr('Entfernen', 'Remove')}
                          icon={<Trash2 className="h-3.5 w-3.5" />}
                          onClick={() =>
                            setActionItemsDraft((prev) =>
                              prev.filter((_, i) => i !== idx)
                            )
                          }
                        />
                      </div>
                    </div>
                  ))}
                </VStack>

                <HStack gap={2} justify="end">
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<X className="h-3.5 w-3.5" />}
                    label={tr('Abbrechen', 'Cancel')}
                    onClick={() => setEditingSummary(false)}
                  />
                  <Button
                    variant="primary"
                    size="sm"
                    isLoading={savingSummary}
                    icon={<Check className="h-3.5 w-3.5" />}
                    label={tr('Speichern', 'Save')}
                    onClick={handleSaveSummaryDraft}
                  />
                </HStack>
              </VStack>
            ) : summary ? (
              <VStack gap={3}>
                {summary.summary && (
                  <div dir="auto" className="max-w-[72ch] wl-break-anywhere">
                    <Text type="body" color="primary">
                      {summary.summary}
                    </Text>
                  </div>
                )}

                {summary.topics && summary.topics.length > 0 && (
                  <ul
                    dir="auto"
                    className="m-0 list-disc pl-5 space-y-1.5 max-w-[72ch] text-[14px] leading-relaxed text-[var(--color-text-secondary)]"
                  >
                    {summary.topics.map((t, idx) => (
                      <li key={idx}>
                        {t.title && (
                          <strong className="font-semibold text-[var(--color-text-primary)]">
                            {t.title}
                          </strong>
                        )}
                        {t.title && t.details ? ' — ' : ''}
                        {t.details}
                      </li>
                    ))}
                  </ul>
                )}

                {summary.action_items && summary.action_items.length > 0 && (
                  <VStack gap={1}>
                    {summary.action_items.map((item, idx) => (
                      <HStack
                        key={idx}
                        gap={2}
                        vAlign="start"
                        className="max-w-[72ch]"
                      >
                        <CheckSquare className="h-4 w-4 shrink-0 mt-0.5 wl-text-accent" />
                        <Text type="supporting" color="primary">
                          <strong className="font-semibold">
                            {item.owner}:
                          </strong>{' '}
                          {item.task}
                          {item.due ? (
                            <span className="text-[var(--color-text-secondary)]">
                              {' '}
                              ({item.due})
                            </span>
                          ) : null}
                        </Text>
                      </HStack>
                    ))}
                  </VStack>
                )}
              </VStack>
            ) : (
              <Text type="supporting" color="secondary">
                {tr(
                  'Noch keine Zusammenfassung hinterlegt.',
                  'No summary added yet.'
                )}
              </Text>
            )}
          </VStack>
        </section>
      )}

      {/* Single Unified Search + Speaker Filter Toolbar */}
      <VStack gap={2}>
        <HStack justify="between" vAlign="center" wrap="wrap" gap={2}>
          <div id="segment-search" className="flex-1 min-w-[240px] max-w-md">
            <TextInput
              type="search"
              size="sm"
              label={tr('Im Transkript suchen', 'Search transcript')}
              isLabelHidden
              value={searchQuery}
              onChange={setSearchQuery}
              hasClear
              placeholder={tr(
                'Im Protokoll suchen…',
                'Search protocol…'
              )}
              startIcon={<Search className="h-3.5 w-3.5" />}
            />
          </div>

          {isOperator && (
            <Button
              variant={showTermBar ? 'secondary' : 'ghost'}
              size="sm"
              icon={<Replace className="h-3.5 w-3.5" />}
              label={
                activeTermEntries.length > 0
                  ? `${tr('Glossar', 'Glossary')} (${activeTermEntries.length})`
                  : tr('Glossar', 'Glossary')
              }
              onClick={() => setShowTermBar((v) => !v)}
            />
          )}
        </HStack>

        {sources.length > 0 && (
          <HStack gap={1.5} wrap="wrap" vAlign="center">
            <button
              type="button"
              aria-pressed={!selectedSourceFilter}
              onClick={() => onSelectedSourceFilterChange('')}
              className={`wl-speaker-chip ${!selectedSourceFilter ? 'active' : ''}`}
            >
              <span>{allSpeakersLabel}</span>
            </button>
            {sources.map((src, idx) => {
              const filterKey = getSourceFilterKey(src);
              const isSelected = selectedSourceFilter === filterKey;
              const pct = Math.min(
                100,
                Math.round(((src.speech_seconds || 0) / totalSpeechSec) * 100)
              );
              const name =
                src.participant_name ||
                src.speaker_label ||
                tr(`Teilnehmer ${idx + 1}`, `Participant ${idx + 1}`);
              return (
                <button
                  key={filterKey}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() =>
                    onSelectedSourceFilterChange(isSelected ? '' : filterKey)
                  }
                  className={`wl-speaker-chip ${isSelected ? 'active' : ''}`}
                  title={name}
                >
                  <span className="wl-speaker-chip-label" dir="auto">
                    {name}
                  </span>
                  <span className="wl-speaker-chip-pct">
                    {lang === 'en' ? `${pct}%` : `${pct} %`}
                  </span>
                </button>
              );
            })}
          </HStack>
        )}

        {/* Progressive-Disclosure Term Replacement Bar */}
        {isOperator && showTermBar && (
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background-surface)] p-3">
            <VStack gap={2}>
              <form
                onSubmit={handleAddTermReplacement}
                className="flex flex-wrap items-center gap-2"
              >
                <div className="w-44 max-w-full">
                  <TextInput
                    size="sm"
                    label={tr('Falsch erkannt', 'Misheard term')}
                    isLabelHidden
                    value={termFrom}
                    onChange={setTermFrom}
                    placeholder={tr('Falsch erkannt…', 'Misheard…')}
                  />
                </div>
                <span className="text-[13px] text-[var(--color-text-secondary)]">
                  →
                </span>
                <div className="w-44 max-w-full">
                  <TextInput
                    size="sm"
                    label={tr('Korrektur', 'Replacement')}
                    isLabelHidden
                    value={termTo}
                    onChange={setTermTo}
                    placeholder={tr('Korrektur…', 'Replacement…')}
                  />
                </div>
                <Button
                  type="submit"
                  variant="secondary"
                  size="sm"
                  isLoading={savingTerm}
                  isDisabled={!termFrom.trim() || !termTo.trim()}
                  label={tr('Ersetzen', 'Replace')}
                />
              </form>

              {activeTermEntries.length > 0 && (
                <HStack gap={1.5} wrap="wrap" vAlign="center">
                  {activeTermEntries.map(([fromTerm, toTerm]) => (
                    <span
                      key={fromTerm}
                      className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-background-muted)] px-2.5 py-0.5 text-[12px]"
                    >
                      <span className="line-through text-[var(--color-text-secondary)]">
                        {fromTerm}
                      </span>
                      <span className="text-[var(--color-text-secondary)]">
                        →
                      </span>
                      <strong className="font-semibold text-[var(--color-text-primary)]">
                        {toTerm}
                      </strong>
                      <button
                        type="button"
                        onClick={() => handleRemoveTermReplacement(fromTerm)}
                        className="ml-0.5 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] cursor-pointer"
                        aria-label={tr(
                          `${fromTerm} entfernen`,
                          `Remove ${fromTerm}`
                        )}
                        title={tr('Entfernen', 'Remove')}
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
      </VStack>

      {/* Editorial Transcript Stream */}
      <div id="transcript-view">
        {timelineItems.length === 0 ? (
          <EmptyState
            headingLevel={2}
            icon={
              participation === 'capturing' ? (
                <LiveWaveform />
              ) : (
                <FileText className="h-8 w-8" />
              )
            }
            title={
              segments.length === 0 &&
              keyframes.length === 0 &&
              pauseWindows.length === 0
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
              segments.length === 0 &&
              keyframes.length === 0 &&
              pauseWindows.length === 0
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
            {timelineItems.map((item) => {
              if (item.kind === 'pause') {
                const pw = item.pause;
                const startLbl = formatWallClockTime(
                  pw.offset_seconds,
                  timeOriginUtc
                );
                const endLbl =
                  pw.end_offset_seconds != null
                    ? formatWallClockTime(pw.end_offset_seconds, timeOriginUtc)
                    : tr('laufend', 'ongoing');
                return (
                  <div
                    key={`pause-${item.index}-${pw.started_at}`}
                    className="wl-turn-row"
                  >
                    <HStack gap={3} vAlign="start">
                      <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full wl-warn-badge">
                        <Pause className="h-3.5 w-3.5" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <HStack gap={2} vAlign="center" wrap="wrap">
                          <Token
                            size="sm"
                            color="orange"
                            label={tr(
                              'Off-the-Record-Pause',
                              'Off-the-Record Pause'
                            )}
                          />
                          <Text
                            type="supporting"
                            color="secondary"
                            hasTabularNumbers
                          >
                            {startLbl} – {endLbl}
                          </Text>
                          {pw.by && (
                            <Text type="supporting" color="secondary">
                              · {pw.by}
                            </Text>
                          )}
                        </HStack>
                        <Text type="supporting" color="secondary">
                          {tr(
                            'Aufnahme im Konferenz-Chat pausiert — weder Audio noch Bildschirmfreigaben wurden in diesem Zeitraum erfasst.',
                            'Recording paused via meeting chat — neither audio nor screen-share slides were captured during this interval.'
                          )}
                        </Text>
                      </div>
                    </HStack>
                  </div>
                );
              }
              if (item.kind === 'keyframe') {
                const kf = item.keyframe;
                const kfFilterKey = kf.participant_id
                  ? `participant:${kf.participant_id}`
                  : `source:${kf.provider_source_id}`;
                return (
                  <KeyframeTimelineCard
                    key={`kf-${kf.id}`}
                    keyframe={kf}
                    blobUrl={keyframeBlobUrls[kf.id]}
                    hasError={Boolean(keyframeErrors[kf.id])}
                    timeLabel={formatWallClockTime(
                      kf.offset_seconds,
                      timeOriginUtc
                    )}
                    badgeLabel={kStr.screenShareBadge}
                    altLabel={kStr.slideSnapshotAlt}
                    loadingLabel={kStr.loadingSlide}
                    unavailableLabel={kStr.slideUnavailable}
                    openPreviewLabel={kStr.openPreview}
                    deleteLabel={kStr.deleteSlide}
                    isOperator={isOperator}
                    isActiveFilter={selectedSourceFilter === kfFilterKey}
                    onToggleFilter={() =>
                      onSelectedSourceFilterChange(
                        selectedSourceFilter === kfFilterKey ? '' : kfFilterKey
                      )
                    }
                    onRequestLoad={requestKeyframeImage}
                    onOpenPreview={(target) => {
                      requestKeyframeImage(target);
                      setPreviewKeyframe(target);
                    }}
                    onRequestDelete={setConfirmDeleteKeyframe}
                  />
                );
              }
              const turn = item.turn;
              const isCopied = copiedTurnId === turn.id;
              const isBound = turn.attributionStatus === 'bound';
              const isPlaying = playingTurnId === turn.id;
              const isLoadingAudio = loadingAudioTurnId === turn.id;
              const isEditing = editingTurnId === turn.id;

              return (
                <div
                  key={turn.id}
                  id={`seg-${turn.id}`}
                  className="group wl-turn-row"
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
                            className={`font-semibold text-[14px] leading-snug cursor-pointer ${
                              selectedSourceFilter === turn.filterKey
                                ? 'wl-text-accent'
                                : 'text-[var(--color-text-primary)] wl-hover-accent'
                            }`}
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
                              className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[12px] leading-4 font-medium transition-colors cursor-pointer ${
                                isPlaying
                                  ? 'bg-emerald-600 text-white'
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
                          className="wl-row-actions"
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
                            <div className="w-72 max-w-full">
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
                              <label className="block text-[12px] font-medium text-[var(--color-text-secondary)] mb-1">
                                {tr(
                                  'Protokolltext dieses Beitrags',
                                  'Statement text'
                                )}
                              </label>
                              <textarea
                                dir="auto"
                                value={editTurnText}
                                onChange={(e) =>
                                  setEditTurnText(e.target.value)
                                }
                                onKeyDown={(e) => {
                                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                                    e.preventDefault();
                                    void handleSaveTurnEdit(turn);
                                  }
                                }}
                                rows={3}
                                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-background-surface)] p-2 text-[16px] md:text-[14px] leading-relaxed text-[var(--color-text-primary)] wl-focus-accent"
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
                        <VStack gap={1.5} paddingBlockStart={1} className="max-w-[74ch]">
                          {turn.paragraphs.map((para) => (
                            <div
                              key={para.id}
                              dir="auto"
                              className="wl-break-anywhere"
                            >
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
              <div className="py-3.5 px-2 flex items-center gap-2.5 text-[14px] text-[var(--color-text-secondary)]">
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

      {/* Full-Size Slide Keyframe Preview Modal */}
      {previewKeyframe && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${kStr.slideSnapshotAlt} — ${previewKeyframe.presenter}`}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
          onClick={() => setPreviewKeyframe(null)}
        >
          <div
            className="relative max-h-[92vh] max-w-[92vw] overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-background-surface)] shadow-2xl flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 py-2.5">
              <HStack gap={2} vAlign="center" wrap="wrap">
                <Text type="body" weight="semibold" color="primary">
                  {previewKeyframe.presenter}
                </Text>
                <Text type="supporting" color="secondary" hasTabularNumbers>
                  {formatWallClockTime(
                    previewKeyframe.offset_seconds,
                    timeOriginUtc
                  )}
                </Text>
                <Token size="sm" color="blue" label={kStr.screenShareBadge} />
              </HStack>
              <HStack gap={1} vAlign="center">
                {isOperator && (
                  <IconButton
                    variant="ghost"
                    size="sm"
                    label={kStr.deleteSlide}
                    tooltip={kStr.deleteSlide}
                    icon={<Trash2 className="h-4 w-4" />}
                    onClick={() => setConfirmDeleteKeyframe(previewKeyframe)}
                  />
                )}
                <IconButton
                  variant="ghost"
                  size="sm"
                  label={kStr.closePreview}
                  tooltip={kStr.closePreview}
                  icon={<X className="h-4 w-4" />}
                  onClick={() => setPreviewKeyframe(null)}
                />
              </HStack>
            </div>
            <div className="overflow-auto bg-black/90 p-2 flex items-center justify-center">
              {keyframeBlobUrls[previewKeyframe.id] ? (
                <img
                  src={keyframeBlobUrls[previewKeyframe.id]}
                  alt={`${kStr.slideSnapshotAlt} — ${previewKeyframe.presenter}`}
                  className="max-h-[82vh] max-w-[88vw] object-contain"
                />
              ) : (
                <div className="p-8 text-[14px] text-white/80">
                  {keyframeErrors[previewKeyframe.id]
                    ? kStr.slideUnavailable
                    : kStr.loadingSlide}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <AlertDialog
        isOpen={Boolean(confirmDeleteKeyframe)}
        onOpenChange={(open) => {
          if (!open) setConfirmDeleteKeyframe(null);
        }}
        title={kStr.deleteSlide}
        description={kStr.confirmDeleteSlide}
        actionLabel={tr('Dauerhaft löschen', 'Delete permanently')}
        cancelLabel={tr('Abbrechen', 'Cancel')}
        actionVariant="destructive"
        isActionLoading={Boolean(deletingKeyframeId)}
        onAction={handleConfirmDeleteKeyframe}
      />
    </VStack>
  );
}
