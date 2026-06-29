// Summer Escape renderer v3 — memory-flat drop-in replacement for /render
// Input  (JSON): { audioBase64List: [b64, b64, ...], coverBase64, width, height, seconds, crossfade }
//   (also still accepts a single audioBase64 for backward compatibility)
// Output: an MP4 file (binary) — identical contract to v2, so n8n keeps piping it to YouTube.
//
// Why this rewrite:
//   v2 built the 30-min track by cycling the source tracks into ~10-15 SEGMENTS, then opened
//   ONE ffmpeg input + decoder per segment and chained them all through a single giant
//   acrossfade filter graph. That keeps every segment's decoder + resampler alive at once,
//   which blows past a 1 GB container and gets ffmpeg OOM-killed (exit "null") ~26s in.
//
//   v3 never opens more than 2 audio inputs in any single ffmpeg process:
//     Stage A  build a crossfaded "unit" from the UNIQUE tracks (inputs = unique count, small)
//     Stage B  extend the unit to >= target by acrossfading it with ITSELF, doubling each pass,
//              one short-lived ffmpeg process per pass (memory released between passes)
//     Stage C  mux the finished audio with the looped cover image (2 inputs) -> final.mp4
//   Peak memory is bounded by ~2 decoders regardless of final length.
//   crossfade=0 is now honored (plain concat, no fade) instead of being silently forced to 3.

const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const app = express();
app.use(express.json({ limit: '300mb' }));

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} failed (${code}): ${err.slice(-1500)}`))));
  });
}

function ffprobeDuration(file) {
  return new Promise((resolve) => {
    const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file]);
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.on('error', () => resolve(0));
    p.on('close', () => {
      const d = parseFloat(out.trim());
      resolve(isFinite(d) && d > 0 ? d : 0);
    });
  });
}

// Normalize one source track to a clean intermediate (flac = lossless, ~half the size of wav on disk).
async function normalizeTrack(src, dst) {
  await run('ffmpeg', [
    '-y', '-i', src,
    '-af', 'aresample=44100,aformat=sample_fmts=s16:channel_layouts=stereo',
    '-c:a', 'flac', '-compression_level', '0',
    dst,
  ]);
}

// Join two on-disk audio files into one, either with an acrossfade (xf>0) or a plain concat (xf<=0).
// Only ever 2 inputs -> memory stays tiny no matter how long the inputs are.
async function joinTwo(a, b, dst, xf) {
  if (xf > 0) {
    await run('ffmpeg', [
      '-y', '-i', a, '-i', b,
      '-filter_complex', `[0:a][1:a]acrossfade=d=${xf}:c1=tri:c2=tri[o]`,
      '-map', '[o]', '-c:a', 'flac', '-compression_level', '0',
      dst,
    ]);
  } else {
    await run('ffmpeg', [
      '-y', '-i', a, '-i', b,
      '-filter_complex', `[0:a][1:a]concat=n=2:v=0:a=1[o]`,
      '-map', '[o]', '-c:a', 'flac', '-compression_level', '0',
      dst,
    ]);
  }
}

app.get('/', (_req, res) => res.json({ ok: true, service: 'summer-escape-renderer-v3' }));

app.post('/render', async (req, res) => {
  const body = req.body || {};
  const width = parseInt(body.width, 10) || 1920;
  const height = parseInt(body.height, 10) || 1080;
  const seconds = parseInt(body.seconds, 10) || 1800;

  // Honor crossfade=0 (plain concat). Default to 3 only when the value is missing/invalid.
  const xfRaw = parseFloat(body.crossfade);
  const XF = Number.isFinite(xfRaw) ? Math.max(0, xfRaw) : 3;

  let list = body.audioBase64List;
  if (!Array.isArray(list) || list.length === 0) {
    list = body.audioBase64 ? [body.audioBase64] : null;
  }
  if (!list) return res.status(400).json({ status: 'error', message: 'No audio provided' });
  if (!body.coverBase64) return res.status(400).json({ status: 'error', message: 'No cover provided' });

  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'render-'));
  const cleanup = () => fsp.rm(work, { recursive: true, force: true }).catch(() => {});

  try {
    const units = [];
    for (let i = 0; i < list.length; i++) {
      const raw = path.join(work, `raw_${i}.mp3`);
      await fsp.writeFile(raw, Buffer.from(list[i], 'base64'));
      const norm = path.join(work, `unit_${i}.flac`);
      await normalizeTrack(raw, norm);
      await fsp.rm(raw, { force: true }).catch(() => {});
      units.push(norm);
    }
    const cover = path.join(work, 'cover.png');
    await fsp.writeFile(cover, Buffer.from(body.coverBase64, 'base64'));

    let unit = units[0];
    for (let i = 1; i < units.length; i++) {
      const next = path.join(work, `seqA_${i}.flac`);
      await joinTwo(unit, units[i], next, XF);
      unit = next;
    }

    const target = seconds + (XF > 0 ? XF : 0) + 2;
    let cur = unit;
    let curDur = await ffprobeDuration(cur);
    if (!curDur) curDur = 180;
    let pass = 0;
    while (curDur < target) {
      const next = path.join(work, `ext_${pass}.flac`);
      await joinTwo(cur, cur, next, XF);
      if (cur.includes(path.sep + 'ext_')) await fsp.rm(cur, { force: true }).catch(() => {});
      cur = next;
      curDur = XF > 0 ? curDur * 2 - XF : curDur * 2;
      pass++;
      if (pass > 20) break;
    }

    const fadeOutStart = Math.max(0, seconds - 4);
    const aFilter = `[0:a]afade=t=in:st=0:d=2,afade=t=out:st=${fadeOutStart}:d=4,atrim=0:${seconds},asetpts=N/SR/TB[aout]`;
    const vFilter = `[1:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=2,format=yuv420p[vout]`;

    const out = path.join(work, 'final.mp4');
    await run('ffmpeg', [
      '-y',
      '-i', cur,
      '-loop', '1', '-i', cover,
      '-filter_complex', `${aFilter};${vFilter}`,
      '-map', '[vout]', '-map', '[aout]',
      '-c:v', 'libx264', '-tune', 'stillimage', '-preset', 'veryfast',
      '-c:a', 'aac', '-b:a', '192k',
      '-t', String(seconds),
      '-movflags', '+faststart',
      out,
    ]);

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="render.mp4"');
    const stream = fs.createReadStream(out);
    stream.pipe(res);
    stream.on('close', cleanup);
    stream.on('error', () => { cleanup(); });
  } catch (err) {
    console.error(err);
    cleanup();
    res.status(500).json({ status: 'error', message: err.message });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log('renderer v3 listening on ' + port));
