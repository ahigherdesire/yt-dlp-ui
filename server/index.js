import cors from "cors";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT || 5179);
const ytdlpBin = process.env.YTDLP_PATH || "yt-dlp";
const defaultOutputDir = path.join(os.homedir(), "Downloads", "yt-dlp-ui");
const jobs = new Map();

fs.mkdirSync(defaultOutputDir, { recursive: true });

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error("Origin is not allowed"));
    }
  })
);
app.use(express.json({ limit: "1mb" }));

function validateMediaUrl(value) {
  if (typeof value !== "string" || value.trim().length < 8 || value.length > 5000) {
    throw new Error("Enter a valid media URL.");
  }

  const parsed = new URL(value.trim());
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http and https URLs are supported.");
  }

  return parsed.toString();
}

function normalizeOutputDir(value) {
  if (!value || typeof value !== "string") {
    return defaultOutputDir;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\0")) {
    return defaultOutputDir;
  }

  const expanded = trimmed
    .replace(/^~(?=$|[\\/])/, os.homedir())
    .replace(/^%USERPROFILE%/i, os.homedir());
  const resolved = path.resolve(expanded);
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

function runYtdlp(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ytdlpBin, args, {
      windowsHide: true,
      ...options
    });
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }

      reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
    });
  });
}

async function getYtdlpVersion() {
  try {
    return (await runYtdlp(["--version"])).trim();
  } catch {
    return null;
  }
}

function simplifyMetadata(info) {
  const rawFormats = Array.isArray(info.formats) ? info.formats : [];
  const formats = rawFormats
    .filter((format) => format.format_id)
    .map((format) => ({
      id: String(format.format_id),
      ext: format.ext || "",
      resolution: format.resolution || (format.height ? `${format.height}p` : "audio"),
      height: format.height || 0,
      fps: format.fps || null,
      vcodec: format.vcodec || "none",
      acodec: format.acodec || "none",
      filesize: format.filesize || format.filesize_approx || null,
      tbr: format.tbr || null,
      label: format.format || `${format.format_id} ${format.ext || ""}`.trim()
    }))
    .sort((a, b) => b.height - a.height || (b.tbr || 0) - (a.tbr || 0))
    .slice(0, 160);

  return {
    id: info.id,
    title: info.title || "Untitled media",
    channel: info.channel || info.uploader || "",
    duration: info.duration || null,
    webpageUrl: info.webpage_url || "",
    extractor: info.extractor_key || info.extractor || "",
    thumbnail: info.thumbnail || "",
    formats
  };
}

function createJob(payload) {
  const now = new Date().toISOString();
  const job = {
    id: randomUUID(),
    status: "queued",
    progress: 0,
    speed: "",
    eta: "",
    title: payload.title || "",
    url: payload.url,
    preset: payload.preset,
    outputDir: payload.outputDir,
    outputPath: "",
    error: "",
    logs: [],
    createdAt: now,
    updatedAt: now,
    proc: null,
    clients: new Set()
  };
  jobs.set(job.id, job);
  return job;
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    speed: job.speed,
    eta: job.eta,
    title: job.title,
    url: job.url,
    preset: job.preset,
    outputDir: job.outputDir,
    outputPath: job.outputPath,
    error: job.error,
    logs: job.logs.slice(-20),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
}

function emitJob(job, event = "job") {
  const payload = JSON.stringify(publicJob(job));
  for (const client of job.clients) {
    client.write(`event: ${event}\n`);
    client.write(`data: ${payload}\n\n`);
  }
}

function updateJob(job, patch, event = "job") {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  emitJob(job, event);
}

function addLog(job, rawLine) {
  const line = rawLine.trim();
  if (!line) return;

  job.logs.push(line);
  if (job.logs.length > 240) {
    job.logs.splice(0, job.logs.length - 240);
  }

  const progressMatch = line.match(/\[download\]\s+([\d.]+)%.*?(?:at\s+([^\s]+\/s))?.*?(?:ETA\s+([^\s]+))?/);
  if (progressMatch) {
    updateJob(job, {
      status: "running",
      progress: Math.min(100, Number(progressMatch[1])),
      speed: progressMatch[2] || job.speed,
      eta: progressMatch[3] || job.eta
    });
    return;
  }

  const destinationMatch = line.match(/\[download\]\s+Destination:\s+(.+)$/);
  const mergeMatch = line.match(/\[Merger\]\s+Merging formats into\s+"(.+)"$/);
  if (destinationMatch || mergeMatch) {
    updateJob(job, {
      outputPath: destinationMatch?.[1] || mergeMatch?.[1] || job.outputPath
    });
    return;
  }

  emitJob(job);
}

function parseTimestamp(value) {
  if (!value || typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (!/^(\d{1,2}:)?\d{1,2}:\d{2}(\.\d{1,3})?$|^\d+(\.\d{1,3})?$/.test(trimmed)) {
    throw new Error("Use timestamps like 01:24, 1:02:30, or seconds.");
  }

  return trimmed;
}

function buildDownloadArgs(body, outputDir) {
  const preset = body.preset || "mp4";
  const args = ["--newline", "--no-color", "-P", outputDir, "-o", "%(title).180B [%(id)s].%(ext)s"];

  if (body.playlistMode === "playlist") {
    args.push("--yes-playlist");
  } else {
    args.push("--no-playlist");
  }

  if (body.includeSubtitles) {
    args.push("--write-subs", "--write-auto-subs", "--sub-langs", body.subtitleLanguages || "en.*,en", "--convert-subs", "srt");
  }

  if (body.writeThumbnail) {
    args.push("--write-thumbnail");
  }

  if (body.embedMetadata) {
    args.push("--embed-metadata");
  }

  const rangeStart = parseTimestamp(body.rangeStart);
  const rangeEnd = parseTimestamp(body.rangeEnd);
  if (body.rangeEnabled && (rangeStart || rangeEnd)) {
    args.push("--download-sections", `*${rangeStart}-${rangeEnd}`, "--force-keyframes-at-cuts");
  }

  if (preset === "custom") {
    if (!body.formatId || typeof body.formatId !== "string") {
      throw new Error("Pick a format ID for a custom download.");
    }
    args.push("-f", body.formatId.trim());
  } else if (preset === "mp3" || preset === "m4a" || preset === "opus" || preset === "flac" || preset === "wav") {
    args.push("-x", "--audio-format", preset, "--audio-quality", body.audioQuality || "0");
  } else if (preset === "webm") {
    args.push("-f", "bv*[ext=webm]+ba[ext=webm]/b[ext=webm]/bv*+ba/best", "--merge-output-format", "webm");
  } else if (preset === "mkv") {
    args.push("-f", "bv*+ba/best", "--merge-output-format", "mkv");
  } else if (preset === "best") {
    args.push("-f", "bv*+ba/best");
  } else {
    args.push("-f", "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/best", "--merge-output-format", "mp4");
  }

  args.push(body.url);
  return args;
}

app.get("/api/health", async (_req, res) => {
  res.json({
    ok: true,
    ytdlpVersion: await getYtdlpVersion(),
    outputDir: defaultOutputDir,
    port
  });
});

app.post("/api/metadata", async (req, res) => {
  try {
    const url = validateMediaUrl(req.body.url);
    const stdout = await runYtdlp(["--dump-single-json", "--no-warnings", "--no-playlist", url]);
    res.json({ metadata: simplifyMetadata(JSON.parse(stdout)) });
  } catch (error) {
    res.status(400).json({ error: error.message || "Could not inspect this URL." });
  }
});

app.get("/api/jobs", (_req, res) => {
  res.json({
    jobs: Array.from(jobs.values())
      .map(publicJob)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  });
});

app.post("/api/download", (req, res) => {
  try {
    const url = validateMediaUrl(req.body.url);
    const outputDir = normalizeOutputDir(req.body.outputDir);
    const args = buildDownloadArgs({ ...req.body, url }, outputDir);
    const job = createJob({
      url,
      title: req.body.title,
      preset: req.body.preset || "mp4",
      outputDir
    });

    updateJob(job, { status: "running" });
    const child = spawn(ytdlpBin, args, { windowsHide: true });
    job.proc = child;

    const handleChunk = (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        addLog(job, line);
      }
    };

    child.stdout?.on("data", handleChunk);
    child.stderr?.on("data", handleChunk);
    child.on("error", (error) => {
      updateJob(job, { status: "failed", error: error.message }, "done");
    });
    child.on("close", (code) => {
      job.proc = null;
      if (job.status === "cancelled") {
        emitJob(job, "done");
        return;
      }

      if (code === 0) {
        updateJob(job, { status: "complete", progress: 100, eta: "" }, "done");
        return;
      }

      updateJob(job, {
        status: "failed",
        error: job.logs.slice(-8).join("\n") || `yt-dlp exited with code ${code}`
      }, "done");
    });

    res.status(202).json({ job: publicJob(job) });
  } catch (error) {
    res.status(400).json({ error: error.message || "Could not start this download." });
  }
});

app.get("/api/jobs/:id/events", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Job not found." });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write(`event: job\n`);
  res.write(`data: ${JSON.stringify(publicJob(job))}\n\n`);

  job.clients.add(res);
  req.on("close", () => job.clients.delete(res));
});

app.post("/api/jobs/:id/cancel", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Job not found." });
    return;
  }

  if (job.proc && job.status === "running") {
    updateJob(job, { status: "cancelled", eta: "" }, "done");
    job.proc.kill("SIGTERM");
  }

  res.json({ job: publicJob(job) });
});

app.post("/api/open-folder", (req, res) => {
  try {
    const targetDir = normalizeOutputDir(req.body.outputDir);
    const explorer = spawn("explorer.exe", [targetDir], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    explorer.unref();
    res.json({ ok: true, outputDir: targetDir });
  } catch (error) {
    res.status(400).json({ error: error.message || "Could not open this folder." });
  }
});

const distDir = path.resolve(__dirname, "..", "dist");
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.use((req, res, next) => {
    if (req.method !== "GET") {
      next();
      return;
    }

    res.sendFile(path.join(distDir, "index.html"));
  });
}

app.listen(port, "127.0.0.1", () => {
  console.log(`YDL Studio API listening on http://127.0.0.1:${port}`);
});
