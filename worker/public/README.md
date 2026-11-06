# public

## Overview
Browser-side WebRTC encoded audio frame observer worker and `AudioWorklet` 16 kHz mono `s16le` PCM capture processor served as static assets for the worker runtime.

## Interface
- `[encoded-audio-observer.js:onrtctransform]`: WebRTC encoded transform handler observing incoming RTP frame metadata without modifying or decoding frames.
- `[encoded-audio-observer.js:onmessage]`: Worker message handler supporting `forget` and `snapshot` commands (`{type: 'snapshot', id, evidence}`).
- `[pcm-worklet.js:PcmCapture]`: `AudioWorkletProcessor` registered as `'wortlaut-pcm'` with k-rate parameter `capturing` (`defaultValue: 1`, range `0..1`).
- `[pcm-worklet.js:PcmCapture.emit]`: Downmixes, resamples via `LibSampleRate` (`SRC_SINC_FASTEST`) to 16 kHz mono `s16le` PCM, and posts `pcm`, `gap`, `ready`, `stopped`, and `error` messages.

## Invariants
- `[encoded-audio-observer.js:onrtctransform]`: Never modifies, clones, reorders, or decodes native receive frames; retains only the last frame snapshot per active transform ID and caps `contributing_sources` at 64 entries.
- `[pcm-worklet.js:PcmCapture]`: Downmixes input channels to mono, resamples from `sampleRate` to `16000` Hz using `LibSampleRate.ConverterType.SRC_SINC_FASTEST`, clamps samples to `[-1, 1]`, and encodes little-endian `Int16` (`pcm_s16le`).
- `[pcm-worklet.js:PcmCapture.process]`: Advances filter clock with zero-padding during missing input frames without emitting padding as received PCM; emits `error` (`reason: 'capture_clock_unknown'`) and stops if output frame length is unavailable after capture has started.

## Side Effects
- `[encoded-audio-observer.js:onrtctransform]`: Pipes `transformer.readable` through `TransformStream` to `transformer.writable` and posts `ready`, `snapshot`, and `failed` messages over the Worker global scope.
- `[pcm-worklet.js:PcmCapture]`: Instantiates and destroys WASM `LibSampleRate` converter instances and transfers `ArrayBuffer` PCM payloads over `MessagePort`.

## Verification
- Run: `npm --prefix worker test`
