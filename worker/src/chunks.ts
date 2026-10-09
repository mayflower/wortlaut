export type Binding = {
  provider_source_id: string;
  speaker_id: string | null;
  source_kind: 'speaker' | 'share_audio';
  attribution_unknown: boolean;
  participant_id?: string;
};

export type Chunk = Binding & {
  meeting_id: string; attempt_id: string; stream_id: string; epoch: string;
  sequence: number; start_sample: number; sample_count: number;
  sample_rate: 16000; channels: 1; encoding: 'pcm_s16le';
  monotonic_origin_ms: number; session_monotonic_origin_ms: number; session_utc_origin: string;
};

export function chunkId(chunk: Pick<Chunk, 'attempt_id' | 'stream_id' | 'epoch' | 'sequence'>) {
  return `${chunk.attempt_id}/${chunk.stream_id}/${chunk.epoch}/${chunk.sequence}`;
}

export class Chunker {
  private bytes = new Uint8Array(16000 * 5 * 2);
  private length = 0;
  private sample = 0;
  private sequence = 0;
  private binding: Binding;
  constructor(private readonly identity: Omit<Chunk, keyof Binding | 'sequence' | 'start_sample' | 'sample_count'>,
              binding: Binding,
              private readonly emit: (metadata: Chunk, pcm: Uint8Array) => void) {
    this.binding = {...binding};
  }
  append(pcm: Uint8Array, startSample: number) {
    if (pcm.length % 2 || startSample !== this.sample + this.length / 2) {
      throw new Error('Non-contiguous PCM input');
    }
    let offset = 0;
    while (offset < pcm.length) {
      const count = Math.min(this.bytes.length - this.length, pcm.length - offset);
      this.bytes.set(pcm.subarray(offset, offset + count), this.length);
      offset += count;
      this.length += count;
      if (this.length === this.bytes.length) this.flush();
    }
  }
  // Only callers with an exact media/sample boundary may use this operation.
  bindAtSample(binding: Binding, sample: number) {
    if (sample !== this.sample + this.length / 2) throw new Error('Binding boundary is not current');
    this.flush();
    this.binding = {...binding};
  }
  gap(startSample: number, sampleCount: number) {
    if (startSample !== this.finalSample || !Number.isSafeInteger(sampleCount) ||
        sampleCount < 1 || sampleCount > 16000 * 5) throw new Error('Invalid capture gap');
    this.flush();
    const range = {sequence: this.sequence++, start_sample: this.sample, sample_count: sampleCount};
    this.sample += sampleCount;
    return range;
  }
  flush() {
    if (!this.length) return;
    const metadata: Chunk = {...this.identity, ...this.binding, sequence: this.sequence++,
      start_sample: this.sample, sample_count: this.length / 2};
    const pcm = this.bytes.slice(0, this.length);
    this.sample += metadata.sample_count;
    this.length = 0;
    this.emit(metadata, pcm);
  }
  get finalSample() { return this.sample + this.length / 2; }
  get lastSequence() { return this.sequence - 1; }
}

// One binary frame: BE metadata length, UTF-8 JSON, raw little-endian PCM.
export function audioFrame(metadata: Chunk, pcm: Uint8Array): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(metadata));
  const frame = new Uint8Array(4 + json.length + pcm.length);
  new DataView(frame.buffer).setUint32(0, json.length, false);
  frame.set(json, 4);
  frame.set(pcm, 4 + json.length);
  return frame.buffer;
}
