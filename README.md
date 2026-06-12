# YDL Studio

A local, responsive UI for `yt-dlp` with a small Express API, a Vite React front end, and a Manifest V3 Chrome extension.

## Requirements

- Node.js 20 or newer
- `yt-dlp` available on `PATH`
- `ffmpeg` on `PATH` for merging, audio extraction, clipping, and metadata embedding

## Run

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:5173`.

The API runs at `http://127.0.0.1:5179` and writes to `~/Downloads/yt-dlp-ui` by default.

## Production build

```bash
npm run build
npm start
```

Open `http://127.0.0.1:5179`.

## Chrome extension

1. Open Chrome and go to `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select this project's `extension` folder.
5. Keep YDL Studio running, then click the extension button on a supported media page.

The extension sends the current tab URL to the local API. It can choose MP4, MP3, M4A, Best, optional subtitles, and an optional timestamp section.

## Configuration

Copy `.env.example` to `.env` if you want to change the API port or `yt-dlp` binary path:

```bash
PORT=5179
YTDLP_PATH=yt-dlp
```

