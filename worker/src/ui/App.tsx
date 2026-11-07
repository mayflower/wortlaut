import React, { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  Check,
  Copy,
  Download,
  FileJson,
  FileText,
  KeyRound,
  MessageSquareText,
  Plus,
  Radio,
  RotateCcw,
  Square,
  Subtitles,
} from 'lucide-react';
import {
  ApiError,
  cancelRecording,
  downloadExportFile,
  fetchCalendar,
  fetchRecordingDetail,
  fetchRecordings,
  fetchTranscript,
  formatRecordingTitle,
  loadInitialToken,
  parseTokenAuthMode,
  rejoinRecording,
  retryMailDelivery,
  saveTokenToStorage,
} from './api';
import { AuthGateDialog } from './components/AuthGateDialog';
import { CalendarWorkspace } from './components/CalendarWorkspace';
import { DiagnosticsTab } from './components/DiagnosticsTab';
import { HeaderBar } from './components/HeaderBar';
import { NewRecordingDialog } from './components/NewRecordingDialog';
import { ParticipationStepper } from './components/ParticipationStepper';
import {
  QuickStatusFilter,
  RecordingSidebar,
} from './components/RecordingSidebar';
import { SourcesTab } from './components/SourcesTab';
import { TranscriptTab } from './components/TranscriptTab';
import {
  Button,
  ProviderBadge,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from './components/ui/primitives';

export function App() {
  const queryClient = useQueryClient();
  const [token, setToken] = useState<string>(() => loadInitialToken());
  const authMode = useMemo(() => parseTokenAuthMode(token), [token]);

  const [activeView, setActiveView] = useState<'recordings' | 'calendar'>(
    'recordings'
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<
    'transcript' | 'sources' | 'diagnostics'
  >('transcript');
  const [selectedSourceFilter, setSelectedSourceFilter] = useState<string>('');

  const [providerFilter, setProviderFilter] = useState<string>('');
  const [quickFilter, setQuickFilter] = useState<QuickStatusFilter>('all');
  const [titleSearch, setTitleSearch] = useState<string>('');

  const [livePoll, setLivePoll] = useState<boolean>(true);
  const [authDialogOpen, setAuthDialogOpen] = useState<boolean>(
    () => parseTokenAuthMode(loadInitialToken()).kind === 'unauthenticated'
  );
  const [newRecordingOpen, setNewRecordingOpen] = useState<boolean>(false);
  const [copiedId, setCopiedId] = useState<boolean>(false);
  const [actionBusy, setActionBusy] = useState<boolean>(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (authMode.kind === 'reader') {
      setSelectedId(authMode.recordingId);
      setDetailTab('transcript');
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

  const recordingsQuery = useQuery({
    queryKey: ['recordings', token, apiFilter],
    queryFn: () => fetchRecordings(token, apiFilter),
    enabled: authMode.kind === 'operator',
    refetchInterval: pollInterval,
    refetchIntervalInBackground: false,
    retry: false,
  });

  const recordings = useMemo(() => {
    const items = recordingsQuery.data?.items || [];
    if (quickFilter === 'failed') {
      return items.filter((item) => {
        const r = item.participation_reason;
        const abnormal = Boolean(r && r !== 'normal' && r !== 'room_empty');
        return item.processing === 'failed' || abnormal;
      });
    }
    return items;
  }, [recordingsQuery.data, quickFilter]);

  useEffect(() => {
    if (
      authMode.kind === 'operator' &&
      !selectedId &&
      recordings.length > 0
    ) {
      setSelectedId(recordings[0].id);
    }
  }, [authMode.kind, selectedId, recordings]);

  const calendarQuery = useQuery({
    queryKey: ['calendar', token],
    queryFn: () => fetchCalendar(token),
    enabled: authMode.kind === 'operator',
    refetchInterval: activeView === 'calendar' ? pollInterval : false,
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
      recordingsQuery.error || detailQuery.error || transcriptQuery.error;
    if (err instanceof ApiError && err.status === 401) {
      return 'Der eingegebene Bearer-Token wurde vom Server abgelehnt (401 Unauthorized).';
    }
    return null;
  }, [recordingsQuery.error, detailQuery.error, transcriptQuery.error]);

  const handleSaveToken = (nextToken: string) => {
    saveTokenToStorage(nextToken);
    setToken(nextToken);
    setActionError(null);
    queryClient.invalidateQueries();
  };

  const handleManualRefresh = () => {
    queryClient.invalidateQueries();
  };

  const rec = detailQuery.data;
  const trans = transcriptQuery.data;

  const canCancel =
    authMode.kind === 'operator' &&
    rec &&
    rec.participation !== 'ended' &&
    !rec.cancelled_at;
  const canRejoin =
    authMode.kind === 'operator' && rec && rec.participation === 'ended';
  const exportsReady =
    rec && (rec.processing === 'completed' || rec.processing === 'failed');

  const handleCopyId = async () => {
    if (!rec || !navigator.clipboard) return;
    await navigator.clipboard.writeText(rec.id).catch(() => {});
    setCopiedId(true);
    setTimeout(() => setCopiedId(false), 1600);
  };

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

  return (
    <div className="min-h-screen bg-[#0b1120] text-slate-100">
      <HeaderBar
        healthy={Boolean(healthQuery.data)}
        authMode={authMode}
        activeView={activeView}
        onChangeView={setActiveView}
        recordingsCount={recordingsQuery.data?.items?.length || 0}
        calendarCount={calendarQuery.data?.events?.length || 0}
        livePoll={livePoll}
        onToggleLivePoll={setLivePoll}
        onManualRefresh={handleManualRefresh}
        onOpenNewRecording={() => setNewRecordingOpen(true)}
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
          onCreatedRecording={(id) => {
            setActiveView('recordings');
            setSelectedId(id);
            setSelectedSourceFilter('');
            queryClient.invalidateQueries();
          }}
          onImportedCalendar={(recId) => {
            if (recId) {
              setActiveView('recordings');
              setSelectedId(recId);
            } else {
              setActiveView('calendar');
            }
            queryClient.invalidateQueries();
          }}
        />
      )}

      {authMode.kind === 'unauthenticated' ? (
        <main className="mx-auto max-w-xl px-4 py-16 text-center space-y-4">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-sky-800/80 bg-sky-950/60 text-sky-400">
            <KeyRound className="h-6 w-6" />
          </div>
          <h1 className="text-xl font-bold text-white">
            Willkommen bei wortlaut
          </h1>
          <p className="text-sm text-slate-400">
            Selbstgehostete Meeting-Aufzeichnung und Sprecher-Transkription für
            Google Meet, Microsoft Teams und Webex. Bitte verbinden Sie sich mit
            Ihrem Operator-Token oder einem Aufnahme-Lese-Token.
          </p>
          <Button
            variant="primary"
            size="lg"
            onClick={() => setAuthDialogOpen(true)}
          >
            <KeyRound className="h-4 w-4" />
            <span>Token eingeben &amp; verbinden</span>
          </Button>
        </main>
      ) : authMode.kind === 'operator' && activeView === 'calendar' ? (
        <CalendarWorkspace
          events={calendarQuery.data?.events || []}
          onSelectRecording={(recId) => {
            setSelectedId(recId);
            setActiveView('recordings');
          }}
          onOpenImportModal={() => setNewRecordingOpen(true)}
        />
      ) : (
        <main
          className={
            authMode.kind === 'operator'
              ? 'mx-auto grid max-w-[1520px] grid-cols-1 gap-4 p-4 lg:grid-cols-[380px_1fr]'
              : 'mx-auto max-w-5xl p-4 sm:p-6'
          }
        >
          {authMode.kind === 'operator' && (
            <RecordingSidebar
              recordings={recordings}
              selectedId={selectedId}
              onSelectRecording={(id) => {
                setSelectedId(id);
                setSelectedSourceFilter('');
              }}
              providerFilter={providerFilter}
              onProviderFilterChange={setProviderFilter}
              quickFilter={quickFilter}
              onQuickFilterChange={setQuickFilter}
              titleSearch={titleSearch}
              onTitleSearchChange={setTitleSearch}
              onOpenNewRecording={() => setNewRecordingOpen(true)}
              isLoading={recordingsQuery.isLoading}
            />
          )}

          <section
            id="detail-panel"
            className="flex flex-col gap-4 rounded-xl border border-slate-800 bg-slate-900/75 p-4 sm:p-5"
          >
            {!activeRecordingId ? (
              <div className="flex flex-col items-center justify-center py-20 text-center space-y-3">
                <MessageSquareText className="h-9 w-9 text-slate-600" />
                <div className="text-sm font-medium text-slate-300">
                  Keine Aufnahme ausgewählt
                </div>
                <p className="max-w-md text-xs text-slate-500">
                  Wählen Sie links eine Aufnahme aus oder schicken Sie über
                  „Neue Aufnahme“ einen Bot in ein laufendes Meeting.
                </p>
                {authMode.kind === 'operator' && (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => setNewRecordingOpen(true)}
                  >
                    <Plus className="h-4 w-4" />
                    <span>Bot in ein Meeting schicken</span>
                  </Button>
                )}
              </div>
            ) : !rec || !trans ? (
              <div className="py-16 text-center text-xs text-slate-400">
                {detailQuery.error
                  ? `Fehler beim Laden der Aufnahme: ${(detailQuery.error as Error).message}`
                  : 'Lade Aufnahmedetails und Transkript…'}
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-800 pb-4">
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <ProviderBadge provider={rec.provider} />
                      <h1 className="text-lg font-bold text-white">
                        {formatRecordingTitle(rec)}
                      </h1>
                      <button
                        type="button"
                        onClick={handleCopyId}
                        title={`Aufnahme-ID kopieren: ${rec.id}`}
                        className="inline-flex items-center gap-1 rounded-md border border-slate-800 bg-slate-950 px-2 py-0.5 font-mono text-[11px] text-slate-400 hover:border-slate-700 hover:text-slate-200 cursor-pointer"
                      >
                        {copiedId ? (
                          <Check className="h-3 w-3 text-emerald-400" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                        <span>{rec.id.slice(0, 8)}…</span>
                      </button>
                    </div>

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
                      <span>
                        Zeitraum:{' '}
                        <strong className="font-medium text-slate-200">
                          {new Date(rec.starts_at).toLocaleString('de-DE')} –{' '}
                          {new Date(rec.ends_at).toLocaleTimeString('de-DE')}
                        </strong>
                      </span>
                      {rec.guest_name && (
                        <span>
                          Bot-Name:{' '}
                          <strong className="font-medium text-slate-200">
                            {rec.guest_name}
                          </strong>
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <div className="inline-flex items-center rounded-lg border border-slate-800 bg-slate-950 p-0.5">
                      <button
                        type="button"
                        data-export="txt"
                        disabled={!exportsReady}
                        onClick={() => handleDownload('txt')}
                        title={
                          exportsReady
                            ? 'Transkript als Textdatei herunterladen'
                            : 'Verfügbar nach Abschluss der Spracherkennung'
                        }
                        className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-40 disabled:pointer-events-none cursor-pointer"
                      >
                        <FileText className="h-3.5 w-3.5 text-sky-400" />
                        <span>TXT</span>
                      </button>
                      <button
                        type="button"
                        data-export="vtt"
                        disabled={!exportsReady}
                        onClick={() => handleDownload('vtt')}
                        title={
                          exportsReady
                            ? 'Untertitel als WebVTT herunterladen'
                            : 'Verfügbar nach Abschluss der Spracherkennung'
                        }
                        className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-40 disabled:pointer-events-none cursor-pointer"
                      >
                        <Subtitles className="h-3.5 w-3.5 text-emerald-400" />
                        <span>WebVTT</span>
                      </button>
                      <button
                        type="button"
                        data-export="json"
                        disabled={!exportsReady}
                        onClick={() => handleDownload('json')}
                        title={
                          exportsReady
                            ? 'Strukturierten JSON-Export herunterladen'
                            : 'Verfügbar nach Abschluss der Spracherkennung'
                        }
                        className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-40 disabled:pointer-events-none cursor-pointer"
                      >
                        <FileJson className="h-3.5 w-3.5 text-amber-400" />
                        <span>JSON</span>
                      </button>
                    </div>

                    {canRejoin && (
                      <Button
                        variant="primary"
                        size="sm"
                        id="rejoin-rec-btn"
                        disabled={actionBusy}
                        onClick={handleRejoin}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        <span>Erneut beitreten</span>
                      </Button>
                    )}

                    {canCancel && (
                      <Button
                        variant="danger"
                        size="sm"
                        id="cancel-rec-btn"
                        disabled={actionBusy}
                        onClick={handleCancel}
                      >
                        <Square className="h-3.5 w-3.5" />
                        <span>Aufnahme beenden</span>
                      </Button>
                    )}
                  </div>
                </div>

                {actionError && (
                  <div className="rounded-lg border border-red-800/80 bg-red-950/60 px-3.5 py-2.5 text-xs text-red-200">
                    {actionError}
                  </div>
                )}

                <ParticipationStepper
                  recording={rec}
                  isOperator={authMode.kind === 'operator'}
                  onRejoin={handleRejoin}
                  rejoining={actionBusy}
                />

                <Tabs
                  value={detailTab}
                  onValueChange={(v) =>
                    setDetailTab(
                      v as 'transcript' | 'sources' | 'diagnostics'
                    )
                  }
                  className="space-y-4"
                >
                  <TabsList className="w-full justify-start overflow-x-auto">
                    <TabsTrigger value="transcript">
                      <MessageSquareText className="h-3.5 w-3.5" />
                      <span>
                        Transkript ({(trans.segments || []).length})
                      </span>
                    </TabsTrigger>
                    <TabsTrigger value="sources">
                      <Radio className="h-3.5 w-3.5" />
                      <span>
                        Teilnehmer &amp; Audio-Quellen (
                        {(trans.sources_summary || []).length})
                      </span>
                    </TabsTrigger>
                    <TabsTrigger value="diagnostics">
                      <Activity className="h-3.5 w-3.5" />
                      <span>Diagnose &amp; Zustellung</span>
                    </TabsTrigger>
                  </TabsList>

                  <TabsContent value="transcript">
                    <TranscriptTab
                      transcript={trans}
                      selectedSourceFilter={selectedSourceFilter}
                      onChangeSourceFilter={setSelectedSourceFilter}
                    />
                  </TabsContent>

                  <TabsContent value="sources">
                    <SourcesTab
                      sources={trans.sources_summary || []}
                      selectedSourceFilter={selectedSourceFilter}
                      onSelectSourceForTranscript={(sourceId) => {
                        setSelectedSourceFilter((prev) =>
                          prev === sourceId ? '' : sourceId
                        );
                        setDetailTab('transcript');
                      }}
                    />
                  </TabsContent>

                  <TabsContent value="diagnostics">
                    <DiagnosticsTab
                      recording={rec}
                      transcript={trans}
                      isOperator={authMode.kind === 'operator'}
                      onRetryMail={handleRetryMail}
                      retryingMail={actionBusy}
                    />
                  </TabsContent>
                </Tabs>
              </>
            )}
          </section>
        </main>
      )}
    </div>
  );
}
