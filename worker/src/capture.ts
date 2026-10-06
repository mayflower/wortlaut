import samplerateUrl from '@alexanderolsen/libsamplerate-js/dist/libsamplerate.worklet.js?url';
import {type Binding, type Chunk, Chunker} from './chunks';

export type CaptureSink = {
  chunk: (metadata: Chunk, pcm: Uint8Array) => void;
  begin: (metadata: Record<string, unknown>) => void;
  end: (metadata: Record<string, unknown>) => void;
  error: (reason: string) => void;
};
type Handle = {stop: () => Promise<void>};

export class AudioCapture {
  private readonly captures = new Map<MediaStreamTrack, Promise<Handle>>();
  private readonly context = new AudioContext();
  private anchor!: {monotonic_ms: number; utc: string; context_time: number};
  private modules!: Promise<void>;
  private closed = false;

  async initialize() {
    await this.context.resume();
    this.anchor = {monotonic_ms: performance.now(), utc: new Date().toISOString(),
      context_time: this.context.currentTime};
    this.modules = (async () => {
      await this.context.audioWorklet.addModule(samplerateUrl);
      await this.context.audioWorklet.addModule(`${import.meta.env.BASE_URL}pcm-worklet.js`);
    })();
    await this.modules;
  }

  async attach(track: MediaStreamTrack, meetingId: string, attemptId: string,
               binding: Binding, sink: CaptureSink): Promise<boolean> {
    if (this.closed || track.readyState === 'ended' || this.captures.has(track)) return false;
    // Reserve before awaiting initialization, so duplicate SDK events cannot attach twice.
    const pending = this.create(track, meetingId, attemptId, binding, sink);
    this.captures.set(track, pending);
    await pending;
    return true;
  }

  async detach(track: MediaStreamTrack) {
    const pending = this.captures.get(track);
    if (!pending) return;
    // Keep the reservation until flush/EOS completes. A concurrent global stop
    // must also wait for this handle before closing the shared AudioContext.
    try { await (await pending).stop(); }
    finally { if (this.captures.get(track) === pending) this.captures.delete(track); }
  }

  private async create(track: MediaStreamTrack, meetingId: string, attemptId: string,
                       binding: Binding, sink: CaptureSink): Promise<Handle> {
    await this.modules;
    const streamId = crypto.randomUUID();
    const epoch = crypto.randomUUID();
    const node = new AudioWorkletNode(this.context, 'wortlaut-pcm', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    });
    const source = this.context.createMediaStreamSource(new MediaStream([track]));
    let chunker: Chunker | undefined;
    let ended!: () => void;
    const done = new Promise<void>((resolve) => { ended = resolve; });
    let ready!: () => void;
    let failed!: (error: Error) => void;
    const initialized = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
    node.port.onmessage = ({data}) => {
      if (data.type === 'ready') { ready(); return; }
      if (data.type === 'error') {
        sink.error(data.reason); failed(new Error(data.reason)); ended(); return;
      }
      if (data.type === 'pcm') {
        if (!chunker) {
          const origin = this.anchor.monotonic_ms +
            (data.first_frame / data.input_rate - this.anchor.context_time) * 1000;
          const identity = {meeting_id: meetingId, attempt_id: attemptId, stream_id: streamId,
            epoch, sample_rate: 16000 as const, channels: 1 as const, encoding: 'pcm_s16le' as const,
            monotonic_origin_ms: origin, session_monotonic_origin_ms: this.anchor.monotonic_ms,
            session_utc_origin: this.anchor.utc};
          chunker = new Chunker(identity, binding, sink.chunk);
          sink.begin({...identity, ...binding, type: 'begin', id: `${attemptId}/${streamId}/${epoch}/begin`});
        }
        try { chunker.append(new Uint8Array(data.bytes), data.start_sample); }
        catch { sink.error('audio_discontinuity'); }
      } else if (data.type === 'stopped') {
        chunker?.flush();
        if (chunker) sink.end({type: 'end', id: `${attemptId}/${streamId}/${epoch}/end`,
          stream_id: streamId, epoch, final_sample: chunker.finalSample,
          last_sequence: chunker.lastSequence});
        ended();
      }
    };
    let stopping: Promise<void> | undefined;
    const handle = {stop: () => stopping ??= (async () => {
      track.removeEventListener('ended', onEnded);
      source.disconnect();
      node.port.postMessage({type: 'stop'});
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([done, new Promise<void>((resolve) => {
        timer = setTimeout(() => { sink.error('capture_stop_timeout'); resolve(); }, 3000);
      })]);
      clearTimeout(timer);
      node.disconnect(); node.port.close();
    })()};
    const onEnded = () => { void handle.stop(); };
    track.addEventListener('ended', onEnded, {once: true});
    const timer = setTimeout(() => {
      sink.error('capture_initialization_timeout');
      failed(new Error('Capture initialization timed out'));
    }, 5000);
    try { await initialized; }
    catch (error) {
      source.disconnect(); node.disconnect(); node.port.close();
      track.removeEventListener('ended', onEnded);
      throw error;
    } finally { clearTimeout(timer); }
    source.connect(node);
    // Output is silence. Capture input is this single track, never the common destination.
    node.connect(this.context.destination);
    return handle;
  }

  async stop() {
    this.closed = true;
    await Promise.all([...this.captures.values()].map(async (entry) => {
      try { await (await entry).stop(); } catch { /* initialization already reported */ }
    }));
    this.captures.clear();
    await this.context.close();
  }
}
