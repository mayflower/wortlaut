import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {extname, join, normalize} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {build} from 'vite';

const MIME_BY_EXT: Record<string, string> = {
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

test('Web-UI renders live Off-the-Record paused banner, inline chat markers & pause windows, search/speaker filters, and Markdown copy', async () => {
  const workerRoot = fileURLToPath(new URL('..', import.meta.url));
  const uiDistDir = join(workerRoot, 'dist', 'ui');
  if (!existsSync(join(uiDistDir, 'app.js'))) {
    await build({
      root: workerRoot,
      configFile: fileURLToPath(new URL('../vite.ui.config.ts', import.meta.url)),
      logLevel: 'silent',
    });
  }

  const recordingId = randomUUID();
  let livePaused = true;
  let recordingLanguage = 'auto';
  const languagePatches: string[] = [];

  const bootPayload = {
    failureReasons: {},
    instance: {
      assistantName: 'wortlaut',
      defaultLocale: 'de',
      botEmail: null,
      providers: {
        google_meet: true,
        google_meet_auth_session: false,
        teams: true,
        webex: true,
        zoom: true,
      },
      mail: {imapEnabled: false, smtpEnabled: false, senderAuth: 'gateway', allowedDomains: []},
      limits: {maxActiveMeetings: 15, lobbyTimeoutSeconds: 600, emptyRoomTimeoutSeconds: 300},
      retention: {audioHours: 24, transcriptDays: 30},
      oidc: {enabled: false, issuer: '', clientId: 'wortlaut', allowedDomains: []},
      calendarOAuth: {
        googleEnabled: false,
        microsoftEnabled: false,
        googleClientId: '',
        microsoftClientId: '',
        microsoftTenantId: 'common',
      },
      privacyUrl: '/privacy',
      enable_keyframes: true,
      llmSummaryEnabled: false,
      llmModel: '',
    },
  };

  const uiHtml = `<!DOCTYPE html>
<html lang="de" data-theme="dark" data-astryx-theme="stone">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>wortlaut UI Test</title>
  <link rel="stylesheet" href="/sdk/ui/app.css">
</head>
<body>
  <div id="root"></div>
  <script>window.__WORTLAUT_BOOT__ = ${JSON.stringify(bootPayload)};</script>
  <script type="module" src="/sdk/ui/app.js"></script>
</body>
</html>`;

  const server = createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (u.pathname === '/ui') {
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
      res.end(uiHtml);
      return;
    }
    if (u.pathname.startsWith('/sdk/ui/')) {
      const rel = normalize(u.pathname.slice('/sdk/ui/'.length)).replace(/^(\.\.(\/|\\|$))+/, '');
      const fullPath = join(uiDistDir, rel);
      try {
        const bytes = await readFile(fullPath);
        res.writeHead(200, {
          'Content-Type': MIME_BY_EXT[extname(fullPath)] ?? 'application/octet-stream',
        });
        res.end(bytes);
      } catch {
        res.writeHead(404);
        res.end();
      }
      return;
    }
    if (u.pathname === '/health/ready') {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({status: 'ready'}));
      return;
    }
    if (u.pathname === '/v1/mcp/grants') {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({endpoint: 'http://127.0.0.1/mcp', grants: []}));
      return;
    }
    if (u.pathname === '/v1/calendar') {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({events: [], connections: [], synced_events: []}));
      return;
    }
    if (u.pathname === '/v1/recordings' && req.method === 'GET') {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(
        JSON.stringify({
          items: [
            {
              id: recordingId,
              provider: 'google_meet',
              title: 'Architektur-Runde Q4',
              guest_name: 'wortlaut',
              language: recordingLanguage,
              owner_email: 'elena.rostova@example.org',
              starts_at: '2026-11-15T10:00:00Z',
              ends_at: '2026-11-15T10:30:00Z',
              participation: 'capturing',
              processing: 'processing',
              processing_error: null,
              participation_reason: null,
              cancelled_at: null,
              audio_deleted_at: null,
              transcript_deleted_at: null,
              metadata_deleted_at: null,
              active_attempt_id: randomUUID(),
              calendar_entry_id: null,
              calendar_conflict: false,
              recurrence_key: null,
            },
          ],
          next_cursor: null,
        }),
      );
      return;
    }
    if (u.pathname === `/v1/recordings/${recordingId}` && req.method === 'PATCH') {
      const chunks: Buffer[] = [];
      for await (const ch of req) chunks.push(Buffer.from(ch));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {language?: string};
      if (typeof body.language === 'string') {
        recordingLanguage = body.language;
        languagePatches.push(body.language);
      }
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({recording_id: recordingId, language: recordingLanguage, segments: []}));
      return;
    }
    if (u.pathname === `/v1/recordings/${recordingId}`) {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(
        JSON.stringify({
          id: recordingId,
          provider: 'google_meet',
          title: 'Architektur-Runde Q4',
          guest_name: 'wortlaut',
          language: recordingLanguage,
          starts_at: '2026-11-15T10:00:00Z',
          ends_at: '2026-11-15T10:30:00Z',
          participation: 'capturing',
          processing: 'processing',
          processing_error: null,
          participation_reason: null,
          cancelled_at: null,
          audio_deleted_at: null,
          transcript_deleted_at: null,
          metadata_deleted_at: null,
          active_attempt_id: randomUUID(),
          calendar_entry_id: null,
          calendar_conflict: false,
          recurrence_key: null,
          attempts: [],
          audio: [],
          ingest: {durable_sample_count: 160000, durable_chunk_count: 2, last_audio_activity: '2026-11-15T10:02:00Z'},
          asr: {pending: 0, failed: 0, completed: 2, pending_source_seconds: 0, oldest_pending_seconds: null},
          live_status: {
            is_active: true,
            paused: livePaused,
            speech_active: !livePaused,
            max_audio_level: !livePaused ? 0.42 : 0,
            active_speakers: !livePaused ? ['Elena Rostova'] : [],
            participation: 'capturing',
            processing: 'processing',
            active_streams: 2,
            audio_seconds: 60,
            active_audio_seconds: 40,
            bound_receivers: 2,
            bound_named_receivers: 2,
            total_receivers: 2,
            dom_or_signaled_participants: 2,
            named_participants: 2,
            dom_participants: 2,
            data_channel_count: 1,
            sdp_descriptions: 2,
            last_heartbeat_at: '2026-11-15T10:02:05Z',
            last_audio_activity: '2026-11-15T10:02:00Z',
          },
        }),
      );
      return;
    }
    if (u.pathname === `/v1/recordings/${recordingId}/transcript`) {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(
        JSON.stringify({
          recording_id: recordingId,
          provider: 'google_meet',
          title: 'Architektur-Runde Q4',
          guest_name: 'wortlaut',
          language: recordingLanguage,
          detected_languages: ['German', 'Japanese'],
          participation: 'capturing',
          participation_reason: null,
          processing: 'processing',
          processing_error: null,
          scheduled_period: {start: '2026-11-15T10:00:00Z', end: '2026-11-15T10:30:00Z'},
          time_origin_utc: '2026-11-15T10:00:00Z',
          last_known_audio_utc: '2026-11-15T10:02:00Z',
          audio_available: false,
          summary: null,
          notes: '',
          quality: {
            no_audio_received: false,
            has_audio_gaps: false,
            audio_clock_interrupted: false,
            capture_end_unknown: false,
            attribution_unknown: false,
            source_coverage: 'bound',
            incomplete_drain: false,
            unprocessed_audio: false,
            failed_asr_ranges: [],
          },
          sources_summary: [
            {
              provider_source_id: `google_meet:${recordingId}:receiver:1`,
              csi: 101,
              signaled_participant_id: 'alice-1',
              participant_name: 'Elena Rostova',
              speaker_label: 'Elena Rostova',
              accepted_seconds: 20,
              speech_seconds: 18,
              segment_count: 1,
              sample_text: 'Willkommen zur Architektur-Runde.',
            },
            {
              provider_source_id: `google_meet:${recordingId}:receiver:2`,
              csi: 102,
              signaled_participant_id: 'bob-2',
              participant_name: 'Marcus Chen',
              speaker_label: 'Marcus Chen',
              accepted_seconds: 20,
              speech_seconds: 16,
              segment_count: 1,
              sample_text: 'Nach der Pause machen wir weiter.',
            },
          ],
          segments: [
            {
              segment_id: 'seg-1',
              stream_id: 's1',
              epoch: 'e1',
              provider_source_id: `google_meet:${recordingId}:receiver:1`,
              participant_id: 'alice-1',
              participant_name: 'Elena Rostova',
              speaker_id: 'alice-1',
              speaker_name: 'Elena Rostova',
              speaker_label: 'Elena Rostova',
              attribution_status: 'bound',
              start: 10,
              end: 16,
              start_sample: 160000,
              end_sample: 256000,
              text: 'Willkommen zur Architektur-Runde.',
            },
            {
              segment_id: 'seg-2',
              stream_id: 's2',
              epoch: 'e1',
              provider_source_id: `google_meet:${recordingId}:receiver:2`,
              participant_id: 'bob-2',
              participant_name: 'Marcus Chen',
              speaker_id: 'bob-2',
              speaker_name: 'Marcus Chen',
              speaker_label: 'Marcus Chen',
              attribution_status: 'bound',
              start: 80,
              end: 86,
              start_sample: 1280000,
              end_sample: 1376000,
              text: 'Nach der Pause machen wir weiter.',
            },
          ],
          keyframes: [],
          pause_windows: [
            {
              started_at: '2026-11-15T10:00:35Z',
              ended_at: '2026-11-15T10:01:15Z',
              offset_seconds: 35,
              end_offset_seconds: 75,
              by: 'Elena Rostova',
            },
          ],
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as {port: number}).port}`;

  const browser = await chromium.launch({headless: true, chromiumSandbox: true});
  try {
    const context = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/ui#token=wortlaut-read-${recordingId}.readerfixturetoken`);

    // 1. Live Off-the-Record paused banner renders in DE
    const liveBanner = page.locator('#live-status-banner');
    await liveBanner.waitFor({state: 'visible', timeout: 10000});
    const bannerTextDe = await liveBanner.innerText();
    assert.ok(
      bannerTextDe.includes('Off the Record — Aufnahme im Konferenz-Chat pausiert'),
      `Expected paused banner in DE, got: ${bannerTextDe}`,
    );
    assert.ok(bannerTextDe.includes('#resume'));

    // 2. Verify inline chronological order in #transcript-view:
    //    seg-1 (10s) -> pause-0 (35s) -> seg-2 (80s)
    const txView = page.locator('#transcript-view');
    await txView.waitFor({state: 'visible', timeout: 10000});
    const txText = await txView.innerText();
    assert.ok(txText.includes('Off-the-Record-Pause'));

    const idxSeg1 = txText.indexOf('Willkommen zur Architektur-Runde.');
    const idxPause = txText.indexOf('Off-the-Record-Pause');
    const idxSeg2 = txText.indexOf('Nach der Pause machen wir weiter.');
    assert.ok(
      idxSeg1 >= 0 && idxSeg1 < idxPause && idxPause < idxSeg2,
      `Expected chronological ordering seg1 < pause < seg2, indices: ${[idxSeg1, idxPause, idxSeg2].join(', ')}`,
    );

    // 3. Verify live Markdown copy includes Off-the-Record-Pause
    await page.getByRole('button', {name: 'Markdown kopieren'}).click();
    await page.getByRole('button', {name: 'Markdown kopiert!'}).waitFor({timeout: 3000});
    const copiedMd = await page.evaluate(() => navigator.clipboard.readText());
    assert.ok(copiedMd.includes('Off-the-Record-Pause (Elena Rostova):'));

    // 4. Verify search filtering + <mark class="wl-search-hit"> highlighting on transcript turns
    const searchInput = page.locator('input[type="search"], input[placeholder*="suchen"], input[placeholder*="Search"]').first();
    await searchInput.fill('Architektur-Runde');
    assert.equal(await page.locator('#seg-seg-1 mark.wl-search-hit').innerText(), 'Architektur-Runde');
    assert.equal(await page.locator('#seg-seg-2').count(), 0);
    await searchInput.fill('');

    // 5. Switch livePaused -> false and verify next poll transitions banner to active voice recording!
    livePaused = false;
    await page.waitForFunction(
      () => {
        const el = document.getElementById('live-status-banner');
        return Boolean(
          el &&
            el.innerText.includes('Ton wird aufgezeichnet') &&
            el.innerText.includes('Elena Rostova'),
        );
      },
      undefined,
      {timeout: 8000},
    );

    // 6. Operator mode: verify ASR language switcher displays all 30 Qwen3-ASR languages + detected languages
    //    and PATCHes /v1/recordings/{id} live when switched to Japanese!
    const opPage = await context.newPage();
    await opPage.goto(`${baseUrl}/ui#token=operator-secret-token`);
    await opPage.getByRole('button', {name: 'Architektur-Runde Q4'}).click();
    const langWrap = opPage.locator('#recording-asr-language-switcher');
    await langWrap.waitFor({state: 'visible', timeout: 10000});
    await opPage.getByText('Erkannt: Deutsch, Japanisch').waitFor({state: 'visible', timeout: 10000});
    await langWrap.getByRole('combobox').click();
    await opPage.getByRole('option', {name: /Japanisch \(日本語\)/}).click();
    await opPage.waitForFunction(() => document.getElementById('recording-asr-language-switcher')?.innerText.includes('Japanisch'));
    assert.deepEqual(languagePatches, ['Japanese']);
    await opPage.close();

    await context.close();
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Web-UI automatically refetches settled transcript summary and 1-click Google Calendar reconnect banner when detailQuery finishes after transcriptQuery', async () => {
  const workerRoot = fileURLToPath(new URL('..', import.meta.url));
  const uiDistDir = join(workerRoot, 'dist', 'ui');
  if (!existsSync(join(uiDistDir, 'app.js'))) {
    await build({
      root: workerRoot,
      configFile: fileURLToPath(new URL('../vite.ui.config.ts', import.meta.url)),
      logLevel: 'silent',
    });
  }

  const recordingId = randomUUID();
  let backendCompleted = false;

  const bootPayload = {
    failureReasons: {},
    instance: {
      assistantName: 'wortlaut',
      defaultLocale: 'de',
      botEmail: null,
      providers: {
        google_meet: true,
        google_meet_auth_session: false,
        teams: true,
        webex: true,
        zoom: true,
      },
      mail: {imapEnabled: false, smtpEnabled: false, senderAuth: 'gateway', allowedDomains: []},
      limits: {maxActiveMeetings: 15, lobbyTimeoutSeconds: 600, emptyRoomTimeoutSeconds: 300},
      retention: {audioHours: 24, transcriptDays: 30},
      oidc: {enabled: false, issuer: '', clientId: 'wortlaut', allowedDomains: []},
      calendarOAuth: {
        googleEnabled: true,
        microsoftEnabled: false,
        googleClientId: 'google-client-123',
        microsoftClientId: '',
        microsoftTenantId: 'common',
      },
      privacyUrl: '/privacy',
      enable_keyframes: true,
      llmSummaryEnabled: true,
      llmModel: 'qwen3.8:latest',
    },
  };

  const uiHtml = `<!DOCTYPE html>
<html lang="de" data-theme="dark" data-astryx-theme="stone">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>wortlaut UI Completion Race Test</title>
  <link rel="stylesheet" href="/sdk/ui/app.css">
</head>
<body>
  <div id="root"></div>
  <script>window.__WORTLAUT_BOOT__ = ${JSON.stringify(bootPayload)};</script>
  <script type="module" src="/sdk/ui/app.js"></script>
</body>
</html>`;

  const server = createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (u.pathname === '/ui') {
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
      res.end(uiHtml);
      return;
    }
    if (u.pathname.startsWith('/sdk/ui/')) {
      const rel = normalize(u.pathname.slice('/sdk/ui/'.length)).replace(/^(\.\.(\/|\\|$))+/, '');
      const fullPath = join(uiDistDir, rel);
      try {
        const bytes = await readFile(fullPath);
        res.writeHead(200, {
          'Content-Type': MIME_BY_EXT[extname(fullPath)] ?? 'application/octet-stream',
        });
        res.end(bytes);
      } catch {
        res.writeHead(404);
        res.end();
      }
      return;
    }
    if (u.pathname === '/health/ready') {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({status: 'ready'}));
      return;
    }
    if (u.pathname === '/v1/mcp/grants') {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({endpoint: 'http://127.0.0.1/mcp', grants: []}));
      return;
    }
    if (u.pathname === '/v1/glossary') {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(
        JSON.stringify({
          entries: [],
          builtin_terms: [],
          effective_terms: [],
          effective_replacements: {},
          effective_count: 0,
          can_manage_global: true,
        }),
      );
      return;
    }
    if (u.pathname === '/v1/calendar') {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(
        JSON.stringify({
          events: [],
          connections: [
            {
              id: randomUUID(),
              provider: 'google',
              account_email: 'alex@example.org',
              owner_email: 'alex@example.org',
              last_synced_at: '2026-11-18T13:45:00Z',
              sync_error: null,
              created_at: '2026-11-09T14:53:33Z',
            },
          ],
          synced_events: [],
        }),
      );
      return;
    }
    if (u.pathname === '/v1/recordings' && req.method === 'GET') {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(
        JSON.stringify({
          items: [
            {
              id: recordingId,
              provider: 'google_meet',
              title: 'Gruppe-DEV Zweekly',
              guest_name: 'wortlaut',
              language: 'de',
              owner_email: 'alex@example.org',
              starts_at: '2026-11-18T13:00:00Z',
              ends_at: '2026-11-18T14:00:00Z',
              participation: 'ended',
              processing: backendCompleted ? 'completed' : 'processing',
              processing_error: null,
              participation_reason: 'room_empty',
              cancelled_at: null,
              audio_deleted_at: null,
              transcript_deleted_at: null,
              metadata_deleted_at: null,
              active_attempt_id: null,
              calendar_entry_id: null,
              calendar_conflict: false,
              recurrence_key: null,
            },
          ],
          next_cursor: null,
        }),
      );
      return;
    }
    if (u.pathname === `/v1/recordings/${recordingId}` && req.method === 'GET') {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(
        JSON.stringify({
          id: recordingId,
          provider: 'google_meet',
          meeting_url: 'https://meet.google.com/zweekly-room',
          title: 'Gruppe-DEV Zweekly',
          guest_name: 'wortlaut',
          language: 'de',
          owner_email: 'alex@example.org',
          starts_at: '2026-11-18T13:00:00Z',
          ends_at: '2026-11-18T14:00:00Z',
          participation: 'ended',
          processing: backendCompleted ? 'completed' : 'processing',
          processing_error: null,
          participation_reason: 'room_empty',
          cancelled_at: null,
          audio_deleted_at: null,
          transcript_deleted_at: null,
          metadata_deleted_at: null,
          active_attempt_id: null,
          calendar_entry_id: null,
          calendar_conflict: false,
          recurrence_key: null,
          attempts: [],
          audio: [],
          ingest: {durable_sample_count: 160000, finalized_gap_count: 0},
          delivery: null,
        }),
      );
      return;
    }
    if (u.pathname === `/v1/recordings/${recordingId}/transcript` && req.method === 'GET') {
      const done = backendCompleted;
      // Flip backendCompleted right AFTER the initial pre-completion transcript fetch returns!
      if (!backendCompleted) {
        backendCompleted = true;
      }
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(
        JSON.stringify({
          recording_id: recordingId,
          provider: 'google_meet',
          title: 'Gruppe-DEV Zweekly',
          language: 'de',
          participation: 'ended',
          participation_reason: 'room_empty',
          processing: done ? 'completed' : 'processing',
          processing_error: null,
          scheduled_period: {start: '2026-11-18T13:00:00Z', end: '2026-11-18T14:00:00Z'},
          time_origin_utc: '2026-11-18T13:00:00Z',
          last_known_audio_utc: '2026-11-18T13:44:45Z',
          audio_available: true,
          summary: done
            ? {
                summary: 'Automatisch erstellte Zusammenfassung des Zweekly.',
                decisions: [
                  {
                    text: 'Glossar wird instanzweit aktiviert.',
                    timestamp: '14:00:05',
                    offset_seconds: 5,
                  },
                ],
                topics: [
                  {
                    title: 'Glossar',
                    details: 'Neuer Glossar-Editor vorgestellt.',
                    timestamp: '14:00:05',
                    offset_seconds: 5,
                  },
                ],
                action_items: [],
                model: 'qwen3.8:latest',
                generated_at: '2026-11-18T13:45:19Z',
              }
            : null,
          calendar_link_synced_at: null,
          calendar_link_error: done ? 'insufficient_calendar_write_scope' : null,
          calendar_link_provider: done ? 'google' : null,
          quality: {
            no_audio_received: false,
            has_audio_gaps: false,
            audio_clock_interrupted: false,
            capture_end_unknown: false,
            attribution_unknown: false,
            source_coverage: 'verified',
            incomplete_drain: false,
            unprocessed_audio: false,
            failed_asr_ranges: [],
          },
          sources_summary: [],
          segments: [
            {
              id: 'seg-1',
              stream_id: randomUUID(),
              start: 5,
              end: 9,
              text: 'Kurzes Update zum Glossar-Editor.',
              speaker_label: 'Alex Weber',
              participant_name: 'Alex Weber',
              attribution_unknown: false,
            },
          ],
          keyframes: [],
          pause_windows: [],
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const browser = await chromium.launch({headless: true});
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseUrl}/ui#view=meetings&id=${recordingId}&token=operator-secret-token`);

    // Initial /transcript returned processing='processing' & summary=null, then flipped backendCompleted=true.
    // On the next detailQuery poll (~3s), detailQuery sees 'completed' and MUST immediately refetch /transcript!
    await page.getByText('Automatisch erstellte Zusammenfassung des Zweekly.').waitFor({
      state: 'visible',
      timeout: 8000,
    });
    await page.getByText('Entscheidungen', {exact: true}).waitFor({
      state: 'visible',
      timeout: 5000,
    });
    await page.getByText('Glossar wird instanzweit aktiviert.').waitFor({
      state: 'visible',
      timeout: 5000,
    });
    const citationChip = page.locator('.wl-citation-chip', {hasText: '14:00:05'}).first();
    await citationChip.waitFor({state: 'visible', timeout: 5000});
    await citationChip.click();
    await page.locator('#seg-seg-1.wl-turn-cited').waitFor({
      state: 'visible',
      timeout: 5000,
    });
    await page.getByRole('button', {name: 'Google Kalender neu verbinden'}).waitFor({
      state: 'visible',
      timeout: 5000,
    });

    await context.close();
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Web-UI fixes glossary tab/count mismatch (#15), merged multi-ID speaker filtering (#16), and wall-clock duration (#18)', async () => {
  const workerRoot = fileURLToPath(new URL('..', import.meta.url));
  const uiDistDir = join(workerRoot, 'dist', 'ui');
  if (!existsSync(join(uiDistDir, 'app.js'))) {
    await build({
      root: workerRoot,
      configFile: fileURLToPath(new URL('../vite.ui.config.ts', import.meta.url)),
      logLevel: 'silent',
    });
  }
  const recordingId = randomUUID();
  const bootPayload = {
    failureReasons: {},
    instance: {
      assistantName: 'wortlaut',
      defaultLocale: 'de',
      botEmail: null,
      providers: {
        google_meet: true,
        google_meet_auth_session: false,
        teams: true,
        webex: false,
        zoom: false,
      },
      mail: {imapEnabled: false, smtpEnabled: false, senderAuth: 'gateway', allowedDomains: []},
      limits: {maxActiveMeetings: 15, lobbyTimeoutSeconds: 600, emptyRoomTimeoutSeconds: 300},
      retention: {audioHours: 24, transcriptDays: 30},
      oidc: {enabled: false, issuer: '', clientId: 'wortlaut', allowedDomains: []},
      calendarOAuth: {
        googleEnabled: false,
        microsoftEnabled: false,
        googleClientId: '',
        microsoftClientId: '',
        microsoftTenantId: 'common',
      },
      privacyUrl: '/privacy',
      enable_keyframes: true,
      llmSummaryEnabled: false,
      llmModel: 'qwen3.8:latest',
    },
  };
  const uiHtml = `<!DOCTYPE html>
<html lang="de" data-theme="dark" data-astryx-theme="stone">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>wortlaut UI Issues #15 #16 #18 Test</title>
  <link rel="stylesheet" href="/sdk/ui/app.css">
</head>
<body>
  <div id="root"></div>
  <script>window.__WORTLAUT_BOOT__ = ${JSON.stringify(bootPayload)};</script>
  <script type="module" src="/sdk/ui/app.js"></script>
</body>
</html>`;

  const personalGlossaryEntries: Array<{
    term_key: string;
    term: string;
    aliases: string[];
    source: string;
    editable: boolean;
  }> = [];
  const glossaryUpsertPayloads: Array<Record<string, unknown>> = [];
  let editedSegA1Text = 'Erster Beitrag am Mikrofon.';

  const server = createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (u.pathname === '/ui') {
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
      res.end(uiHtml);
      return;
    }
    if (u.pathname.startsWith('/sdk/ui/')) {
      const rel = normalize(u.pathname.slice('/sdk/ui/'.length)).replace(/^(\.\.(\/|\\|$))+/, '');
      const fullPath = join(uiDistDir, rel);
      try {
        const bytes = await readFile(fullPath);
        res.writeHead(200, {
          'Content-Type': MIME_BY_EXT[extname(fullPath)] ?? 'application/octet-stream',
        });
        res.end(bytes);
      } catch {
        res.writeHead(404);
        res.end();
      }
      return;
    }
    if (u.pathname === '/health/ready') {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({status: 'ready'}));
      return;
    }
    if (u.pathname === '/v1/auth/me') {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(
        JSON.stringify({
          authenticated: true,
          kind: 'user',
          is_admin: false,
          sub: 'sub-user',
          email: 'clara@example.org',
          name: 'Ingrid',
          oidc_enabled: true,
          providers: {google_meet: true, teams: true, webex: false, zoom: false},
          calendar_oauth: {google: true, microsoft: false},
          assistant_name: 'wortlaut',
          default_locale: 'de',
          features: {llm_summary: false, keyframes: true, email_delivery: false, mcp_oauth: true},
          limits: {
            max_concurrent_recordings: 3,
            max_recording_minutes: 240,
            lobby_timeout_seconds: 300,
            audio_retention_hours: 24,
            transcript_retention_days: 30,
          },
        }),
      );
      return;
    }
    if (u.pathname === '/v1/mcp/grants') {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({endpoint: 'http://127.0.0.1/mcp', grants: []}));
      return;
    }
    if (u.pathname === '/v1/calendar') {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({events: [], connections: [], synced_events: []}));
      return;
    }
    if (u.pathname === '/v1/glossary' && req.method === 'GET') {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(
        JSON.stringify({
          can_edit_global: false,
          has_personal_scope: true,
          default_scope: 'personal',
          global_entries: [
            {term_key: 'wortlaut', term: 'wortlaut', aliases: [], source: 'team', editable: false},
            {term_key: 'acmepay', term: 'AcmePay', aliases: ['AcmiPay'], source: 'team', editable: false},
          ],
          personal_entries: personalGlossaryEntries,
          suppressed_env_terms: [],
          effective_count: 2 + personalGlossaryEntries.length,
        }),
      );
      return;
    }
    if (u.pathname === '/v1/glossary/entries' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}') as {term?: string; aliases?: string[]};
      glossaryUpsertPayloads.push(parsed);
      const term = String(parsed.term || '').trim();
      if (term) {
        personalGlossaryEntries.push({
          term_key: term.toLowerCase(),
          term,
          aliases: Array.isArray(parsed.aliases) ? parsed.aliases : [],
          source: 'custom',
          editable: true,
        });
      }
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(
        JSON.stringify({
          scope: 'personal',
          can_edit_global: false,
          has_personal_scope: true,
          default_scope: 'personal',
          global_entries: [
            {term_key: 'wortlaut', term: 'wortlaut', aliases: [], source: 'team', editable: false},
            {term_key: 'acmepay', term: 'AcmePay', aliases: ['AcmiPay'], source: 'team', editable: false},
          ],
          personal_entries: personalGlossaryEntries,
          suppressed_env_terms: [],
          effective_count: 2 + personalGlossaryEntries.length,
        }),
      );
      return;
    }
    if (u.pathname === `/v1/recordings/${recordingId}` && req.method === 'PATCH') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}') as {segment_edits?: Record<string, string>};
      if (parsed.segment_edits?.['seg-a1']) {
        editedSegA1Text = parsed.segment_edits['seg-a1'];
      }
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({recording_id: recordingId}));
      return;
    }
    if (u.pathname === '/v1/recordings' && req.method === 'GET') {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(
        JSON.stringify({
          items: [
            {
              id: recordingId,
              provider: 'google_meet',
              title: 'Live 3-Spur Meeting',
              guest_name: 'wortlaut',
              language: 'de',
              owner_email: 'clara@example.org',
              starts_at: '2026-11-19T09:00:00Z',
              ends_at: '2026-11-19T10:00:00Z',
              participation: 'capturing',
              processing: 'pending',
              processing_error: null,
              participation_reason: null,
              cancelled_at: null,
              audio_deleted_at: null,
              transcript_deleted_at: null,
              metadata_deleted_at: null,
              active_attempt_id: null,
              calendar_entry_id: null,
              calendar_conflict: false,
              recurrence_key: null,
              quality: {
                durable_sample_count: 3 * 57 * 60 * 16000,
                duration_seconds: 57 * 60,
                has_audio_gaps: false,
                capture_end_unknown: true,
                attribution_unknown: false,
                incomplete_drain: false,
                unprocessed_audio: false,
                failed_asr: false,
              },
            },
          ],
          next_cursor: null,
        }),
      );
      return;
    }
    if (u.pathname === `/v1/recordings/${recordingId}` && req.method === 'GET') {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(
        JSON.stringify({
          id: recordingId,
          provider: 'google_meet',
          title: 'Live 3-Spur Meeting',
          guest_name: 'wortlaut',
          language: 'de',
          owner_email: 'clara@example.org',
          starts_at: '2026-11-19T09:00:00Z',
          ends_at: '2026-11-19T10:00:00Z',
          participation: 'capturing',
          processing: 'pending',
          processing_error: null,
          participation_reason: null,
          cancelled_at: null,
          audio_deleted_at: null,
          transcript_deleted_at: null,
          metadata_deleted_at: null,
          active_attempt_id: null,
          calendar_entry_id: null,
          calendar_conflict: false,
          recurrence_key: null,
          attempts: [],
          audio: [],
          ingest: {
            durable_sample_count: 3 * 57 * 60 * 16000,
            durable_chunk_count: 2052,
            duration_seconds: 57 * 60,
            last_audio_activity: '2026-11-19T09:57:00Z',
          },
          asr: {pending: 0, failed: 0, completed: 2, pending_source_seconds: 0, oldest_pending_seconds: null},
          live_status: {
            is_active: true,
            paused: false,
            speech_active: true,
            max_audio_level: 0.12,
            active_speakers: ['Person E'],
            participation: 'capturing',
            processing: 'pending',
            active_streams: 3,
            audio_seconds: 57 * 60,
            active_audio_seconds: 1200,
            bound_receivers: 3,
            bound_named_receivers: 3,
            total_receivers: 3,
            dom_or_signaled_participants: 4,
            named_participants: 4,
            dom_participants: 4,
            data_channel_count: 1,
            sdp_descriptions: 1,
            last_heartbeat_at: '2026-11-19T09:57:00Z',
            last_audio_activity: '2026-11-19T09:57:00Z',
          },
          delivery: null,
        }),
      );
      return;
    }
    if (u.pathname === `/v1/recordings/${recordingId}/transcript` && req.method === 'GET') {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(
        JSON.stringify({
          recording_id: recordingId,
          provider: 'google_meet',
          title: 'Live 3-Spur Meeting',
          guest_name: 'wortlaut',
          language: 'de',
          participation: 'capturing',
          participation_reason: null,
          processing: 'pending',
          processing_error: null,
          scheduled_period: {start: '2026-11-19T09:00:00Z', end: '2026-11-19T10:00:00Z'},
          time_origin_utc: '2026-11-19T09:00:00Z',
          last_known_audio_utc: '2026-11-19T09:57:00Z',
          audio_available: true,
          summary: null,
          notes: '',
          quality: {
            no_audio_received: false,
            has_audio_gaps: false,
            audio_clock_interrupted: false,
            capture_end_unknown: true,
            attribution_unknown: false,
            source_coverage: 'unknown',
            incomplete_drain: false,
            unprocessed_audio: false,
            failed_asr_ranges: [],
          },
          sources_summary: [
            {
              provider_source_id: `google_meet:${recordingId}:receiver:0`,
              provider_source_ids: [
                `google_meet:${recordingId}:receiver:0`,
                `google_meet:${recordingId}:receiver:2`,
              ],
              csi: 101,
              signaled_participant_id: 'devices/person-a-mic',
              signaled_participant_ids: ['devices/person-a-mic', 'devices/person-a-share'],
              participant_name: 'Person A',
              speaker_label: 'Person A',
              accepted_seconds: 120,
              speech_seconds: 60,
              segment_count: 2,
              sample_text: 'Erster Beitrag am Mikrofon.',
            },
            {
              provider_source_id: `google_meet:${recordingId}:receiver:1`,
              provider_source_ids: [`google_meet:${recordingId}:receiver:1`],
              csi: 102,
              signaled_participant_id: 'devices/person-e',
              signaled_participant_ids: ['devices/person-e'],
              participant_name: 'Person E',
              speaker_label: 'Person E',
              accepted_seconds: 0,
              speech_seconds: 0,
              segment_count: 0,
              sample_text: null,
            },
          ],
          segments: [
            {
              segment_id: 'seg-a1',
              stream_id: 'st-0',
              epoch: 'ep-0',
              provider_source_id: `google_meet:${recordingId}:receiver:0`,
              participant_id: 'devices/person-a-mic',
              participant_name: 'Person A',
              speaker_id: 'devices/person-a-mic',
              speaker_name: 'Person A',
              speaker_label: 'Person A',
              attribution_status: 'verified',
              start: 5,
              end: 35,
              start_sample: 80000,
              end_sample: 560000,
              text: editedSegA1Text,
            },
            {
              segment_id: 'seg-a2',
              stream_id: 'st-2',
              epoch: 'ep-2',
              provider_source_id: `google_meet:${recordingId}:receiver:2`,
              participant_id: 'devices/person-a-share',
              participant_name: 'Person A',
              speaker_id: 'devices/person-a-share',
              speaker_name: 'Person A',
              speaker_label: 'Person A',
              attribution_status: 'verified',
              start: 40,
              end: 70,
              start_sample: 640000,
              end_sample: 1120000,
              text: 'Zweiter Beitrag über Screenshare.',
            },
          ],
          keyframes: [],
          pause_windows: [],
          opted_out_windows: [
            {
              started_at: '2026-11-19T09:00:36Z',
              ended_at: '2026-11-19T09:00:39Z',
              offset_seconds: 36,
              end_offset_seconds: 39,
            },
          ],
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const browser = await chromium.launch({headless: true});
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    // #18: Detail header shows 57m (wall-clock), NOT 171m (3x summed sample count), and banner uses "Audiospuren zugeordnet"
    await page.goto(`${baseUrl}/ui#view=meetings&id=${recordingId}&token=user-session-token`);
    await page.getByText('· 57m').waitFor({state: 'visible', timeout: 5000});
    assert.equal(await page.getByText('171m').count(), 0);
    await page.getByText('Audiospuren zugeordnet: 3/3').waitFor({state: 'visible', timeout: 5000});
    await page.locator('[data-testid="opted-out-comment-row"]').getByText('(OPTED OUT COMMENT)').waitFor({
      state: 'visible',
      timeout: 5000,
    });

    // #16: Clicking merged multi-ID speaker chip "Person A" keeps turns from BOTH participant IDs visible
    await page.locator('.wl-speaker-chip', {hasText: 'Person A'}).click();
    await page.getByText('Erster Beitrag am Mikrofon.').waitFor({state: 'visible', timeout: 5000});
    await page.getByText('Zweiter Beitrag über Screenshare.').waitFor({state: 'visible', timeout: 5000});

    // #15: Sidebar glossary badge shows 2 with breakdown tooltip and opens directly onto populated Team Glossary
    const glossaryBadge = page.locator('span[title="0 persönlich · 2 Team"]');
    await glossaryBadge.waitFor({state: 'visible', timeout: 5000});
    await page.getByRole('button', {name: /Glossar/}).click();
    await page.getByText('AcmePay').waitFor({state: 'visible', timeout: 5000});

    // Switching to empty Personal tab explains active Team Glossary terms and links back to Team Glossary
    await page.getByText('Persönlich (0)', {exact: true}).click();
    await page
      .getByRole('heading', {name: 'Noch keine persönlichen Glossarbegriffe hinterlegt'})
      .waitFor({
        state: 'visible',
        timeout: 5000,
      });
    await page.getByRole('button', {name: 'Team-Glossar anzeigen (2)'}).click();
    await page.getByText('AcmePay').waitFor({state: 'visible', timeout: 5000});

    // Active learning: inline turn edit proposes 1-click Glossary entry and refreshes sidebar count
    await page.goto(`${baseUrl}/ui#view=meetings&id=${recordingId}&token=user-session-token`);
    await page.getByText('Erster Beitrag am Mikrofon.').waitFor({state: 'visible', timeout: 5000});
    await page.locator('#seg-seg-a1').getByRole('button', {name: 'Sprecher oder Text korrigieren'}).click();
    await page.locator('#seg-seg-a1 textarea').fill('Erster Beitrag am FireHOL.');
    await page.locator('#seg-seg-a1').getByRole('button', {name: 'Speichern'}).click();
    const learnBar = page.locator('[data-testid="glossary-learn-bar"]');
    await learnBar.waitFor({state: 'visible', timeout: 5000});
    await learnBar.getByRole('button', {name: /Mikrofon.*FireHOL/}).click();
    await page.locator('span[title="1 persönlich · 2 Team"]').waitFor({state: 'visible', timeout: 5000});
    assert.deepEqual(glossaryUpsertPayloads, [
      {scope: 'auto', term: 'FireHOL', aliases: ['Mikrofon']},
    ]);

    await context.close();
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
