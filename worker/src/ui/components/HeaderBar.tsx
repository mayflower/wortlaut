import React from 'react';
import {
  Calendar,
  KeyRound,
  Mic,
  Plus,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import type { AuthMode } from '../types';
import { Button, cn } from './ui/primitives';

export interface HeaderBarProps {
  healthy: boolean;
  authMode: AuthMode;
  activeView: 'recordings' | 'calendar';
  onChangeView: (view: 'recordings' | 'calendar') => void;
  recordingsCount: number;
  calendarCount: number;
  livePoll: boolean;
  onToggleLivePoll: (enabled: boolean) => void;
  onManualRefresh: () => void;
  onOpenNewRecording: () => void;
  onOpenAuthDialog: () => void;
}

export function HeaderBar({
  healthy,
  authMode,
  activeView,
  onChangeView,
  recordingsCount,
  calendarCount,
  livePoll,
  onToggleLivePoll,
  onManualRefresh,
  onOpenNewRecording,
  onOpenAuthDialog,
}: HeaderBarProps) {
  return (
    <header className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 bg-slate-950/95 px-5 py-3 backdrop-blur-sm">
      <div className="flex items-center gap-5">
        <div className="flex items-center gap-2.5">
          <span
            id="health-dot"
            title={healthy ? 'System bereit' : 'System nicht erreichbar'}
            className={cn(
              'h-2.5 w-2.5 rounded-full transition-colors',
              healthy ? 'bg-emerald-400 shadow-[0_0_8px_#34d399]' : 'bg-red-500'
            )}
          />
          <span className="text-lg font-bold tracking-tight text-white">
            wortlaut
          </span>
          <span className="hidden rounded-md border border-slate-800 bg-slate-900 px-2 py-0.5 text-[11px] font-medium text-slate-400 sm:inline-block">
            Meet · Teams · Webex
          </span>
        </div>

        {authMode.kind === 'operator' && (
          <nav
            aria-label="Hauptnavigation"
            className="flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-900/80 p-1"
          >
            <button
              type="button"
              onClick={() => onChangeView('recordings')}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-semibold transition-colors cursor-pointer',
                activeView === 'recordings'
                  ? 'bg-slate-800 text-sky-400 shadow-xs'
                  : 'text-slate-400 hover:text-slate-200'
              )}
            >
              <Mic className="h-3.5 w-3.5" />
              <span>Aufnahmen</span>
              <span className="rounded-full bg-slate-950/80 px-1.5 py-0.2 text-[11px] text-slate-300">
                {recordingsCount}
              </span>
            </button>
            <button
              type="button"
              onClick={() => onChangeView('calendar')}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-semibold transition-colors cursor-pointer',
                activeView === 'calendar'
                  ? 'bg-slate-800 text-sky-400 shadow-xs'
                  : 'text-slate-400 hover:text-slate-200'
              )}
            >
              <Calendar className="h-3.5 w-3.5" />
              <span>Kalender &amp; Mail</span>
              <span
                id="calendar-count"
                className="rounded-full bg-slate-950/80 px-1.5 py-0.2 text-[11px] text-slate-300"
              >
                {calendarCount}
              </span>
            </button>
          </nav>
        )}

        {authMode.kind === 'reader' && (
          <div className="inline-flex items-center gap-1.5 rounded-full border border-sky-800/80 bg-sky-950/60 px-3 py-1 text-xs font-medium text-sky-300">
            <ShieldCheck className="h-3.5 w-3.5" />
            <span>Aufnahme-Lesezugriff ({authMode.recordingId.slice(0, 8)}…)</span>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        {authMode.kind === 'operator' && (
          <Button
            variant="primary"
            size="md"
            onClick={onOpenNewRecording}
            id="open-dispatch-modal-btn"
          >
            <Plus className="h-4 w-4" />
            <span>Neue Aufnahme</span>
          </Button>
        )}

        <label className="inline-flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-300 cursor-pointer select-none">
          <input
            id="auto-refresh"
            type="checkbox"
            checked={livePoll}
            onChange={(e) => onToggleLivePoll(e.target.checked)}
            className="rounded border-slate-700 bg-slate-950 text-sky-500 focus:ring-sky-500"
          />
          <span>Live (3s)</span>
        </label>

        <Button
          variant="secondary"
          size="sm"
          id="refresh-btn"
          onClick={onManualRefresh}
          title="Daten jetzt aktualisieren"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Aktualisieren</span>
        </Button>

        <Button
          variant="outline"
          size="sm"
          onClick={onOpenAuthDialog}
          title="API-Token oder Lese-Token verwalten"
        >
          <KeyRound className="h-3.5 w-3.5 text-sky-400" />
          <span>
            {authMode.kind === 'operator'
              ? 'Operator-Zugang'
              : authMode.kind === 'reader'
                ? 'Lese-Token'
                : 'Anmelden'}
          </span>
        </Button>
      </div>
    </header>
  );
}
