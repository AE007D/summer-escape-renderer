const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const app = express();
// Big limit: a base64 30-min MP3 can be ~10-15 MB -> ~20 MB encoded
app.use(express.json({ limit: "80mb" }));

const PORT = process.env.PORT || 8080;
const RENDER_TOKEN = process.env.RENDER_TOKEN || "";
const TARGET_SECONDS = 30 * 60; // 30 minutes

function fail(res, code, msg, extra) {
  console.error("[render] " + code + " " + msg, extra || "");
  if (!res.headersSent) res.status(code).json({ error: msg, ...(extra ? { detail: extra } : {}) });
}

function checkAuth(req) {
  if (!RENDER_TOKEN) return true;
  return (req.headers.authorization || "") === "Bearer " + RENDER_TOKEN;
}

async function downloadTo(url, destPath) {
  const resp = await fetch(url, { redirect: "follow" });
  if (!resp.ok) throw new Error("download failed " + resp.status + " for " + url);
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(destPath, buf);
  return destPath;
}

function writeB64(b64, destPath) {
  const clean = String(b64).replace(/^data:[^;]+;base64,/, "");
  fs.writeFileSync(destPath, Buffer.from(clean, "base64"));
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
  if (!checkAuth(req)) return fail(res, 401, "unauthorized");

  const body = req.body || {};
  const width = parseInt(body.width, 10) || 1920;
  const height = parseInt(body.height, 10) || 1080;
  const loop = String(body.loop) !== "false";
  const seconds = parseInt(body.seconds, 10) || TARGET_SECONDS;

  const id = crypto.randomBytes(6).toString("hex");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "render-" + id + "-"));
  const audioPath = path.join(dir, "audio.mp3");
  const coverPath = path.join(dir, "cover.img");
  const outPath = path.join(dir, "out.mp4");

  try {
    if (body.audioBase64) writeB64(body.audioBase64, audioPath);
    else if (body.audioUrl) await downloadTo(body.audioUrl, audioPath);
    else return fail(res, 400, "audio required (audioBase64 or audioUrl)");

    if (body.coverBase64) writeB64(body.coverBase64, coverPath);
    else if (body.coverUrl) await downloadTo(body.coverUrl, coverPath);
    else return fail(res, 400, "cover required (coverBase64 or coverUrl)");

    console.log("[render " + id + "] " + width + "x" + height + " loop=" + loop + " seconds=" + seconds);

    const args = ["-y", "-loop", "1", "-framerate", "1", "-i", coverPath];
    if (loop) args.push("-stream_loop", "-1");
    args.push(
      "-i", audioPath,
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-tune", "stillimage",
      "-pix_fmt", "yuv420p",
      "-vf", "scale=" + width + ":" + height + ":force_original_aspect_ratio=decrease,pad=" + width + ":" + height + ":(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p",
      "-r", "1",
      "-c:a", "aac",
      "-b:a", "192k",
      "-t", String(seconds),
      "-movflags", "+faststart",
      outPath
    );

    await runFfmpeg(args);

    const stat = fs.statSync(outPath);
    console.log("[render " + id + "] done, " + (stat.size / 1e6).toFixed(1) + " MB");

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Content-Disposition", 'attachment; filename="render-' + id + '.mp4"');

    const stream = fs.createReadStream(outPath);
    stream.pipe(res);
    stream.on("close", () => fs.rm(dir, { recursive: true, force: true }, () => {}));
  } catch (err) {
    fs.rm(dir, { recursive: true, force: true }, () => {});
    return fail(res, 500, "render failed", String(err.message || err));
  }
});

app.listen(PORT, () => console.log("renderer listening on :" + PORT));
