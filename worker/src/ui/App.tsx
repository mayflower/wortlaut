import React, { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AppShell } from '@astryxdesign/core/AppShell';
import { Banner } from '@astryxdesign/core/Banner';
import { CommandPalette } from '@astryxdesign/core/CommandPalette';
import {
  createStaticSource,
  type SearchableItem,
} from '@astryxdesign/core/Typeahead';
import {
  ApiError,
  PROVIDER_LABELS,
  claimRecordingAccess,
  completeOidcCallbackIfPresent,
  exitReaderModeToAccount,
  fetchCalendar,
  fetchMcpGrants,
  fetchRecordingDetail,
  fetchRecordings,
  fetchTranscript,
  formatRecordingTitle,
  getSavedAccountToken,
  isProblemRecording,
  loadInitialToken,
  parseTokenAuthMode,
  readNavStateFromHash,
  saveTokenToStorage,
  startOidcLogin,
  writeNavStateToHash,
} from './api';
import { AuthGateDialog } from './components/AuthGateDialog';
import {
  CalendarWorkspace,
  isPastCalendarSlot,
} from './components/CalendarWorkspace';
import {
  HeaderBar,
  ReaderTopBar,
  type NavSection,
} from './components/HeaderBar';
import { McpWorkspace } from './components/McpWorkspace';
import { MeetingDetailView } from './components/MeetingDetailView';
import { NewRecordingDialog } from './components/NewRecordingDialog';
import {
  RecordingSidebar,
  type QuickStatusFilter,
} from './components/RecordingSidebar';
import { SystemView } from './components/SystemView';
import { WelcomeLandingView } from './components/WelcomeLandingView';
import { UiErrorBoundary, useThemeMode } from './components/ui/primitives';
import { useI18n } from './i18n';

interface CommandItem
  extends SearchableItem<{
    group: string;
    action: () => void;
    keywords?: string[];
  }> {}

export function App() {
  const queryClient = useQueryClient();
  const { mode, setMode } = useThemeMode();
  const { lang, tr } = useI18n();

  const [token, setToken] = useState<string>(() => loadInitialToken());
  const [authDialogOpen, setAuthDialogOpen] = useState<boolean>(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const initialNav = useMemo(() => readNavStateFromHash(), []);
  const [activeNav, setActiveNav] = useState<NavSection>(initialNav.view);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialNav.recordingId
  );
  const [focusKeyframeId, setFocusKeyframeId] = useState<string | null>(
    initialNav.keyframeId
  );
  const [newRecordingOpen, setNewRecordingOpen] = useState<boolean>(false);
  const [newRecordingTab, setNewRecordingTab] = useState<'link' | 'ics'>(
    'link'
  );
  const [commandPaletteOpen, setCommandPaletteOpen] = useState<boolean>(false);

  const [providerFilter, setProviderFilter] = useState<string>('');
  const [quickFilter, setQuickFilter] = useState<QuickStatusFilter>('all');
  const [titleSearch, setTitleSearch] = useState<string>('');
  const [debouncedTitleSearch, setDebouncedTitleSearch] = useState<string>('');
  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  useEffect(() => {
    const t = window.setTimeout(() => {
      setDebouncedTitleSearch(titleSearch.trim());
    }, 250);
    return () => window.clearTimeout(t);
  }, [titleSearch]);

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      queryClient.invalidateQueries();
    };
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [queryClient]);

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
      setFocusKeyframeId(next.keyframeId);
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
      const savedAccount = getSavedAccountToken();
      if (savedAccount) {
        let cancelled = false;
        claimRecordingAccess(
          savedAccount,
          authMode.recordingId,
          authMode.token
        )
          .then(() => {
            if (cancelled) return;
            const restored = exitReaderModeToAccount();
            if (restored) {
              setToken(restored);
              queryClient.invalidateQueries();
            }
          })
          .catch(() => {});
        return () => {
          cancelled = true;
        };
      }
    }
  }, [authMode, queryClient]);

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
    refetchInterval: 15000,
    refetchIntervalInBackground: false,
  });

  // Recordings list query (operator only) + cursor pagination for >100 items
  const [olderRecordings, setOlderRecordings] = useState<
    import('./types').RecordingSummary[]
  >([]);
  const [olderCursor, setOlderCursor] = useState<string | null | undefined>(
    undefined
  );
  const [loadingMoreRecordings, setLoadingMoreRecordings] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

  useEffect(() => {
    setOlderRecordings([]);
    setOlderCursor(undefined);
    setLoadMoreError(null);
  }, [token, providerFilter, debouncedTitleSearch]);

  const recordingsQuery = useQuery({
    queryKey: ['recordings', token, providerFilter, debouncedTitleSearch],
    queryFn: () =>
      fetchRecordings(token, {
        provider: providerFilter || undefined,
        q: debouncedTitleSearch || undefined,
      }),
    enabled: authMode.kind === 'operator',
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
    retry: false,
  });

  useEffect(() => {
    const err = recordingsQuery.error;
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      setAuthError(
        tr(
          'Sitzung abgelaufen oder ungültiger Schlüssel. Bitte melden Sie sich erneut an.',
          'Session expired or invalid key. Please sign in again.'
        )
      );
      saveTokenToStorage('');
      setToken('');
    } else if (recordingsQuery.isSuccess) {
      setAuthError(null);
    }
  }, [recordingsQuery.error, recordingsQuery.isSuccess, tr]);

  const effectiveNextCursor =
    olderCursor !== undefined
      ? olderCursor
      : (recordingsQuery.data?.next_cursor ?? null);

  const handleLoadMoreRecordings = async () => {
    if (!effectiveNextCursor || loadingMoreRecordings) return;
    setLoadingMoreRecordings(true);
    setLoadMoreError(null);
    try {
      const page = await fetchRecordings(token, {
        provider: providerFilter || undefined,
        q: debouncedTitleSearch || undefined,
        cursor: effectiveNextCursor,
      });
      setOlderRecordings((prev) => {
        const seen = new Set(prev.map((r) => r.id));
        const added = page.items.filter((r) => !seen.has(r.id));
        return [...prev, ...added];
      });
      setOlderCursor(page.next_cursor);
    } catch (err) {
      setLoadMoreError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingMoreRecordings(false);
    }
  };

  const rawRecordings = useMemo(() => {
    const firstPage = recordingsQuery.data?.items || [];
    if (olderRecordings.length === 0) return firstPage;
    const seen = new Set(firstPage.map((r) => r.id));
    return [...firstPage, ...olderRecordings.filter((r) => !seen.has(r.id))];
  }, [recordingsQuery.data?.items, olderRecordings]);

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
          reason === 'source_binding_unverified' ||
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

  const failedRecordingsCount = useMemo(() => {
    return rawRecordings.filter(isProblemRecording).length;
  }, [rawRecordings]);

  // Calendar query (operator only) — poll when viewing Recordings or Calendar
  const calendarQuery = useQuery({
    queryKey: ['calendar', token],
    queryFn: () => fetchCalendar(token),
    enabled: authMode.kind === 'operator',
    refetchInterval:
      !selectedId && (activeNav === 'calendar' || activeNav === 'meetings')
        ? 15000
        : false,
    refetchIntervalInBackground: false,
    retry: false,
  });

  // Connected MCP clients query (operator only)
  const mcpGrantsQuery = useQuery({
    queryKey: ['mcpGrants', token],
    queryFn: () => fetchMcpGrants(token),
    enabled: authMode.kind === 'operator',
    refetchInterval: activeNav === 'mcp' ? 10000 : false,
    refetchIntervalInBackground: false,
    retry: false,
  });

  // Active recording detail + transcript (stop polling once recording is ended & settled)
  const activeRecordingId =
    authMode.kind === 'reader' ? authMode.recordingId : selectedId;

  const detailQuery = useQuery({
    queryKey: ['recordingDetail', token, activeRecordingId],
    queryFn: () => fetchRecordingDetail(token, activeRecordingId!),
    enabled:
      authMode.kind !== 'unauthenticated' && Boolean(activeRecordingId),
    refetchInterval: (query) => {
      const d = query.state.data;
      if (
        d &&
        d.participation === 'ended' &&
        (d.processing === 'completed' || d.processing === 'failed')
      ) {
        return false;
      }
      return 3000;
    },
    refetchIntervalInBackground: false,
    retry: false,
  });

  const isSelectedRecordingSettled =
    detailQuery.data?.participation === 'ended' &&
    (detailQuery.data?.processing === 'completed' ||
      detailQuery.data?.processing === 'failed');

  const transcriptQuery = useQuery({
    queryKey: ['transcript', token, activeRecordingId],
    queryFn: () => fetchTranscript(token, activeRecordingId!),
    enabled:
      authMode.kind !== 'unauthenticated' && Boolean(activeRecordingId),
    refetchInterval: !isSelectedRecordingSettled ? 3000 : false,
    refetchIntervalInBackground: false,
    retry: false,
  });

  useEffect(() => {
    const err = detailQuery.error || transcriptQuery.error;
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      setAuthError(
        tr(
          'Ungültiger oder abgelaufener Lese-Link / API-Schlüssel.',
          'Invalid or expired read-only link / API key.'
        )
      );
      setAuthDialogOpen(true);
    }
  }, [detailQuery.error, transcriptQuery.error, tr]);

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
    setActiveNav('meetings');
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
  const nowMs = Date.now();
  const upcomingSyncedCount = calendarSyncedEvents.filter(
    (ev) =>
      ev.status !== 'cancelled' &&
      !isPastCalendarSlot(ev.ends_at, nowMs)
  ).length;
  const upcomingIcsCount = calendarEvents.filter(
    (ev) =>
      ev.status !== 'cancelled' &&
      ev.status !== 'CANCELLED' &&
      !isPastCalendarSlot(ev.ends_at, nowMs)
  ).length;

  // CommandPalette search source
  const commandItems = useMemo<CommandItem[]>(() => {
    const baseCommands: CommandItem[] = [
      {
        id: 'act:new-link',
        label: tr(
          'Neues Meeting per Link aufzeichnen…',
          'Record a new meeting via URL…'
        ),
        auxiliaryData: {
          group: tr('Aktionen', 'Actions'),
          keywords: ['start', 'bot', 'link', 'meet', 'teams', 'webex', 'zoom'],
          action: () => handleOpenNewModal('link'),
        },
      },
      {
        id: 'act:new-ics',
        label: tr(
          'Kalendereinladung (.ics / .eml) importieren…',
          'Import calendar invitation (.ics / .eml)…'
        ),
        auxiliaryData: {
          group: tr('Aktionen', 'Actions'),
          keywords: ['ics', 'eml', 'kalender', 'calendar', 'import'],
          action: () => handleOpenNewModal('ics'),
        },
      },
      {
        id: 'nav:meetings',
        label: tr('Zu Aufnahmen wechseln', 'Go to Recordings'),
        auxiliaryData: {
          group: 'Navigation',
          keywords: ['aufnahmen', 'meetings', 'archiv', 'recordings', 'startseite', 'home'],
          action: () => {
            setSelectedId(null);
            setActiveNav('meetings');
          },
        },
      },
      {
        id: 'nav:calendar',
        label: tr(
          'Zu Kalender & Synchronisation wechseln',
          'Go to Calendar & Sync'
        ),
        auxiliaryData: {
          group: 'Navigation',
          keywords: ['kalender', 'calendar', 'google', 'outlook', 'microsoft', 'oauth'],
          action: () => {
            setSelectedId(null);
            setActiveNav('calendar');
          },
        },
      },
      {
        id: 'nav:mcp',
        label: tr(
          'Zu MCP & KI-Clients wechseln',
          'Go to MCP & AI Clients'
        ),
        auxiliaryData: {
          group: 'Navigation',
          keywords: ['mcp', 'oauth', 'claude', 'cursor', 'agent', 'ai', 'ki'],
          action: () => {
            setSelectedId(null);
            setActiveNav('mcp');
          },
        },
      },
      {
        id: 'nav:system',
        label: tr(
          'Zu System & Diagnose wechseln',
          'Go to System & Diagnostics'
        ),
        auxiliaryData: {
          group: 'Navigation',
          keywords: ['system', 'diagnose', 'status', 'gpu', 'asr', 'qwen'],
          action: () => {
            setSelectedId(null);
            setActiveNav('system');
          },
        },
      },
      {
        id: 'theme:toggle',
        label: tr(
          `Darstellung wechseln (aktuell: ${mode === 'light' ? 'Hell' : mode === 'dark' ? 'Dunkel' : 'Auto'})`,
          `Toggle theme (current: ${mode === 'light' ? 'Light' : mode === 'dark' ? 'Dark' : 'Auto'})`
        ),
        auxiliaryData: {
          group: tr('Einstellungen', 'Settings'),
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
          group: tr('Aufnahmen', 'Recordings'),
          keywords: [r.provider, r.participation, r.id],
          action: () => handleOpenRecording(r.id),
        },
      }));

    return [...baseCommands, ...recordingCommands];
  }, [rawRecordings, mode, lang]);

  const commandSearchSource = useMemo(
    () =>
      createStaticSource(commandItems, {
        keywords: (item) => item.auxiliaryData?.keywords || [],
      }),
    [commandItems]
  );

  const nonAuthErrorText = (err: unknown): string | null => {
    if (!err) return null;
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      return null;
    }
    return err instanceof Error ? err.message : String(err);
  };

  const detailLoadError = detailQuery.error || transcriptQuery.error || null;
  const offlineBanner = !isOnline ? (
    <div className="px-4 pt-3">
      <div className="wl-page-container">
        <Banner
          status="warning"
          container="card"
          title={tr(
            'Keine Internetverbindung — Live-Aktualisierungen werden automatisch fortgesetzt, sobald die Verbindung wiederhergestellt ist.',
            'Offline — live updates will resume automatically once your connection is restored.'
          )}
        />
      </div>
    </div>
  ) : null;

  // Reader or unauthenticated top-bar shell
  if (authMode.kind === 'unauthenticated' || authMode.kind === 'reader') {
    return (
      <AppShell
        variant="surface"
        height="fill"
        contentPadding={0}
        topNav={
          <ReaderTopBar
            healthy={Boolean(healthQuery.data) && isOnline}
            authMode={authMode}
            hasSavedAccount={hasSavedAccount}
            onReturnToAccount={handleReturnToAccount}
            onOpenAuthDialog={() => setAuthDialogOpen(true)}
          />
        }
      >
        {offlineBanner}
        <UiErrorBoundary resetKey={`top:${authMode.kind}:${activeRecordingId || 'landing'}`}>
          {authMode.kind === 'unauthenticated' ? (
            <WelcomeLandingView
              healthy={Boolean(healthQuery.data) && isOnline}
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
              loadError={detailLoadError}
              onRefresh={handleManualRefresh}
              onDeleted={() => {}}
            />
          )}
        </UiErrorBoundary>

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
          healthy={Boolean(healthQuery.data) && isOnline}
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
            calendarSyncedEvents.length > 0 || calendarConnections.length > 0
              ? upcomingSyncedCount
              : upcomingIcsCount
          }
          calendarConnectedCount={calendarConnections.length}
          mcpGrantCount={mcpGrantsQuery.data?.grants.length || 0}
          onOpenNewRecording={() => handleOpenNewModal('link')}
          onOpenAuthDialog={() => setAuthDialogOpen(true)}
          onOpenCommandPalette={() => setCommandPaletteOpen(true)}
        />
      }
    >
      {offlineBanner}
      <UiErrorBoundary
        resetKey={`${activeNav}:${selectedId || 'list'}`}
        onResetView={() => {
          setSelectedId(null);
          setActiveNav('meetings');
        }}
      >
        {activeNav === 'calendar' ? (
          <CalendarWorkspace
            token={token}
            events={calendarEvents}
            connections={calendarConnections}
            syncedEvents={calendarSyncedEvents}
            loadError={nonAuthErrorText(calendarQuery.error)}
            onRefreshCalendar={() =>
              queryClient.invalidateQueries({ queryKey: ['calendar'] })
            }
            onSelectRecording={handleOpenRecording}
            onOpenImportModal={() => handleOpenNewModal('ics')}
          />
        ) : activeNav === 'mcp' ? (
          <McpWorkspace
            token={token}
            endpoint={mcpGrantsQuery.data?.endpoint}
            grants={mcpGrantsQuery.data?.grants || []}
            isLoading={mcpGrantsQuery.isLoading}
            loadError={nonAuthErrorText(mcpGrantsQuery.error)}
            onRefresh={() =>
              queryClient.invalidateQueries({ queryKey: ['mcpGrants'] })
            }
          />
        ) : activeNav === 'system' ? (
          <SystemView
            healthy={Boolean(healthQuery.data) && isOnline}
            authMode={authMode}
            recordings={rawRecordings}
            onOpenAuthDialog={() => setAuthDialogOpen(true)}
            onSelectRecording={handleOpenRecording}
          />
        ) : selectedId ? (
          <MeetingDetailView
            authMode={authMode}
            recording={detailQuery.data || null}
            transcript={transcriptQuery.data || null}
            focusKeyframeId={focusKeyframeId}
            isLoading={detailQuery.isLoading || transcriptQuery.isLoading}
            loadError={detailLoadError}
            onRefresh={handleManualRefresh}
            onBackToOverview={() => {
              setSelectedId(null);
              setFocusKeyframeId(null);
              setActiveNav('meetings');
            }}
            onOpenCalendar={() => {
              setSelectedId(null);
              setFocusKeyframeId(null);
              setActiveNav('calendar');
            }}
            onDeleted={() => {
              setSelectedId(null);
              setFocusKeyframeId(null);
              handleManualRefresh();
            }}
          />
        ) : (
          <RecordingSidebar
            token={token}
            recordings={filteredRecordings}
            totalRecordingsCount={rawRecordings.length}
            failedRecordingsCount={failedRecordingsCount}
            hasMoreRecordings={Boolean(effectiveNextCursor)}
            isLoadingMoreRecordings={loadingMoreRecordings}
            loadMoreError={loadMoreError}
            onLoadMoreRecordings={handleLoadMoreRecordings}
            loadError={nonAuthErrorText(recordingsQuery.error)}
            onRetry={() =>
              queryClient.invalidateQueries({ queryKey: ['recordings'] })
            }
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
      </UiErrorBoundary>

      <CommandPalette<CommandItem>
        isOpen={commandPaletteOpen}
        onOpenChange={setCommandPaletteOpen}
        searchSource={commandSearchSource}
        label={tr('Schnellsuche & Befehle', 'Quick Search & Commands')}
        emptySearchText={tr(
          'Keine passenden Aufnahmen oder Befehle gefunden.',
          'No matching recordings or commands found.'
        )}
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
