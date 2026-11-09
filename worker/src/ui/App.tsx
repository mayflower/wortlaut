import React, { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import {
  ApiError,
  cancelRecording,
  completeOidcCallbackIfPresent,
  downloadExportFile,
  exitReaderModeToAccount,
  fetchCalendar,
  fetchRecordingDetail,
  fetchRecordings,
  fetchTranscript,
  getSavedAccountToken,
  issueReaderToken,
  loadInitialToken,
  parseTokenAuthMode,
  readNavStateFromHash,
  rejoinRecording,
  retryMailDelivery,
  saveTokenToStorage,
  startOidcLogin,
  writeNavStateToHash,
} from './api';
import { AuthGateDialog } from './components/AuthGateDialog';
import { CalendarWorkspace } from './components/CalendarWorkspace';
import { HeaderBar, NavSection } from './components/HeaderBar';
import { HomeView } from './components/HomeView';
import { MeetingDetailView } from './components/MeetingDetailView';
import { NewRecordingDialog } from './components/NewRecordingDialog';
import {
  QuickStatusFilter,
  RecordingSidebar,
} from './components/RecordingSidebar';
import { SystemView } from './components/SystemView';
import { WelcomeLandingView } from './components/WelcomeLandingView';

export function App() {
  const queryClient = useQueryClient();
  const [token, setToken] = useState<string>(() => loadInitialToken());
  const authMode = useMemo(() => parseTokenAuthMode(token), [token]);
  const savedAccountToken = useMemo(() => getSavedAccountToken(), [token]);

  const initialNav = useMemo(() => readNavStateFromHash(), []);
  const [activeNav, setActiveNav] = useState<NavSection>(initialNav.view);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialNav.recordingId
  );
  const [selectedSourceFilter, setSelectedSourceFilter] = useState<string>('');

  const [providerFilter, setProviderFilter] = useState<string>('');
  const [quickFilter, setQuickFilter] = useState<QuickStatusFilter>('all');
  const [titleSearch, setTitleSearch] = useState<string>('');

  const [livePoll, setLivePoll] = useState<boolean>(true);
  const [authDialogOpen, setAuthDialogOpen] = useState<boolean>(false);
  const [newRecordingOpen, setNewRecordingOpen] = useState<boolean>(false);
  const [newRecordingTab, setNewRecordingTab] = useState<'link' | 'ics'>('link');
  const [actionBusy, setActionBusy] = useState<boolean>(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [oidcError, setOidcError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    completeOidcCallbackIfPresent().then((res) => {
      if (cancelled || !res) return;
      if (res.token) {
        setOidcError(null);
        setToken(res.token);
        queryClient.invalidateQueries();
      } else if (res.error) {
        setOidcError(res.error);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [queryClient]);

  useEffect(() => {
    if (authMode.kind === 'reader') {
      setSelectedId(authMode.recordingId);
    }
  }, [authMode]);

  useEffect(() => {
    if (authMode.kind !== 'operator') return;
    writeNavStateToHash(activeNav, selectedId);
  }, [authMode.kind, activeNav, selectedId]);

  useEffect(() => {
    const onPopState = () => {
      if (authMode.kind !== 'operator') return;
      const next = readNavStateFromHash();
      setActiveNav(next.view);
      setSelectedId(next.recordingId);
      setSelectedSourceFilter('');
      setActionError(null);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [authMode.kind]);

  const pollInterval = livePoll ? 3000 : false;

  const healthQuery = useQuery({
    queryKey: ['health'],
    queryFn: async () => {
      const res = await fetch('/health/ready');
      return res.ok;
    },
    refetchInterval: pollInterval,
    refetchIntervalInBackground: false,
  });

  // Unfiltered recordings query for HomeView & SystemView overview
  const allRecordingsQuery = useQuery({
    queryKey: ['recordings-all', token],
    queryFn: () => fetchRecordings(token, {}),
    enabled: authMode.kind === 'operator',
    refetchInterval: pollInterval,
    refetchIntervalInBackground: false,
    retry: false,
  });

  const apiFilter = useMemo(() => {
    let participation: string | undefined;
    let processing: string | undefined;
    if (quickFilter === 'active') {
      participation = 'starting,preparing,joining,waiting_admission,capturing';
    } else if (quickFilter === 'scheduled') {
      participation = 'scheduled';
    } else if (quickFilter === 'completed') {
      participation = 'ended';
      processing = 'completed';
    } else if (quickFilter === 'failed') {
      participation = 'ended';
    }
    return {
      provider: providerFilter || undefined,
      participation,
      processing,
      q: titleSearch || undefined,
    };
  }, [providerFilter, quickFilter, titleSearch]);

  const filteredRecordingsQuery = useQuery({
    queryKey: ['recordings-filtered', token, apiFilter],
    queryFn: () => fetchRecordings(token, apiFilter),
    enabled: authMode.kind === 'operator' && activeNav === 'meetings',
    refetchInterval: pollInterval,
    refetchIntervalInBackground: false,
    retry: false,
  });

  const allRecordings = useMemo(
    () => allRecordingsQuery.data?.items || [],
    [allRecordingsQuery.data]
  );

  const filteredRecordings = useMemo(() => {
    const items =
      filteredRecordingsQuery.data?.items || allRecordingsQuery.data?.items || [];
    if (quickFilter === 'failed') {
      return items.filter((item) => {
        const r = item.participation_reason;
        const samples = item.quality?.durable_sample_count || 0;
        const cleanStop =
          !r ||
          r === 'normal' ||
          r === 'room_empty' ||
          ((r === 'cancelled' || r === 'deadline') && samples > 0);
        return item.processing === 'failed' || !cleanStop;
      });
    }
    return items;
  }, [filteredRecordingsQuery.data, allRecordingsQuery.data, quickFilter]);

  const activeLiveCount = useMemo(
    () =>
      allRecordings.filter(
        (r) =>
          r.participation === 'starting' ||
          r.participation === 'preparing' ||
          r.participation === 'joining' ||
          r.participation === 'waiting_admission' ||
          r.participation === 'capturing'
      ).length,
    [allRecordings]
  );

  const calendarQuery = useQuery({
    queryKey: ['calendar', token],
    queryFn: () => fetchCalendar(token),
    enabled: authMode.kind === 'operator',
    refetchInterval: activeNav === 'calendar' ? pollInterval : false,
    refetchIntervalInBackground: false,
    retry: false,
  });

  const activeRecordingId =
    authMode.kind === 'reader' ? authMode.recordingId : selectedId;

  const detailQuery = useQuery({
    queryKey: ['recording-detail', token, activeRecordingId],
    queryFn: () => fetchRecordingDetail(token, activeRecordingId!),
    enabled:
      authMode.kind !== 'unauthenticated' && Boolean(activeRecordingId),
    refetchInterval: pollInterval,
    refetchIntervalInBackground: false,
    retry: false,
  });

  const transcriptQuery = useQuery({
    queryKey: ['recording-transcript', token, activeRecordingId],
    queryFn: () => fetchTranscript(token, activeRecordingId!),
    enabled:
      authMode.kind !== 'unauthenticated' && Boolean(activeRecordingId),
    refetchInterval: pollInterval,
    refetchIntervalInBackground: false,
    retry: false,
  });

  const authError = useMemo(() => {
    if (oidcError) {
      return oidcError;
    }
    const err =
      allRecordingsQuery.error ||
      filteredRecordingsQuery.error ||
      detailQuery.error ||
      transcriptQuery.error;
    if (err instanceof ApiError && err.status === 401) {
      return 'Ihre Sitzung oder Ihr Zugangsschlüssel ist abgelaufen oder ungültig (401 Unauthorized).';
    }
    return null;
  }, [
    oidcError,
    allRecordingsQuery.error,
    filteredRecordingsQuery.error,
    detailQuery.error,
    transcriptQuery.error,
  ]);

  const handleSaveToken = (nextToken: string) => {
    saveTokenToStorage(nextToken);
    setToken(nextToken);
    setOidcError(null);
    setActionError(null);
    queryClient.invalidateQueries();
  };

  const handleStartOidcLogin = async () => {
    setOidcError(null);
    try {
      await startOidcLogin();
    } catch (err) {
      setOidcError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleManualRefresh = () => {
    queryClient.invalidateQueries();
  };

  const handleSelectRecording = (id: string) => {
    setSelectedId(id);
    setSelectedSourceFilter('');
    setActionError(null);
  };

  const handleChangeNav = (nav: NavSection) => {
    setActiveNav(nav);
    setSelectedId(null);
    setActionError(null);
  };

  const handleReturnToAccount = () => {
    const restored = exitReaderModeToAccount();
    setToken(restored);
    setSelectedId(null);
    setOidcError(null);
    setActionError(null);
    queryClient.invalidateQueries();
  };

  const handleTriggerNewRecording = () => {
    setNewRecordingTab('link');
    setNewRecordingOpen(true);
  };

  const backLabel = useMemo(() => {
    if (activeNav === 'meetings') return 'Alle Meetings';
    if (activeNav === 'calendar') return 'Zurück zum Kalender';
    if (activeNav === 'system') return 'Zurück zu System & Diagnose';
    return 'Zurück zur Übersicht';
  }, [activeNav]);

  const handleOpenIcsImportModal = () => {
    setNewRecordingTab('ics');
    setNewRecordingOpen(true);
  };

  const rec = detailQuery.data;
  const trans = transcriptQuery.data;

  const handleCancel = async () => {
    if (!rec) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await cancelRecording(token, rec.id);
      await queryClient.invalidateQueries();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  };

  const handleRejoin = async () => {
    if (!rec) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await rejoinRecording(token, rec.id);
      await queryClient.invalidateQueries();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  };

  const handleRetryMail = async () => {
    if (!rec) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await retryMailDelivery(token, rec.id);
      await queryClient.invalidateQueries();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  };

  const handleDownload = async (format: 'txt' | 'vtt' | 'json' | 'md') => {
    if (!rec) return;
    setActionError(null);
    try {
      await downloadExportFile(token, rec.id, format);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleShareReaderLink = async (): Promise<string | null> => {
    if (!rec) return null;
    setActionError(null);
    try {
      const res = await issueReaderToken(token, rec.id);
      return `${window.location.origin}/ui#token=${res.ui_token}`;
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
      return null;
    }
  };

  return (
    <div className="min-h-screen bg-[#0b1120] text-slate-100">
      <HeaderBar
        healthy={Boolean(healthQuery.data)}
        authMode={authMode}
        hasSavedAccount={Boolean(savedAccountToken)}
        onReturnToAccount={handleReturnToAccount}
        activeNav={activeNav}
        onChangeNav={handleChangeNav}
        recordingsCount={allRecordings.length}
        activeLiveCount={activeLiveCount}
        calendarCount={calendarQuery.data?.events?.length || 0}
        livePoll={livePoll}
        onToggleLivePoll={setLivePoll}
        onManualRefresh={handleManualRefresh}
        onOpenNewRecording={handleTriggerNewRecording}
        onOpenAuthDialog={() => setAuthDialogOpen(true)}
      />

      <AuthGateDialog
        open={authDialogOpen || Boolean(authError && token)}
        onOpenChange={setAuthDialogOpen}
        currentToken={token}
        authMode={authMode}
        authError={authError}
        onSaveToken={handleSaveToken}
        onStartOidcLogin={handleStartOidcLogin}
      />

      {authMode.kind === 'operator' && (
        <NewRecordingDialog
          open={newRecordingOpen}
          onOpenChange={setNewRecordingOpen}
          token={token}
          initialTab={newRecordingTab}
          onCreatedRecording={(id) => {
            handleSelectRecording(id);
            queryClient.invalidateQueries();
          }}
          onImportedCalendar={(recId) => {
            if (recId) {
              handleSelectRecording(recId);
            } else {
              handleChangeNav('calendar');
            }
            queryClient.invalidateQueries();
          }}
        />
      )}

      {/* Main Content Area (offset by 240px left sidebar on desktop for operators) */}
      <div className={authMode.kind !== 'operator' ? '' : 'lg:pl-60'}>
        <main className="mx-auto max-w-6xl p-4 sm:p-6 lg:p-8">
          {authMode.kind === 'unauthenticated' ? (
            <WelcomeLandingView
              healthy={Boolean(healthQuery.data)}
              authError={authError}
              onConnectToken={handleSaveToken}
              onStartOidcLogin={handleStartOidcLogin}
              onOpenAuthDialog={() => setAuthDialogOpen(true)}
            />
          ) : activeRecordingId ? (
            /* Full-page Meeting Detail View (Otter / Fireflies style) */
            !rec || !trans ? (
              <div className="rounded-xl border border-slate-800 bg-slate-900/75 py-16 text-center text-xs text-slate-400">
                {detailQuery.error
                  ? `Fehler beim Laden der Aufnahme: ${(detailQuery.error as Error).message}`
                  : 'Lade Meeting-Transkript und Sprecherdaten…'}
              </div>
            ) : (
              <MeetingDetailView
                recording={rec}
                transcript={trans}
                isOperator={authMode.kind === 'operator'}
                backLabel={backLabel}
                onBack={
                  authMode.kind === 'operator'
                    ? () => setSelectedId(null)
                    : undefined
                }
                onCancel={handleCancel}
                onRejoin={handleRejoin}
                onRetryMail={handleRetryMail}
                onShareReaderLink={handleShareReaderLink}
                onDownload={handleDownload}
                actionBusy={actionBusy}
                actionError={actionError}
              />
            )
          ) : activeNav === 'home' ? (
            <HomeView
              token={token}
              recordings={allRecordings}
              calendarEvents={calendarQuery.data?.events || []}
              onOpenRecording={handleSelectRecording}
              onNavigateMeetings={() => handleChangeNav('meetings')}
              onNavigateCalendar={() => handleChangeNav('calendar')}
              onOpenIcsImport={handleOpenIcsImportModal}
              onCreatedRecording={(id) => {
                handleSelectRecording(id);
                queryClient.invalidateQueries();
              }}
            />
          ) : activeNav === 'meetings' ? (
            <RecordingSidebar
              recordings={filteredRecordings}
              selectedId={selectedId}
              onSelectRecording={handleSelectRecording}
              providerFilter={providerFilter}
              onProviderFilterChange={setProviderFilter}
              quickFilter={quickFilter}
              onQuickFilterChange={setQuickFilter}
              titleSearch={titleSearch}
              onTitleSearchChange={setTitleSearch}
              onOpenNewRecording={() => {
                setNewRecordingTab('link');
                setNewRecordingOpen(true);
              }}
              isLoading={
                filteredRecordingsQuery.isLoading ||
                allRecordingsQuery.isLoading
              }
            />
          ) : activeNav === 'calendar' ? (
            <CalendarWorkspace
              events={calendarQuery.data?.events || []}
              onSelectRecording={handleSelectRecording}
              onOpenImportModal={handleOpenIcsImportModal}
            />
          ) : (
            <SystemView
              healthy={Boolean(healthQuery.data)}
              authMode={authMode}
              recordings={allRecordings}
              livePoll={livePoll}
              onToggleLivePoll={setLivePoll}
              onManualRefresh={handleManualRefresh}
              onOpenAuthDialog={() => setAuthDialogOpen(true)}
              onSelectRecording={handleSelectRecording}
            />
          )}
        </main>
      </div>
    </div>
  );
}
