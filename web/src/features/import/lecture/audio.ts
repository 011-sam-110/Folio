// Pulling 16kHz mono Float32 audio out of a lecture MP4, in the browser, with no ffmpeg.
//
// WebAudio does the whole job: `decodeAudioData` resamples to the sample rate of the
// BaseAudioContext it is called on, so decoding on an OfflineAudioContext constructed at
// 16000Hz yields Whisper's required rate directly, and rendering that through a 1-channel
// context downmixes to mono. No WASM, no extra dependency.
//
// The unavoidable cost is memory: decodeAudioData has no streaming form, so the compressed
// file has to be handed over as one ArrayBuffer, and 53 minutes of 16kHz mono Float32 is
// ~204MB on its own. References are dropped as early as possible to keep the peak down, and
// `estimateAudioMemoryMb` lets the UI warn before a very long video is attempted.

/** Whisper is trained on 16kHz mono; anything else has to be resampled anyway. */
export const TARGET_SAMPLE_RATE = 16000;

export interface DecodedAudio {
  samples: Float32Array;
  sampleRate: number;
  durationSeconds: number;
}

/** Rough peak heap for decoding `durationSeconds` of audio, used to warn before we try. */
export function estimateAudioMemoryMb(durationSeconds: number, fileSizeBytes: number): number {
  const mono = (durationSeconds * TARGET_SAMPLE_RATE * 4) / 1024 / 1024;
  // Worst case the decode lands as stereo before the downmix, plus the compressed file itself.
  return Math.round(mono * 3 + fileSizeBytes / 1024 / 1024);
}

function hasWebAudio(): boolean {
  return typeof OfflineAudioContext !== 'undefined' || typeof (globalThis as { webkitOfflineAudioContext?: unknown }).webkitOfflineAudioContext !== 'undefined';
}

/**
 * Decodes the audio track of a media file to 16kHz mono Float32.
 *
 * @param durationHint the video's duration; used to size the offline context.
 */
export async function decodeAudioTo16kMono(
  file: File,
  durationHint: number,
  signal?: AbortSignal,
): Promise<DecodedAudio> {
  if (!hasWebAudio()) {
    throw new Error('This browser has no Web Audio support, so audio cannot be extracted for transcription.');
  }

  // One unavoidable full read — decodeAudioData cannot stream.
  let buffer: ArrayBuffer | null = await file.arrayBuffer();
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');

  const Ctor: typeof OfflineAudioContext =
    typeof OfflineAudioContext !== 'undefined'
      ? OfflineAudioContext
      : (globalThis as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;

  const frames = Math.max(1, Math.ceil(durationHint * TARGET_SAMPLE_RATE));
  const ctx = new Ctor(1, frames, TARGET_SAMPLE_RATE);

  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(buffer);
  } catch {
    throw new Error(
      "The audio track couldn't be decoded. The file may have no audio, or use a codec this browser can't read.",
    );
  } finally {
    // Let the compressed copy go before the decoded copy is expanded any further.
    buffer = null;
  }
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');

  // Already mono at the target rate: hand the channel straight back, no second copy.
  if (decoded.numberOfChannels === 1 && decoded.sampleRate === TARGET_SAMPLE_RATE) {
    const samples = decoded.getChannelData(0);
    return { samples, sampleRate: TARGET_SAMPLE_RATE, durationSeconds: samples.length / TARGET_SAMPLE_RATE };
  }

  // Otherwise let the audio engine do the downmix.
  const src = ctx.createBufferSource();
  src.buffer = decoded;
  src.connect(ctx.destination);
  src.start();
  const rendered = await ctx.startRendering();
  const samples = rendered.getChannelData(0);
  return { samples, sampleRate: TARGET_SAMPLE_RATE, durationSeconds: samples.length / TARGET_SAMPLE_RATE };
}
