import {readFile} from 'node:fs/promises';
import type {Frame, Locator, Page} from 'playwright';
import type {CaptureSink} from '../src/capture.js';
import type {Chunk} from '../src/chunks.js';
import type {MeetBridgeMessage, MeetCaptureConfig} from '../src/meet-page.js';
import type {MeetInput} from './browser.js';
import {AudioTransport} from '../src/transport.js';
import {isTeamsOrigin, teamsOrigins} from '../src/teams-url.js';
import {isZoomOrigin} from '../src/zoom-url.js';
import {installVideoTile, type VideoTilePatch} from './video-tile.js';

export type MeetBootstrap = {provider: 'google_meet'; meeting_id: string; attempt_id: string;
  meeting_url: string; deadline: string; lobby_timeout_seconds: number;
  empty_room_timeout_seconds?: number; chat_intro?: string | null;
  invited_by: string | null; invited_by_name: string | null; meeting_title: string | null;
  default_locale: string;
  meet: {display_name: string; locale: string; auth_mode: 'guest' | 'account'}};

export class MeetError extends Error {
  constructor(readonly reason: string) { super(reason); }
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export async function installMeetCapture(page: Page, bootstrap: Pick<MeetBootstrap, 'meeting_id' | 'attempt_id' | 'meeting_url'>, sink: CaptureSink,
  assets = new URL('../../dist/meet/', import.meta.url), provider: 'google_meet' | 'webex' | 'teams' | 'zoom' = 'google_meet') {
  const bundle = await readFile(new URL('capture.js', assets), 'utf8');
  const active = new Set<string>();
  let captureFrame: Frame | undefined = provider !== 'webex' ? page.mainFrame() : undefined;
  await page.exposeBinding('wortlautMeetBridge', (source, raw: MeetBridgeMessage) => {
    const url = new URL(source.frame.url());
    if (source.page !== page || source.frame !== captureFrame ||
        (provider === 'webex' ? url.origin !== 'https://web.webex.com' || !/^\/(?:meeting|guest-join-meeting)$/.test(url.pathname) ||
          url.search.includes('preload=true')
          : provider === 'teams' ? !isTeamsOrigin(url)
          : provider === 'zoom' ? !isZoomOrigin(url)
          : url.origin !== 'https://meet.google.com' ||
            url.pathname.replace(/^\/meet\//, '/') !== new URL(bootstrap.meeting_url).pathname.replace(/^\/meet\//, '/')) ||
        !raw || raw.attempt_id !== bootstrap.attempt_id || !['control', 'chunk'].includes(raw.type)) {
      throw new MeetError('browser_bridge_rejected');
    }
    const metadata = raw.metadata;
    if (!metadata || JSON.stringify(metadata).length > 8192 || typeof metadata.stream_id !== 'string' ||
        !uuid.test(metadata.stream_id) || typeof metadata.epoch !== 'string' || !uuid.test(metadata.epoch)) {
      throw new MeetError('browser_bridge_rejected');
    }
    const key = `${metadata.stream_id}/${metadata.epoch}`;
    const unsigned = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
    const validBinding = () => (metadata.source_kind === 'speaker' || metadata.source_kind === 'share_audio') &&
      (metadata.attribution_unknown === true
        ? metadata.speaker_id === null && metadata.participant_id == null && metadata.participant_name == null
        : metadata.attribution_unknown === false &&
          (metadata.source_kind === 'share_audio'
            ? metadata.speaker_id === null || (typeof metadata.speaker_id === 'string' && metadata.speaker_id.length >= 1 && metadata.speaker_id.length <= 200)
            : typeof metadata.speaker_id === 'string' && metadata.speaker_id.length >= 1 && metadata.speaker_id.length <= 200) &&
          (metadata.participant_id == null || (typeof metadata.participant_id === 'string' && metadata.participant_id.length >= 1 && metadata.participant_id.length <= 200)) &&
          (metadata.participant_name == null || (typeof metadata.participant_name === 'string' && metadata.participant_name.length >= 1 && metadata.participant_name.length <= 200))) &&
      typeof metadata.provider_source_id === 'string' && metadata.provider_source_id.length <= 200 &&
      metadata.provider_source_id.startsWith(`${provider}:${bootstrap.meeting_id}:receiver:`);
    const binding = () => metadata.meeting_id === bootstrap.meeting_id &&
      metadata.attempt_id === bootstrap.attempt_id && metadata.sample_rate === 16000 &&
      metadata.channels === 1 && metadata.encoding === 'pcm_s16le' && validBinding();
    if (raw.type === 'control' && metadata.type === 'begin') {
      if (!binding() || (active.size >= 64 && !active.has(key)) ||
          metadata.id !== `${bootstrap.attempt_id}/${key}/begin`) throw new MeetError('browser_bridge_rejected');
      active.add(key); sink.begin(metadata);
    } else if (raw.type === 'control' && metadata.type === 'bind') {
      if (!active.has(key) || !validBinding() || !unsigned(metadata.start_sample) ||
          (metadata.start_sample as number) < 1 ||
          metadata.id !== `${bootstrap.attempt_id}/${key}/${metadata.start_sample}/bind`) {
        throw new MeetError('browser_bridge_rejected');
      }
      sink.bind?.(metadata);
    } else if (raw.type === 'control' && metadata.type === 'end') {
      if (!active.has(key) || !unsigned(metadata.final_sample) ||
          !Number.isSafeInteger(metadata.last_sequence) || (metadata.last_sequence as number) < -1 ||
          metadata.id !== `${bootstrap.attempt_id}/${key}/end`) throw new MeetError('browser_bridge_rejected');
      active.delete(key); sink.end(metadata);
    } else if (raw.type === 'control' && metadata.type === 'gap') {
      if (!active.has(key) || !unsigned(metadata.sequence) || !unsigned(metadata.start_sample) ||
          !unsigned(metadata.sample_count) || (metadata.sample_count as number) < 1 ||
          (metadata.sample_count as number) > 80000 || metadata.final !== true ||
          metadata.reason !== 'capture_input_missing' ||
          metadata.id !== `${bootstrap.attempt_id}/${key}/${metadata.sequence}/gap`) {
        throw new MeetError('browser_bridge_rejected');
      }
      sink.gap(metadata);
    } else if (raw.type === 'chunk') {
      if (!active.has(key) || !binding() || !unsigned(metadata.sequence) || !unsigned(metadata.start_sample) ||
          !unsigned(metadata.sample_count) || (metadata.sample_count as number) < 1 ||
          (metadata.sample_count as number) > 80000 || typeof raw.pcm !== 'string' || raw.pcm.length > 213336 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(raw.pcm)) throw new MeetError('browser_bridge_rejected');
      const pcm = Buffer.from(raw.pcm, 'base64');
      if (pcm.length !== (metadata.sample_count as number) * 2) throw new MeetError('browser_bridge_rejected');
      sink.chunk(metadata as Chunk, pcm);
    } else throw new MeetError('browser_bridge_rejected');
  });
  const config: MeetCaptureConfig = {meeting_id: bootstrap.meeting_id, attempt_id: bootstrap.attempt_id,
    meeting_url: bootstrap.meeting_url, provider, teams_origins: teamsOrigins};
  // Only the small native hook belongs in every new document. The local WASM
  // bundle is loaded once in the main Meet document, before clicking join.
  await page.addInitScript((config: MeetCaptureConfig) => {
    (globalThis as Record<string, unknown>).__name ??= (fn: unknown) => fn;
    const isZoomHost = location.protocol === 'https:' && !location.port &&
      (location.hostname === 'zoom.us' || location.hostname.endsWith('.zoom.us'));
    if (config.provider === 'webex'
      ? location.origin !== 'https://web.webex.com' || !/^\/(?:meeting|guest-join-meeting)$/.test(location.pathname)
      : config.provider === 'teams' ? window !== window.top || !config.teams_origins?.includes(location.origin)
      : config.provider === 'zoom' ? window !== window.top || !isZoomHost
      : window !== window.top || location.origin !== 'https://meet.google.com' ||
        location.pathname.replace(/^\/meet\//, '/') !== new URL(config.meeting_url).pathname.replace(/^\/meet\//, '/')) {
      // Diagnostics only: count peer connections that Meet creates in a
      // same-origin child frame, which the top-window capture never sees.
      if (config.provider === 'google_meet' && window !== window.top) {
        try {
          const top = window.top as unknown as {wortlautMeetReceivers?: {frameConnections?: Set<RTCPeerConnection>}};
          const Native = window.RTCPeerConnection;
          if (top.wortlautMeetReceivers && typeof Native === 'function') {
            top.wortlautMeetReceivers.frameConnections ??= new Set();
            window.RTCPeerConnection = new Proxy(Native, {construct(target, args, newTarget) {
              const pc = Reflect.construct(target, args, newTarget) as RTCPeerConnection;
              top.wortlautMeetReceivers?.frameConnections?.add(pc);
              return pc;
            }});
          }
        } catch { /* cross-origin frame */ }
      }
      return;
    }
    window.wortlautMeetConfig = config;
    const connections = new Set<RTCPeerConnection>(), received = new WeakSet<RTCRtpReceiver>();
    const encodedReserved = new WeakSet<RTCPeerConnection>();
    const receiverStreams = new WeakMap<RTCRtpReceiver, string[]>();
    const receiverMediaStreams = new WeakMap<RTCRtpReceiver, MediaStream>();
    const encodedFrameMeta = new WeakMap<RTCRtpReceiver, {ssrc: number | null; csrcs: number[]}>();
    const dataChannels = new Set<RTCDataChannel>();
    const hookedChannels = new WeakSet<RTCDataChannel>();
    const dataMessages: unknown[] = [];
    const dataSends: {channel: RTCDataChannel; data: unknown}[] = [];
    const remoteDescriptions: string[] = [];
    const pushDataMessage = (wrapped: unknown) => {
      if (window.wortlautMeetReceivers.onDataMessage) {
        window.wortlautMeetReceivers.onDataMessage(wrapped);
      } else if (dataMessages.length < 256) {
        dataMessages.push(wrapped);
      }
    };
    const attachDataChannel = (channel: RTCDataChannel) => {
      dataChannels.add(channel);
      if (hookedChannels.has(channel)) return;
      hookedChannels.add(channel);
      channel.addEventListener('message', (event) => {
        pushDataMessage({__wortlautChannel: channel.label || 'default',
          readyState: channel.readyState || 'open', data: event.data});
      });
      if (typeof channel.send === 'function') {
        channel.send = new Proxy(channel.send, {apply(sendFn, sendThis, sendArgs) {
          let payload = sendArgs[0];
          if (window.wortlautMeetReceivers.transformDataSend) {
            payload = window.wortlautMeetReceivers.transformDataSend(channel, payload);
          } else if (dataSends.length < 64) {
            dataSends.push({channel, data: payload});
          }
          return Reflect.apply(sendFn, sendThis, [payload, ...sendArgs.slice(1)]);
        }});
      }
    };
    window.wortlautMeetReceivers = {connections, received, encodedReserved, receiverStreams,
      receiverMediaStreams, encodedFrameMeta, dataChannels, dataMessages, dataSends, remoteDescriptions};
    if (config.provider === 'google_meet') {
      // Unbranded Chromium lacks Google Chrome's Finch trial for Opus DRED/LACE
      // (`extensions=120` blocks carried inside RFC 2198 `audio/red` PT 63):
      // advertising Opus without `audio/red` keeps Meet on standard RFC 7587 Opus.
      for (const RtpEndpoint of [window.RTCRtpReceiver, window.RTCRtpSender]) {
        if (typeof RtpEndpoint?.getCapabilities === 'function') {
          RtpEndpoint.getCapabilities = new Proxy(RtpEndpoint.getCapabilities, {
            apply(fn, thisArg, capArgs) {
              const caps = Reflect.apply(fn, thisArg, capArgs) as RTCRtpCapabilities | null;
              if (caps && String(capArgs[0]).toLowerCase() === 'audio' && Array.isArray(caps.codecs)) {
                const filtered = caps.codecs.filter((c) => c.mimeType.toLowerCase() !== 'audio/red');
                if (filtered.length > 0) return {...caps, codecs: filtered};
              }
              return caps;
            },
          });
        }
      }
      if (typeof window.RTCRtpTransceiver?.prototype?.setCodecPreferences === 'function') {
        window.RTCRtpTransceiver.prototype.setCodecPreferences = new Proxy(
          window.RTCRtpTransceiver.prototype.setCodecPreferences,
          {
            apply(fn, thisArg: RTCRtpTransceiver, prefArgs) {
              if (Array.isArray(prefArgs[0])) {
                const filtered = prefArgs[0].filter(
                  (c: {mimeType?: string}) => c?.mimeType?.toLowerCase() !== 'audio/red',
                );
                if (filtered.length > 0) return Reflect.apply(fn, thisArg, [filtered]);
              }
              return Reflect.apply(fn, thisArg, prefArgs);
            },
          },
        );
      }
      // In Google Meet's WASM audio rollout (`forceEncodedAudioInsertableStreams: true`),
      // Meet consumes `receiver.createEncodedStreams().readable` in a Worker and plays
      // mixed audio via WebAudio without writing frames back to `writable`, starving
      // Chromium's per-receiver NetEq (`codecId: null`, `jitterBufferEmittedCount: 0`).
      // Tee cloned encoded frames into `writable` unless the caller writes back itself.
      const recvProto = window.RTCRtpReceiver?.prototype as (RTCRtpReceiver & {
        createEncodedStreams?: () => {readable: ReadableStream; writable: WritableStream};
      }) | undefined;
      const AudioFrameCtor = (window as unknown as {
        RTCEncodedAudioFrame?: new (frame: unknown) => unknown;
      }).RTCEncodedAudioFrame;
      if (typeof recvProto?.createEncodedStreams === 'function' && typeof AudioFrameCtor === 'function') {
        recvProto.createEncodedStreams = new Proxy(recvProto.createEncodedStreams, {
          apply(fn, thisArg: RTCRtpReceiver, streamArgs) {
            const orig = Reflect.apply(fn, thisArg, streamArgs) as {
              readable: ReadableStream;
              writable: WritableStream;
            };
            if (thisArg?.track?.kind !== 'audio') return orig;
            const netEqWriter = orig.writable.getWriter();
            let providerWritesBack = false;
            let passthroughConfirmed = false;
            let seenFrames = 0;
            let providerCancelled = false;
            let providerCtrl = null as ReadableStreamDefaultController | null;
            const providerReadable = new ReadableStream(
              {
                start(c) { providerCtrl = c; },
                cancel() { providerCancelled = true; },
              },
              {highWaterMark: 256},
            );
            const providerWritable = new WritableStream({
              async write(frame) {
                providerWritesBack = true;
                await netEqWriter.write(frame);
              },
              close() { return netEqWriter.close().catch(() => {}); },
              abort(reason) { return netEqWriter.abort(reason).catch(() => {}); },
            });
            void (async () => {
              const reader = orig.readable.getReader();
              try {
                while (true) {
                  const {value: frame, done} = await reader.read();
                  if (done) break;
                  seenFrames += 1;
                  try {
                    const meta = (frame as {
                      getMetadata?: () => {synchronizationSource?: number; contributingSources?: number[]};
                    })?.getMetadata?.();
                    if (meta) {
                      encodedFrameMeta.set(thisArg, {
                        ssrc: typeof meta.synchronizationSource === 'number' ? meta.synchronizationSource : null,
                        csrcs: Array.isArray(meta.contributingSources) ? meta.contributingSources.slice(0, 64) : [],
                      });
                    }
                  } catch { /* metadata optional */ }
                  let clone: unknown = null;
                  if (!providerWritesBack) {
                    try { clone = new AudioFrameCtor(frame); } catch { clone = null; }
                  }
                  if (!providerCancelled && providerCtrl &&
                      (providerCtrl.desiredSize === null || providerCtrl.desiredSize > -256)) {
                    try { providerCtrl.enqueue(frame); } catch { providerCancelled = true; }
                  }
                  if (clone && !providerWritesBack) {
                    if (passthroughConfirmed) {
                      await netEqWriter.write(clone).catch(() => {});
                    } else {
                      const idx = seenFrames;
                      setTimeout(() => {
                        if (!providerWritesBack) {
                          if (idx >= 5) passthroughConfirmed = true;
                          void netEqWriter.write(clone).catch(() => {});
                        }
                      }, 15);
                    }
                  }
                }
                if (!providerCancelled) {
                  try { providerCtrl?.close(); } catch { /* already closed */ }
                }
              } catch { /* stream closed on peer teardown */ }
              finally {
                try { reader.releaseLock(); } catch { /* ignore */ }
              }
            })();
            return {readable: providerReadable, writable: providerWritable};
          },
        });
      }
    }
    const Native = window.RTCPeerConnection;
    window.RTCPeerConnection = new Proxy(Native, {construct(target, args, newTarget) {
      const pc = Reflect.construct(target, args, newTarget) as RTCPeerConnection;
      connections.add(pc);
      const pcCfg = args[0] as (RTCConfiguration & {
        encodedInsertableStreams?: boolean;
        forceEncodedAudioInsertableStreams?: boolean;
      }) | undefined;
      if (pcCfg?.encodedInsertableStreams === true || pcCfg?.forceEncodedAudioInsertableStreams === true) {
        encodedReserved.add(pc);
      }
      if (config.provider === 'google_meet' && typeof pc.createOffer === 'function') {
        pc.createOffer = new Proxy(pc.createOffer, {apply(fn, thisArg: RTCPeerConnection, offerArgs) {
          try {
            const caps = window.RTCRtpReceiver?.getCapabilities?.('audio')?.codecs ?? [];
            const noRed = caps.filter((c) => c.mimeType.toLowerCase() !== 'audio/red');
            if (noRed.length > 0 && typeof thisArg.getTransceivers === 'function') {
              for (const tr of thisArg.getTransceivers()) {
                if (tr.receiver?.track?.kind === 'audio' && typeof tr.setCodecPreferences === 'function') {
                  tr.setCodecPreferences(noRed);
                }
              }
            }
          } catch { /* preserve default offer if transceiver rejects codec preferences */ }
          return Reflect.apply(fn, thisArg, offerArgs);
        }});
      }
      let lastRemoteSdp = '';
      const recordRemoteSdp = (sdp: unknown) => {
        if (typeof sdp === 'string' && sdp.length > 0 && sdp.length <= 524288 && sdp !== lastRemoteSdp) {
          lastRemoteSdp = sdp;
          if (remoteDescriptions.length < 64) remoteDescriptions.push(sdp);
          window.wortlautMeetReceivers.onRemoteDescription?.(sdp);
        }
      };
      pc.setRemoteDescription = new Proxy(pc.setRemoteDescription, {apply(fn, thisArg, sdpArgs) {
        recordRemoteSdp(sdpArgs[0]?.sdp);
        return Reflect.apply(fn, thisArg, sdpArgs);
      }});
      pc.addEventListener('signalingstatechange', () => {
        recordRemoteSdp(pc.remoteDescription?.sdp);
      });
      pc.createDataChannel = new Proxy(pc.createDataChannel, {apply(fn, thisArg, channelArgs) {
        const channel = Reflect.apply(fn, thisArg, channelArgs) as RTCDataChannel;
        attachDataChannel(channel);
        return channel;
      }});
      pc.addEventListener('datachannel', (event) => {
        attachDataChannel(event.channel);
      });
      pc.addEventListener('track', (event) => {
        received.add(event.receiver);
        receiverStreams.set(event.receiver, event.streams.map((stream) => stream.id));
        if (event.streams[0]) receiverMediaStreams.set(event.receiver, event.streams[0]);
        window.wortlautMeetReceivers.observe?.(event.receiver, pc);
      });
      pc.addEventListener('connectionstatechange', () => {
        if (pc.connectionState === 'closed') connections.delete(pc);
      });
      return pc;
    }});
    if (config.provider !== 'google_meet' && typeof window.fetch === 'function') {
      window.fetch = new Proxy(window.fetch, {apply(fn, thisArg, fetchArgs) {
        const reqUrl = typeof fetchArgs[0] === 'string'
          ? fetchArgs[0]
          : (fetchArgs[0] as Request)?.url ?? '';
        const result = Reflect.apply(fn, thisArg, fetchArgs) as Promise<Response>;
        result.then((res) => {
          const ct = res.headers?.get('content-type') ?? '';
          if (/json|protobuf|octet-stream|text\/plain/i.test(ct) ||
              /sync|roster|participant|locus|meeting|space/i.test(reqUrl)) {
            res.clone().arrayBuffer().then((buf) => {
              if (buf.byteLength > 0 && buf.byteLength <= 262144) {
                pushDataMessage({__wortlautChannel: 'http:fetch', readyState: 'open', data: buf});
              }
            }).catch(() => {});
          }
        }).catch(() => {});
        return result;
      }});
    }
    if (config.provider !== 'google_meet' && typeof window.WebSocket === 'function') {
      window.WebSocket = new Proxy(window.WebSocket, {construct(target, wsArgs, newTarget) {
        const ws = Reflect.construct(target, wsArgs, newTarget) as WebSocket;
        ws.addEventListener('message', (event) => {
          const d = event.data;
          if ((typeof d === 'string' && d.length > 0 && d.length <= 262144) ||
              ((d instanceof ArrayBuffer || ArrayBuffer.isView(d)) &&
                d.byteLength > 0 && d.byteLength <= 262144)) {
            pushDataMessage({__wortlautChannel: 'ws:signaling', readyState: 'open', data: d});
          }
        });
        return ws;
      }});
    }
    if (config.provider !== 'google_meet' && typeof XMLHttpRequest === 'function') {
      XMLHttpRequest.prototype.send = new Proxy(XMLHttpRequest.prototype.send, {
        apply(fn, thisArg: XMLHttpRequest, xhrArgs) {
          thisArg.addEventListener('load', () => {
            try {
              const rt = thisArg.responseType;
              if (rt === '' || rt === 'text') {
                const txt = thisArg.responseText;
                if (typeof txt === 'string' && txt.length > 0 && txt.length <= 262144) {
                  pushDataMessage({__wortlautChannel: 'http:xhr', readyState: 'open', data: txt});
                }
              } else if (rt === 'json' && thisArg.response && typeof thisArg.response === 'object') {
                const txt = JSON.stringify(thisArg.response);
                if (txt.length > 0 && txt.length <= 262144) {
                  pushDataMessage({__wortlautChannel: 'http:xhr', readyState: 'open', data: txt});
                }
              } else if (rt === 'arraybuffer' && thisArg.response instanceof ArrayBuffer &&
                  thisArg.response.byteLength > 0 && thisArg.response.byteLength <= 262144) {
                pushDataMessage({__wortlautChannel: 'http:xhr',
                  readyState: 'open', data: thisArg.response});
              }
            } catch {}
          });
          return Reflect.apply(fn, thisArg, xhrArgs);
        },
      });
    }
    if (config.provider === 'zoom' && typeof window.Worker === 'function') {
      window.Worker = new Proxy(window.Worker, {construct(target, workerArgs, newTarget) {
        const worker = Reflect.construct(target, workerArgs, newTarget) as Worker;
        worker.addEventListener('message', (event) => {
          const d = event.data;
          if (!d) return;
          if (typeof d === 'string' && d.length > 0 && d.length <= 262144) {
            pushDataMessage({__wortlautChannel: 'worker:zoom', readyState: 'open', data: d});
          } else if (typeof d === 'object' && !(d instanceof ArrayBuffer) && !ArrayBuffer.isView(d)) {
            try {
              const txt = JSON.stringify(d);
              if (txt.length > 2 && txt.length <= 262144) {
                pushDataMessage({__wortlautChannel: 'worker:zoom', readyState: 'open', data: txt});
              }
            } catch {}
          }
        });
        return worker;
      }});
    }
  }, config);
  return async () => {
    const url = new URL(page.url());
    if (url.origin === 'https://accounts.google.com') throw new MeetError('auth_session_missing');
    if (provider === 'webex') {
      if (url.origin !== new URL(bootstrap.meeting_url).origin) throw new MeetError('unexpected_browser_origin');
      const frames = page.frames().filter(frame =>
        /^https:\/\/web\.webex\.com\/(?:meeting|guest-join-meeting)(?:[?#]|$)/.test(frame.url()) &&
        !frame.url().includes('preload=true'));
      captureFrame = frames[frames.length - 1];
    } else if (provider === 'teams') {
      if (!isTeamsOrigin(url)) throw new MeetError('unexpected_browser_origin');
    } else if (provider === 'zoom') {
      if (!isZoomOrigin(url)) throw new MeetError('unexpected_browser_origin');
    } else if (url.origin !== 'https://meet.google.com' ||
        url.pathname.replace(/^\/meet\//, '/') !== new URL(bootstrap.meeting_url).pathname.replace(/^\/meet\//, '/')) {
      throw new MeetError('unexpected_browser_origin');
    }
    if (!captureFrame) throw new MeetError('webex_frame_missing');
    await captureFrame.evaluate(bundle);
    await captureFrame.waitForFunction(() => window.wortlautMeet?.inspect().capture_ready ||
      window.wortlautMeet?.inspect().reason, undefined, {timeout: 10000});
    const state = await captureFrame.evaluate(() => window.wortlautMeet.inspect());
    if (state.reason) throw new MeetError(state.reason);
  };
}

// Join/admission selectors were reviewed against @vexa/join's Google Meet
// implementation at 18e7ac1d6a0201d1489ce30b12b6f7138067a598 (Apache-2.0).
// Labels: https://support.google.com/meet/answer/9303069 and /15738543 (hl=de/en).
// Camera aktivieren was also observed in the German Meet prejoin UI.
// Only exact English/German actions are used; no broad structural button click.
const actions = {
  join: /^(?:Ask to join|Join now|Teilnahme erbitten|Um Teilnahme bitten|Jetzt teilnehmen|(?:add_to_queue\s*)?(?:Join here too|Auch von hier teilnehmen))$/i,
  withoutMedia: /^(Continue without (?:microphone and camera|camera|microphone)|Ohne (?:Mikrofon und Kamera|Kamera|Mikrofon) fortfahren)$/i,
  leave: /^(Leave call|Leave meeting|Anruf verlassen|Besprechung verlassen)(?: \(.*\))?$/i,
  micOff: /^(Turn off microphone|Mikrofon ausschalten|Mikrofon deaktivieren)(?: \(.*\))?$/i,
  micOn: /^(Turn on microphone|(?:Microphone problem\.\s*)?Show more info(?: about the microphone problem)?|Microphone:\s*Permission needed|Mikrofon einschalten|Mikrofon aktivieren|(?:Mikrofonproblem\.\s*)?Weitere Informationen(?: zum Mikrofonproblem)? anzeigen|Mikrofon:\s*Berechtigung erforderlich)(?: \(.*\))?$/i,
  cameraOff: /^(Turn off camera|Kamera ausschalten|Kamera deaktivieren)(?: \(.*\))?$/i,
  cameraOn: /^(Turn on camera|(?:Camera problem\.\s*)?Show more info(?: about the camera problem)?|Camera:\s*Permission needed|Kamera einschalten|Kamera aktivieren|(?:Kameraproblem\.\s*)?Weitere Informationen(?: zum Kameraproblem)? anzeigen|Kamera:\s*Berechtigung erforderlich)(?: \(.*\))?$/i,
};
const knockJoin = /^(?:Ask to join|Teilnahme erbitten|Um Teilnahme bitten)$/i;
const emptyPrejoin = /Andere Anrufteilnehmer werden gesucht|Looking for others|Außer (?:Ihnen|dir) ist niemand (?:da|hier)|Noch ist niemand (?:sonst )?(?:da|hier)|Niemand sonst ist (?:da|hier)|No one else is here|You[’']re the first one here/i;
const waiting = /Please wait until a meeting host brings you into the call|Asking to be let in|You[’']ll join the call when someone lets you|Someone in the call (?:will|can) let you in|Waiting (?:for the host|to be let in)|Host hasn[’']t joined yet|Um Teilnahme (?:gebeten|bitten)|Teilnahme wird angefragt|Anfrage.*Teilnahme|(?:Sie|Du)\s+(?:können|kannst|nehmen|nimmst)\s+teil(?:nehmen)?,\s*sobald|Jemand.*(?:(?:lässt|lassen)\s+(?:Sie|dich).*(?:ein|teilnehmen)|kann\s+(?:Sie|dich).*einlassen)|Bitte warten(?:\s+Sie)?,\s*bis.*(?:einlässt|eingeladen)|Warten.*(?:Zulassung|Gastgeber|Host|Organisator|einlässt|eingelassen|eingeladen)|Sobald.*(?:zugelassen|teilnehmen|einlässt)|noch nicht eingelassen/i;
const denied = /You (?:can[’']t|cannot) join this video call|denied your request|request to join was denied|not allowed to join|weren[’']t allowed|Anfrage.*abgelehnt|Teilnahme.*(?:abgelehnt|nicht gestattet)|Sie können nicht an diesem Videoanruf teilnehmen/i;
const removed = /removed from (?:the )?(?:call|meeting)|aus.*(?:Besprechung|Anruf).*entfernt/i;
const ended = /^(?:This )?(?:meeting|call) (?:has )?ended\.?$|Besprechung.*beendet|Anruf.*beendet/i;
const consentPrompt = /take notes for me|taking notes|Notizen.*(?:zustimmen|Einwilligung)/i;

// Meet can replace the accessible name with a device-state description.
function joinButton(page: Page) {
  return page.getByRole('button', {name: actions.join})
    .or(page.getByRole('button').filter({hasText: actions.join}))
    .or(page.getByRole('menuitem').filter({hasText: actions.join}));
}

function leaveButton(page: Page) {
  return page.getByRole('button', {name: actions.leave}).or(
    page.locator(
      'button[aria-label="Leave call" i], button[aria-label="Leave meeting" i], ' +
      'button[aria-label="Anruf verlassen" i], button[aria-label="Besprechung verlassen" i]',
    ),
  );
}

async function visible(locator: Locator) { return locator.first().isVisible(); }

// Background anchors/badges do not mean that a person must solve a challenge.
async function humanVerificationVisible(page: Page) {
  for (const frame of await page.locator('iframe[src*="/recaptcha/"]').all()) {
    if (!await frame.evaluate(element => element.checkVisibility({checkOpacity: true, checkVisibilityCSS: true}))) continue;
    const path = new URL(await frame.getAttribute('src') ?? '', page.url()).pathname;
    if (/\/recaptcha\/(?:api2|enterprise)\/bframe$/.test(path)) return true;
    if (/\/recaptcha\/(?:api2|enterprise)\/anchor$/.test(path) &&
        await frame.contentFrame().getByRole('checkbox').first().isVisible()) return true;
  }
  return false;
}

export class MeetBrowser {
  private participation = 'joining';
  private reason = '';
  private stopping: Promise<void> | undefined;
  private readonly transport: AudioTransport;
  private drained = false;
  private joinSent = false;
  private chatSent = false;
  private chatAttempts = 0;
  private rosterOpened = false;
  private chatRestored = false;
  private initialize?: () => Promise<void>;
  private pushVideoTile?: (patch: VideoTilePatch) => Promise<void>;

  constructor(private readonly page: Page, private readonly bootstrap: MeetBootstrap,
    api: string, credential: string, workerId: string,
    private readonly assets?: URL,
    private readonly input: MeetInput = {click: locator => locator.click({timeout: 5000}),
      fill: (locator, text) => locator.fill(text, {timeout: 5000})}) {
    const ingest = new URL(`/v1/attempts/${bootstrap.attempt_id}/audio`, api);
    if (!['https:', 'http:'].includes(ingest.protocol)) throw new MeetError('invalid_ingest_url');
    ingest.protocol = ingest.protocol === 'https:' ? 'wss:' : 'ws:';
    this.transport = new AudioTransport(ingest.href, credential, workerId,
      (reason) => { this.reason = reason; });
  }

  async prepare() {
    this.pushVideoTile = await installVideoTile(this.page, 'google_meet', this.bootstrap.meeting_url, {
      locale: this.bootstrap.default_locale,
      invitedBy: this.bootstrap.invited_by_name ?? this.bootstrap.invited_by,
      meetingTitle: this.bootstrap.meeting_title,
    });
    this.initialize = await installMeetCapture(this.page, this.bootstrap, {
      begin: (metadata) => this.transport.control(metadata as Record<string, unknown> & {id: string}),
      bind: (metadata) => this.transport.control(metadata as Record<string, unknown> & {id: string}),
      end: (metadata) => this.transport.control(metadata as Record<string, unknown> & {id: string}),
      gap: (metadata) => this.transport.control(metadata as Record<string, unknown> & {id: string}),
      chunk: (metadata, pcm) => this.transport.chunk(metadata, pcm),
      error: (reason) => { this.reason = reason; },
    }, this.assets);
    this.transport.connect();
  }

  async updateVideoTile(patch: VideoTilePatch) {
    await this.pushVideoTile?.(patch);
  }

  private async dismissSigninTip() {
    const tip = this.page.getByText(/^(Mit Ihrem Google-Konto anmelden|Sign in with your Google Account)$/i);
    const dismiss = this.page.getByRole('button', {name: /^(OK|Got it|Verstanden)$/i});
    if (!await visible(tip) || await dismiss.count() !== 1 || !await visible(dismiss)) return false;
    await this.input.click(dismiss);
    await tip.first().waitFor({state: 'hidden', timeout: 5000});
    return true;
  }

  private async dismissWithoutMedia() {
    let dismissed = false;
    for (let step = 0; step < 2; step++) {
      const button = this.page.getByRole('button', {name: actions.withoutMedia});
      if (!await visible(button)) break;
      await this.input.click(button.first());
      await button.first().waitFor({state: 'hidden', timeout: 5000}).catch(() => {});
      dismissed = true;
    }
    return dismissed;
  }

  private async dismissInfoDialog() {
    const dialog = this.page.getByRole('dialog').or(this.page.getByRole('alertdialog'))
      .filter({hasNotText: consentPrompt});
    if (!await visible(dialog)) return false;
    const choiceOrCancel = dialog.first().getByRole('button', {
      name: /^(?:Cancel|Deny|Reject|Agree|Allow|Turn on|Leave|Remove|Abbrechen|Ablehnen|Zustimmen|Erlauben|Aktivieren|Verlassen|Entfernen)/i,
    });
    if (await visible(choiceOrCancel)) return false;
    const ok = dialog.first().getByRole('button', {name: /^(?:OK|Got it|Verstanden)$/i});
    if (await ok.count() !== 1 || !await visible(ok)) return false;
    await this.input.click(ok.first());
    await ok.first().waitFor({state: 'hidden', timeout: 5000}).catch(() => {});
    return true;
  }

  async join() {
    await this.initialize?.();
    const button = joinButton(this.page);
    const joinDeadline = Date.now() + 30000;
    let otherWaysClicked = false;
    while (!await visible(button)) {
      if (this.stopping) return;
      await this.dismissWithoutMedia()
        .catch(() => { throw new MeetError('join_click_failed'); });
      if (await visible(button)) break;
      if (this.bootstrap.meet.auth_mode === 'guest') {
        const continueAsGuest = this.page.getByRole('button', {
          name: /^(?:Continue as guest|Als Gast fortfahren|Ohne Konto fortfahren)$/i,
        });
        if (await visible(continueAsGuest)) {
          await this.input.click(continueAsGuest.first()).catch(() => {});
          await continueAsGuest.first().waitFor({state: 'hidden', timeout: 5000}).catch(() => {});
          if (await visible(button)) break;
        }
      }
      const switchHere = this.page.getByRole('button', {name: /^(Switch here|Auf dieses Gerät wechseln)$/i})
        .or(this.page.getByRole('button').filter({hasText: /^(Switch here|Auf dieses Gerät wechseln)$/i}));
      const otherWays = this.page.getByRole('button', {name: /^(Other ways to join|Weitere Möglichkeiten zur Teilnahme)$/i});
      if (!otherWaysClicked && await visible(switchHere) && await visible(otherWays)) {
        otherWaysClicked = true;
        await this.input.click(otherWays.first()).catch(() => {});
      }
      if (Date.now() >= joinDeadline) throw new MeetError('join_button_missing');
      await this.page.waitForTimeout(250);
    }
    if (this.stopping) return;
    const name = this.page.locator('input[type="text"]:not([aria-hidden="true"])');
    if (await visible(name)) {
      if (this.bootstrap.meet.auth_mode === 'account') throw new MeetError('auth_session_missing');
      if (await name.count() !== 1) throw new MeetError('join_control_ambiguous');
      try {
        await this.dismissSigninTip();
        await this.dismissWithoutMedia();
        try { await this.input.fill(name, this.bootstrap.meet.display_name); }
        catch (error) {
          // Meet may display this coachmark or permission dialog after the prejoin controls appear.
          if (!await this.dismissSigninTip() && !await this.dismissWithoutMedia()) throw error;
          await this.input.fill(name, this.bootstrap.meet.display_name);
        }
      } catch { throw new MeetError('guest_name_input_failed'); }
    } else if (this.bootstrap.meet.auth_mode === 'guest') {
      throw new MeetError('guest_name_missing');
    }
    // Microphone must strictly be confirmed OFF; virtual live-transcript camera stays ON when available.
    {
      await this.dismissWithoutMedia()
        .catch(() => { throw new MeetError('join_click_failed'); });
      let skipMicOnWait = false;
      const turnOffMic = this.page.getByRole('button', {name: actions.micOff});
      if (await visible(turnOffMic)) {
        const micUnavailable = await this.page.evaluate(async () => {
          const status = await navigator.permissions.query({name: 'microphone' as PermissionName});
          return status.state === 'denied' &&
            !(await navigator.mediaDevices.enumerateDevices()).some(device => device.kind === 'audioinput');
        }).catch(() => false);
        if (micUnavailable) {
          skipMicOnWait = true;
        } else {
          await this.input.click(turnOffMic)
            .catch(() => { throw new MeetError('microphone_state_unconfirmed'); });
        }
      }
      if (!skipMicOnWait) {
        await this.dismissWithoutMedia()
          .catch(() => { throw new MeetError('join_click_failed'); });
        await this.page.getByRole('button', {name: actions.micOn}).first().waitFor({state: 'visible', timeout: 10000})
          .catch(() => { throw new MeetError('microphone_state_unconfirmed'); });
      }

      if (!await visible(this.page.getByRole('button', {name: actions.cameraOff}))) {
        const enableCamera = this.page.getByRole('button', {
          name: /^(Turn on camera|Kamera einschalten|Kamera aktivieren)(?: \(.*\))?$/i,
        });
        if (await visible(enableCamera)) {
          await this.input.click(enableCamera.first()).catch(() => {});
          await this.dismissWithoutMedia().catch(() => {});
        }
      }
      if (await this.page.evaluate(() => [...(window.wortlautMeetReceivers?.connections ?? [])]
        .some(pc => pc.getSenders().some(sender => {
          const track = sender.track as (MediaStreamTrack & {__wortlautVirtualVideo?: boolean}) | null;
          if (!track || track.readyState !== 'live' || !track.enabled) return false;
          return track.kind === 'audio' || !track.__wortlautVirtualVideo;
        }))).catch(() => false)) {
        throw new MeetError('meet_sending_device_active');
      }
    }
    if (this.stopping) return;
    await this.dismissWithoutMedia()
      .catch(() => { throw new MeetError('join_click_failed'); });
    if (!await visible(button)) {
      const otherWays = this.page.getByRole('button', {name: /^(Other ways to join|Weitere Möglichkeiten zur Teilnahme)$/i});
      if (await visible(otherWays)) {
        await this.input.click(otherWays.first()).catch(() => {});
        await button.first().waitFor({state: 'visible', timeout: 5000}).catch(() => {});
      }
    }
    if (await button.count() !== 1) throw new MeetError('join_control_ambiguous');
    const buttonText = (await button.first().innerText().catch(() => '')).trim();
    const buttonAria = ((await button.first().getAttribute('aria-label').catch(() => '')) ?? '').trim();
    if ((knockJoin.test(buttonText) || knockJoin.test(buttonAria)) && await visible(this.page.getByText(emptyPrejoin))) {
      // Knocking into a cold, completely empty Google Meet space leaves Meet with zero
      // DOM <audio> sinks and stalled Opus header-extension negotiation even after host
      // admission. Stay on prejoin in waiting_admission until a participant enters.
      this.participation = 'waiting_admission';
      while (!this.stopping && !this.reason && await visible(this.page.getByText(emptyPrejoin))) {
        if (await visible(this.page.getByText(denied))) throw new MeetError('prejoin_denied');
        if (await visible(this.page.getByText(ended))) throw new MeetError('meeting_ended');
        if (await humanVerificationVisible(this.page)) throw new MeetError('human_verification_required');
        await this.dismissWithoutMedia().catch(() => {});
        await this.page.waitForTimeout(500);
      }
      if (this.stopping || this.reason) return;
      await this.page.waitForTimeout(500);
      if (this.stopping || this.reason) return;
      await this.dismissWithoutMedia().catch(() => {});
      await button.first().waitFor({state: 'visible', timeout: 10000}).catch(() => {});
      if (await button.count() !== 1) throw new MeetError('join_control_ambiguous');
    }
    await this.input.click(button).catch(() => { throw new MeetError('join_click_failed'); });
    this.joinSent = true;
  }

  private async sendChatIntro() {
    const text = this.bootstrap.chat_intro?.trim();
    if (!text) {
      this.chatSent = true;
      return;
    }
    try {
      await this.dismissWithoutMedia().catch(() => {});
      const chatBox = this.page.getByRole('textbox', {
        name: /send a message|nachricht.*senden|chat/i,
      }).or(this.page.locator(
        'textarea[aria-label*="Nachricht" i], textarea[aria-label*="message" i], ' +
        '[contenteditable="true"][aria-label*="Nachricht" i], [contenteditable="true"][aria-label*="message" i]'
      ));
      if (!await visible(chatBox)) {
        const chatToggle = this.page.getByRole('button', {
          name: /^(?:Chat with everyone|Mit allen chatten|Chat|Nachricht an alle|In-call messages|Nachrichten im Anruf)(?:\b|\s|\d|$)/i,
        }).or(this.page.locator('button[data-panel-id="2"]:not([aria-label*="Organisator" i]):not([aria-label*="organizer" i]):not([aria-label*="Host" i]):not([aria-label*="Gastgeber" i])'))
          .and(this.page.locator(':not([aria-expanded="true"]):not([aria-pressed="true"])')).first();
        if (!await visible(chatToggle)) return;
        await chatToggle.click({timeout: 2500}).catch(async () => {
          await chatToggle.evaluate((el: HTMLElement) => el.click()).catch(() => {});
        });
        await chatBox.first().waitFor({state: 'visible', timeout: 2500}).catch(() => {});
      }
      if (!await visible(chatBox)) return;
      await chatBox.first().fill(text, {timeout: 2500});
      const sendBtn = this.page.getByRole('button', {
        name: /^(?:Send a message|Send message|Send|Nachricht senden|Senden)(?:\b|\s|$)/i,
      }).first();
      if (await visible(sendBtn) && await sendBtn.isEnabled().catch(() => false)) {
        await sendBtn.click({timeout: 2000}).catch(() => {});
      } else {
        await chatBox.first().press('Enter', {timeout: 2000}).catch(() => {});
      }
      this.chatSent = true;
    } catch { /* chat intro is non-critical */ }
  }

  async inspect() {
    let state;
    try { state = await this.page.evaluate(() => window.wortlautMeet?.inspect()); }
    catch { /* navigation may be in progress; classify its origin below */ }
    const url = new URL(this.page.url());
    if (url.origin === 'https://accounts.google.com') this.reason = 'auth_session_missing';
    else if (url.origin !== 'https://meet.google.com') this.reason = 'unexpected_browser_origin';
    if (state?.reason) this.reason = state.reason;
    if (!this.stopping) {
      if (await visible(this.page.getByText(denied))) {
        this.reason = this.joinSent ? 'admission_denied' : 'prejoin_denied';
      }
      else if (await visible(this.page.getByText(removed))) this.reason = 'removed';
      else if (await visible(this.page.getByText(ended))) this.reason = 'meeting_ended';
      else if (await humanVerificationVisible(this.page)) this.reason = 'human_verification_required';
      else if (await visible(this.page.getByRole('dialog').filter({hasText: consentPrompt}))) {
        this.reason = 'consent_required';
      } else {
        if (this.joinSent) {
          await this.dismissWithoutMedia().catch(() => {});
          await this.dismissInfoDialog().catch(() => {});
        }
        if (this.participation !== 'capturing' && await visible(this.page.getByText(waiting))) {
          this.participation = 'waiting_admission';
        } else if (this.joinSent && !await visible(joinButton(this.page))) {
          const hasLeave = await visible(leaveButton(this.page));
          const hasRtp =
            (state?.streams ?? 0) > 0 ||
            (state?.receiver_sources ?? []).some((r: Record<string, any>) =>
              (r.ssrc?.length ?? 0) > 0 ||
              (r.csrc?.length ?? 0) > 0 ||
              (r.encoded_transform?.frame_count ?? 0) > 0);
          const hasRtpOrDomParticipants =
            hasRtp ||
            (state?.participant_sources?.dom_participants ?? 0) > 0;
          const collectionsChannel = (state?.data_channels ?? []).find(
            (dc: Record<string, any>) => dc.label === 'collections',
          );
          const isPrewarmedLobbyChannel =
            collectionsChannel != null &&
            (collectionsChannel.binary_frames ?? 0) +
              (collectionsChannel.text_frames ?? 0) +
              (collectionsChannel.json_frames ?? 0) === 0 &&
            !hasRtp;
          const hasInCallControls = hasLeave && await visible(
            this.page.locator('[data-panel-id="1"], button[data-panel-id="2"]:not([aria-label*="Organisator" i]):not([aria-label*="organizer" i]):not([aria-label*="Host" i]):not([aria-label*="Gastgeber" i])').or(
              this.page.getByRole('button', {
                name: /^(?:People|Participants|Show everyone|Alle anzeigen|Teilnehmer|Personen|Chat with everyone|Mit allen chatten|In-call messages|Nachrichten im Anruf|Raise hand|Hand heben)(?:\b|\s|\d|$)/i,
              }),
            ),
          );
          if (this.participation === 'capturing' ||
              (hasLeave && !isPrewarmedLobbyChannel && (hasRtpOrDomParticipants || hasInCallControls) &&
                await this.page.locator('[data-self-name], [data-participant-id], [data-requested-participant-id]').count() > 0)) {
            this.participation = 'capturing';
            if (!this.chatSent && this.chatAttempts < 8) {
              this.chatAttempts += 1;
              await this.sendChatIntro();
            }
            if (!this.rosterOpened && (this.chatSent || !this.bootstrap.chat_intro?.trim() || this.chatAttempts >= 3)) {
              this.rosterOpened = true;
              const toggle = this.page.getByRole('button', {
                name: /^(?:People|Participants|Show everyone|Alle anzeigen|Teilnehmer|Personen)(?:\b|\s|\d|$)/i,
              }).or(this.page.locator('[data-panel-id="1"]'))
                .and(this.page.locator(':not([aria-expanded="true"]):not([aria-pressed="true"])')).first();
              if (await visible(toggle)) {
                await this.input.click(toggle).catch(() => {});
              }
            } else if (this.rosterOpened && this.chatSent && Boolean(this.bootstrap.chat_intro?.trim()) && !this.chatRestored) {
              this.chatRestored = true;
              const chatToggle = this.page.getByRole('button', {
                name: /^(?:Chat with everyone|Mit allen chatten|Chat|Nachricht an alle|In-call messages|Nachrichten im Anruf)(?:\b|\s|\d|$)/i,
              }).or(this.page.locator('button[data-panel-id="2"]:not([aria-label*="Organisator" i]):not([aria-label*="organizer" i]):not([aria-label*="Host" i]):not([aria-label*="Gastgeber" i])'))
                .and(this.page.locator(':not([aria-expanded="true"]):not([aria-pressed="true"])')).first();
              if (await visible(chatToggle)) {
                await this.input.click(chatToggle).catch(() => {});
              }
            }
          } else {
            this.participation = 'waiting_admission';
          }
        }
      }
    }
    return {capability: 'unverified', participation: this.stopping ? 'ended' : this.participation,
      reason: this.reason || (this.participation === 'capturing' ? 'source_binding_unverified' : ''),
      stopped: Boolean(this.reason || this.stopping), streams: state?.streams ?? 0,
      audio_samples: state?.audio_samples ?? 0,
      active_audio_samples: state?.active_audio_samples ?? 0,
      drained: this.stopping ? this.drained : null,
      configured_speaker_slots: null, configured_share_slots: null,
      receiver_sources: state?.receiver_sources ?? [],
      audio_clock: state?.audio_clock,
      participant_sources: state?.participant_sources ?? {available: false, total: 0, truncated: false, sources: []},
      data_channels: state?.data_channels ?? [],
      sdp: state?.sdp ?? {descriptions: 0, audio_sections: 0, video_sections: 0, ssrc_count: 0, cname_count: 0, msid_count: 0},
      ...(state?.media ? {media: state.media} : {})};
  }

  stop(reason: string) {
    return this.stopping ??= (async () => {
      const bridged = await this.page.evaluate(() => {
        window.wortlautVideoTile?.stop();
        return window.wortlautMeet?.stop();
      }).catch(() => false);
      this.drained = (await this.transport.drain()) && bridged === true;
      if (!['removed', 'meeting_ended', 'admission_denied', 'prejoin_denied'].includes(reason)) {
        await this.dismissInfoDialog().catch(() => {});
        const leave = leaveButton(this.page);
        if (await visible(leave)) await this.input.click(leave.first()).catch(() => { this.reason = 'leave_unconfirmed'; });
      }
    })();
  }
}
