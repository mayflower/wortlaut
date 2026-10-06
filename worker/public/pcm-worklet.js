/* libsamplerate is loaded in this worklet scope before this processor. */
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.converter = null;
    this.inputCount = 0;
    this.outputCount = 0;
    this.firstFrame = null;
    this.stopped = false;
    globalThis.LibSampleRate.create(1, sampleRate, 16000, {
      converterType: globalThis.LibSampleRate.ConverterType.SRC_SINC_FASTEST,
    }).then((converter) => {
      this.converter = converter;
      this.port.postMessage({type: 'ready'});
    }).catch(() => this.port.postMessage({type: 'error', reason: 'resampler_initialization'}));
    this.port.onmessage = ({data}) => {
      if (data.type !== 'stop' || this.stopped) return;
      this.stopped = true;
      if (this.converter && this.firstFrame !== null) {
        // full() has no end_of_input parameter. Drain filter state with zero
        // padding and keep only the duration of the actual input samples.
        this.emit(this.converter.full(new Float32Array(4096)));
      }
      this.converter?.destroy();
      this.port.postMessage({type: 'stopped', final_sample: this.outputCount});
    };
  }

  emit(samples) {
    const remaining = Math.floor(this.inputCount * 16000 / sampleRate) - this.outputCount;
    const count = Math.min(samples.length, remaining);
    if (count <= 0) return;
    const bytes = new ArrayBuffer(count * 2);
    const view = new DataView(bytes);
    for (let i = 0; i < count; i++) {
      const value = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(i * 2, Math.round(value < 0 ? value * 32768 : value * 32767), true);
    }
    this.port.postMessage({type: 'pcm', bytes, start_sample: this.outputCount,
      first_frame: this.firstFrame, input_rate: sampleRate}, [bytes]);
    this.outputCount += count;
  }

  process(inputs) {
    if (this.stopped) return false;
    const channels = inputs[0];
    if (!this.converter || !channels?.[0]?.length) return true;
    if (this.firstFrame === null) this.firstFrame = currentFrame;
    const mono = new Float32Array(channels[0].length);
    for (const channel of channels) {
      for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / channels.length;
    }
    this.inputCount += mono.length;
    this.emit(this.converter.full(mono));
    return true;
  }
}
registerProcessor('wortlaut-pcm', PcmCapture);
