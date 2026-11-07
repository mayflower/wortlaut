import React, { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import {
  ApiError,
  cancelRecording,
  downloadExportFile,
  fetchCalendar,
  fetchRecordingDetail,
  fetchRecordings,
  fetchTranscript,
  issueReaderToken,
  loadInitialToken,
  parseTokenAuthMode,
  rejoinRecording,
  retryMailDelivery,
  saveTokenToStorage,
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
import { Button } from './components/ui/primitives';

export function App() {
  const queryClient = useQueryClient();
  const [token, setToken] = useState<string>(() => loadInitialToken());
  const authMode = useMemo(() => parseTokenAuthMode(token), [token]);

  const [activeNav, setActiveNav] = useState<NavSection>('home');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedSourceFilter, setSelectedSourceFilter] = useState<string>('');

  const [providerFilter, setProviderFilter] = useState<string>('');
  const [quickFilter, setQuickFilter] = useState<QuickStatusFilter>('all');
  const [titleSearch, setTitleSearch] = useState<string>('');

  const [livePoll, setLivePoll] = useState<boolean>(true);
  const [authDialogOpen, setAuthDialogOpen] = useState<boolean>(
    () => parseTokenAuthMode(loadInitialToken()).kind === 'unauthenticated'
  );
  const [newRecordingOpen, setNewRecordingOpen] = useState<boolean>(false);
  const [newRecordingTab, setNewRecordingTab] = useState<'link' | 'ics'>('link');
  const [actionBusy, setActionBusy] = useState<boolean>(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (authMode.kind === 'reader') {
      setSelectedId(authMode.recordingId);
    }
  }, [authMode]);

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
        const abnormal = Boolean(r && r !== 'normal' && r !== 'room_empty');
        return item.processing === 'failed' || abnormal;
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
    const err =
      allRecordingsQuery.error ||
      filteredRecordingsQuery.error ||
      detailQuery.error ||
      transcriptQuery.error;
    if (err instanceof ApiError && err.status === 401) {
      return 'Der eingegebene Bearer-Token wurde vom Server abgelehnt (401 Unauthorized).';
    }
    return null;
  }, [
    allRecordingsQuery.error,
    filteredRecordingsQuery.error,
    detailQuery.error,
    transcriptQuery.error,
  ]);

  const handleSaveToken = (nextToken: string) => {
    saveTokenToStorage(nextToken);
    setToken(nextToken);
    setActionError(null);
    queryClient.invalidateQueries();
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

  const handleTriggerNewRecording = () => {
    if (activeNav === 'home' && !selectedId) {
      const urlInput = document.getElementById(
        'meeting-url'
      ) as HTMLInputElement | null;
      if (urlInput) {
        urlInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
        urlInput.focus();
        return;
      }
    }
    setNewRecordingTab('link');
    setNewRecordingOpen(true);
  };

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

  const handleDownload = async (format: 'txt' | 'vtt' | 'json') => {
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
        open={authDialogOpen || Boolean(authError)}
        onOpenChange={setAuthDialogOpen}
        currentToken={token}
        authError={authError}
        onSaveToken={handleSaveToken}
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
      <div className={authMode.kind === 'reader' ? '' : 'lg:pl-60'}>
        <main className="mx-auto max-w-6xl p-4 sm:p-6 lg:p-8">
          {authMode.kind === 'unauthenticated' ? (
            <div className="mx-auto max-w-xl py-20 text-center space-y-4">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-sky-800/80 bg-sky-950/60 text-sky-400">
                <KeyRound className="h-6 w-6" />
              </div>
              <h1 className="text-xl font-bold text-white">
                Willkommen bei wortlaut
              </h1>
              <p className="text-sm text-slate-400">
                Ihr KI-Notizassistent für Google Meet, Microsoft Teams und Webex
                mit präziser Sprecher-Zuordnung. Bitte verbinden Sie sich mit
                Ihrem Operator-Token oder einem Lese-Token.
              </p>
              <Button
                variant="primary"
                size="lg"
                onClick={() => setAuthDialogOpen(true)}
              >
                <KeyRound className="h-4 w-4" />
                <span>Token eingeben &amp; verbinden</span>
              </Button>
            </div>
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
                onBack={() => setSelectedId(null)}
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
