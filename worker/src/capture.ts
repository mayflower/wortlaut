import {type Binding, type Chunk, Chunker} from './chunks.js';

export type CaptureSink = {
  chunk: (metadata: Chunk, pcm: Uint8Array) => void;
  begin: (metadata: Record<string, unknown>) => void;
  bind?: (metadata: Record<string, unknown>) => void;
  end: (metadata: Record<string, unknown>) => void;
  gap: (metadata: Record<string, unknown>) => void;
  error: (reason: string) => void;
};
type Handle = {stop: () => Promise<void>; suspend: () => void;
  rebind: (binding: Binding) => void;
  restart: () => Promise<Handle>; error: (reason: string) => void};
export type AudioClock = {state: string; total_interruptions: number;
  interruptions: {reason: 'suspended' | 'interrupted'; observed_start_utc: string;
    observed_end_utc: string | null}[]};

export class AudioCapture {
  private readonly captures = new Map<MediaStreamTrack, Promise<Handle>>();
  private readonly context = new AudioContext();
  private anchor!: {monotonic_ms: number; utc: string; context_time: number};
  private clockAnchor!: {monotonic_ms: number; context_time: number};
  private readonly interruptions: AudioClock['interruptions'] = [];
  private totalInterruptions = 0;
  private paused?: {interval?: AudioClock['interruptions'][number]};
  private resumeTimer?: ReturnType<typeof setTimeout>;
  private modules!: Promise<void>;
  private closed = false;

  constructor(private readonly worklets: {resampler: string; pcm: string}) {}

  async initialize() {
    await this.context.resume();
    this.anchor = {monotonic_ms: performance.now(), utc: new Date().toISOString(),
      context_time: this.context.currentTime};
    this.clockAnchor = {...this.anchor};
    this.context.addEventListener('statechange', this.onClockState);
    this.modules = (async () => {
      await this.context.audioWorklet.addModule(this.worklets.resampler);
      await this.context.audioWorklet.addModule(this.worklets.pcm);
    })();
    await this.modules;
  }

  inspectClock(): AudioClock {
    return {state: this.context.state, total_interruptions: this.totalInterruptions,
      interruptions: this.interruptions.map((interval) => ({...interval}))};
  }

  private observedUtc() {
    return new Date(Date.parse(this.anchor.utc) + performance.now() - this.anchor.monotonic_ms).toISOString();
  }

  private readonly onClockState = () => {
    if (this.closed || this.context.state === 'closed') return;
    if (this.context.state !== 'running') {
      if (this.paused) return;
      const interval: AudioClock['interruptions'][number] | undefined = this.captures.size ? {
        reason: this.context.state === 'suspended' ? 'suspended' : 'interrupted',
        observed_start_utc: this.observedUtc(), observed_end_utc: null,
      } : undefined;
      this.paused = {interval};
      if (interval) {
        this.totalInterruptions++;
        this.interruptions.push(interval);
        if (this.interruptions.length > 64) this.interruptions.shift();
      }
      const suspending = Promise.all([...this.captures.values()].map((pending) =>
        pending.then((handle) => handle.suspend())));
      this.resumeTimer = setTimeout(() => {
        for (const pending of this.captures.values()) {
          void pending.then((handle) => handle.error('audio_context_resume_timeout')).catch(() => {});
        }
      }, 5000);
      // Disable old processors before requesting resume; otherwise a fast
      // resume can accept new frames on the pre-interruption sample clock.
      void suspending.then(() => {
        if (!this.closed && this.paused) return this.context.resume();
      }).catch(() => {
        for (const pending of this.captures.values()) {
          void pending.then((handle) => handle.error('audio_context_resume_failed')).catch(() => {});
        }
      });
      return;
    }
    if (!this.paused) return;
    if (this.paused.interval) this.paused.interval.observed_end_utc = this.observedUtc();
    this.paused = undefined;
    clearTimeout(this.resumeTimer);
    // currentTime did not advance while suspended. Keep the meeting's original
    // UTC anchor, but rebase the rendering clock and start fresh source epochs.
    this.clockAnchor = {monotonic_ms: performance.now(), context_time: this.context.currentTime};
    for (const [track, pending] of this.captures) {
      const replacement = pending.then(async (handle) => {
        await handle.stop();
        if (this.closed || track.readyState === 'ended') return handle;
        return handle.restart();
      });
      this.captures.set(track, replacement);
      void replacement.catch(() => {}); // Initialization already reports its reason.
    }
  };

  async attach(track: MediaStreamTrack, meetingId: string, attemptId: string,
               binding: Binding, sink: CaptureSink): Promise<boolean> {
    if (this.closed || track.readyState === 'ended' || this.captures.has(track)) return false;
    // Reserve before awaiting initialization, so duplicate SDK events cannot attach twice.
    const pending = this.create(track, meetingId, attemptId, binding, sink);
    this.captures.set(track, pending);
    await pending;
    return true;
  }

  async rebind(track: MediaStreamTrack, binding: Binding): Promise<boolean> {
    const pending = this.captures.get(track);
    if (!pending || this.closed || track.readyState === 'ended') return false;
    (await pending).rebind(binding);
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
    const clockAnchor = {...this.clockAnchor};
    let chunker: Chunker | undefined;
    let currentBinding: Binding = {...binding};
    let pendingBinding: Binding | undefined;
    let lastBoundSample = 0;
    let gapStart = 0, gapEnd = 0;
    const flushGap = () => {
      if (gapEnd === gapStart || !chunker) return;
      const range = chunker.gap(gapStart, gapEnd - gapStart);
      sink.gap({type: 'gap', id: `${attemptId}/${streamId}/${epoch}/${range.sequence}/gap`,
        stream_id: streamId, epoch, ...range, reason: 'capture_input_missing', final: true});
      gapStart = gapEnd;
    };
    const applyPendingBind = () => {
      if (!pendingBinding || !chunker || stopping) return;
      flushGap();
      chunker.flush();
      const sample = chunker.finalSample;
      if (sample <= lastBoundSample) return;
      currentBinding = {...pendingBinding};
      pendingBinding = undefined;
      lastBoundSample = sample;
      chunker.bindAtSample(currentBinding, sample);
      sink.bind?.({type: 'bind', id: `${attemptId}/${streamId}/${epoch}/${sample}/bind`,
        stream_id: streamId, epoch, start_sample: sample, ...currentBinding});
    };
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
      if (data.type === 'pcm' || data.type === 'gap') {
        if (!chunker) {
          const origin = clockAnchor.monotonic_ms +
            (data.first_frame / data.input_rate - clockAnchor.context_time) * 1000;
          const identity = {meeting_id: meetingId, attempt_id: attemptId, stream_id: streamId,
            epoch, sample_rate: 16000 as const, channels: 1 as const, encoding: 'pcm_s16le' as const,
            monotonic_origin_ms: origin, session_monotonic_origin_ms: this.anchor.monotonic_ms,
            session_utc_origin: this.anchor.utc};
          chunker = new Chunker(identity, currentBinding, sink.chunk);
          sink.begin({...identity, ...currentBinding, type: 'begin', id: `${attemptId}/${streamId}/${epoch}/begin`});
        }
        try {
          if (data.type === 'gap') {
            if (gapStart === gapEnd) gapStart = gapEnd = chunker.finalSample;
            if (data.start_sample !== gapEnd) throw new Error('Non-contiguous gap');
            gapEnd += data.sample_count;
            if (gapEnd - gapStart >= 16000 * 5) {
              const rest = gapEnd - (gapStart + 16000 * 5);
              gapEnd -= rest; flushGap(); gapEnd += rest;
            }
          } else {
            flushGap(); chunker.append(new Uint8Array(data.bytes), data.start_sample);
            if (pendingBinding) applyPendingBind();
          }
        }
        catch { sink.error('audio_discontinuity'); }
      } else if (data.type === 'stopped') {
        flushGap();
        chunker?.flush();
        if (chunker) sink.end({type: 'end', id: `${attemptId}/${streamId}/${epoch}/end`,
          stream_id: streamId, epoch, final_sample: chunker.finalSample,
          last_sequence: chunker.lastSequence});
        ended();
      }
    };
    let stopping: Promise<void> | undefined;
    const handle: Handle = {error: sink.error,
      rebind: (next: Binding) => {
        const active = pendingBinding ?? currentBinding;
        if (active.provider_source_id === next.provider_source_id &&
            active.speaker_id === next.speaker_id &&
            active.source_kind === next.source_kind &&
            active.attribution_unknown === next.attribution_unknown &&
            active.participant_id === next.participant_id &&
            active.participant_name === next.participant_name) return;
        if (!chunker) { currentBinding = {...next}; pendingBinding = undefined; return; }
        pendingBinding = {...next};
        applyPendingBind();
      },
      restart: () => this.create(track, meetingId, attemptId, pendingBinding ?? currentBinding, sink),
      suspend: () => {
        node.parameters.get('capturing')!.setValueAtTime(0, this.context.currentTime);
        node.port.postMessage({type: 'stop'});
      },
      stop: () => stopping ??= (async () => {
      track.removeEventListener('ended', onEnded);
      node.port.postMessage({type: 'stop'});
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([done, new Promise<void>((resolve) => {
        timer = setTimeout(() => { sink.error('capture_stop_timeout'); resolve(); }, 3000);
      })]);
      clearTimeout(timer);
      source.disconnect(); node.disconnect(); node.port.close();
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
    clearTimeout(this.resumeTimer);
    this.context.removeEventListener('statechange', this.onClockState);
    // Let already requested worklet flushes run even when stop follows a pause.
    void this.context.resume().catch(() => {});
    await Promise.all([...this.captures.values()].map(async (entry) => {
      try { await (await entry).stop(); } catch { /* initialization already reported */ }
    }));
    this.captures.clear();
    await this.context.close();
  }
}
