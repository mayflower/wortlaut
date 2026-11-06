# src

## Overview
In-page browser media capture, 5-second PCM chunking, WebSocket ingest transport, and provider SDK/WebRTC inspection modules for Webex, Google Meet, and Microsoft Teams.

## Interface
- `[capture.ts:CaptureSink]`: Callback contract `{chunk, begin, bind?, end, gap, error}` for captured audio streams.
- `[capture.ts:AudioClock]`: `AudioContext` clock state and interruption history type.
- `[capture.ts:AudioCapture]`: Manages shared `AudioContext`, `wortlaut-pcm` `AudioWorkletNode` instances per `MediaStreamTrack`, sample-accurate source rebinding (`rebind`), clock interruption tracking, and automatic epoch restart on resume.
- `[chunks.ts:Binding]`: Source attribution metadata type (`provider_source_id`, `speaker_id`, `source_kind`, `attribution_unknown`, `participant_id`, `participant_name`).
- `[chunks.ts:Chunk]`: Complete metadata record for a 16 kHz mono `pcm_s16le` audio chunk.
- `[chunks.ts:chunkId]`: Formats deterministic chunk IDs `${attempt_id}/${stream_id}/${epoch}/${sequence}`.
- `[chunks.ts:Chunker]`: Buffers contiguous 16 kHz mono `s16le` PCM into 5-second (`16000 * 5 * 2` byte) chunks, records sample-accurate gaps, and supports mid-stream source rebinding (`bindAtSample`, `finalSample`).
- `[chunks.ts:audioFrame]`: Serializes a `Chunk` metadata header and raw PCM payload into a binary frame (`uint32be` JSON length + UTF-8 JSON + raw `pcm_s16le`).
- `[meet-page.ts:MeetCaptureConfig]`: Configuration injected onto `window.wortlautMeetConfig`.
- `[meet-page.ts:MeetBridgeMessage]`: Message schema sent across `window.wortlautMeetBridge`.
- `[meet-page.ts:window.wortlautMeet]`: In-page controller (`{inspect, stop}`) polling `RTCPeerConnection` audio receivers, ingesting `RTCDataChannel` participant signaling (`onDataMessage`, `ingestParticipantRecord`), resolving RTP `csrc`/`ssrc`/`track_id`/`stream_id` participant bindings (`resolveReceiver`, `capture.rebind`, `participant_sources`), managing `RTCRtpScriptTransform` encoded frame observers, and bridging 5-second PCM chunks.
- `[page.ts:window.wortlaut]`: Webex SDK page controller (`{start, stop, renewGuest, inspectReceivers, state}`).
- `[page.ts:window.wortlautAudioTest]`: Synthetic 440 Hz / 880 Hz dual-oscillator capture fixture for browser audio verification.
- `[teams-url.ts:teamsOrigins]`: Allowed Microsoft Teams web client origins (`https://teams.microsoft.com`, `https://teams.live.com`, `https://teams.cloud.microsoft`).
- `[teams-url.ts:isTeamsOrigin]`: Checks whether a `URL` origin is in `teamsOrigins`.
- `[teams-url.ts:isTeamsMeeting]`: Validates `https:` Teams meeting URLs without credentials matching `/meet/<id>` or `/l/meetup-join/...`.
- `[transport.ts:AudioTransport]`: Reconnecting WebSocket client for `/v1/attempts/${attempt_id}/audio` with ACK tracking, bounded buffering, and gap emission on overflow.
- `[webex.ts:RemoteMedia]`, `[webex.ts:MediaGroup]`, `[webex.ts:Meeting]`, `[webex.ts:WebexClient]`: TypeScript contracts for Webex Meetings SDK objects and multistream WebRTC transceivers.
- `[webex.ts:participantEvidence]`: Extracts participant audio and share-audio CSIs (up to 256 members, 64 CSIs per member) from `meeting.members`.
- `[webex.ts:audioReceiver]`: Resolves the underlying `RTCRtpReceiver` for a Webex `RemoteMedia` slot via `multistreamConnection.recvTransceivers` (`AUDIO-MAIN` / `AUDIO-SLIDES`).
- `[webex.ts:receiverEvidence]`: Builds receiver diagnostic evidence (`provider_source_id`, `capture_path`, `track_id`, `csi`, `signaled_participant_id`, `ssrc`, `csrc`).
- `[webex.ts:receiveOptions]`: Builds receive-only multistream Webex join options (`numOfActiveSpeakerStreams: 3`, `numOfScreenShareStreams: 1`, send audio/video disabled).
- `[webex.ts:replaceGuestToken]`: Updates `client.credentials` `supertoken` and resets cached `userTokens`.

## Invariants
- `[capture.ts:AudioCapture]`: Never mixes tracks into a shared destination; each `MediaStreamTrack` gets an isolated `AudioWorkletNode`, and any `AudioContext` suspension/interruption stops the current worklet and starts a fresh `epoch` upon resume (or triggers `audio_context_resume_timeout` after 5000 ms).
- `[chunks.ts:Chunker]`: Requires strictly contiguous `startSample` values and even byte lengths (`pcm.length % 2 === 0`); caps individual gaps at `16000 * 5` samples.
- `[meet-page.ts:install]`: Only activates on verified top-level Meet/Teams origins or `https://web.webex.com/meeting`; caps concurrent observed receivers at 64 (`audio_source_limit`) and pending bridge buffer at 64 messages or 4 MiB (`browser_bridge_limit`).
- `[transport.ts:AudioTransport]`: Buffers at most 256 control frames (`<= 8192` bytes each) and 256 audio chunks / `16000 * 120` samples (120 source-seconds, 3.84 MB PCM); drops oldest unacknowledged chunks on overflow and replaces each with a final `worker_buffer_limit` gap control message.
- `[webex.ts:receiverEvidence]`: Treats Webex CSIs and RTP SSRCs/CSRCs strictly as diagnostic evidence (`speaker_id: null`, `attribution_unknown: true` for speaker slots) without assuming `CSI == SSRC/CSRC`.
- `[teams-url.ts:isTeamsMeeting]`: Rejects Microsoft login hosts and URLs containing usernames or passwords.

## Side Effects
- `[capture.ts:AudioCapture]`: Creates browser `AudioContext`, loads worklet modules, and attaches/detaches `MediaStreamSource` and `AudioWorkletNode` instances.
- `[meet-page.ts:install]`: Creates and revokes `Blob` URLs, spawns a Web Worker for `encoded-audio-observer.js`, attaches `RTCRtpScriptTransform` instances to `RTCRtpReceiver`s, runs a 500 ms receiver inspection interval, and invokes `window.wortlautMeetBridge`.
- `[page.ts:start]`: Initializes `window.Webex`, registers the device, joins the Webex meeting via WebRTC multistream, and streams captured audio over `AudioTransport`.
- `[transport.ts:AudioTransport]`: Opens and reconnects `WebSocket` connections to `/v1/attempts/${attempt_id}/audio`, sending JSON control frames and binary PCM frames.

## Verification
- Run: `npm --prefix worker test`
