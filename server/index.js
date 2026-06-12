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
const extensionDir = path.resolve(__dirname, "..", "extension");
const extensionZipName = "ydl-studio-capture-extension.zip";
const tempRootDir = path.join(os.tmpdir(), "yt-dlp-ui");
const jobs = new Map();

fs.mkdirSync(defaultOutputDir, { recursive: true });
fs.mkdirSync(tempRootDir, { recursive: true });

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
    tempDir: payload.tempDir,
    signature: payload.signature,
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

function getDownloadSignature(url, outputDir) {
  return `${url}\n${path.resolve(outputDir).toLowerCase()}`;
}

function findActiveDuplicate(signature) {
  for (const job of jobs.values()) {
    if (job.signature === signature && ["queued", "running"].includes(job.status)) {
      return job;
    }
  }

  return null;
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

function cleanupTempDir(job) {
  if (!job.tempDir || !path.resolve(job.tempDir).startsWith(path.resolve(tempRootDir))) {
    return;
  }

  fs.rm(job.tempDir, { recursive: true, force: true }, () => undefined);
}

const crcTable = new Uint32Array(256);
for (let index = 0; index < crcTable.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable[index] = value >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function getZipDateParts(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

function collectZipFiles(rootDir) {
  return fs
    .readdirSync(rootDir, { withFileTypes: true })
    .flatMap((entry) => {
      const fullPath = path.join(rootDir, entry.name);
      if (entry.isDirectory()) {
        return collectZipFiles(fullPath);
      }

      if (!entry.isFile()) {
        return [];
      }

      return [fullPath];
    })
    .sort((a, b) => a.localeCompare(b));
}

function buildZipFromDirectory(rootDir) {
  const fileParts = [];
  const centralParts = [];
  let offset = 0;

  for (const filePath of collectZipFiles(rootDir)) {
    const stat = fs.statSync(filePath);
    const data = fs.readFileSync(filePath);
    const relativeName = path.relative(rootDir, filePath).replace(/\\/g, "/");
    const name = Buffer.from(relativeName, "utf8");
    const checksum = crc32(data);
    const { time, date } = getZipDateParts(stat.mtime);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(offset, 42);

    fileParts.push(localHeader, name, data);
    centralParts.push(centralHeader, name);
    offset += localHeader.length + name.length + data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const endHeader = Buffer.alloc(22);
  endHeader.writeUInt32LE(0x06054b50, 0);
  endHeader.writeUInt16LE(centralParts.length / 2, 8);
  endHeader.writeUInt16LE(centralParts.length / 2, 10);
  endHeader.writeUInt32LE(centralSize, 12);
  endHeader.writeUInt32LE(offset, 16);

  return Buffer.concat([...fileParts, ...centralParts, endHeader]);
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
    const reportedProgress = Math.min(100, Number(progressMatch[1]));
    updateJob(job, {
      status: "running",
      progress: Math.max(job.progress || 0, reportedProgress),
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

function buildDownloadArgs(body, outputDir, tempDir) {
  const preset = body.preset || "mp4";
  const args = [
    "--newline",
    "--no-color",
    "--retries",
    "10",
    "--fragment-retries",
    "10",
    "--file-access-retries",
    "10",
    "-P",
    outputDir,
    "-P",
    `temp:${tempDir}`,
    "-o",
    "%(title).180B [%(id)s].%(ext)s"
  ];

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
  let tempDir = "";
  try {
    const url = validateMediaUrl(req.body.url);
    const outputDir = normalizeOutputDir(req.body.outputDir);
    const signature = getDownloadSignature(url, outputDir);
    const duplicateJob = findActiveDuplicate(signature);
    if (duplicateJob) {
      res.status(202).json({ job: publicJob(duplicateJob), duplicate: true });
      return;
    }

    tempDir = path.join(tempRootDir, randomUUID());
    fs.mkdirSync(tempDir, { recursive: true });
    const args = buildDownloadArgs({ ...req.body, url }, outputDir, tempDir);
    const job = createJob({
      url,
      title: req.body.title,
      preset: req.body.preset || "mp4",
      outputDir,
      tempDir,
      signature
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
        cleanupTempDir(job);
        emitJob(job, "done");
        return;
      }

      if (code === 0) {
        cleanupTempDir(job);
        updateJob(job, { status: "complete", progress: 100, eta: "" }, "done");
        return;
      }

      cleanupTempDir(job);
      updateJob(job, {
        status: "failed",
        error: job.logs.slice(-8).join("\n") || `yt-dlp exited with code ${code}`
      }, "done");
    });

    res.status(202).json({ job: publicJob(job) });
  } catch (error) {
    if (tempDir) {
      fs.rm(tempDir, { recursive: true, force: true }, () => undefined);
    }
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

app.delete("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Job not found." });
    return;
  }

  if (job.proc && ["queued", "running"].includes(job.status)) {
    updateJob(job, { status: "cancelled", eta: "" }, "done");
    job.proc.kill("SIGTERM");
  }

  cleanupTempDir(job);
  jobs.delete(job.id);
  for (const client of job.clients) {
    client.write("event: removed\n");
    client.write(`data: ${JSON.stringify({ id: job.id })}\n\n`);
    client.end();
  }
  job.clients.clear();

  res.json({ ok: true, id: job.id });
});

app.get("/api/extension.zip", (_req, res) => {
  try {
    const archive = buildZipFromDirectory(extensionDir);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Length", archive.length);
    res.setHeader("Content-Disposition", `attachment; filename="${extensionZipName}"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(archive);
  } catch (error) {
    res.status(500).json({ error: error.message || "Could not package the extension." });
  }
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

app.post("/api/open-extension-folder", (_req, res) => {
  try {
    const explorer = spawn("explorer.exe", [extensionDir], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    explorer.unref();
    res.json({ ok: true, extensionDir });
  } catch (error) {
    res.status(400).json({ error: error.message || "Could not open the extension folder." });
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
