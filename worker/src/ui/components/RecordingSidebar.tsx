import React from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Clock,
  FolderOpen,
  Plus,
  Search,
} from 'lucide-react';
import {
  formatDurationHuman,
  formatRecordingTitle,
  getFailureReasons,
} from '../api';
import type { RecordingSummary } from '../types';
import { Button, ProviderBadge, StatusBadge, cn } from './ui/primitives';

export type QuickStatusFilter =
  | 'all'
  | 'active'
  | 'scheduled'
  | 'completed'
  | 'failed';

export interface RecordingSidebarProps {
  recordings: RecordingSummary[];
  selectedId: string | null;
  onSelectRecording: (id: string) => void;
  providerFilter: string;
  onProviderFilterChange: (provider: string) => void;
  quickFilter: QuickStatusFilter;
  onQuickFilterChange: (filter: QuickStatusFilter) => void;
  titleSearch: string;
  onTitleSearchChange: (q: string) => void;
  onOpenNewRecording: () => void;
  isLoading: boolean;
}

const QUICK_FILTERS: Array<{ id: QuickStatusFilter; label: string }> = [
  { id: 'all', label: 'Alle Meetings' },
  { id: 'active', label: 'Live & Warteraum' },
  { id: 'scheduled', label: 'Geplant' },
  { id: 'completed', label: 'Transkript fertig' },
  { id: 'failed', label: 'Mit Hinweis / Fehler' },
];

export function RecordingSidebar({
  recordings,
  selectedId,
  onSelectRecording,
  providerFilter,
  onProviderFilterChange,
  quickFilter,
  onQuickFilterChange,
  titleSearch,
  onTitleSearchChange,
  onOpenNewRecording,
  isLoading,
}: RecordingSidebarProps) {
  const failureReasons = getFailureReasons();

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-white">Alle Meetings</h1>
          <p className="text-xs text-slate-400">
            Durchsuchen und filtern Sie vergangene Transkripte, laufende
            Aufzeichnungen und geplante Termine.
          </p>
        </div>
        <Button variant="primary" size="md" onClick={onOpenNewRecording}>
          <Plus className="h-4 w-4" />
          <span>Meeting aufzeichnen</span>
        </Button>
      </div>

      {/* Filter Bar */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/75 p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-500" />
            <input
              id="title-search"
              type="search"
              value={titleSearch}
              onChange={(e) => onTitleSearchChange(e.target.value)}
              placeholder="Nach Meeting-Titel, Thema oder Raum suchen…"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 pl-9 pr-3 py-2 text-xs text-slate-100 placeholder-slate-500 focus:border-sky-500 focus:outline-none"
            />
          </div>

          <select
            id="provider-filter"
            aria-label="Provider filtern"
            value={providerFilter}
            onChange={(e) => onProviderFilterChange(e.target.value)}
            className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-200 focus:border-sky-500 focus:outline-none"
          >
            <option value="">Alle Konferenzsysteme</option>
            <option value="google_meet">Google Meet</option>
            <option value="teams">Microsoft Teams</option>
            <option value="webex">Webex</option>
          </select>
        </div>

        <div
          id="participation-filter"
          className="flex flex-wrap items-center gap-1.5"
          role="tablist"
          aria-label="Status-Schnellfilter"
        >
          {QUICK_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => onQuickFilterChange(f.id)}
              className={cn(
                'rounded-full px-3 py-1 text-xs font-medium transition-colors cursor-pointer border',
                quickFilter === f.id
                  ? 'border-sky-500/80 bg-sky-950/90 text-sky-300'
                  : 'border-slate-800 bg-slate-950/60 text-slate-400 hover:border-slate-700 hover:text-slate-200'
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Meetings List */}
      <div
        id="recordings-list"
        className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/75 divide-y divide-slate-800/80"
      >
        {isLoading && recordings.length === 0 ? (
          <div className="py-12 text-center text-xs text-slate-400">
            Lade Meetings…
          </div>
        ) : recordings.length === 0 ? (
          <div className="p-12 text-center space-y-3">
            <FolderOpen className="mx-auto h-8 w-8 text-slate-600" />
            <div className="text-sm font-medium text-slate-300">
              Keine Meetings für diesen Filter gefunden
            </div>
            <p className="text-xs text-slate-500">
              Passen Sie den Suchbegriff an oder starten Sie eine neue
              Meeting-Aufzeichnung.
            </p>
            <Button variant="primary" size="sm" onClick={onOpenNewRecording}>
              <Plus className="h-3.5 w-3.5" />
              <span>Bot in Meeting schicken</span>
            </Button>
          </div>
        ) : (
          recordings.map((item) => {
            const isSelected = item.id === selectedId;
            const reason = item.participation_reason;
            const isNormalEnd =
              !reason || reason === 'normal' || reason === 'room_empty';
            const hasError =
              item.processing === 'failed' ||
              (item.participation === 'ended' && !isNormalEnd);
            const reasonHint =
              reason && failureReasons[reason]
                ? failureReasons[reason]
                : reason && !isNormalEnd
                  ? reason
                  : null;
            const samples = item.quality?.durable_sample_count || 0;
            const audioSec = Math.round(samples / 16000);
            const startFormatted = new Date(item.starts_at).toLocaleString(
              'de-DE',
              {
                day: '2-digit',
                month: '2-digit',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              }
            );

            return (
              <div
                key={item.id}
                onClick={() => onSelectRecording(item.id)}
                className={cn(
                  'group flex flex-wrap items-center justify-between gap-4 px-5 py-4 transition-colors cursor-pointer',
                  isSelected
                    ? 'bg-sky-950/30 hover:bg-sky-950/40'
                    : 'hover:bg-slate-800/50'
                )}
              >
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <ProviderBadge provider={item.provider} />
                    <span className="text-sm font-semibold text-slate-100 group-hover:text-sky-300 transition-colors">
                      {formatRecordingTitle(item)}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
                    <span className="inline-flex items-center gap-1">
                      <Clock className="h-3.5 w-3.5 text-slate-500" />
                      {startFormatted}
                    </span>
                    {audioSec > 0 && (
                      <span>Dauer: {formatDurationHuman(audioSec)}</span>
                    )}
                    {item.guest_name && <span>Bot: {item.guest_name}</span>}
                  </div>

                  {item.participation === 'waiting_admission' && (
                    <div className="inline-flex items-center gap-1.5 rounded-md bg-amber-950/70 px-2.5 py-1 text-xs font-medium text-amber-200 border border-amber-800/60">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-400" />
                      <span>
                        Wartet im Warteraum — bitte Bot im Meeting zulassen
                      </span>
                    </div>
                  )}

                  {reasonHint && (
                    <div className="flex items-start gap-1.5 text-xs text-red-300">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />
                      <span>{reasonHint}</span>
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-3">
                  <StatusBadge
                    participation={item.participation}
                    processing={item.processing}
                    hasError={hasError}
                  />
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-400 group-hover:text-sky-400 transition-colors">
                    <span className="hidden sm:inline">Öffnen</span>
                    <ArrowRight className="h-4 w-4" />
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
