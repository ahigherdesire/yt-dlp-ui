import {
  AlertCircle,
  BadgeCheck,
  Clock3,
  Download,
  ExternalLink,
  FileAudio,
  FileVideo,
  FolderOpen,
  Info,
  Link2,
  Loader2,
  ListVideo,
  Music2,
  PauseCircle,
  Play,
  Puzzle,
  RefreshCw,
  Scissors,
  Settings2,
  ShieldCheck,
  Square,
  Subtitles,
  Zap
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

type FormatOption = {
  id: string;
  ext: string;
  resolution: string;
  height: number;
  fps: number | null;
  vcodec: string;
  acodec: string;
  filesize: number | null;
  tbr: number | null;
  label: string;
};

type Metadata = {
  id: string;
  title: string;
  channel: string;
  duration: number | null;
  webpageUrl: string;
  extractor: string;
  thumbnail: string;
  formats: FormatOption[];
};

type Job = {
  id: string;
  status: "queued" | "running" | "complete" | "failed" | "cancelled";
  progress: number;
  speed: string;
  eta: string;
  title: string;
  url: string;
  preset: string;
  outputDir: string;
  outputPath: string;
  error: string;
  logs: string[];
  createdAt: string;
  updatedAt: string;
};

type Health = {
  ok: boolean;
  ytdlpVersion: string | null;
  outputDir: string;
  port: number;
};

const presets = [
  { id: "mp4", label: "MP4", detail: "Video", icon: FileVideo },
  { id: "mp3", label: "MP3", detail: "Audio", icon: Music2 },
  { id: "m4a", label: "M4A", detail: "Audio", icon: FileAudio },
  { id: "webm", label: "WebM", detail: "Video", icon: FileVideo },
  { id: "mkv", label: "MKV", detail: "Archive", icon: FileVideo },
  { id: "best", label: "Best", detail: "Native", icon: Zap },
  { id: "custom", label: "Format ID", detail: "Manual", icon: Settings2 }
] as const;

const apiBase = import.meta.env.VITE_API_BASE || "";

function apiUrl(path: string) {
  return `${apiBase}${path}`;
}

function formatDuration(seconds: number | null) {
  if (!seconds) return "Unknown";
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hrs) return `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function formatBytes(bytes: number | null) {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value > 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value > 100 ? 0 : 1)} ${units[unitIndex]}`;
}

function useJobEvents(onJob: (job: Job) => void) {
  const streams = useRef<Map<string, EventSource>>(new Map());

  useEffect(() => {
    return () => {
      for (const stream of streams.current.values()) stream.close();
      streams.current.clear();
    };
  }, []);

  return (jobId: string) => {
    if (streams.current.has(jobId)) return;
    const stream = new EventSource(apiUrl(`/api/jobs/${jobId}/events`));
    const handle = (event: MessageEvent) => {
      const job = JSON.parse(event.data) as Job;
      onJob(job);
      if (["complete", "failed", "cancelled"].includes(job.status)) {
        stream.close();
        streams.current.delete(job.id);
      }
    };
    stream.addEventListener("job", handle);
    stream.addEventListener("done", handle);
    stream.onerror = () => {
      stream.close();
      streams.current.delete(jobId);
    };
    streams.current.set(jobId, stream);
  };
}

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [url, setUrl] = useState("");
  const [metadata, setMetadata] = useState<Metadata | null>(null);
  const [preset, setPreset] = useState("mp4");
  const [formatId, setFormatId] = useState("");
  const [outputDir, setOutputDir] = useState("");
  const [rangeEnabled, setRangeEnabled] = useState(false);
  const [rangeStart, setRangeStart] = useState("");
  const [rangeEnd, setRangeEnd] = useState("");
  const [includeSubtitles, setIncludeSubtitles] = useState(false);
  const [writeThumbnail, setWriteThumbnail] = useState(false);
  const [embedMetadata, setEmbedMetadata] = useState(true);
  const [playlistMode, setPlaylistMode] = useState<"single" | "playlist">("single");
  const [audioQuality, setAudioQuality] = useState("0");
  const [isInspecting, setIsInspecting] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);

  const upsertJob = (job: Job) => {
    setJobs((current) => {
      const next = current.filter((item) => item.id !== job.id);
      return [job, ...next].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    });
  };
  const subscribeJob = useJobEvents(upsertJob);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const incomingUrl = params.get("url");
    if (incomingUrl) setUrl(incomingUrl);

    fetch(apiUrl("/api/health"))
      .then((response) => response.json())
      .then((data: Health) => {
        setHealth(data);
        setOutputDir(data.outputDir);
      })
      .catch(() => setHealth(null));

    fetch(apiUrl("/api/jobs"))
      .then((response) => response.json())
      .then((data: { jobs: Job[] }) => {
        setJobs(data.jobs);
        data.jobs.filter((job) => job.status === "running").forEach((job) => subscribeJob(job.id));
      })
      .catch(() => undefined);
  }, []);

  const videoFormats = useMemo(() => {
    return metadata?.formats.filter((format) => format.vcodec !== "none").slice(0, 50) || [];
  }, [metadata]);

  const audioFormats = useMemo(() => {
    return metadata?.formats.filter((format) => format.vcodec === "none").slice(0, 24) || [];
  }, [metadata]);

  async function inspect(event?: FormEvent) {
    event?.preventDefault();
    setError("");
    setIsInspecting(true);
    setMetadata(null);

    try {
      const response = await fetch(apiUrl("/api/metadata"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not inspect this URL.");
      setMetadata(data.metadata);
      setFormatId(data.metadata.formats?.[0]?.id || "");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not inspect this URL.");
    } finally {
      setIsInspecting(false);
    }
  }

  async function startDownload() {
    setError("");
    setIsStarting(true);

    try {
      const response = await fetch(apiUrl("/api/download"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          title: metadata?.title,
          preset,
          formatId,
          outputDir,
          rangeEnabled,
          rangeStart,
          rangeEnd,
          includeSubtitles,
          writeThumbnail,
          embedMetadata,
          playlistMode,
          audioQuality
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not start the download.");
      upsertJob(data.job);
      subscribeJob(data.job.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not start the download.");
    } finally {
      setIsStarting(false);
    }
  }

  async function cancelJob(jobId: string) {
    const response = await fetch(apiUrl(`/api/jobs/${jobId}/cancel`), { method: "POST" });
    if (response.ok) {
      const data = await response.json();
      upsertJob(data.job);
    }
  }

  async function openFolder(target = outputDir) {
    await fetch(apiUrl("/api/open-folder"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outputDir: target })
    });
  }

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Workspace">
        <div className="brand-row">
          <div className="brand-mark">
            <Download size={19} />
          </div>
          <div>
            <strong>YDL Studio</strong>
            <span>yt-dlp workbench</span>
          </div>
        </div>

        <nav className="sidebar-nav">
          <a className="nav-item active" href="#download">
            <Play size={17} /> Download
          </a>
          <a className="nav-item" href="#queue">
            <ListVideo size={17} /> Queue
          </a>
          <a className="nav-item" href="#extension">
            <Puzzle size={17} /> Extension
          </a>
        </nav>

        <div className="system-panel">
          <div className="system-row">
            <ShieldCheck size={17} />
            <span>{health?.ytdlpVersion ? `yt-dlp ${health.ytdlpVersion}` : "yt-dlp unavailable"}</span>
          </div>
          <button className="ghost-button" onClick={() => openFolder()} type="button">
            <FolderOpen size={16} /> Downloads
          </button>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Local capture console</p>
            <h1>Download, clip, and convert media.</h1>
          </div>
          <a className="extension-link" href="#extension">
            <Puzzle size={17} /> Chrome extension
          </a>
        </header>

        {error && (
          <div className="notice error" role="alert">
            <AlertCircle size={18} />
            <span>{error}</span>
          </div>
        )}

        <section className="content-grid" id="download">
          <div className="control-panel">
            <form className="url-form" onSubmit={inspect}>
              <label htmlFor="url">URL</label>
              <div className="url-row">
                <div className="input-with-icon">
                  <Link2 size={18} />
                  <input
                    id="url"
                    placeholder="https://www.youtube.com/watch?v=..."
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                  />
                </div>
                <button className="primary-button" disabled={!url || isInspecting} type="submit">
                  {isInspecting ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
                  Inspect
                </button>
              </div>
            </form>

            <div className="section-heading">
              <div>
                <p className="eyebrow">Format</p>
                <h2>Output preset</h2>
              </div>
            </div>

            <div className="preset-grid" role="list">
              {presets.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    className={`preset-button ${preset === item.id ? "selected" : ""}`}
                    key={item.id}
                    onClick={() => setPreset(item.id)}
                    type="button"
                  >
                    <Icon size={19} />
                    <span>{item.label}</span>
                    <small>{item.detail}</small>
                  </button>
                );
              })}
            </div>

            {preset === "custom" && (
              <label className="field-block">
                Format ID
                <select value={formatId} onChange={(event) => setFormatId(event.target.value)}>
                  <option value="">Pick a format</option>
                  <optgroup label="Video">
                    {videoFormats.map((format) => (
                      <option key={format.id} value={format.id}>
                        {format.id} - {format.resolution} {format.ext} {formatBytes(format.filesize)}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Audio">
                    {audioFormats.map((format) => (
                      <option key={format.id} value={format.id}>
                        {format.id} - {format.ext} {format.tbr ? `${Math.round(format.tbr)}kbps` : ""}
                      </option>
                    ))}
                  </optgroup>
                </select>
              </label>
            )}

            {(preset === "mp3" || preset === "m4a" || preset === "opus" || preset === "flac" || preset === "wav") && (
              <label className="field-block">
                Audio quality
                <select value={audioQuality} onChange={(event) => setAudioQuality(event.target.value)}>
                  <option value="0">Best</option>
                  <option value="3">High</option>
                  <option value="5">Balanced</option>
                  <option value="9">Small file</option>
                </select>
              </label>
            )}

            <div className="split-controls">
              <label className="toggle-row">
                <input
                  checked={rangeEnabled}
                  onChange={(event) => setRangeEnabled(event.target.checked)}
                  type="checkbox"
                />
                <span>
                  <Scissors size={17} /> Section
                </span>
              </label>
              <label className="toggle-row">
                <input
                  checked={includeSubtitles}
                  onChange={(event) => setIncludeSubtitles(event.target.checked)}
                  type="checkbox"
                />
                <span>
                  <Subtitles size={17} /> Subtitles
                </span>
              </label>
              <label className="toggle-row">
                <input
                  checked={writeThumbnail}
                  onChange={(event) => setWriteThumbnail(event.target.checked)}
                  type="checkbox"
                />
                <span>
                  <Info size={17} /> Thumbnail
                </span>
              </label>
              <label className="toggle-row">
                <input
                  checked={embedMetadata}
                  onChange={(event) => setEmbedMetadata(event.target.checked)}
                  type="checkbox"
                />
                <span>
                  <BadgeCheck size={17} /> Metadata
                </span>
              </label>
            </div>

            {rangeEnabled && (
              <div className="range-grid">
                <label className="field-block">
                  Start
                  <input
                    placeholder="00:45"
                    value={rangeStart}
                    onChange={(event) => setRangeStart(event.target.value)}
                  />
                </label>
                <label className="field-block">
                  End
                  <input
                    placeholder="02:10"
                    value={rangeEnd}
                    onChange={(event) => setRangeEnd(event.target.value)}
                  />
                </label>
              </div>
            )}

            <div className="range-grid">
              <label className="field-block">
                Playlist
                <select value={playlistMode} onChange={(event) => setPlaylistMode(event.target.value as "single" | "playlist")}>
                  <option value="single">Single item</option>
                  <option value="playlist">Full playlist</option>
                </select>
              </label>
              <label className="field-block">
                Output folder
                <input value={outputDir} onChange={(event) => setOutputDir(event.target.value)} />
              </label>
            </div>

            <div className="action-row">
              <button className="primary-button large" disabled={!url || isStarting} onClick={startDownload} type="button">
                {isStarting ? <Loader2 className="spin" size={18} /> : <Download size={18} />}
                Start download
              </button>
              <button className="secondary-button large" onClick={() => openFolder()} type="button">
                <FolderOpen size={18} />
                Open folder
              </button>
            </div>
          </div>

          <aside className="preview-panel">
            <div className="media-frame">
              {metadata?.thumbnail ? (
                <img alt="" src={metadata.thumbnail} referrerPolicy="no-referrer" />
              ) : (
                <div className="media-empty">
                  <FileVideo size={46} />
                  <span>Media preview</span>
                </div>
              )}
            </div>
            <div className="metadata-stack">
              <p className="eyebrow">{metadata?.extractor || "Ready"}</p>
              <h2>{metadata?.title || "Paste a URL to inspect formats"}</h2>
              <div className="meta-row">
                <span>{metadata?.channel || "Local yt-dlp service"}</span>
                <span>
                  <Clock3 size={15} /> {formatDuration(metadata?.duration || null)}
                </span>
              </div>
              {metadata?.webpageUrl && (
                <a className="source-link" href={metadata.webpageUrl} rel="noreferrer" target="_blank">
                  Source <ExternalLink size={15} />
                </a>
              )}
            </div>
          </aside>
        </section>

        <section className="queue-section" id="queue">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Activity</p>
              <h2>Download queue</h2>
            </div>
            <button className="secondary-button" onClick={() => openFolder()} type="button">
              <FolderOpen size={17} /> Folder
            </button>
          </div>

          <div className="job-list">
            {jobs.length === 0 && (
              <div className="empty-state">
                <Download size={26} />
                <span>No downloads yet.</span>
              </div>
            )}
            {jobs.map((job) => (
              <article className="job-card" key={job.id}>
                <div className="job-main">
                  <div className={`status-dot ${job.status}`} />
                  <div>
                    <h3>{job.title || job.url}</h3>
                    <p>
                      {job.preset.toUpperCase()} · {job.outputPath || job.outputDir}
                    </p>
                  </div>
                </div>
                <div className="job-progress">
                  <div className="bar">
                    <span style={{ width: `${Math.max(0, Math.min(100, job.progress))}%` }} />
                  </div>
                  <small>
                    {job.status} {job.progress ? `${Math.round(job.progress)}%` : ""} {job.speed} {job.eta ? `ETA ${job.eta}` : ""}
                  </small>
                </div>
                <div className="job-actions">
                  {job.status === "running" && (
                    <button className="icon-button" onClick={() => cancelJob(job.id)} title="Cancel" type="button">
                      <Square size={16} />
                    </button>
                  )}
                  <button className="icon-button" onClick={() => openFolder(job.outputDir)} title="Open folder" type="button">
                    <FolderOpen size={16} />
                  </button>
                </div>
                {job.error && <pre className="job-error">{job.error}</pre>}
              </article>
            ))}
          </div>
        </section>

        <section className="extension-band" id="extension">
          <div>
            <p className="eyebrow">Browser capture</p>
            <h2>Chrome extension included</h2>
            <p>Load the `extension` folder in Chrome and send the current tab straight into this queue.</p>
          </div>
          <div className="extension-path">
            <Puzzle size={20} />
            <code>extension/</code>
          </div>
        </section>
      </main>
    </div>
  );
}
