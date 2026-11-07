import React from 'react';
import {
  Activity,
  Calendar,
  FolderOpen,
  Home,
  KeyRound,
  Plus,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import type { AuthMode } from '../types';
import { Button, cn } from './ui/primitives';

export type NavSection = 'home' | 'meetings' | 'calendar' | 'system';

export interface HeaderBarProps {
  healthy: boolean;
  authMode: AuthMode;
  activeNav: NavSection;
  onChangeNav: (nav: NavSection) => void;
  recordingsCount: number;
  activeLiveCount: number;
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
  activeNav,
  onChangeNav,
  recordingsCount,
  activeLiveCount,
  calendarCount,
  livePoll,
  onToggleLivePoll,
  onManualRefresh,
  onOpenNewRecording,
  onOpenAuthDialog,
}: HeaderBarProps) {
  // Clean, distraction-free top bar for single-recording Reader Links (Mara / Dr. Thomas)
  if (authMode.kind === 'reader') {
    return (
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-slate-800/90 bg-slate-950/95 px-6 py-3 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <span
            id="health-dot"
            className={cn(
              'h-2.5 w-2.5 rounded-full',
              healthy ? 'bg-emerald-400' : 'bg-red-500'
            )}
          />
          <span className="text-base font-bold tracking-tight text-white">
            wortlaut
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-800/70 bg-sky-950/60 px-2.5 py-0.5 text-[11px] font-medium text-sky-300">
            <ShieldCheck className="h-3 w-3 text-sky-400" />
            <span>Freigegebenes Transkript</span>
          </span>
        </div>

        <Button variant="outline" size="sm" onClick={onOpenAuthDialog}>
          <KeyRound className="h-3.5 w-3.5 text-sky-400" />
          <span>Zugang wechseln</span>
        </Button>
      </header>
    );
  }

  const navItems: Array<{
    id: NavSection;
    label: string;
    icon: React.ReactNode;
    badge?: number;
    badgeLive?: boolean;
  }> = [
    {
      id: 'home',
      label: 'Übersicht',
      icon: <Home className="h-4 w-4" />,
      badge: activeLiveCount > 0 ? activeLiveCount : undefined,
      badgeLive: activeLiveCount > 0,
    },
    {
      id: 'meetings',
      label: 'Meetings',
      icon: <FolderOpen className="h-4 w-4" />,
      badge: recordingsCount,
    },
    {
      id: 'calendar',
      label: 'Kalender',
      icon: <Calendar className="h-4 w-4" />,
      badge: calendarCount,
    },
    {
      id: 'system',
      label: 'System & Diagnose',
      icon: <Activity className="h-4 w-4" />,
    },
  ];

  return (
    <>
      {/* Desktop Left App Sidebar */}
      <aside className="hidden lg:fixed lg:inset-y-0 lg:left-0 lg:z-30 lg:flex lg:w-60 lg:flex-col lg:border-r lg:border-slate-800/90 lg:bg-slate-950/95">
        {/* Brand Header */}
        <div className="flex items-center justify-between border-b border-slate-800/80 px-5 py-4">
          <button
            type="button"
            onClick={() => onChangeNav('home')}
            className="flex items-center gap-2.5 text-left cursor-pointer"
          >
            <span
              id="health-dot"
              title={healthy ? 'System bereit' : 'System nicht erreichbar'}
              className={cn(
                'h-2.5 w-2.5 rounded-full transition-colors',
                healthy
                  ? 'bg-emerald-400 shadow-[0_0_8px_#34d399]'
                  : 'bg-red-500'
              )}
            />
            <div>
              <div className="text-base font-bold tracking-tight text-white">
                wortlaut
              </div>
              <div className="text-[10px] font-medium text-slate-400">
                Meet · Teams · Webex
              </div>
            </div>
          </button>
        </div>

        {/* Primary CTA */}
        {authMode.kind === 'operator' && (
          <div className="px-4 pt-4 pb-2">
            <Button
              variant="primary"
              size="md"
              onClick={onOpenNewRecording}
              id="open-dispatch-modal-btn"
              className="w-full justify-center shadow-sm"
            >
              <Plus className="h-4 w-4" />
              <span>Meeting aufzeichnen</span>
            </Button>
          </div>
        )}

        {/* Primary Navigation Links */}
        <nav
          aria-label="Hauptnavigation"
          className="flex-1 space-y-1 px-3 py-3"
        >
          {authMode.kind === 'operator'
            ? navItems.map((item) => {
                const active = activeNav === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onChangeNav(item.id)}
                    className={cn(
                      'flex w-full items-center justify-between rounded-lg px-3 py-2 text-xs font-medium transition-colors cursor-pointer',
                      active
                        ? 'bg-sky-950/80 text-sky-300 border border-sky-800/60 font-semibold'
                        : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200 border border-transparent'
                    )}
                  >
                    <span className="flex items-center gap-2.5">
                      {item.icon}
                      <span>{item.label}</span>
                    </span>

                    {item.badge !== undefined && (
                      <span
                        id={
                          item.id === 'calendar' ? 'calendar-count' : undefined
                        }
                        className={cn(
                          'rounded-full px-2 py-0.5 text-[10px] font-semibold',
                          item.badgeLive
                            ? 'bg-emerald-950 text-emerald-300 border border-emerald-700/60'
                            : active
                              ? 'bg-sky-900/80 text-sky-200'
                              : 'bg-slate-900 text-slate-400'
                        )}
                      >
                        {item.badge}
                      </span>
                    )}
                  </button>
                );
              })
            : null}
        </nav>

        {/* Sidebar Footer: Live Polling + Token */}
        <div className="border-t border-slate-800/80 p-3 space-y-2">
          <div className="flex items-center justify-between gap-2 px-1">
            <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-400 cursor-pointer select-none">
              <input
                id="auto-refresh"
                type="checkbox"
                checked={livePoll}
                onChange={(e) => onToggleLivePoll(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-slate-700 bg-slate-900 text-sky-500 focus:ring-sky-500"
              />
              <span>Live-Update (3s)</span>
            </label>

            <button
              type="button"
              id="refresh-btn"
              onClick={onManualRefresh}
              title="Daten jetzt aktualisieren"
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-slate-400 hover:bg-slate-900 hover:text-slate-200 cursor-pointer"
            >
              <RefreshCw className="h-3 w-3" />
              <span>Sync</span>
            </button>
          </div>

          <button
            type="button"
            onClick={onOpenAuthDialog}
            className="flex w-full items-center justify-between rounded-lg border border-slate-800 bg-slate-900/90 px-3 py-2 text-xs text-slate-300 hover:border-slate-700 hover:text-white cursor-pointer"
          >
            <span className="flex items-center gap-2 truncate">
              <KeyRound className="h-3.5 w-3.5 shrink-0 text-sky-400" />
              <span className="truncate font-medium">
                {authMode.kind === 'operator'
                  ? 'Team-Zugang aktiv'
                  : 'Mit Schlüssel verbinden'}
              </span>
            </span>
            <span className="text-[10px] text-slate-500">Ändern</span>
          </button>
        </div>
      </aside>

      {/* Mobile / Tablet Top Header */}
      <header className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 bg-slate-950/95 px-4 py-2.5 backdrop-blur-sm lg:hidden">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'h-2.5 w-2.5 rounded-full',
              healthy ? 'bg-emerald-400' : 'bg-red-500'
            )}
          />
          <span className="text-base font-bold text-white">wortlaut</span>
        </div>

        {authMode.kind === 'operator' && (
          <div className="flex items-center gap-1 overflow-x-auto">
            {navItems.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onChangeNav(item.id)}
                className={cn(
                  'inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium cursor-pointer',
                  activeNav === item.id
                    ? 'bg-sky-950 text-sky-300 border border-sky-800/60'
                    : 'text-slate-400 hover:text-slate-200'
                )}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        )}

        <div className="flex items-center gap-1.5">
          {authMode.kind === 'operator' && (
            <Button
              variant="primary"
              size="sm"
              onClick={onOpenNewRecording}
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Aufzeichnen</span>
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onOpenAuthDialog}>
            <KeyRound className="h-3.5 w-3.5 text-sky-400" />
          </Button>
        </div>
      </header>
    </>
  );
}
