import React, { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AppShell } from '@astryxdesign/core/AppShell';
import { CommandPalette } from '@astryxdesign/core/CommandPalette';
import {
  createStaticSource,
  type SearchableItem,
} from '@astryxdesign/core/Typeahead';
import {
  ApiError,
  PROVIDER_LABELS,
  completeOidcCallbackIfPresent,
  exitReaderModeToAccount,
  fetchCalendar,
  fetchRecordingDetail,
  fetchRecordings,
  fetchTranscript,
  formatRecordingTitle,
  getSavedAccountToken,
  loadInitialToken,
  parseTokenAuthMode,
  readNavStateFromHash,
  saveTokenToStorage,
  startOidcLogin,
  writeNavStateToHash,
} from './api';
import { AuthGateDialog } from './components/AuthGateDialog';
import { CalendarWorkspace } from './components/CalendarWorkspace';
import {
  HeaderBar,
  ReaderTopBar,
  type NavSection,
} from './components/HeaderBar';
import { MeetingDetailView } from './components/MeetingDetailView';
import { NewRecordingDialog } from './components/NewRecordingDialog';
import {
  RecordingSidebar,
  type QuickStatusFilter,
} from './components/RecordingSidebar';
import { SystemView } from './components/SystemView';
import { WelcomeLandingView } from './components/WelcomeLandingView';
import { useThemeMode } from './components/ui/primitives';

interface CommandItem
  extends SearchableItem<{
    group: string;
    action: () => void;
    keywords?: string[];
  }> {}

export function App() {
  const queryClient = useQueryClient();
  const { mode, setMode } = useThemeMode();

  const [token, setToken] = useState<string>(() => loadInitialToken());
  const [authDialogOpen, setAuthDialogOpen] = useState<boolean>(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const initialNav = useMemo(() => readNavStateFromHash(), []);
  const [activeNav, setActiveNav] = useState<NavSection>(initialNav.view);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialNav.recordingId
  );
  const [livePoll, setLivePoll] = useState<boolean>(true);
  const [newRecordingOpen, setNewRecordingOpen] = useState<boolean>(false);
  const [newRecordingTab, setNewRecordingTab] = useState<'link' | 'ics'>(
    'link'
  );
  const [commandPaletteOpen, setCommandPaletteOpen] = useState<boolean>(false);

  const [providerFilter, setProviderFilter] = useState<string>('');
  const [quickFilter, setQuickFilter] = useState<QuickStatusFilter>('all');
  const [titleSearch, setTitleSearch] = useState<string>('');

  const authMode = useMemo(() => parseTokenAuthMode(token), [token]);
  const hasSavedAccount = useMemo(
    () => Boolean(getSavedAccountToken()),
    [token]
  );

  // Global Cmd+K / Ctrl+K shortcut for CommandPalette
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        if (authMode.kind === 'operator') {
          e.preventDefault();
          setCommandPaletteOpen((open) => !open);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [authMode.kind]);

  // Complete Dex OIDC or Calendar OAuth2 Authorization Code + PKCE callback
  useEffect(() => {
    let cancelled = false;
    completeOidcCallbackIfPresent().then((res) => {
      if (cancelled || !res) return;
      if (res.error) {
        setAuthError(res.error);
      } else if (res.token) {
        setAuthError(null);
        setToken(res.token);
      } else if (res.calendarConnected) {
        setAuthError(null);
        setActiveNav('calendar');
        setSelectedId(null);
        queryClient.invalidateQueries({ queryKey: ['calendar'] });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [queryClient]);

  // Keep browser Back/Forward history and hash token links in sync with UI state
  useEffect(() => {
    const onUrlChange = () => {
      if (window.location.hash.includes('token=')) {
        const extracted = loadInitialToken();
        if (extracted) {
          setToken(extracted);
          setAuthError(null);
          queryClient.invalidateQueries();
        }
      }
      const next = readNavStateFromHash();
      setActiveNav(next.view);
      setSelectedId(next.recordingId);
    };
    window.addEventListener('popstate', onUrlChange);
    window.addEventListener('hashchange', onUrlChange);
    return () => {
      window.removeEventListener('popstate', onUrlChange);
      window.removeEventListener('hashchange', onUrlChange);
    };
  }, [queryClient]);

  useEffect(() => {
    if (authMode.kind === 'operator') {
      writeNavStateToHash(activeNav, selectedId);
    }
  }, [authMode.kind, activeNav, selectedId]);

  useEffect(() => {
    if (authMode.kind === 'reader') {
      setSelectedId(authMode.recordingId);
      setActiveNav('meetings');
    }
  }, [authMode]);

  const handleStartOidcLogin = () => {
    setAuthError(null);
    startOidcLogin().catch((err) => {
      setAuthError(err instanceof Error ? err.message : String(err));
    });
  };

  // Health query
  const healthQuery = useQuery({
    queryKey: ['health'],
    queryFn: async () => {
      const res = await fetch('/health/ready');
      return res.ok;
    },
    refetchInterval: livePoll ? 5000 : false,
  });

  // Recordings list query (operator only)
  const recordingsQuery = useQuery({
    queryKey: ['recordings', token, providerFilter, titleSearch],
    queryFn: () =>
      fetchRecordings(token, {
        provider: providerFilter || undefined,
        q: titleSearch.trim() || undefined,
      }),
    enabled: authMode.kind === 'operator',
    refetchInterval: livePoll ? 3000 : false,
    retry: false,
  });

  useEffect(() => {
    const err = recordingsQuery.error;
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      setAuthError(
        'Sitzung abgelaufen oder ungültiger Schlüssel. Bitte melden Sie sich erneut an.'
      );
      saveTokenToStorage('');
      setToken('');
    } else if (recordingsQuery.isSuccess) {
      setAuthError(null);
    }
  }, [recordingsQuery.error, recordingsQuery.isSuccess]);

  const rawRecordings = recordingsQuery.data?.items || [];

  // Client-side quick status filter + human-first ordering:
  // 1. Live/active recordings first,
  // 2. Recent/ended recordings sorted by starts_at DESC (newest first),
  // 3. Upcoming scheduled recordings sorted by starts_at ASC (next upcoming first).
  const filteredRecordings = useMemo(() => {
    const activeStates = new Set([
      'starting',
      'preparing',
      'joining',
      'waiting_admission',
      'capturing',
    ]);
    const matching = rawRecordings.filter((r) => {
      if (quickFilter === 'active') {
        return activeStates.has(r.participation);
      }
      if (quickFilter === 'scheduled') {
        return r.participation === 'scheduled';
      }
      if (quickFilter === 'completed') {
        return r.participation === 'ended' && r.processing === 'completed';
      }
      if (quickFilter === 'failed') {
        const reason = r.participation_reason;
        const samples = r.quality?.durable_sample_count || 0;
        const cleanStop =
          !reason ||
          reason === 'normal' ||
          reason === 'room_empty' ||
          ((reason === 'cancelled' || reason === 'deadline') && samples > 0);
        return (
          r.processing === 'failed' ||
          (r.participation === 'ended' && !cleanStop)
        );
      }
      return true;
    });

    const rankOf = (p: string): number => {
      if (activeStates.has(p)) return 0;
      if (p !== 'scheduled') return 1;
      return 2;
    };

    return [...matching].sort((a, b) => {
      const rankA = rankOf(a.participation);
      const rankB = rankOf(b.participation);
      if (rankA !== rankB) return rankA - rankB;
      const tA = new Date(a.starts_at).getTime();
      const tB = new Date(b.starts_at).getTime();
      // Scheduled meetings: soonest upcoming first; Recent/Active: newest first
      return rankA === 2 ? tA - tB : tB - tA;
    });
  }, [rawRecordings, quickFilter]);

  const activeLiveCount = useMemo(() => {
    return rawRecordings.filter((r) =>
      [
        'starting',
        'preparing',
        'joining',
        'waiting_admission',
        'capturing',
      ].includes(r.participation)
    ).length;
  }, [rawRecordings]);

  // Calendar query (operator only)
  const calendarQuery = useQuery({
    queryKey: ['calendar', token],
    queryFn: () => fetchCalendar(token),
    enabled: authMode.kind === 'operator',
    refetchInterval: livePoll ? 5000 : false,
    retry: false,
  });

  // Active recording detail + transcript
  const activeRecordingId =
    authMode.kind === 'reader' ? authMode.recordingId : selectedId;

  const detailQuery = useQuery({
    queryKey: ['recordingDetail', token, activeRecordingId],
    queryFn: () => fetchRecordingDetail(token, activeRecordingId!),
    enabled:
      authMode.kind !== 'unauthenticated' && Boolean(activeRecordingId),
    refetchInterval: livePoll ? 3000 : false,
    retry: false,
  });

  const transcriptQuery = useQuery({
    queryKey: ['transcript', token, activeRecordingId],
    queryFn: () => fetchTranscript(token, activeRecordingId!),
    enabled:
      authMode.kind !== 'unauthenticated' && Boolean(activeRecordingId),
    refetchInterval: livePoll ? 3000 : false,
    retry: false,
  });

  useEffect(() => {
    const err = detailQuery.error || transcriptQuery.error;
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      setAuthError('Ungültiger oder abgelaufener Lese-Link / API-Schlüssel.');
      setAuthDialogOpen(true);
    }
  }, [detailQuery.error, transcriptQuery.error]);

  const handleSaveToken = (nextToken: string) => {
    saveTokenToStorage(nextToken);
    setToken(nextToken);
    setAuthError(null);
    queryClient.invalidateQueries();
  };

  const handleReturnToAccount = () => {
    const saved = exitReaderModeToAccount();
    setToken(saved);
    setSelectedId(null);
    setActiveNav('home');
    setAuthError(null);
    queryClient.invalidateQueries();
  };

  const handleManualRefresh = () => {
    queryClient.invalidateQueries();
  };

  const handleOpenRecording = (id: string) => {
    setSelectedId(id);
    setActiveNav('meetings');
  };

  const handleOpenNewModal = (tab: 'link' | 'ics' = 'link') => {
    setNewRecordingTab(tab);
    setNewRecordingOpen(true);
  };

  const calendarEvents = calendarQuery.data?.events || [];
  const calendarConnections = calendarQuery.data?.connections || [];
  const calendarSyncedEvents = calendarQuery.data?.synced_events || [];

  // CommandPalette search source
  const commandItems = useMemo<CommandItem[]>(() => {
    const baseCommands: CommandItem[] = [
      {
        id: 'act:new-link',
        label: 'Neues Meeting per Link aufzeichnen…',
        auxiliaryData: {
          group: 'Aktionen',
          keywords: ['start', 'bot', 'link', 'meet', 'teams', 'webex', 'zoom'],
          action: () => handleOpenNewModal('link'),
        },
      },
      {
        id: 'act:new-ics',
        label: 'Kalendereinladung (.ics / .eml) importieren…',
        auxiliaryData: {
          group: 'Aktionen',
          keywords: ['ics', 'eml', 'kalender', 'import'],
          action: () => handleOpenNewModal('ics'),
        },
      },
      {
        id: 'nav:home',
        label: 'Zur Startseite wechseln',
        auxiliaryData: {
          group: 'Navigation',
          keywords: ['startseite', 'home', 'übersicht', 'willkommen'],
          action: () => {
            setSelectedId(null);
            setActiveNav('home');
          },
        },
      },
      {
        id: 'nav:meetings',
        label: 'Zu Aufnahmen wechseln',
        auxiliaryData: {
          group: 'Navigation',
          keywords: ['aufnahmen', 'meetings', 'archiv', 'protokolle'],
          action: () => {
            setSelectedId(null);
            setActiveNav('meetings');
          },
        },
      },
      {
        id: 'nav:calendar',
        label: 'Zu Kalender & Synchronisation wechseln',
        auxiliaryData: {
          group: 'Navigation',
          keywords: ['kalender', 'google', 'outlook', 'microsoft', 'oauth'],
          action: () => {
            setSelectedId(null);
            setActiveNav('calendar');
          },
        },
      },
      {
        id: 'nav:system',
        label: 'Zu System & Diagnose wechseln',
        auxiliaryData: {
          group: 'Navigation',
          keywords: ['system', 'diagnose', 'status', 'gpu', 'parakeet'],
          action: () => {
            setSelectedId(null);
            setActiveNav('system');
          },
        },
      },
      {
        id: 'theme:toggle',
        label: `Darstellung wechseln (aktuell: ${mode})`,
        auxiliaryData: {
          group: 'Einstellungen',
          keywords: ['dark', 'light', 'theme', 'hell', 'dunkel'],
          action: () => setMode(mode === 'dark' ? 'light' : 'dark'),
        },
      },
    ];

    const recordingCommands: CommandItem[] = rawRecordings
      .slice(0, 30)
      .map((r) => ({
        id: `rec:${r.id}`,
        label: `${formatRecordingTitle(r)} (${PROVIDER_LABELS[r.provider] || r.provider})`,
        auxiliaryData: {
          group: 'Aufnahmen',
          keywords: [r.provider, r.participation, r.id],
          action: () => handleOpenRecording(r.id),
        },
      }));

    return [...baseCommands, ...recordingCommands];
  }, [rawRecordings, mode]);

  const commandSearchSource = useMemo(
    () =>
      createStaticSource(commandItems, {
        keywords: (item) => item.auxiliaryData?.keywords || [],
      }),
    [commandItems]
  );

  // Reader or unauthenticated top-bar shell
  if (authMode.kind === 'unauthenticated' || authMode.kind === 'reader') {
    return (
      <AppShell
        variant="surface"
        height="fill"
        contentPadding={0}
        topNav={
          <ReaderTopBar
            healthy={Boolean(healthQuery.data)}
            authMode={authMode}
            hasSavedAccount={hasSavedAccount}
            onReturnToAccount={handleReturnToAccount}
            onOpenAuthDialog={() => setAuthDialogOpen(true)}
          />
        }
      >
        {authMode.kind === 'unauthenticated' ? (
          <WelcomeLandingView
            healthy={Boolean(healthQuery.data)}
            authError={authError}
            onConnectToken={handleSaveToken}
            onStartOidcLogin={handleStartOidcLogin}
            onOpenAuthDialog={() => setAuthDialogOpen(true)}
          />
        ) : (
          <MeetingDetailView
            authMode={authMode}
            recording={detailQuery.data || null}
            transcript={transcriptQuery.data || null}
            isLoading={detailQuery.isLoading || transcriptQuery.isLoading}
            onRefresh={handleManualRefresh}
            onDeleted={() => {}}
          />
        )}

        <AuthGateDialog
          open={authDialogOpen}
          onOpenChange={setAuthDialogOpen}
          currentToken={token}
          authMode={authMode}
          authError={authError}
          onSaveToken={handleSaveToken}
          onStartOidcLogin={handleStartOidcLogin}
        />
      </AppShell>
    );
  }

  // Operator full workspace shell with Astryx SideNav + Layout
  return (
    <AppShell
      variant="surface"
      height="fill"
      contentPadding={0}
      sideNav={
        <HeaderBar
          healthy={Boolean(healthQuery.data)}
          authMode={authMode}
          hasSavedAccount={hasSavedAccount}
          onReturnToAccount={handleReturnToAccount}
          activeNav={activeNav}
          hasSelectedRecording={Boolean(selectedId)}
          onChangeNav={(nav) => {
            setSelectedId(null);
            setActiveNav(nav);
          }}
          recordingsCount={rawRecordings.length}
          activeLiveCount={activeLiveCount}
          calendarCount={
            calendarSyncedEvents.length > 0
              ? calendarSyncedEvents.length
              : calendarEvents.length
          }
          calendarConnectedCount={calendarConnections.length}
          livePoll={livePoll}
          onToggleLivePoll={setLivePoll}
          onManualRefresh={handleManualRefresh}
          onOpenNewRecording={() => handleOpenNewModal('link')}
          onOpenAuthDialog={() => setAuthDialogOpen(true)}
          onOpenCommandPalette={() => setCommandPaletteOpen(true)}
        />
      }
    >
      {activeNav === 'calendar' ? (
        <CalendarWorkspace
          token={token}
          events={calendarEvents}
          connections={calendarConnections}
          syncedEvents={calendarSyncedEvents}
          onRefreshCalendar={() =>
            queryClient.invalidateQueries({ queryKey: ['calendar'] })
          }
          onSelectRecording={handleOpenRecording}
          onOpenImportModal={() => handleOpenNewModal('ics')}
          onNavigateHome={() => {
            setSelectedId(null);
            setActiveNav('home');
          }}
        />
      ) : activeNav === 'system' ? (
        <SystemView
          healthy={Boolean(healthQuery.data)}
          authMode={authMode}
          recordings={rawRecordings}
          livePoll={livePoll}
          onToggleLivePoll={setLivePoll}
          onManualRefresh={handleManualRefresh}
          onOpenAuthDialog={() => setAuthDialogOpen(true)}
          onSelectRecording={handleOpenRecording}
          onNavigateHome={() => {
            setSelectedId(null);
            setActiveNav('home');
          }}
        />
      ) : selectedId ? (
        <MeetingDetailView
          authMode={authMode}
          recording={detailQuery.data || null}
          transcript={transcriptQuery.data || null}
          isLoading={detailQuery.isLoading || transcriptQuery.isLoading}
          onRefresh={handleManualRefresh}
          onBackToOverview={() => {
            setSelectedId(null);
            setActiveNav('meetings');
          }}
          onNavigateHome={() => {
            setSelectedId(null);
            setActiveNav('home');
          }}
          onDeleted={() => {
            setSelectedId(null);
            handleManualRefresh();
          }}
        />
      ) : (
        <RecordingSidebar
          mode={activeNav === 'meetings' ? 'meetings' : 'home'}
          userName={
            authMode.kind === 'operator'
              ? authMode.user?.name || authMode.user?.email || null
              : null
          }
          token={token}
          recordings={filteredRecordings}
          totalRecordingsCount={rawRecordings.length}
          calendarConnections={calendarConnections}
          calendarSyncedEvents={calendarSyncedEvents}
          selectedId={selectedId}
          onSelectRecording={handleOpenRecording}
          providerFilter={providerFilter}
          onProviderFilterChange={setProviderFilter}
          quickFilter={quickFilter}
          onQuickFilterChange={setQuickFilter}
          titleSearch={titleSearch}
          onTitleSearchChange={setTitleSearch}
          onOpenNewRecording={() => handleOpenNewModal('link')}
          onOpenIcsImport={() => handleOpenNewModal('ics')}
          onNavigateHome={() => {
            setSelectedId(null);
            setActiveNav('home');
          }}
          onNavigateMeetings={() => {
            setSelectedId(null);
            setActiveNav('meetings');
          }}
          onNavigateCalendar={() => {
            setSelectedId(null);
            setActiveNav('calendar');
          }}
          onRefreshCalendar={() =>
            queryClient.invalidateQueries({ queryKey: ['calendar'] })
          }
          onCreatedRecording={(id) => {
            handleManualRefresh();
            handleOpenRecording(id);
          }}
          isLoading={recordingsQuery.isLoading}
        />
      )}

      <CommandPalette<CommandItem>
        isOpen={commandPaletteOpen}
        onOpenChange={setCommandPaletteOpen}
        searchSource={commandSearchSource}
        label="Schnellsuche & Befehle"
        emptySearchText="Keine passenden Aufnahmen oder Befehle gefunden."
        onValueChange={(id) => {
          const match = commandItems.find((item) => item.id === id);
          if (match?.auxiliaryData?.action) {
            setCommandPaletteOpen(false);
            match.auxiliaryData.action();
          }
        }}
      />

      <NewRecordingDialog
        open={newRecordingOpen}
        onOpenChange={setNewRecordingOpen}
        token={token}
        initialTab={newRecordingTab}
        onCreatedRecording={(id) => {
          handleManualRefresh();
          handleOpenRecording(id);
        }}
        onImportedCalendar={(recId) => {
          handleManualRefresh();
          if (recId) {
            handleOpenRecording(recId);
          } else {
            setActiveNav('calendar');
          }
        }}
      />

      <AuthGateDialog
        open={authDialogOpen}
        onOpenChange={setAuthDialogOpen}
        currentToken={token}
        authMode={authMode}
        authError={authError}
        onSaveToken={handleSaveToken}
        onStartOidcLogin={handleStartOidcLogin}
      />
    </AppShell>
  );
}
