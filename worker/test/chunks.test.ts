import assert from 'node:assert/strict';
import {test} from 'node:test';
import {audioFrame, type Chunk, Chunker} from '../src/chunks';

const identity = {meeting_id: 'meeting', attempt_id: 'attempt', stream_id: 'stream', epoch: 'epoch',
  sample_rate: 16000 as const, channels: 1 as const, encoding: 'pcm_s16le' as const,
  monotonic_origin_ms: 1200, session_monotonic_origin_ms: 1000, session_utc_origin: '2026-10-06T00:00:00Z'};
const binding = {provider_source_id: 'source-A', speaker_id: 'speaker-A',
  source_kind: 'speaker' as const, attribution_unknown: false};

test('five-second PCM chunk and last short sentence preserve bytes and boundaries', () => {
  const output: {metadata: Chunk; pcm: Uint8Array}[] = [];
  const chunker = new Chunker(identity, binding, (metadata, pcm) => output.push({metadata, pcm}));
  const pcm = Uint8Array.from({length: 16000 * 6 * 2}, (_, i) => i % 251);
  chunker.append(pcm.subarray(0, 2468), 0);
  chunker.append(pcm.subarray(2468), 1234);
  chunker.flush();
  assert.equal(output.length, 2);
  assert.deepEqual(output.map(({metadata}) => [metadata.sequence, metadata.start_sample, metadata.sample_count]),
    [[0, 0, 80000], [1, 80000, 16000]]);
  assert.deepEqual(Buffer.concat(output.map(({pcm}) => Buffer.from(pcm))), Buffer.from(pcm));
  assert.equal(chunker.finalSample, 96000);
});

test('exact binding switch closes old chunk and cannot rename old samples', () => {
  const output: Chunk[] = [];
  const chunker = new Chunker(identity, binding, (metadata) => output.push(metadata));
  chunker.append(new Uint8Array(400), 0);
  assert.throws(() => chunker.bindAtSample({...binding, speaker_id: 'speaker-B'}, 201));
  chunker.bindAtSample({...binding, provider_source_id: 'source-B', speaker_id: 'speaker-B'}, 200);
  chunker.append(new Uint8Array(200), 200); chunker.flush();
  assert.deepEqual(output.map((chunk) => [chunk.speaker_id, chunk.start_sample, chunk.sample_count]),
    [['speaker-A', 0, 200], ['speaker-B', 200, 100]]);
  assert.equal(output[0].provider_source_id, 'source-A');
});

test('non-contiguous or odd PCM is rejected; binary frame retains immutable metadata', () => {
  let emitted: Chunk | undefined;
  const chunker = new Chunker(identity, binding, (metadata) => { emitted = metadata; });
  assert.throws(() => chunker.append(new Uint8Array(3), 0));
  assert.throws(() => chunker.append(new Uint8Array(2), 1));
  chunker.append(new Uint8Array([1, 2]), 0); chunker.flush();
  const frame = audioFrame(emitted!, new Uint8Array([1, 2]));
  const length = new DataView(frame).getUint32(0, false);
  const metadata = JSON.parse(new TextDecoder().decode(new Uint8Array(frame, 4, length)));
  assert.deepEqual(metadata, emitted);
  assert.deepEqual([...new Uint8Array(frame, 4 + length)], [1, 2]);
});

test('capture gaps flush real PCM and preserve the following sample time and sequence', () => {
  const output: {metadata: Chunk; pcm: Uint8Array}[] = [];
  const chunker = new Chunker(identity, binding, (metadata, pcm) => output.push({metadata, pcm}));
  chunker.append(new Uint8Array([1, 2, 3, 4]), 0);
  assert.throws(() => chunker.gap(1, 16000));
  assert.throws(() => chunker.gap(2, 80001));
  assert.deepEqual(chunker.gap(2, 16000), {sequence: 1, start_sample: 2, sample_count: 16000});
  chunker.append(new Uint8Array([5, 6, 7, 8]), 16002);
  chunker.flush();
  assert.deepEqual(output.map(({metadata, pcm}) => [metadata.sequence, metadata.start_sample, [...pcm]]),
    [[0, 0, [1, 2, 3, 4]], [2, 16002, [5, 6, 7, 8]]]);
  assert.equal(chunker.finalSample, 16004);
  assert.equal(chunker.lastSequence, 2);
});
