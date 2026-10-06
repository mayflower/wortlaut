import assert from 'node:assert/strict';
import {test} from 'node:test';
import {participantEvidence, receiveOptions} from '../src/webex';

test('join explicitly requests multistream and only receives audio', () => {
  const options = receiveOptions();
  assert.deepEqual(options.joinOptions, {enableMultistream: true});
  assert.deepEqual(options.mediaOptions.additionalMediaOptions,
    {sendAudio: false, sendVideo: false, receiveAudio: true, receiveVideo: false});
  assert.deepEqual(options.mediaOptions.remoteMediaManagerConfig.audio,
    {numOfActiveSpeakerStreams: 3, numOfScreenShareStreams: 1});
});

test('participant evidence separates signaled audio from share sources and follows roster changes', () => {
  let roster = {alice: {}, room: {}} as Record<string, unknown>;
  const calls: unknown[] = [];
  const meeting = {members: {
    membersCollection: {getAll: () => roster},
    getCsisForMember: (id: string, type: string, content: string) => {
      calls.push([id, type, content]);
      return id === 'alice' ? (content === 'main' ? [10, 11, 10] : [20]) : [];
    },
  }};
  const first = participantEvidence(meeting);
  assert.deepEqual(first, {available: true, total: 2, truncated: false, sources: [
    {participant_id: 'alice', audio_csis: [10, 11], share_audio_csis: [20]},
    {participant_id: 'room', audio_csis: [], share_audio_csis: []},
  ]});
  assert.deepEqual(calls, [['alice', 'audio', 'main'], ['alice', 'audio', 'slides'],
    ['room', 'audio', 'main'], ['room', 'audio', 'slides']]);
  roster = {room: {}};
  assert.deepEqual(participantEvidence(meeting).sources,
    [{participant_id: 'room', audio_csis: [], share_audio_csis: []}]);
  assert.equal(first.sources.length, 2);
  assert.deepEqual(participantEvidence(), {available: false, total: 0, truncated: false, sources: []});
});

test('oversized or invalid signaled source evidence is bounded and explicitly incomplete', () => {
  const meeting = {members: {
    membersCollection: {getAll: () => Object.fromEntries(
      Array.from({length: 257}, (_, id) => [`participant-${id}`, {}]))},
    getCsisForMember: () => [-1, NaN, 1.5, 0x100000000,
      ...Array.from({length: 65}, (_, csi) => csi)],
  }};
  const evidence = participantEvidence(meeting);
  assert.equal(evidence.total, 257);
  assert.equal(evidence.sources.length, 256);
  assert.equal(evidence.truncated, true);
  assert.deepEqual(evidence.sources[0].audio_csis, Array.from({length: 64}, (_, csi) => csi));
});
