import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {test} from 'node:test';

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
