/* libsamplerate is loaded in this worklet scope before this processor. */
class PcmCapture extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{name: 'capturing', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate'}];
  }

  constructor() {
    super();
    this.converter = null;
    this.inputCount = 0;
    this.outputCount = 0;
    this.firstFrame = null;
    this.missing = [];
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
    let offset = 0;
    while (offset < count) {
      while (this.missing[0]?.end <= this.outputCount) this.missing.shift();
      const gap = this.missing[0];
      const absent = gap && this.outputCount >= gap.start;
      const size = Math.min(count - offset,
        gap ? (absent ? gap.end : gap.start) - this.outputCount : count - offset);
      const metadata = {start_sample: this.outputCount,
        first_frame: this.firstFrame, input_rate: sampleRate};
      if (absent) {
        this.port.postMessage({type: 'gap', ...metadata, sample_count: size});
      } else {
        const bytes = new ArrayBuffer(size * 2);
        const view = new DataView(bytes);
        for (let i = 0; i < size; i++) {
          const value = Math.max(-1, Math.min(1, samples[offset + i]));
          view.setInt16(i * 2, Math.round(value < 0 ? value * 32768 : value * 32767), true);
        }
        this.port.postMessage({type: 'pcm', ...metadata, bytes}, [bytes]);
      }
      this.outputCount += size;
      offset += size;
    }
  }

  process(inputs, outputs, parameters) {
    if (this.stopped) return false;
    if (parameters.capturing[0] === 0) return true;
    const channels = inputs[0];
    if (!this.converter) return true;
    const length = channels?.[0]?.length;
    if (!length) {
      if (this.firstFrame === null) return true;
      const frames = outputs[0]?.[0]?.length;
      if (!frames) {
        this.port.postMessage({type: 'error', reason: 'capture_clock_unknown'});
        this.stopped = true;
        this.converter.destroy();
        this.converter = null;
        return false;
      }
      const start = Math.floor(this.inputCount * 16000 / sampleRate);
      this.inputCount += frames;
      const end = Math.floor(this.inputCount * 16000 / sampleRate);
      const previous = this.missing.at(-1);
      if (previous && previous.end === start) previous.end = end;
      else this.missing.push({start, end});
      // Advance the filter clock, but never emit the padding as received PCM.
      this.emit(this.converter.full(new Float32Array(frames)));
      return true;
    }
    if (this.firstFrame === null) this.firstFrame = currentFrame;
    const mono = new Float32Array(length);
    for (const channel of channels) {
      for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / channels.length;
    }
    this.inputCount += mono.length;
    this.emit(this.converter.full(mono));
    return true;
  }
}
registerProcessor('wortlaut-pcm', PcmCapture);
