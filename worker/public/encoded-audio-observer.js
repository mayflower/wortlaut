// Observe native receive frames; never modify, clone, reorder or decode them.
// Snapshots are pulled by the page so a busy main thread cannot accumulate
// one message per media frame. Only active transforms retain a last frame.
const sources = new Map();
self.onrtctransform = ({transformer}) => {
  const id = transformer.options.id;
  const state = {state: 'waiting_frames', frame_count: 0, last_frame: null};
  sources.set(id, state);
  transformer.readable.pipeThrough(new TransformStream({transform(frame, controller) {
    state.frame_count++;
    try {
      const metadata = frame.getMetadata();
      state.last_frame = {
        timestamp: frame.timestamp,
        rtp_timestamp: metadata.rtpTimestamp ?? null,
        synchronization_source: metadata.synchronizationSource ?? null,
        contributing_sources: (metadata.contributingSources ?? []).slice(0, 64),
        payload_type: metadata.payloadType ?? null,
        receive_time: metadata.receiveTime ?? null,
        capture_time: metadata.captureTime ?? null,
        mime_type: metadata.mimeType ?? null,
      };
      state.state = 'observing';
    } catch {
      state.state = 'metadata_unavailable';
    }
    controller.enqueue(frame);
  }})).pipeTo(transformer.writable)
    .catch(() => self.postMessage({type: 'failed', id}))
    .finally(() => sources.delete(id));
};
self.onmessage = ({data}) => {
  if (data.type === 'forget') sources.delete(data.id);
  if (data.type === 'snapshot') self.postMessage({type: 'snapshot', id: data.id,
    evidence: sources.get(data.id) ?? {state: 'waiting_frames', frame_count: 0, last_frame: null}});
};
self.postMessage({type: 'ready'});
