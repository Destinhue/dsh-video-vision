import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAudio } from '../src/timeline.js';

// Synthesise PCM at the analyser's own rate so the VAD and the speech/music
// split can be tested without ffmpeg and without a fixture file.
const SR = 8000;

function pcm(seconds, sample) {
  const n = Math.round(seconds * SR);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, sample(i / SR, i)));
    buf.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return buf;
}

const fakeRun = (buf) => async () => ({ code: 0, stdout: buf, stderr: Buffer.alloc(0), ms: 1 });
const tone = (t, hz, amp) => Math.sin(2 * Math.PI * hz * t) * amp;

// A syllable: 90 ms of voiced sound, 30 ms of closure, carrier flipping between
// bright and dark so the spectral centroid moves too. That is the shape the
// analyser is meant to notice, and the shape a steady tone is not.
function syllable(t) {
  const period = t % 0.12;
  if (period > 0.09) return 0;
  const bright = Math.floor(t / 0.09) % 2 === 1;
  // Loud stressed syllables next to quiet ones, as in a spoken sentence.
  const amp = 0.10 + 0.85 * Math.abs(Math.sin(2 * Math.PI * 1.7 * t));
  return tone(t, bright ? 1200 : 330, amp);
}

test('a steady music-like tone is activity, not speech', async () => {
  const audio = await analyzeAudio({
    input: 'x.mp4', ffmpegPath: 'ffmpeg', run: fakeRun(pcm(4, (t) => tone(t, 220, 0.5))),
  });
  assert.equal(audio.hasAudio, true);
  assert.ok(audio.activity.length >= 1, 'a sustained tone is activity');
  assert.equal(audio.voiceDetected, false);
  assert.deepEqual(audio.speech, []);
});

test('syllable-like modulation is detected as speech', async () => {
  const audio = await analyzeAudio({
    input: 'x.mp4', ffmpegPath: 'ffmpeg', run: fakeRun(pcm(4, syllable)),
  });
  assert.equal(audio.voiceDetected, true, JSON.stringify(audio.activity));
  assert.ok(audio.speech.length >= 1);
  assert.ok(audio.speech[0].dur > 0.5);
});

test('pauses between sentences end a span, syllable closures do not', async () => {
  // Three 1 s utterances separated by 1.5 s of silence: three spans, not thirty.
  const audio = await analyzeAudio({
    input: 'x.mp4', ffmpegPath: 'ffmpeg', run: fakeRun(pcm(9, (t) => (t % 3 > 1 ? 0 : syllable(t)))),
  });
  assert.equal(audio.activity.length, 3, JSON.stringify(audio.activity));
  assert.ok(audio.activity.every((s) => s.dur >= 0.9));
});
