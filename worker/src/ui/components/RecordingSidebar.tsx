import React from 'react';
import {
  AlertTriangle,
  Clock,
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
  { id: 'all', label: 'Alle' },
  { id: 'active', label: 'Live & Warteraum' },
  { id: 'scheduled', label: 'Geplant' },
  { id: 'completed', label: 'Fertig' },
  { id: 'failed', label: 'Fehler' },
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
    <aside className="flex flex-col rounded-xl border border-slate-800 bg-slate-900/75 p-4 lg:h-[calc(100vh-84px)]">
      <div className="mb-3 space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-bold tracking-tight text-slate-100">
            Aufnahmen
          </h2>
          <select
            id="provider-filter"
            aria-label="Provider filtern"
            value={providerFilter}
            onChange={(e) => onProviderFilterChange(e.target.value)}
            className="rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1 text-xs text-slate-200 focus:border-sky-500 focus:outline-none"
          >
            <option value="">Alle Provider</option>
            <option value="google_meet">Google Meet</option>
            <option value="teams">Microsoft Teams</option>
            <option value="webex">Webex</option>
          </select>
        </div>

        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-slate-500" />
          <input
            id="title-search"
            type="search"
            value={titleSearch}
            onChange={(e) => onTitleSearchChange(e.target.value)}
            placeholder="Meeting-Titel suchen…"
            className="w-full rounded-lg border border-slate-700 bg-slate-950 pl-8 pr-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:border-sky-500 focus:outline-none"
          />
        </div>

        <div
          id="participation-filter"
          className="flex flex-wrap gap-1 pt-0.5"
          role="tablist"
          aria-label="Status-Schnellfilter"
        >
          {QUICK_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => onQuickFilterChange(f.id)}
              className={cn(
                'rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors cursor-pointer border',
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

      <div
        id="recordings-list"
        className="flex-1 space-y-2 overflow-y-auto pr-1"
      >
        {isLoading && recordings.length === 0 ? (
          <div className="py-10 text-center text-xs text-slate-400">
            Lade Aufnahmen…
          </div>
        ) : recordings.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-800 bg-slate-950/50 p-6 text-center space-y-3">
            <p className="text-xs text-slate-400">
              Keine Aufnahmen für diesen Filter gefunden.
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
                hour: '2-digit',
                minute: '2-digit',
              }
            );

            return (
              <div
                key={item.id}
                onClick={() => onSelectRecording(item.id)}
                className={cn(
                  'group relative flex flex-col gap-1.5 rounded-lg border p-3 transition-all cursor-pointer',
                  isSelected
                    ? 'border-sky-500/90 bg-slate-800/90 shadow-sm'
                    : 'border-slate-800/90 bg-slate-950/70 hover:border-slate-700 hover:bg-slate-900'
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <ProviderBadge provider={item.provider} />
                  <StatusBadge
                    participation={item.participation}
                    processing={item.processing}
                    hasError={hasError}
                  />
                </div>

                <div className="text-sm font-semibold text-slate-100 line-clamp-1">
                  {formatRecordingTitle(item)}
                </div>

                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
                  <span className="inline-flex items-center gap-1">
                    <Clock className="h-3 w-3 text-slate-500" />
                    {startFormatted}
                  </span>
                  {audioSec > 0 && (
                    <span>Audio: {formatDurationHuman(audioSec)}</span>
                  )}
                  {item.guest_name && <span>Bot: {item.guest_name}</span>}
                </div>

                {item.participation === 'waiting_admission' && (
                  <div className="mt-1 flex items-center gap-1.5 rounded-md bg-amber-950/70 px-2 py-1 text-[11px] font-medium text-amber-200 border border-amber-800/60">
                    <AlertTriangle className="h-3 w-3 shrink-0 text-amber-400" />
                    <span>Bitte Bot im Meeting zulassen</span>
                  </div>
                )}

                {reasonHint && (
                  <div className="mt-0.5 flex items-start gap-1.5 text-[11px] text-red-300 line-clamp-2">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-red-400" />
                    <span>{reasonHint}</span>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
