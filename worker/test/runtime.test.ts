import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {test} from 'node:test';
import {isTeamsMeeting, sanitizeTeamsDisplayName} from '../src/teams-url.js';
import {extractGlossarySuggestions} from '../src/ui/glossaryLearning.js';

test('extractGlossarySuggestions detects localized term fixes and ignores noise', () => {
  assert.deepEqual(
    extractGlossarySuggestions(
      'Wir deployen auf Kubernetis mit AcmiPay.',
      'Wir deployen auf Kubernetes mit AcmePay.',
    ),
    [
      {from: 'Kubernetis', to: 'Kubernetes'},
      {from: 'AcmiPay', to: 'AcmePay'},
    ],
  );
  assert.deepEqual(
    extractGlossarySuggestions(
      'Die Firewall ist Fire Hall im Cluster.',
      'Die Firewall ist FireHOL im Cluster.',
    ),
    [{from: 'Fire Hall', to: 'FireHOL'}],
  );
  assert.deepEqual(
    extractGlossarySuggestions('Wort laut', 'wortlaut'),
    [{from: 'Wort laut', to: 'wortlaut'}],
  );
  // Punctuation-only changes produce no suggestion
  assert.deepEqual(
    extractGlossarySuggestions('Das ist gut.', 'Das ist gut!'),
    [],
  );
  // Complete unrelated sentence rewrites without shared anchors are ignored
  assert.deepEqual(
    extractGlossarySuggestions(
      'Eins zwei drei vier fuenf sechs',
      'Alpha Beta Gamma Delta Epsilon Zeta',
    ),
    [],
  );
});

test('teams URL validation and display name sanitization handle calendar invites', () => {
  assert.equal(
    isTeamsMeeting(new URL('https://teams.microsoft.com/l/meetup-join/19:meeting_abc==@thread.v2/0?context=%7b%7d')),
    true,
  );
  assert.equal(
    isTeamsMeeting(new URL('https://teams.microsoft.com/meet/3847003177954612?p=abc')),
    true,
  );
  assert.equal(
    isTeamsMeeting(new URL('https://teams.microsoft.com/evil/path')),
    false,
  );
  assert.equal(
    sanitizeTeamsDisplayName('Wortlaut.cloud (Alex Weber)'),
    'Wortlaut.cloud - Alex Weber',
  );
  assert.equal(
    sanitizeTeamsDisplayName('wortlaut (Björn Müller / R&D)'),
    'wortlaut - Björn Müller R D',
  );
  assert.equal(sanitizeTeamsDisplayName('() / :'), 'wortlaut');
});

test('claimed startup failure reports terminal status; rejected claim never bootstraps', async () => {
  for (const rejectClaim of [false, true]) {
    const requests: {path: string; body: Record<string, unknown>}[] = [];
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const part of request) body += part;
      const path = request.url!.split('/').at(-1)!;
      requests.push({path, body: body ? JSON.parse(body) : {}});
      response.writeHead(path === 'bootstrap' ? 422 : path === 'claim' && rejectClaim ? 409 : 200,
        {'Content-Type': 'application/json'});
      response.end('{}');
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const child = spawn(process.execPath, ['--import', 'tsx', 'runtime/main.ts'], {
      env: {...process.env, WORTLAUT_API_URL: `http://127.0.0.1:${(server.address() as any).port}`,
        WORTLAUT_ATTEMPT_ID: '22222222-2222-4222-8222-222222222222',
        WORTLAUT_BOOTSTRAP_CREDENTIAL: 'fixture-runtime-secret'}, stdio: 'pipe',
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    let output = '';
    child.stdout.on('data', (part) => { output += part.toString(); });
    child.stderr.on('data', (part) => { output += part.toString(); });
    try {
      const [code, signal] = await once(child, 'exit');
      assert.equal(code, 1, JSON.stringify({signal, requests: requests.map((item) => item.path)}));
      assert.equal(output, '');
      assert.deepEqual(requests.map((item) => item.path), rejectClaim ? ['claim'] : ['claim', 'bootstrap', 'status']);
      if (!rejectClaim) assert.deepEqual(requests[2].body,
        {participation: 'ended', reason: 'worker_startup_failed', drained: true});
    } finally {
      clearTimeout(timer); child.kill();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});
