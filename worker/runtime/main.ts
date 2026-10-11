import {randomUUID} from 'node:crypto';
import type {Browser} from 'playwright';
import {serviceRequest} from './http.js';
import {MeetBrowser, MeetError} from './meet.js';
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
  if (!['webex', 'google_meet'].includes(bootstrap.provider)) throw new Error('Unknown provider');
  const isMeet = bootstrap.provider === 'google_meet';
  const pageUrl = new URL(isMeet ? bootstrap.meeting_url : bootstrap.sdk_page_url);
  const deadline = Date.parse(bootstrap.deadline);
  sessionDeadline = deadline;
  if (pageUrl.protocol !== 'https:' || pageUrl.username || pageUrl.password || pageUrl.search ||
      !Number.isFinite(deadline)) {
    throw new Error('Provider page requires trusted HTTPS and a valid deadline');
  }
  if (isMeet && (pageUrl.hostname !== 'meet.google.com' || pageUrl.port ||
      !/^\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(pageUrl.pathname))) throw new Error('Invalid Meet URL');
  // No ignoreHTTPSErrors, device capture, foreign page selectors or disabled sandbox.
  const browser = await launchBrowser(bootstrap.provider, isMeet ? bootstrap.meet.locale : undefined);
  startupBrowser = browser;
  const context = await browser.newContext({permissions: [],
    ...(isMeet ? {viewport: null, locale: bootstrap.meet.locale,
      ...(bootstrap.meet.auth_mode === 'account' ? {storageState: '/run/meet/storage-state.json'} : {})} : {}),
  });
  const page = await context.newPage();
  const meet = isMeet ? new MeetBrowser(page, bootstrap, api, credential, workerId, undefined, nativeMeetInput(page)) : undefined;
  let stopping: Promise<void> | undefined;
  let endReason = 'normal';
  let diagnostics: Record<string, unknown> = {capability: 'unverified', streams: 0, audio_samples: 0, drained: null,
    configured_speaker_slots: 0, configured_share_slots: 0,
    receiver_sources: [], participant_sources: {available: false, total: 0, truncated: false, sources: []}};
  let signalStop!: () => void;
  let lobbySince: number | undefined;
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
  async function monitor() {
    while (!stopping) {
      const state = meet ? await meet.inspect() : await page.evaluate(() => (window as any).wortlaut.inspectReceivers());
      diagnostics = {capability: state.capability, streams: state.streams,
        configured_speaker_slots: state.configured_speaker_slots, configured_share_slots: state.configured_share_slots,
        audio_samples: state.audio_samples, receiver_sources: state.receiver_sources,
        participant_sources: state.participant_sources, audio_clock: state.audio_clock,
        drained: state.stopped ? state.drained : null};
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
    // SDK error messages can contain request URLs or tokens. Report only our safe reason.
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
        audio_samples: state.audio_samples, receiver_sources: state.receiver_sources,
        participant_sources: state.participant_sources, audio_clock: state.audio_clock, drained: state.drained};
    } catch { /* preserve last known diagnostics */ }
    // An SDK event alone is not proof of process termination. Report ended only
    // after Chromium has closed; lost status ACKs can replay the same final report.
    await browser.close();
    if (endReason === 'normal' && diagnostics.drained === false) endReason = 'audio_drain_incomplete';
    try { await request(`/v1/attempts/${attemptId}/status`, 'POST',
      {participation: 'ended', reason: endReason, ...diagnostics}, Date.now() + 20000); }
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
