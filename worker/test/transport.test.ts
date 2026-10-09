import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {once} from 'node:events';
import {AudioTransport} from '../src/transport';
import {chunkId, type Chunk} from '../src/chunks';

const {WebSocketServer} = createRequire(import.meta.url)('ws');
const base: Chunk = {meeting_id: 'meeting', attempt_id: 'attempt', stream_id: 'stream', epoch: 'epoch',
  provider_source_id: 'source', source_kind: 'speaker', speaker_id: null, attribution_unknown: true,
  sequence: 0, start_sample: 0, sample_count: 80000, sample_rate: 16000, channels: 1,
  encoding: 'pcm_s16le', monotonic_origin_ms: 0, session_monotonic_origin_ms: 0,
  session_utc_origin: '2026-10-07T00:00:00Z'};

test('aggregate overflow across closed epochs retains bytes and sends exact gap boundaries', async () => {
  const server = createServer(), ws = new WebSocketServer({server});
  const received: {metadata: any; pcm?: Buffer}[] = [], errors: string[] = [];
  ws.on('connection', (socket: any) => socket.on('message', (data: Buffer, binary: boolean) => {
    const metadata = binary ? JSON.parse(data.subarray(4, 4 + data.readUInt32BE(0)).toString()) : JSON.parse(data.toString());
    if (metadata.type === 'auth') { socket.send(JSON.stringify({type: 'ready'})); return; }
    received.push({metadata, ...(binary ? {pcm: data.subarray(4 + data.readUInt32BE(0))} : {})});
    socket.send(JSON.stringify({type: 'ack', id: metadata.id ?? chunkId(metadata)}));
  }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const transport = new AudioTransport(`ws://127.0.0.1:${(server.address() as any).port}`, 'credential', 'worker',
    (reason) => errors.push(reason));
  const pcm = Uint8Array.from({length: 160000}, (_, i) => i % 251);
  try {
    for (let i = 0; i < 30; i++) {
      const metadata = {...base, stream_id: `stream-${i}`, epoch: `epoch-${i}`};
      transport.control({...metadata, type: 'begin', id: `${chunkId(metadata)}/begin`});
      transport.chunk(metadata, pcm);
      transport.control({type: 'end', id: `${chunkId(metadata)}/end`, stream_id: metadata.stream_id,
        epoch: metadata.epoch, final_sample: 80000, last_sequence: 0});
    }
    transport.connect();
    assert.equal(await transport.drain(3000), true, JSON.stringify({
      received_frames: received.length, received_chunks: received.filter((item) => item.pcm).length,
      errors,
    }));
    const audio = received.filter((item) => item.pcm);
    assert.equal(audio.length, 24);
    assert.equal(audio.reduce((sum, item) => sum + item.pcm!.length, 0), 3840000);
    for (const item of audio) assert.deepEqual(item.pcm, Buffer.from(pcm));
    const gaps = received.filter((item) => item.metadata.type === 'gap').map((item) => item.metadata);
    assert.deepEqual(gaps.map((gap) => [gap.stream_id, gap.start_sample, gap.sample_count]),
      Array.from({length: 6}, (_, i) => [`stream-${i}`, 0, 80000]));
    assert.ok(gaps.every((gap) => gap.final === true));
    assert.deepEqual(errors, []);
  } finally {
    await transport.drain(0);
    for (const socket of ws.clients) socket.terminate();
    await new Promise<void>((resolve) => ws.close(() => server.close(() => resolve())));
  }
});

test('lost ACK replays identical bytes after reconnect; control limit reports failure', async () => {
  const server = createServer(), ws = new WebSocketServer({server});
  const replay: Buffer[] = []; let connections = 0;
  ws.on('connection', (socket: any) => {
    connections++;
    socket.on('message', (data: Buffer, binary: boolean) => {
      if (!binary) { socket.send(JSON.stringify({type: 'ready'})); return; }
      replay.push(Buffer.from(data));
      if (replay.length === 1) socket.close();
      else socket.send(JSON.stringify({type: 'ack', id: chunkId(base)}));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const errors: string[] = [];
  const transport = new AudioTransport(`ws://127.0.0.1:${(server.address() as any).port}`, 'credential', 'worker',
    (reason) => errors.push(reason));
  try {
    transport.chunk(base, new Uint8Array(160000)); transport.connect();
    assert.equal(await transport.drain(4000), true);
    assert.equal(connections, 2); assert.equal(replay.length, 2);
    assert.deepEqual(replay[0], replay[1]); assert.deepEqual(errors, []);
    const overflows: string[] = [];
    const overflow = new AudioTransport('ws://127.0.0.1:1', 'credential', 'worker', (reason) => overflows.push(reason));
    for (let i = 0; i < 257; i++) overflow.control({type: 'begin', id: String(i)});
    assert.deepEqual(overflows, ['control_buffer_limit']);
    assert.equal(await overflow.drain(0), false);
  } finally {
    await transport.drain(0);
    for (const socket of ws.clients) socket.terminate();
    await new Promise<void>((resolve) => ws.close(() => server.close(() => resolve())));
  }
});

test('90-second ingest outage retains bounded PCM across source changes and replays lost EOS',
  {skip: process.env.WORTLAUT_TEST_LONG_TRANSPORT !== 'true', timeout: 120000}, async () => {
  const server = createServer(), ws = new WebSocketServer({server});
  const audio = new Map<string, {metadata: Chunk; pcm: Buffer}>();
  const controls = new Map<string, any>(), deliveries = new Map<string, number>();
  const expected = new Map<string, {metadata: Chunk; pcm: Buffer}>();
  const errors: string[] = [];
  let outageAt: number | undefined, rejectedConnections = 0, eosLost = false;
  const lastEnd = 'slot-2/epoch-17/end';
  ws.on('connection', (socket: any) => {
    if (outageAt !== undefined && performance.now() - outageAt < 90000) {
      rejectedConnections++; socket.close(1011); return;
    }
    socket.on('message', (data: Buffer, binary: boolean) => {
      const length = binary ? data.readUInt32BE(0) : 0;
      const metadata = JSON.parse(binary ? data.subarray(4, 4 + length).toString() : data.toString());
      if (metadata.type === 'auth') { socket.send(JSON.stringify({type: 'ready'})); return; }
      const id = binary ? chunkId(metadata) : metadata.id;
      deliveries.set(id, (deliveries.get(id) ?? 0) + 1);
      if (binary) {
        const pcm = Buffer.from(data.subarray(4 + length)), original = expected.get(id)!;
        assert.deepEqual(metadata, original.metadata);
        assert.deepEqual(pcm, original.pcm);
        if (audio.has(id)) assert.deepEqual(audio.get(id)!.pcm, pcm);
        else audio.set(id, {metadata, pcm});
      } else {
        if (controls.has(id)) assert.deepEqual(controls.get(id), metadata);
        else controls.set(id, metadata);
      }
      if (id === lastEnd && !eosLost) { eosLost = true; socket.close(1011); return; }
      socket.send(JSON.stringify({type: 'ack', id}));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const transport = new AudioTransport(`ws://127.0.0.1:${(server.address() as any).port}`,
    'credential', 'worker', (reason) => errors.push(reason));
  const emit = (epoch: number) => {
    for (let slot = 0; slot < 3; slot++) {
      const metadata = {...base, stream_id: `slot-${slot}`, epoch: `epoch-${epoch}`,
        provider_source_id: `fixture:${slot}:${epoch}`, monotonic_origin_ms: (epoch + 1) * 5000};
      const pcm = Buffer.alloc(160000, (epoch + 2) * 3 + slot);
      expected.set(chunkId(metadata), {metadata, pcm});
      transport.control({...metadata, type: 'begin', id: `${metadata.stream_id}/${metadata.epoch}/begin`});
      transport.chunk(metadata, pcm);
      transport.control({type: 'end', id: `${metadata.stream_id}/${metadata.epoch}/end`,
        stream_id: metadata.stream_id, epoch: metadata.epoch, final_sample: 80000, last_sequence: 0});
    }
  };
  try {
    emit(-1); transport.connect();
    const initialDeadline = performance.now() + 5000;
    while (controls.size < 6 && performance.now() < initialDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(audio.size, 3); assert.equal(controls.size, 6);
    const outageStartedAt = performance.now();
    outageAt = outageStartedAt;
    for (const socket of ws.clients) socket.close(1011);
    // Emit five-second replay blocks on their real clock, changing the source
    // each time. All old epochs close while their audio is still unacknowledged.
    for (let epoch = 0; epoch < 18; epoch++) {
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, outageStartedAt + epoch * 5000 - performance.now())));
      emit(epoch);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, outageStartedAt + 90000 - performance.now())));
    const outageMs = performance.now() - outageStartedAt;
    assert.equal(await transport.drain(15000), true);
    assert.ok(outageMs >= 90000); assert.ok(rejectedConnections > 1);
    assert.equal(eosLost, true); assert.equal(deliveries.get(lastEnd), 2);
    assert.deepEqual(errors, []);
    const recovered = [...audio.values()].filter(({metadata}) => metadata.epoch !== 'epoch--1');
    assert.equal(recovered.length, 24);
    assert.equal(recovered.reduce((sum, item) => sum + item.pcm.length, 0), 3840000);
    const gaps = [...controls.values()].filter((item) => item.type === 'gap');
    assert.equal(gaps.length, 30);
    for (const [id, original] of expected) {
      assert.ok(controls.has(`${original.metadata.stream_id}/${original.metadata.epoch}/begin`));
      assert.ok(controls.has(`${original.metadata.stream_id}/${original.metadata.epoch}/end`));
      if (audio.has(id)) assert.ok(!controls.has(`${id}/gap`));
      else {
        const gap = controls.get(`${id}/gap`);
        assert.ok(gap);
        assert.deepEqual([gap.start_sample, gap.sample_count, gap.sequence, gap.final], [0, 80000, 0, true]);
        assert.equal(gap.reason, 'worker_buffer_limit');
      }
    }
    for (let slot = 0; slot < 3; slot++) {
      assert.ok([...audio.values()].some(({metadata}) => metadata.stream_id === `slot-${slot}` && metadata.epoch === 'epoch-17'));
    }
    console.log(JSON.stringify({fixture: 'long_transport', outage_ms: outageMs,
      active_sources: 3, changed_epochs: 54, recovered_source_seconds: 120,
      lost_source_seconds: 150, eos_ack_replayed: true}));
  } finally {
    await transport.drain(0);
    for (const socket of ws.clients) socket.terminate();
    await new Promise<void>((resolve) => ws.close(() => server.close(() => resolve())));
  }
});
