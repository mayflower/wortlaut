import {audioFrame, chunkId, type Chunk} from './chunks.js';

type Pending = {id: string; frame: ArrayBuffer | string; chunk?: Chunk};
export type TransportLimits = {
  maxSamples?: number;
  maxChunks?: number;
  maxControls?: number;
};

export class AudioTransport {
  private readonly pending = new Map<string, Pending>();
  private socket?: WebSocket;
  private timer?: ReturnType<typeof setTimeout>;
  private ready = false;
  private stopped = false;
  private sent = new Set<string>();
  private controls = 0;
  private samples = 0;
  private chunks = 0;
  private readonly maxSamples: number;
  private readonly maxChunks: number;
  private readonly maxControls: number;
  constructor(private readonly url: string, private readonly credential: string,
              private readonly workerId: string, private readonly error: (reason: string) => void,
              limits?: TransportLimits) {
    this.maxSamples = limits?.maxSamples ?? 16000 * 360;
    this.maxChunks = limits?.maxChunks ?? 1024;
    this.maxControls = limits?.maxControls ?? 1024;
  }

  connect() {
    if (this.stopped) return;
    this.ready = false; clearTimeout(this.timer);
    this.socket?.close();
    const socket = this.socket = new WebSocket(this.url);
    socket.onopen = () => {
      if (this.socket !== socket || this.stopped) { socket.close(); return; }
      socket.send(JSON.stringify({type: 'auth', credential: this.credential, worker_id: this.workerId}));
    };
    socket.onmessage = ({data}) => {
      if (this.socket !== socket || this.stopped) return;
      try {
        const message = JSON.parse(data);
        if (message.type === 'ready') { this.ready = true; this.sent.clear(); this.send(); }
        if (message.type === 'ack') {
          const item = this.pending.get(message.id);
          if (item && !item.chunk) this.controls--;
          if (item?.chunk) { this.samples -= item.chunk.sample_count; this.chunks--; }
          this.pending.delete(message.id); this.sent.delete(message.id); this.send();
        }
        if (message.type === 'error') this.error(message.reason ?? 'ingest_rejected');
      } catch { this.error('invalid_server_message'); }
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.ready = false;
      if (event.code === 1008) { this.error('ingest_authentication_rejected'); return; }
      if (!this.stopped) this.timer = setTimeout(() => this.connect(), 1000);
    };
  }

  control(message: Record<string, unknown> & {id: string}) {
    if (this.stopped) return;
    if (this.pending.has(message.id)) return;
    const frame = JSON.stringify(message);
    if (this.controls >= this.maxControls || frame.length > 8192) { this.error('control_buffer_limit'); return; }
    this.controls++;
    this.pending.set(message.id, {id: message.id, frame});
    this.send();
  }

  chunk(chunk: Chunk, pcm: Uint8Array) {
    if (this.stopped) return;
    const id = chunkId(chunk);
    if (this.pending.has(id)) return;
    this.pending.set(id, {id, frame: audioFrame(chunk, pcm), chunk: {...chunk}});
    this.samples += chunk.sample_count;
    this.chunks++;
    // At most maxSamples (default 360 source-seconds = 11.52 MB PCM) across the worker.
    // Each discarded range is final: socket order plus the server's reconnect
    // fence settle earlier frames, and durable PCM wins over its lost ACK.
    for (const item of this.pending.values()) {
      if (this.samples <= this.maxSamples && this.chunks <= this.maxChunks) break;
      if (!item.chunk) continue;
      const dropped = item.chunk!;
      this.pending.delete(item.id); this.sent.delete(item.id);
      this.samples -= dropped.sample_count;
      this.chunks--;
      this.control({type: 'gap', id: `${item.id}/gap`, stream_id: dropped.stream_id,
        epoch: dropped.epoch, sequence: dropped.sequence, start_sample: dropped.start_sample,
        sample_count: dropped.sample_count, reason: 'worker_buffer_limit', final: true});
    }
    this.send();
  }

  private send() {
    if (!this.ready || this.socket?.readyState !== WebSocket.OPEN) return;
    for (const item of this.pending.values()) {
      if (this.sent.has(item.id)) continue;
      if (this.socket.bufferedAmount > 1024 * 1024) {
        clearTimeout(this.timer); this.timer = setTimeout(() => this.send(), 50); return;
      }
      this.socket.send(item.frame); this.sent.add(item.id);
    }
  }

  async drain(timeoutMs = 45000): Promise<boolean> {
    const deadline = performance.now() + timeoutMs;
    while (this.pending.size && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const complete = this.pending.size === 0;
    this.stopped = true; clearTimeout(this.timer); this.socket?.close();
    return complete;
  }
}
