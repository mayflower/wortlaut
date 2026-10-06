import {audioFrame, chunkId, type Chunk} from './chunks';

type Pending = {id: string; frame: ArrayBuffer | string; chunk?: Chunk};
export class AudioTransport {
  private readonly pending = new Map<string, Pending>();
  private socket?: WebSocket;
  private timer?: ReturnType<typeof setTimeout>;
  private ready = false;
  private stopped = false;
  private sent = new Set<string>();
  private controls = 0;
  constructor(private readonly url: string, private readonly credential: string,
              private readonly workerId: string, private readonly error: (reason: string) => void) {}

  connect() {
    if (this.stopped) return;
    const socket = this.socket = new WebSocket(this.url);
    socket.onopen = () => socket.send(JSON.stringify({type: 'auth', credential: this.credential,
      worker_id: this.workerId}));
    socket.onmessage = ({data}) => {
      try {
        const message = JSON.parse(data);
        if (message.type === 'ready') { this.ready = true; this.sent.clear(); this.send(); }
        if (message.type === 'ack') {
          const item = this.pending.get(message.id);
          if (item && !item.chunk) this.controls--;
          this.pending.delete(message.id); this.sent.delete(message.id); this.send();
        }
        if (message.type === 'error') this.error(message.reason ?? 'ingest_rejected');
      } catch { this.error('invalid_server_message'); }
    };
    socket.onclose = (event) => {
      this.ready = false;
      if (event.code === 1008) { this.error('ingest_authentication_rejected'); return; }
      if (!this.stopped) this.timer = setTimeout(() => this.connect(), 1000);
    };
  }

  control(message: Record<string, unknown> & {id: string}) {
    if (this.pending.has(message.id)) return;
    if (++this.controls > 256) { this.error('control_buffer_limit'); return; }
    this.pending.set(message.id, {id: message.id, frame: JSON.stringify(message)});
    this.send();
  }

  chunk(chunk: Chunk, pcm: Uint8Array) {
    const id = chunkId(chunk);
    if (this.pending.has(id)) return;
    this.pending.set(id, {id, frame: audioFrame(chunk, pcm), chunk: {...chunk}});
    // At most 120s of unacknowledged PCM per stream. Lost ACKs are reconciled
    // against durable chunks by the server before turning these into actual gaps.
    const streamItems = [...this.pending.values()].filter((item) => item.chunk &&
      item.chunk.stream_id === chunk.stream_id && item.chunk.epoch === chunk.epoch);
    let samples = streamItems.reduce((sum, item) => sum + item.chunk!.sample_count, 0);
    for (const item of streamItems) {
      if (samples <= 16000 * 120) break;
      const dropped = item.chunk!;
      this.pending.delete(item.id); this.sent.delete(item.id);
      samples -= dropped.sample_count;
      this.control({type: 'gap', id: `${item.id}/gap`, stream_id: dropped.stream_id,
        epoch: dropped.epoch, sequence: dropped.sequence, start_sample: dropped.start_sample,
        sample_count: dropped.sample_count, reason: 'worker_buffer_limit'});
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

  async drain(timeoutMs = 15000): Promise<boolean> {
    const deadline = performance.now() + timeoutMs;
    while (this.pending.size && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const complete = this.pending.size === 0;
    this.stopped = true; clearTimeout(this.timer); this.socket?.close();
    return complete;
  }
}
