const apiBase = "http://127.0.0.1:5179";
let currentUrl = "";
let selectedPreset = "mp4";

const urlInput = document.querySelector("#url");
const message = document.querySelector("#message");
const serviceState = document.querySelector("#serviceState");
const buttons = [...document.querySelectorAll(".preset")];

function setMessage(text, isError = false) {
  message.textContent = text;
  message.style.color = isError ? "#b42318" : "#667085";
}

function setPreset(value) {
  selectedPreset = value;
  buttons.forEach((button) => {
    button.classList.toggle("selected", button.dataset.preset === value);
  });
  chrome.storage.local.set({ selectedPreset });
}

async function checkService() {
  try {
    const response = await fetch(`${apiBase}/api/health`);
    const data = await response.json();
    serviceState.textContent = data.ytdlpVersion ? `yt-dlp ${data.ytdlpVersion}` : "Service ready";
  } catch {
    serviceState.textContent = "Open the app first";
  }
}

chrome.storage.local.get(["selectedPreset"], (settings) => {
  setPreset(settings.selectedPreset || "mp4");
});

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  currentUrl = tabs[0]?.url || "";
  urlInput.value = currentUrl;
});

buttons.forEach((button) => {
  button.addEventListener("click", () => setPreset(button.dataset.preset));
});

document.querySelector("#openApp").addEventListener("click", () => {
  chrome.tabs.create({ url: `${apiBase}/?url=${encodeURIComponent(currentUrl)}` });
});

document.querySelector("#download").addEventListener("click", async () => {
  setMessage("Starting...");
  try {
    const response = await fetch(`${apiBase}/api/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: currentUrl,
        preset: selectedPreset,
        rangeEnabled: document.querySelector("#rangeEnabled").checked,
        rangeStart: document.querySelector("#rangeStart").value,
        rangeEnd: document.querySelector("#rangeEnd").value,
        includeSubtitles: document.querySelector("#includeSubtitles").checked
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not start download.");
    setMessage("Queued in YDL Studio.");
  } catch (error) {
    setMessage(error.message || "Open YDL Studio and try again.", true);
  }
});

checkService();

