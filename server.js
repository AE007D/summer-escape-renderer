const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "5mb" }));

const PORT = process.env.PORT || 8080;
const RENDER_TOKEN = process.env.RENDER_TOKEN || "";

function fail(res, code, msg, extra) {
  console.error("[render] " + code + " " + msg, extra || "");
  res.status(code).json({ error: msg, ...(extra ? { detail: extra } : {}) });
}

async function download(url, destPath) {
  const resp = await fetch(url, { redirect: "follow" });
  if (!resp.ok) throw new Error("download failed " + resp.status + " for " + url);
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(destPath, buf);
  return destPath;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    ff.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    ff.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error("ffmpeg exited " + code + "\n" + stderr));
    });
    ff.on("error", reject);
  });
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/render", async (req, res) => {
  if (RENDER_TOKEN) {
    const auth = req.headers.authorization || "";
    if (auth !== "Bearer " + RENDER_TOKEN) {
      return fail(res, 401, "unauthorized");
    }
  }

  const { audioUrl, coverUrl } = req.body || {};
  const width = parseInt(req.body && req.body.width, 10) || 1920;
  const height = parseInt(req.body && req.body.height, 10) || 1080;

  if (!audioUrl || !coverUrl) {
    return fail(res, 400, "audioUrl and coverUrl are required");
  }

  const id = crypto.randomBytes(6).toString("hex");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "render-" + id + "-"));
  const audioPath = path.join(dir, "audio.mp3");
  const coverPath = path.join(dir, "cover.img");
  const outPath = path.join(dir, "out.mp4");

  try {
    console.log("[render " + id + "] downloading inputs");
    await download(audioUrl, audioPath);
    await download(coverUrl, coverPath);

    console.log("[render " + id + "] rendering " + width + "x" + height);
    // -framerate 1 on the looped image input so ffmpeg produces frames at the
    // target rate directly instead of generating 25fps and dropping frames
    // (which was exhausting memory). -shortest stops at end of audio.
    await runFfmpeg([
      "-y",
      "-loop", "1",
      "-framerate", "1",
      "-i", coverPath,
      "-i", audioPath,
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-tune", "stillimage",
      "-pix_fmt", "yuv420p",
      "-vf",
      "scale=" + width + ":" + height + ":force_original_aspect_ratio=decrease,pad=" + width + ":" + height + ":(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p",
      "-r", "1",
      "-c:a", "aac",
      "-b:a", "192k",
      "-shortest",
      "-fflags", "+shortest",
      "-movflags", "+faststart",
      outPath,
    ]);

    const stat = fs.statSync(outPath);
    console.log("[render " + id + "] done, " + (stat.size / 1e6).toFixed(1) + " MB");

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Content-Disposition", 'attachment; filename="render-' + id + '.mp4"');

    const stream = fs.createReadStream(outPath);
    stream.pipe(res);
    stream.on("close", () => {
      fs.rm(dir, { recursive: true, force: true }, () => {});
    });
  } catch (err) {
    fs.rm(dir, { recursive: true, force: true }, () => {});
    return fail(res, 500, "render failed", String(err.message || err));
  }
});

app.listen(PORT, () => {
  console.log("renderer listening on :" + PORT);
});
