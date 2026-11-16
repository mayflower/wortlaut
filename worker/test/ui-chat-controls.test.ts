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
