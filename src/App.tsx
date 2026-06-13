import {
  AlertCircle,
  BadgeCheck,
  Check,
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
  Play,
  Puzzle,
  RefreshCw,
  Scissors,
  Settings2,
  ShieldCheck,
  Square,
  Subtitles,
  X,
  Zap
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

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
  hiddenFromQueue?: boolean;
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
type AppView = "download" | "queue" | "history" | "extension";

const viewCopy: Record<AppView, { eyebrow: string; title: string }> = {
  download: { eyebrow: "Local capture console", title: "Download, clip, and convert media." },
  queue: { eyebrow: "Active workspace", title: "Current download queue." },
  history: { eyebrow: "Download archive", title: "History and completed jobs." },
  extension: { eyebrow: "Browser capture", title: "Chrome extension setup." }
};

function apiUrl(path: string) {
  return `${apiBase}${path}`;
}

function getViewFromHash(): AppView {
  const view = window.location.hash.replace("#", "") as AppView;
  return ["download", "queue", "history", "extension"].includes(view) ? view : "download";
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

function formatDateTime(value: string) {
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function getValidMediaUrl(value: string) {
  try {
    const parsed = new URL(value.trim());
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function formatCodec(format: FormatOption) {
  const parts = [];
  if (format.vcodec && format.vcodec !== "none") parts.push(format.vcodec);
  if (format.acodec && format.acodec !== "none") parts.push(format.acodec);
  return parts.join(" / ") || "audio";
}

function useJobEvents(onJob: (job: Job) => void, onRemove: (jobId: string) => void) {
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
    const handleRemoved = (event: MessageEvent) => {
      const payload = JSON.parse(event.data) as { id: string };
      onRemove(payload.id);
      stream.close();
      streams.current.delete(payload.id);
    };
    stream.addEventListener("job", handle);
    stream.addEventListener("done", handle);
    stream.addEventListener("removed", handleRemoved);
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
  const [isStartLocked, setIsStartLocked] = useState(false);
  const [isOpeningFolder, setIsOpeningFolder] = useState(false);
  const [error, setError] = useState("");
  const [folderStatus, setFolderStatus] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [historyJobs, setHistoryJobs] = useState<Job[]>([]);
  const [activeView, setActiveView] = useState<AppView>(getViewFromHash);
  const inspectRequestRef = useRef(0);
  const lastInspectedUrlRef = useRef("");
  const startButtonRef = useRef<HTMLButtonElement | null>(null);
  const startLockRef = useRef(false);
  const startUnlockTimerRef = useRef<number | null>(null);
  const folderStatusTimerRef = useRef<number | null>(null);

  const upsertJob = (job: Job) => {
    setJobs((current) => {
      if (job.hiddenFromQueue) {
        return current.filter((item) => item.id !== job.id);
      }

      const existing = current.find((item) => item.id === job.id);
      const mergedJob = existing
        ? { ...job, progress: job.status === "complete" ? 100 : Math.max(existing.progress || 0, job.progress || 0) }
        : job;
      const next = current.filter((item) => item.id !== job.id);
      return [mergedJob, ...next].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    });
    setHistoryJobs((current) => {
      const existing = current.find((item) => item.id === job.id);
      const mergedJob = existing
        ? { ...job, progress: job.status === "complete" ? 100 : Math.max(existing.progress || 0, job.progress || 0) }
        : job;
      const next = current.filter((item) => item.id !== job.id);
      return [mergedJob, ...next].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    });
  };
  const removeJobFromState = (jobId: string) => {
    setJobs((current) => current.filter((job) => job.id !== jobId));
    setHistoryJobs((current) =>
      current.map((job) => (job.id === jobId ? { ...job, hiddenFromQueue: true } : job))
    );
  };
  const subscribeJob = useJobEvents(upsertJob, removeJobFromState);
  const queueJobs = useMemo(() => jobs.slice(0, 5), [jobs]);
  const recentQueueJobs = useMemo(() => jobs.slice(0, 3), [jobs]);
  const hiddenQueueCount = Math.max(0, jobs.length - queueJobs.length);
  const activeCount = jobs.filter((job) => job.status === "running" || job.status === "queued").length;
  const completedCount = historyJobs.filter((job) => job.status === "complete").length;
  const failedCount = historyJobs.filter((job) => job.status === "failed" || job.status === "cancelled").length;

  const videoFormats = useMemo(() => {
    return metadata?.formats.filter((format) => format.vcodec !== "none").slice(0, 50) || [];
  }, [metadata]);

  const audioFormats = useMemo(() => {
    return metadata?.formats.filter((format) => format.vcodec === "none").slice(0, 24) || [];
  }, [metadata]);

  const customFormats = useMemo(() => metadata?.formats || [], [metadata]);
  const selectedFormat = useMemo(
    () => customFormats.find((format) => format.id === formatId) || null,
    [customFormats, formatId]
  );

  const inspectUrl = useCallback(async (targetUrl: string, options: { silent?: boolean } = {}) => {
    const normalizedUrl = getValidMediaUrl(targetUrl);
    if (!normalizedUrl) {
      if (!options.silent) setError("Enter a valid media URL.");
      return;
    }

    const requestId = inspectRequestRef.current + 1;
    inspectRequestRef.current = requestId;
    setError("");
    setIsInspecting(true);
    setMetadata(null);
    setFormatId("");

    try {
      const response = await fetch(apiUrl("/api/metadata"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: normalizedUrl })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not inspect this URL.");
      if (inspectRequestRef.current !== requestId) return;

      setMetadata(data.metadata);
      setFormatId(data.metadata.formats?.[0]?.id || "");
      lastInspectedUrlRef.current = normalizedUrl;
    } catch (caught) {
      if (inspectRequestRef.current === requestId && !options.silent) {
        setError(caught instanceof Error ? caught.message : "Could not inspect this URL.");
      }
    } finally {
      if (inspectRequestRef.current === requestId) {
        setIsInspecting(false);
      }
    }
  }, []);

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

    fetch(apiUrl("/api/history"))
      .then((response) => response.json())
      .then((data: { jobs: Job[] }) => {
        setHistoryJobs(data.jobs);
        data.jobs.filter((job) => job.status === "running").forEach((job) => subscribeJob(job.id));
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const syncView = () => setActiveView(getViewFromHash());
    window.addEventListener("hashchange", syncView);
    window.addEventListener("popstate", syncView);
    syncView();
    return () => {
      window.removeEventListener("hashchange", syncView);
      window.removeEventListener("popstate", syncView);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (startUnlockTimerRef.current) {
        window.clearTimeout(startUnlockTimerRef.current);
      }
      if (folderStatusTimerRef.current) {
        window.clearTimeout(folderStatusTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const normalizedUrl = getValidMediaUrl(url);
    if (!normalizedUrl) {
      inspectRequestRef.current += 1;
      lastInspectedUrlRef.current = "";
      setMetadata(null);
      setFormatId("");
      setIsInspecting(false);
      return;
    }

    if (normalizedUrl === lastInspectedUrlRef.current) return;

    const timer = window.setTimeout(() => {
      void inspectUrl(normalizedUrl, { silent: true });
    }, 800);

    return () => window.clearTimeout(timer);
  }, [url, inspectUrl]);

  function inspect(event: FormEvent) {
    event.preventDefault();
    void inspectUrl(url);
  }

  function selectPreset(nextPreset: string) {
    setPreset(nextPreset);
    if (nextPreset === "custom" && !metadata && !isInspecting) {
      void inspectUrl(url);
    }
  }

  async function startDownload() {
    if (startLockRef.current || !url) return;

    startLockRef.current = true;
    setIsStartLocked(true);
    setError("");
    setIsStarting(true);
    startButtonRef.current?.blur();

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
      if (startUnlockTimerRef.current) {
        window.clearTimeout(startUnlockTimerRef.current);
      }
      startUnlockTimerRef.current = window.setTimeout(() => {
        startLockRef.current = false;
        setIsStartLocked(false);
      }, 1100);
    }
  }

  async function cancelJob(jobId: string) {
    const response = await fetch(apiUrl(`/api/jobs/${jobId}/cancel`), { method: "POST" });
    if (response.ok) {
      const data = await response.json();
      upsertJob(data.job);
    }
  }

  async function removeJob(jobId: string) {
    const response = await fetch(apiUrl(`/api/jobs/${jobId}`), { method: "DELETE" });
    if (response.ok || response.status === 404) {
      removeJobFromState(jobId);
    }
  }

  function showFolderStatus(message: string, persist = false) {
    setFolderStatus(message);
    if (folderStatusTimerRef.current) {
      window.clearTimeout(folderStatusTimerRef.current);
    }
    if (!persist) {
      folderStatusTimerRef.current = window.setTimeout(() => setFolderStatus(""), 2600);
    }
  }

  async function openFolder(target = outputDir, options: { announce?: boolean } = {}) {
    const announce = options.announce ?? false;
    if (announce) {
      setIsOpeningFolder(true);
      showFolderStatus("Opening Downloads...", true);
    }

    try {
      const response = await fetch(apiUrl("/api/open-folder"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outputDir: target })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not open the folder.");
      if (announce) showFolderStatus("Downloads folder opened.");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Could not open the folder.";
      if (announce) showFolderStatus(message, true);
      setError(message);
    } finally {
      if (announce) setIsOpeningFolder(false);
    }
  }

  async function openExtensionFolder() {
    await fetch(apiUrl("/api/open-extension-folder"), { method: "POST" });
  }

  function goToView(view: AppView) {
    setActiveView(view);
    if (window.location.hash !== `#${view}`) {
      window.history.pushState(null, "", `#${view}`);
    }
  }

  function renderJobCard(job: Job, options: { compact?: boolean; showRemove?: boolean } = {}) {
    const isFinished = ["complete", "failed", "cancelled"].includes(job.status);
    const isComplete = job.status === "complete";
    const resultLabel = isComplete ? "Complete" : job.status === "cancelled" ? "Cancelled" : "Failed";

    return (
      <article className={`job-card ${isFinished ? "finished" : ""}`} key={job.id}>
        <div className="job-main">
          <div className={`status-dot ${job.status}`} />
          <div>
            <h3>{job.title || job.url}</h3>
            <p>
              {job.preset.toUpperCase()} - {job.outputPath || job.outputDir}
            </p>
            {!options.compact && <small className="job-time">{formatDateTime(job.createdAt)}</small>}
          </div>
        </div>

        {isFinished ? (
          <div className={`job-result ${isComplete ? "complete" : "failed"}`} role="status">
            <span className="result-symbol" aria-hidden="true">
              {isComplete ? <Check size={34} strokeWidth={2.6} /> : <X size={32} strokeWidth={2.7} />}
            </span>
            <div>
              <strong>{resultLabel}</strong>
              <small>{isComplete ? "Saved to folder" : "Stopped"}</small>
            </div>
          </div>
        ) : (
          <div className="job-progress">
            <div className="bar">
              <span style={{ width: `${Math.max(0, Math.min(100, job.progress))}%` }} />
            </div>
            <div className="progress-meta">
              <span className="loading-ring" aria-hidden="true" />
              <small>
                {job.status} {job.progress ? `${Math.round(job.progress)}%` : ""} {job.speed} {job.eta ? `ETA ${job.eta}` : ""}
              </small>
            </div>
          </div>
        )}

        <div className="job-actions">
          {job.status === "running" && (
            <button className="icon-button" onClick={() => cancelJob(job.id)} title="Cancel" type="button">
              <Square size={16} />
            </button>
          )}
          {options.showRemove && isFinished && !job.hiddenFromQueue && (
            <button className="icon-button remove-button" onClick={() => removeJob(job.id)} title="Remove from queue" type="button">
              <span className="remove-mark" aria-hidden="true" />
            </button>
          )}
          <button className="icon-button" onClick={() => openFolder(job.outputDir)} title="Open folder" type="button">
            <FolderOpen size={16} />
          </button>
        </div>
        {!options.compact && job.error && <pre className="job-error">{job.error}</pre>}
      </article>
    );
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
          <a className={`nav-item ${activeView === "download" ? "active" : ""}`} href="#download" onClick={() => goToView("download")}>
            <Play size={17} />
            <span>Download</span>
          </a>
          <a className={`nav-item ${activeView === "queue" ? "active" : ""}`} href="#queue" onClick={() => goToView("queue")}>
            <ListVideo size={17} />
            <span>Queue</span>
            {jobs.length > 0 && <small>{jobs.length}</small>}
          </a>
          <a className={`nav-item ${activeView === "history" ? "active" : ""}`} href="#history" onClick={() => goToView("history")}>
            <Clock3 size={17} />
            <span>History</span>
            {historyJobs.length > 0 && <small>{historyJobs.length}</small>}
          </a>
          <a className={`nav-item ${activeView === "extension" ? "active" : ""}`} href="#extension" onClick={() => goToView("extension")}>
            <Puzzle size={17} />
            <span>Extension</span>
          </a>
        </nav>

        <div className="system-panel">
          <div className="system-row">
            <ShieldCheck size={17} />
            <span>{health?.ytdlpVersion ? `yt-dlp ${health.ytdlpVersion}` : "yt-dlp unavailable"}</span>
          </div>
          <button className="ghost-button" disabled={isOpeningFolder} onClick={() => openFolder(outputDir, { announce: true })} type="button">
            {isOpeningFolder ? <Loader2 className="spin" size={16} /> : <FolderOpen size={16} />}
            Downloads
          </button>
          {folderStatus && <p className="folder-status" role="status">{folderStatus}</p>}
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">{viewCopy[activeView].eyebrow}</p>
            <h1>{viewCopy[activeView].title}</h1>
          </div>
          {activeView === "extension" ? (
            <a className="extension-link" download href={apiUrl("/api/extension.zip")}>
              <Download size={17} /> Download extension
            </a>
          ) : activeView === "queue" ? (
            <a className="extension-link" href="#history" onClick={() => goToView("history")}>
              <Clock3 size={17} /> Full history
            </a>
          ) : (
            <a className="extension-link" href="#queue" onClick={() => goToView("queue")}>
              <ListVideo size={17} /> Queue
            </a>
          )}
        </header>

        {error && (
          <div className="notice error" role="alert">
            <AlertCircle size={18} />
            <span>{error}</span>
          </div>
        )}

        {activeView === "download" && (
          <>
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
                    onClick={() => selectPreset(item.id)}
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
              <div className="format-block">
                <div className="field-row">
                  <span>Format ID</span>
                  {isInspecting && (
                    <span className="inline-status">
                      <Loader2 className="spin" size={14} /> Loading
                    </span>
                  )}
                  {selectedFormat && (
                    <span className="inline-status selected-format">
                      {selectedFormat.id} - {selectedFormat.resolution}
                    </span>
                  )}
                </div>
                <div className="format-picker" role="listbox" aria-label="Format ID">
                  {customFormats.length === 0 && (
                    <button className="format-option empty" disabled type="button">
                      {isInspecting ? "Loading formats" : "No formats"}
                    </button>
                  )}
                  {customFormats.map((format) => (
                    <button
                      aria-selected={format.id === formatId}
                      className={`format-option ${format.id === formatId ? "selected" : ""}`}
                      key={`${format.id}-${format.ext}-${format.resolution}`}
                      onClick={() => setFormatId(format.id)}
                      role="option"
                      type="button"
                    >
                      <span className="format-id">{format.id}</span>
                      <span className="format-main">
                        {format.resolution} {format.ext.toUpperCase()} {format.fps ? `${format.fps}fps` : ""}
                      </span>
                      <small>
                        {formatCodec(format)}
                        {format.filesize ? ` - ${formatBytes(format.filesize)}` : ""}
                        {format.tbr ? ` - ${Math.round(format.tbr)}kbps` : ""}
                      </small>
                    </button>
                  ))}
                </div>
                <label className="field-block compact">
                  Manual ID
                  <input value={formatId} onChange={(event) => setFormatId(event.target.value)} />
                </label>
              </div>
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
              <button
                aria-busy={isStarting}
                className={`primary-button large start-button ${isStartLocked ? "is-locked" : ""}`}
                disabled={!url || isStartLocked}
                onClick={startDownload}
                ref={startButtonRef}
                type="button"
              >
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
              <h2>{metadata?.title || "Awaiting media"}</h2>
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
            <section className="queue-section recent-queue" aria-label="Recent download queue">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Latest three</p>
                  <h2>Recent queue</h2>
                </div>
                <a className="secondary-button" href="#queue" onClick={() => goToView("queue")}>
                  <ListVideo size={17} /> Queue
                </a>
              </div>

              <div className="job-list">
                {recentQueueJobs.length === 0 && (
                  <div className="empty-state">
                    <Download size={26} />
                    <span>No downloads yet.</span>
                  </div>
                )}
                {recentQueueJobs.map((job) => renderJobCard(job, { compact: true, showRemove: true }))}
              </div>
            </section>
          </>
        )}

        {activeView === "queue" && (
          <section className="queue-section page-panel" id="queue">
            <div className="metric-grid">
              <div className="metric-item">
                <span>Visible</span>
                <strong>{Math.min(jobs.length, 5)}</strong>
              </div>
              <div className="metric-item">
                <span>Active</span>
                <strong>{activeCount}</strong>
              </div>
              <div className="metric-item">
                <span>Hidden</span>
                <strong>{hiddenQueueCount}</strong>
              </div>
            </div>

            <div className="section-heading">
              <div>
                <p className="eyebrow">Latest five</p>
                <h2>Download queue</h2>
              </div>
              <a className="secondary-button" href="#history" onClick={() => goToView("history")}>
                <Clock3 size={17} /> History
              </a>
            </div>

            <div className="job-list">
              {queueJobs.length === 0 && (
                <div className="empty-state">
                  <Download size={26} />
                  <span>No downloads yet.</span>
                </div>
              )}
              {queueJobs.map((job) => renderJobCard(job, { compact: true, showRemove: true }))}
            </div>
          </section>
        )}

        {activeView === "history" && (
          <section className="queue-section page-panel" id="history">
            <div className="metric-grid">
              <div className="metric-item">
                <span>Total</span>
                <strong>{historyJobs.length}</strong>
              </div>
              <div className="metric-item">
                <span>Complete</span>
                <strong>{completedCount}</strong>
              </div>
              <div className="metric-item">
                <span>Stopped</span>
                <strong>{failedCount}</strong>
              </div>
            </div>

            <div className="section-heading">
              <div>
                <p className="eyebrow">All jobs</p>
                <h2>Download history</h2>
              </div>
              <button className="secondary-button" onClick={() => openFolder()} type="button">
                <FolderOpen size={17} /> Folder
              </button>
            </div>

            <div className="job-list history-list">
              {historyJobs.length === 0 && (
                <div className="empty-state">
                  <Clock3 size={26} />
                  <span>No history yet.</span>
                </div>
              )}
              {historyJobs.map((job) => renderJobCard(job, { showRemove: !job.hiddenFromQueue }))}
            </div>
          </section>
        )}

        {activeView === "extension" && (
          <section className="extension-page" id="extension">
            <div className="extension-hero">
              <div>
                <p className="eyebrow">One-click capture</p>
                <h2>Send the current tab into YDL Studio.</h2>
                <p>
                  Use the Chrome extension to choose MP4, MP3, M4A, Best, subtitles, or a timestamp section from the browser toolbar.
                </p>
              </div>
              <div className="extension-actions">
                <a className="primary-button large" download href={apiUrl("/api/extension.zip")}>
                  <Download size={18} /> Download ZIP
                </a>
                <button className="secondary-button large" onClick={openExtensionFolder} type="button">
                  <FolderOpen size={18} /> Open folder
                </button>
              </div>
            </div>

            <div className="setup-grid">
              <div className="setup-step">
                <span>1</span>
                <h3>Open Chrome Extensions</h3>
                <p>Go to <code>chrome://extensions</code> and enable Developer mode.</p>
              </div>
              <div className="setup-step">
                <span>2</span>
                <h3>Load The Folder</h3>
                <p>Select the extracted extension folder from Downloads or this project.</p>
              </div>
              <div className="setup-step">
                <span>3</span>
                <h3>Capture Current Tab</h3>
                <p>Keep YDL Studio running, click the toolbar button, choose a preset, and queue the download.</p>
              </div>
            </div>

            <div className="extension-path">
              <Puzzle size={20} />
              <code>C:\Users\LIXINYUAN\Downloads\ydl-studio-capture-extension</code>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
