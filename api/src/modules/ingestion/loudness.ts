import { spawn } from 'node:child_process';
import { rm, stat } from 'node:fs/promises';
import { availableDiskBudget, assertDiskCapacity, type CapacityLimits } from '../../storage/capacity.js';
import { fingerprintAudio } from '../../storage/copyAudio.js';
import { CapacityError, InvalidAudioError, NormalizedAudioTooLargeError } from '../../storage/errors.js';

const peakLimit = -2;
const loudnessTarget = -17;
const rangeTarget = 50;
const peakHeadroomDb = 0.5;
const loudnessToleranceLu = 0.5;
const target = `loudnorm=I=${loudnessTarget}:TP=${peakLimit}:LRA=${rangeTarget}`;
const sampleClock = 'asetpts=N/SR/TB';
const meterFilter = `aresample=48000,${sampleClock},ebur128=peak=true:framelog=verbose`;
// Some encoders and containers add or drop a few frames of codec delay or padding.
const durationToleranceUs = 100_000;
const opus = ['-c:a', 'libopus', '-b:a', '128k'];
const formats: Readonly<Record<string, { demuxer: string; muxer: string; encode: string[] }>> = {
  '.mp3': { demuxer: 'mp3', muxer: 'mp3', encode: ['-c:a', 'libmp3lame', '-q:a', '2'] },
  '.flac': { demuxer: 'flac', muxer: 'flac', encode: ['-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24'] },
  '.wav': { demuxer: 'wav', muxer: 'wav', encode: ['-c:a', 'pcm_s24le'] },
  '.ogg': { demuxer: 'ogg', muxer: 'ogg', encode: ['-c:a', 'libvorbis', '-q:a', '5'] },
  '.opus': { demuxer: 'ogg', muxer: 'ogg', encode: opus },
  '.m4a': { demuxer: 'mov', muxer: 'ipod', encode: ['-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'] },
  '.webm': { demuxer: 'matroska', muxer: 'webm', encode: opus },
};

async function runFfmpeg(path: string, demuxer: string, output: string[], signal: AbortSignal,
  { source = false, map = '0:a:0' } = {}) {
  signal.throwIfAborted();
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-nostdin', '-hide_banner', '-nostats', '-stats_period', '3600', '-loglevel', 'info', '-xerror',
      '-filter_threads', '1', '-filter_complex_threads', '1', '-max_alloc', '67108864', '-progress', 'pipe:1',
      '-protocol_whitelist', 'file', '-threads', '1', '-f', demuxer, '-i', path,
      '-map', map, '-map_metadata', '-1', '-map_chapters', '-1', ...output,
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
      if (source && code !== null) return reject(new InvalidAudioError('FFmpeg could not decode uploaded audio'));
      // FFmpeg stderr can include arbitrary embedded tags. Keep it out of server logs.
      reject(new Error(`FFmpeg ${source ? 'analysis' : 'processing'} failed (${code ?? termination ?? 'unknown'})`));
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

async function measureAudio(path: string, demuxer: string, signal: AbortSignal, source = false) {
  const result = await runFfmpeg(path, demuxer, ['-af', meterFilter, '-f', 'null', '-'], signal, { source });
  const summary = result.stderr.slice(result.stderr.lastIndexOf('Summary:'));
  return {
    time: finishedAt(result.stdout),
    loudness: Number(summary.match(/Integrated loudness:\s+I:\s+([+-]?\d+(?:\.\d+)?)\s+LUFS/)?.[1]),
    range: Number(summary.match(/Loudness range:\s+LRA:\s+(\d+(?:\.\d+)?)\s+LU/)?.[1]),
    peak: Number(summary.match(/True peak:\s+Peak:\s+([+-]?\d+(?:\.\d+)?)\s+dBFS/)?.[1]),
  };
}

export async function normalizeUpload(input: { path: string; extension: string }, destination: string,
  audioRoot: string, limits: CapacityLimits, signal: AbortSignal, expected?: { byteSize: number; sha256: string }) {
  const format = formats[input.extension.toLowerCase()];
  if (!format) throw new InvalidAudioError('Unsupported audio extension');
  const original = await measureAudio(input.path, format.demuxer, signal, true);
  const diskBudget = await availableDiskBudget(audioRoot, limits.minFreeBytes);
  const maxOutput = Math.min(limits.maxBytes, diskBudget);
  if (maxOutput <= 0) throw new CapacityError('Insufficient space for normalized audio');
  const render = async (filter: string) => {
    await runFfmpeg(input.path, format.demuxer, [
      '-af', filter, '-ar', '48000', ...format.encode,
      '-threads', '1', '-fflags', '+bitexact', '-flags:a', '+bitexact', '-fs', String(maxOutput + 1),
      '-f', format.muxer, destination,
    ], signal);
    const size = (await stat(destination)).size;
    // FFmpeg's -fs can exceed the limit by a packet. Classify size errors using actual bytes only.
    if (size > maxOutput) {
      if (diskBudget < limits.maxBytes) throw new CapacityError('Insufficient space for normalized audio');
      throw new NormalizedAudioTooLargeError('Normalized audio exceeds file size limit');
    }
    // A capped render may still exit successfully. Verify decoded length and peak in the final file.
    const checks = await measureAudio(destination, format.demuxer, signal);
    if (checks.time + durationToleranceUs < original.time) {
      throw new Error(`Normalized audio is incomplete (${checks.time} of ${original.time} microseconds)`);
    }
    if (!Number.isFinite(checks.peak)) throw new Error('FFmpeg did not return output true peak');
    return { size, ...checks };
  };
  const fingerprint = async ({ size, time }: { size: number; time: number }) => {
    await assertDiskCapacity(audioRoot, 0, limits.minFreeBytes);
    const result = await fingerprintAudio(destination, maxOutput);
    if (!result?.byteSize || result.byteSize !== size) throw new Error('Normalized audio changed before import');
    return { ...result, durationSeconds: time / 1_000_000 };
  };

  // EBU's summary is rounded to a tenth. Leave room for rounding and overshoot from lossy encoders.
  const gain = Number((loudnessTarget - original.loudness).toFixed(1));
  if (original.loudness > -69.9 && original.range < rangeTarget && original.peak + gain <= peakLimit - peakHeadroomDb) {
    const quick = await render(`aresample=48000,volume=${gain}dB:precision=double`);
    if (quick.peak <= peakLimit && quick.range <= rangeTarget && Math.abs(quick.loudness - loudnessTarget) <= loudnessToleranceLu) {
      const result = await fingerprint(quick);
      if (!expected || (result.sha256 === expected.sha256 && result.byteSize === expected.byteSize)) return result;
    }
    // Preserve the ability to regenerate bytes for songs stored by the original full loudnorm workflow.
    await rm(destination);
  }

  const analysisFilter = `[0:a:0]aresample=48000,asplit=2[raw][meter];[raw]${sampleClock}[clock];` +
    `[meter]${target}:print_format=json,anullsink`;
  const analysis = await runFfmpeg(input.path, format.demuxer,
    ['-filter_complex', analysisFilter, '-ar', '48000', '-f', 'null', '-'], signal, { source: true, map: '[clock]' });
  const measured = measuredOptions(analysis.stderr);
  const fullFilter = (trimDb: number) => `aresample=48000,${target}:${measured}:linear=true,aresample=48000,volume=${trimDb}dB`;
  let trimDb = 0;
  let result = await render(fullFilter(0));
  for (let retry = 0; retry < 2 && result.peak > peakLimit; retry++) {
    trimDb -= result.peak - peakLimit + 0.2;
    await rm(destination);
    result = await render(fullFilter(trimDb));
  }
  if (result.peak > peakLimit) throw new Error('Normalized audio still exceeds the true-peak ceiling');
  return fingerprint(result);
}
