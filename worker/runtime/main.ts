import {randomUUID} from 'node:crypto';
import type {Browser} from 'playwright';
import {serviceRequest} from './http.js';
import {MeetBrowser, MeetError} from './meet.js';
import {TeamsBrowser} from './teams-browser.js';
import {isTeamsMeeting} from '../src/teams-url.js';
import {WebexBrowser} from './webex-browser.js';
import {ZoomBrowser} from './zoom-browser.js';
import {isZoomMeeting} from '../src/zoom-url.js';
import {launchBrowser, nativeMeetInput} from './browser.js';

const api = process.env.WORTLAUT_API_URL;
const attemptId = process.env.WORTLAUT_ATTEMPT_ID;
const credential = process.env.WORTLAUT_BOOTSTRAP_CREDENTIAL;
if (!api || !attemptId || !credential) throw new Error('Worker configuration is incomplete');
const workerId = process.env.WORTLAUT_WORKER_ID ?? randomUUID();
const headers = {Authorization: `Bearer ${credential}`, 'X-Worker-ID': workerId,
  'Content-Type': 'application/json'};
let sessionDeadline = Infinity;
async function request(path: string, method = 'GET', body?: unknown, until = sessionDeadline) {
  return serviceRequest(new URL(path, api), {method, headers,
    body: body === undefined ? undefined : JSON.stringify(body)}, until);
}

let claimed = false, startupComplete = false;
let startupBrowser: Browser | undefined;
async function run(api: string, credential: string) {
  await request(`/v1/attempts/${attemptId}/claim`, 'POST', {worker_id: workerId});
  claimed = true;
  const bootstrap = await request(`/v1/attempts/${attemptId}/bootstrap`);
  if (!['webex', 'google_meet', 'teams', 'zoom'].includes(bootstrap.provider)) throw new Error('Unknown provider');
  const isTeams = bootstrap.provider === 'teams';
  const isMeet = bootstrap.provider === 'google_meet';
  const isZoom = bootstrap.provider === 'zoom';
  const isWebexBrowser = bootstrap.provider === 'webex' && Boolean(bootstrap.webex_browser);
  const pageUrl = new URL(isMeet || isTeams || isZoom || isWebexBrowser ? bootstrap.meeting_url : bootstrap.sdk_page_url);
  if (isWebexBrowser && (!pageUrl.hostname.endsWith('.webex.com') || pageUrl.port)) {
    throw new Error('Invalid Webex URL');
  }
  const deadline = Date.parse(bootstrap.deadline);
  sessionDeadline = deadline;
  if (pageUrl.protocol !== 'https:' || pageUrl.username || pageUrl.password || (!isTeams && !isZoom && pageUrl.search) ||
      !Number.isFinite(deadline)) {
    throw new Error('Provider page requires trusted HTTPS and a valid deadline');
  }
  if (isMeet && (pageUrl.hostname !== 'meet.google.com' || pageUrl.port ||
      !/^\/(?:meet\/)?[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(pageUrl.pathname))) throw new Error('Invalid Meet URL');
  if (isTeams && !isTeamsMeeting(pageUrl)) throw new Error('Invalid Teams URL');
  if (isZoom && !isZoomMeeting(pageUrl)) throw new Error('Invalid Zoom URL');
  // No ignoreHTTPSErrors, device capture, foreign page selectors or disabled sandbox.
  const browser = await launchBrowser(
    bootstrap.provider,
    isMeet ? bootstrap.meet.locale : isTeams ? bootstrap.teams.locale : isZoom ? bootstrap.zoom.locale : undefined,
    isWebexBrowser,
  );
  startupBrowser = browser;
  const context = await browser.newContext({permissions: [],
    ...(isTeams ? {viewport: null, locale: bootstrap.teams.locale} : {}),
    ...(isZoom ? {viewport: null, locale: bootstrap.zoom.locale,
      ...(bootstrap.zoom.auth_mode === 'account' ? {storageState: '/run/zoom/storage-state.json'} : {})} : {}),
    ...(isWebexBrowser ? {viewport: null, locale: 'en-US'} : {}),
    ...(isMeet ? {viewport: null, locale: bootstrap.meet.locale,
      ...(bootstrap.meet.auth_mode === 'account' ? {storageState: '/run/meet/storage-state.json'} : {})} : {}),
  });
  const page = await context.newPage();
  for (const other of browser.contexts()) {
    if (other !== context) for (const blank of other.pages()) await blank.close().catch(() => {});
  }
  const meet = isMeet ? new MeetBrowser(page, bootstrap, api, credential, workerId, undefined, nativeMeetInput(page))
    : isTeams ? new TeamsBrowser(page, bootstrap, api, credential, workerId)
    : isZoom ? new ZoomBrowser(page, bootstrap, api, credential, workerId)
    : isWebexBrowser ? new WebexBrowser(page, bootstrap, api, credential, workerId) : undefined;
  let stopping: Promise<void> | undefined;
  let endReason = 'normal';
  let diagnostics: Record<string, unknown> = {capability: 'unverified', streams: 0, audio_samples: 0, drained: null,
    configured_speaker_slots: 0, configured_share_slots: 0,
    receiver_sources: [], participant_sources: {available: false, total: 0, truncated: false, sources: []},
    data_channels: []};
  let signalStop!: () => void;
  let lobbySince: number | undefined;
  let emptySince: number | undefined;
  let lastActiveSamples = 0;
  let lastRtpTimestamp = -Infinity;
  let maxDomParticipants = 0;
  const stopped = new Promise<void>((resolve) => { signalStop = resolve; });
  async function stop(reason: string) {
    return stopping ??= (async () => {
      endReason = reason;
      signalStop();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          meet ? meet.stop(reason) : page.evaluate((r) => (window as any).wortlaut.stop(r), reason),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Stop deadline exceeded')), 30000);
          }),
        ]);
      } catch { endReason = 'browser_end_unconfirmed'; }
      finally { clearTimeout(timer); }
    })();
  }
  const terminate = () => { void stop('cancelled'); };
  process.on('SIGTERM', terminate);
  process.on('SIGINT', terminate);
  // Enforce the deadline during register/join/lobby too, not only after join resolves.
  const deadlineTimer = setTimeout(() => { void stop('deadline'); }, Math.max(0, deadline - Date.now()));
  let guestExpiryTimer: ReturnType<typeof setTimeout> | undefined;
  let renewAt = Infinity, guestStopAt = Infinity;
  function scheduleGuest(issued: typeof bootstrap) {
    const expires = Date.parse(issued.guest_expires_at);
    const lifetime = issued.guest.expires_in;
    if (!Number.isFinite(expires) || !Number.isFinite(lifetime) || lifetime <= 30) {
      throw new Error('Guest expiration is invalid');
    }
    renewAt = expires - Math.min(300000, lifetime * 500);
    guestStopAt = expires - Math.min(30000, lifetime * 100);
    clearTimeout(guestExpiryTimer);
    // This remains active while an HTTP renewal or register/join is pending.
    guestExpiryTimer = setTimeout(() => { void stop('guest_token_expired'); },
      Math.max(0, guestStopAt - Date.now()));
  }
  let lastMediaLogAt = -Infinity;
  async function monitor() {
    while (!stopping) {
      const state = meet ? await meet.inspect() : await page.evaluate(() => (window as any).wortlaut.inspectReceivers());
      diagnostics = {capability: state.capability, streams: state.streams,
        configured_speaker_slots: state.configured_speaker_slots, configured_share_slots: state.configured_share_slots,
        audio_samples: state.audio_samples, active_audio_samples: state.active_audio_samples ?? 0,
        receiver_sources: state.receiver_sources,
        participant_sources: state.participant_sources,
        data_channels: state.data_channels ?? [],
        sdp: state.sdp ?? {descriptions: 0, audio_sections: 0, video_sections: 0, ssrc_count: 0, cname_count: 0, msid_count: 0},
        audio_clock: state.audio_clock,
        ...(state.media ? {media: state.media} : {}),
        drained: state.stopped ? state.drained : null};
      if (performance.now() - lastMediaLogAt >= 10_000) {
        lastMediaLogAt = performance.now();
        // One line per 10 s: the time series of receive counters that the
        // single stored status snapshot cannot provide. No names or tokens.
        console.log('[wortlaut-media] ' + JSON.stringify({
          participation: state.participation, streams: state.streams,
          audio_samples: state.audio_samples, active_audio_samples: state.active_audio_samples ?? 0,
          clock: state.audio_clock?.state, dom: state.participant_sources?.dom_participants ?? null,
          participants: state.participant_sources?.total ?? null,
          receivers: ((state.receiver_sources ?? []) as Array<{track_id?: string; source_state?: string;
            rtp_stats?: Record<string, unknown>}>).map((r) => ({track: r.track_id?.slice(0, 8),
            state: r.source_state, ...(r.rtp_stats ?? {})})),
          media: state.media ?? null,
        }));
      }
      if (state.stopped || state.participation === 'ended') {
        await stop(state.reason || 'normal');
        return;
      }
      if (state.participation === 'waiting_admission') {
        lobbySince ??= performance.now();
        if (performance.now() - lobbySince >= bootstrap.lobby_timeout_seconds * 1000) {
          await stop('lobby_timeout');
          return;
        }
      } else { lobbySince = undefined; }
      if (state.participation === 'capturing') {
        const currentDom = state.participant_sources?.dom_participants ?? 0;
        if (currentDom > maxDomParticipants) maxDomParticipants = currentDom;
        const activeSamples = typeof state.active_audio_samples === 'number'
          ? state.active_audio_samples
          : (state.streams > 0 ? state.audio_samples : 0);
        let maxRtpTs = -Infinity;
        for (const recv of (state.receiver_sources ?? []) as Array<{csrc?: Array<{timestamp?: number}>; ssrc?: Array<{timestamp?: number}>}>) {
          for (const item of [...(recv.csrc ?? []), ...(recv.ssrc ?? [])]) {
            if (typeof item.timestamp === 'number' && Number.isFinite(item.timestamp) && item.timestamp > maxRtpTs) {
              maxRtpTs = item.timestamp;
            }
          }
        }
        const rtpAdvanced = maxRtpTs > lastRtpTimestamp;
        if (rtpAdvanced) lastRtpTimestamp = maxRtpTs;
        if ((activeSamples > lastActiveSamples && state.streams > 0) || rtpAdvanced) {
          if (activeSamples > lastActiveSamples) lastActiveSamples = activeSamples;
          emptySince = undefined;
        } else {
          emptySince ??= performance.now();
          const configuredTimeout = bootstrap.empty_room_timeout_seconds ?? 300;
          const emptyTimeoutSeconds = (maxDomParticipants >= 1 && currentDom === 0)
            ? Math.min(configuredTimeout, 15)
            : (maxDomParticipants >= 2 && currentDom <= 1)
              ? Math.min(configuredTimeout, 60)
              : currentDom >= 2
                ? Math.max(configuredTimeout * 6, 1800)
                : configuredTimeout;
          if (performance.now() - emptySince >= emptyTimeoutSeconds * 1000) {
            await stop('room_empty');
            return;
          }
        }
      } else { emptySince = undefined; }
      if (Date.now() >= renewAt && renewAt < deadline) {
        try {
          const renewed = await request(`/v1/attempts/${attemptId}/bootstrap`, 'GET', undefined,
            Math.min(deadline, guestStopAt));
          if (stopping) return;
          await page.evaluate((guest) => (window as any).wortlaut.renewGuest(guest), renewed.guest);
          scheduleGuest(renewed);
        } catch {
          await stop('guest_renewal_failed');
          return;
        }
      }
      const reported = await request(`/v1/attempts/${attemptId}/status`, 'POST', {
        ...diagnostics, participation: state.participation === 'preparing' ? 'joining' : state.participation,
        reason: state.reason,
      });
      if (reported.stop_requested) {
        await stop(reported.stop_reason);
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([stopped, new Promise<void>((resolve) => { timer = setTimeout(resolve, 5000); })]);
      clearTimeout(timer);
    }
  }
  startupComplete = true;
  try {
    if (meet) await meet.prepare();
    else scheduleGuest(bootstrap);
    await Promise.race([page.goto(pageUrl.href, {waitUntil: 'domcontentloaded', timeout: 60000}), stopped]);
    if (!stopping) {
      if (!meet) await Promise.race([page.waitForFunction(() => Boolean((window as any).wortlaut),
        undefined, {timeout: 30000}), stopped]);
      if (!stopping) await Promise.race([
        Promise.all([
          meet ? meet.join() : page.evaluate((config) => (window as any).wortlaut.start(config),
            {bootstrap, credential, worker_id: workerId}),
          monitor(),
        ]),
        stopped,
      ]);
    }
  } catch (error) {
    // SDK error messages can contain request URLs or tokens. Log only local code locations.
    const locations = error instanceof Error ? [...(error.stack ?? '').matchAll(
      /\/app\/worker\/dist-worker\/[a-zA-Z0-9_./-]+:\d+:\d+/g)].map(match => match[0]) : [];
    console.error(JSON.stringify({event: 'worker_failed', locations}));
    await stop(error instanceof MeetError ? error.reason : 'worker_failed');
    process.exitCode = 1;
  } finally {
    clearTimeout(deadlineTimer);
    clearTimeout(guestExpiryTimer);
    await stopping;
    try {
      const state = meet ? await meet.inspect() : await page.evaluate(() => (window as any).wortlaut.state);
      diagnostics = {capability: state.capability, streams: state.streams,
        configured_speaker_slots: state.configured_speaker_slots, configured_share_slots: state.configured_share_slots,
        audio_samples: state.audio_samples, active_audio_samples: state.active_audio_samples ?? 0,
        receiver_sources: state.receiver_sources,
        participant_sources: state.participant_sources,
        data_channels: state.data_channels ?? [],
        sdp: state.sdp ?? {descriptions: 0, audio_sections: 0, video_sections: 0, ssrc_count: 0, cname_count: 0, msid_count: 0},
        audio_clock: state.audio_clock, drained: state.drained};
    } catch { /* preserve last known diagnostics */ }
    // An SDK event alone is not proof of process termination. Report ended only
    // after Chromium has closed; lost status ACKs can replay the same final report.
    await browser.close();
    if (endReason === 'normal' && diagnostics.drained === false) endReason = 'audio_drain_incomplete';
    try { await request(`/v1/attempts/${attemptId}/status`, 'POST',
      {participation: 'ended', reason: endReason, ...diagnostics}, Date.now() + 60000); }
    catch { process.exitCode = 1; }
    process.off('SIGTERM', terminate);
    process.off('SIGINT', terminate);
  }
}

try { await run(api, credential); }
catch {
  // Startup has not touched a provider. A confirmed browser close can release
  // that claim terminally; later failures still require the normal stop path.
  process.exitCode = 1;
  if (!startupComplete) {
    let closed = true;
    try { await startupBrowser?.close(); } catch { closed = false; }
    if (claimed && closed) {
      try { await request(`/v1/attempts/${attemptId}/status`, 'POST',
        {participation: 'ended', reason: 'worker_startup_failed', drained: true}, Date.now() + 20000); }
      catch { /* Kubernetes process-termination proof remains authoritative. */ }
    }
  }
}
