const apiBase = "http://127.0.0.1:5179";

document.querySelector("#openApp").addEventListener("click", () => {
  chrome.tabs.create({ url: apiBase });
});
