import { spawn } from 'node:child_process';
import { rm, stat } from 'node:fs/promises';
import { availableDiskBudget, assertDiskCapacity, type CapacityLimits } from '../../storage/capacity.js';
import { fingerprintAudio } from '../../storage/copyAudio.js';
import { CapacityError, InvalidAudioError, NormalizedAudioTooLargeError } from '../../storage/errors.js';

const peakLimit = -2;
const target = `loudnorm=I=-17:TP=${peakLimit}:LRA=50`;
const inputFormats: Readonly<Record<string, string>> = {
  '.mp3': 'mp3', '.flac': 'flac', '.wav': 'wav', '.ogg': 'ogg',
  '.opus': 'ogg', '.m4a': 'mov', '.webm': 'matroska',
};

async function runFfmpeg(input: { path: string; extension: string }, output: string[], signal: AbortSignal, analysis: boolean) {
  signal.throwIfAborted();
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-nostdin', '-hide_banner', '-nostats', '-stats_period', '3600', '-loglevel', 'info', '-xerror',
      '-filter_threads', '1', '-max_alloc', '67108864', '-progress', 'pipe:1',
      '-protocol_whitelist', 'file', '-threads', '1', '-f', inputFormats[input.extension]!, '-i', input.path,
      '-map', '0:a:0', '-map_metadata', '-1', '-map_chapters', '-1', ...output,
    ], { signal, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', processError: Error | undefined;
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout = (stdout + chunk).slice(-4096); });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-32768); });
    child.on('error', error => { processError = error; });
    // Wait for the process and its pipes before releasing the slot or deleting its output.
    child.once('close', (code, termination) => {
      if (signal.aborted) return reject(signal.reason);
      if (processError) return reject(processError);
      if (code === 0) return resolve({ stdout, stderr });
      if (stderr.includes('No space left on device')) return reject(new CapacityError('Insufficient space for normalized audio'));
      if (analysis && code !== null) return reject(new InvalidAudioError('FFmpeg could not decode uploaded audio'));
      // FFmpeg stderr can include arbitrary embedded tags. Keep it out of server logs.
      reject(new Error(`FFmpeg ${analysis ? 'analysis' : 'encoding'} failed (${code ?? termination ?? 'unknown'})`));
    });
  });
}

function finishedAt(progress: string) {
  const time = Number([...progress.matchAll(/^out_time_us=(\d+)\r?$/gm)].at(-1)?.[1]);
  if (!Number.isSafeInteger(time) || time <= 0 || !/^progress=end\r?$/m.test(progress)) {
    throw new InvalidAudioError('FFmpeg did not finish a non-empty audio stream');
  }
  return time;
}

function measuredOptions(stderr: string) {
  const json = stderr.match(/\{\s*"input_i"\s*:[^{}]+\}/g)?.at(-1);
  if (!json) throw new Error('FFmpeg did not return loudness measurements');
  const stats = JSON.parse(json) as Record<string, unknown>;
  return Object.entries({ input_i: 'measured_I', input_tp: 'measured_TP', input_lra: 'measured_LRA',
    input_thresh: 'measured_thresh', target_offset: 'offset' }).map(([key, option]) => {
    const value = stats[key];
    if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value))) {
      throw new InvalidAudioError('Audio has no measurable integrated loudness');
    }
    return `${option}=${value}`;
  }).join(':');
}

export async function normalizeUpload(input: { path: string; extension: string }, destination: string,
  audioRoot: string, limits: CapacityLimits, signal: AbortSignal) {
  const analysis = await runFfmpeg(input, ['-af', `aresample=48000,${target}:print_format=json`, '-ar', '48000', '-f', 'null', '-'], signal, true);
  const inputTime = finishedAt(analysis.stdout);
  const measured = measuredOptions(analysis.stderr);
  const diskBudget = await availableDiskBudget(audioRoot, limits.minFreeBytes);
  const maxOutput = Math.min(limits.maxBytes, diskBudget);
  if (maxOutput <= 0) throw new CapacityError('Insufficient space for normalized audio');
  const render = async (trimDb: number) => {
    const filter = `aresample=48000,${target}:${measured}:linear=true,aresample=48000,` +
      `volume=${trimDb}dB,ebur128=peak=true:framelog=verbose`;
    const encoded = await runFfmpeg(input, [
      '-af', filter, '-ar', '48000', '-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24',
      '-threads', '1', '-fflags', '+bitexact', '-flags:a', '+bitexact', '-fs', String(maxOutput + 1),
      '-f', 'flac', destination,
    ], signal, false);
    const size = (await stat(destination)).size;
    // FFmpeg's -fs may exit successfully with partial audio and can exceed the limit by a packet.
    const time = finishedAt(encoded.stdout);
    if (size > maxOutput || time + 10_000 < inputTime) {
      if (diskBudget < limits.maxBytes) throw new CapacityError('Insufficient space for normalized audio');
      throw new NormalizedAudioTooLargeError('Normalized audio exceeds file size limit');
    }
    const summary = encoded.stderr.slice(encoded.stderr.lastIndexOf('Summary:'));
    const peak = Number(summary.match(/True peak:\s+Peak:\s+(-?\d+(?:\.\d+)?)\s+dBFS/)?.[1]);
    if (!Number.isFinite(peak)) throw new Error('FFmpeg did not return output true peak');
    return { size, time, peak };
  };
  let result = await render(0);
  if (result.peak > peakLimit) {
    // The 192 kHz dynamic mode can produce new peaks when resampled for playback.
    await rm(destination);
    result = await render(peakLimit - result.peak - 0.1);
    if (result.peak > peakLimit) throw new Error('Normalized audio still exceeds the true-peak ceiling');
  }
  await assertDiskCapacity(audioRoot, 0, limits.minFreeBytes);
  const fingerprint = await fingerprintAudio(destination, maxOutput);
  if (!fingerprint?.byteSize || fingerprint.byteSize !== result.size) throw new Error('Normalized audio changed before import');
  return { ...fingerprint, durationSeconds: result.time / 1_000_000 };
}
