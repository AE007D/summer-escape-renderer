// Summer Escape renderer v2 — drop-in replacement for /render
// Input  (JSON): { audioBase64List: [b64, b64, ...], coverBase64, width, height, seconds, crossfade }
//   (also still accepts a single audioBase64 for backward compatibility)
// Output: an MP4 file (binary) — same as before, so n8n keeps piping it straight to YouTube.
//
// What's new:
//  - Uses ALL tracks you drop, stitched in order.
//  - ~3s CROSSFADE at every join (track->track AND every loop wrap) => no audible gaps/cuts.
//  - Loops the sequence only as much as needed to reach `seconds`, then trims + fades out.
//  - Cover is scaled to FILL the whole frame (cover-crop), so it's full screen, no bars.

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

app.get('/', (_req, res) => res.json({ ok: true, service: 'summer-escape-renderer-v2' }));

app.post('/render', async (req, res) => {
  const body = req.body || {};
  const width = parseInt(body.width, 10) || 1920;
  const height = parseInt(body.height, 10) || 1080;
  const seconds = parseInt(body.seconds, 10) || 1800;
  const XF = Math.max(0.5, parseFloat(body.crossfade) || 3);

  let list = body.audioBase64List;
  if (!Array.isArray(list) || list.length === 0) {
    list = body.audioBase64 ? [body.audioBase64] : null;
  }
  if (!list) return res.status(400).json({ status: 'error', message: 'No audio provided' });
  if (!body.coverBase64) return res.status(400).json({ status: 'error', message: 'No cover provided' });

  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'render-'));
  try {
    // write each unique track + the cover
    const trackFiles = [];
    for (let i = 0; i < list.length; i++) {
      const f = path.join(work, `track_${i}.mp3`);
      await fsp.writeFile(f, Buffer.from(list[i], 'base64'));
      trackFiles.push(f);
    }
    const cover = path.join(work, 'cover.png');
    await fsp.writeFile(cover, Buffer.from(body.coverBase64, 'base64'));

    const durations = [];
    for (const f of trackFiles) durations.push(await ffprobeDuration(f));

    // Build a play sequence by cycling through the tracks until it covers `seconds`.
    // Crossfade overlap shortens the total, so we account for it and add a small buffer.
    const target = seconds + XF + 2;
    const seq = [];
    let effective = 0;
    let k = 0;
    while (effective < target) {
      const idx = k % trackFiles.length;
      const dur = durations[idx] || 180;
      effective += seq.length === 0 ? dur : Math.max(0.2, dur - XF);
      seq.push(idx);
      k++;
      if (seq.length > 600) break; // hard safety cap
    }

    // inputs: each segment (repeats allowed), then the cover image last
    const inArgs = [];
    seq.forEach((idx) => { inArgs.push('-i', trackFiles[idx]); });
    inArgs.push('-loop', '1', '-i', cover);
    const coverIdx = seq.length;

    // normalize every audio input so acrossfade never chokes on mismatched formats
    let filter = '';
    seq.forEach((_, i) => {
      filter += `[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[n${i}];`;
    });

    // crossfade-chain all segments -> [mix]
    if (seq.length === 1) {
      filter += `[n0]anull[mix];`;
    } else {
      let prev = 'n0';
      for (let i = 1; i < seq.length; i++) {
        const out = i === seq.length - 1 ? 'mix' : `x${i}`;
        filter += `[${prev}][n${i}]acrossfade=d=${XF}:c1=tri:c2=tri[${out}];`;
        prev = out;
      }
    }

    const fadeOutStart = Math.max(0, seconds - 4);
    filter += `[mix]afade=t=in:st=0:d=2,afade=t=out:st=${fadeOutStart}:d=4,atrim=0:${seconds},asetpts=N/SR/TB[aout];`;
    filter += `[${coverIdx}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=2,format=yuv420p[vout]`;

    const out = path.join(work, 'final.mp4');
    await run('ffmpeg', [
      '-y', ...inArgs,
      '-filter_complex', filter,
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
    stream.on('close', () => { fsp.rm(work, { recursive: true, force: true }).catch(() => {}); });
  } catch (err) {
    console.error(err);
    fsp.rm(work, { recursive: true, force: true }).catch(() => {});
    res.status(500).json({ status: 'error', message: err.message });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log('renderer v2 listening on ' + port));
