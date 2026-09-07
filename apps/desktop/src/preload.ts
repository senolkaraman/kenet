import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("kenetControl", {
  send: (command: unknown) => ipcRenderer.send("control:input", command),
  requestElevation: () => ipcRenderer.invoke("app:request-elevation") as Promise<{ started: boolean; reason?: string }>,
  recordAudit: (event: string, details: string) => ipcRenderer.send("audit:record", { event, details }),
  listAudit: () => ipcRenderer.invoke("audit:list"),
  notifyIncoming: (name: string) => ipcRenderer.send("session:incoming", name),
  notifyIncomingFile: (name: string, from?: string) => ipcRenderer.send("session:incoming-file", { name, from }),
  clearAttention: () => ipcRenderer.send("session:attention-clear"),
  readClipboard: () => ipcRenderer.invoke("clipboard:read") as Promise<string>,
  writeClipboard: (text: string) => ipcRenderer.invoke("clipboard:write", text) as Promise<void>,
  listScreens: () => ipcRenderer.invoke("screen:list") as Promise<Array<{ id: string; label: string; thumbnail: string }>>,
  setPreferredScreen: (id: string) => ipcRenderer.invoke("screen:prefer", id) as Promise<void>,
  setFullscreen: (on: boolean) => ipcRenderer.invoke("window:fullscreen", on) as Promise<boolean>,
  minimizeWindow: () => ipcRenderer.send("window:minimize"),
  closeWindow: () => ipcRenderer.send("window:close"),
  getStartupPrefs: () =>
    ipcRenderer.invoke("app:startup-prefs") as Promise<{ startWithWindows: boolean; runInBackground: boolean }>,
  setStartupPrefs: (prefs: { startWithWindows?: boolean; runInBackground?: boolean }) =>
    ipcRenderer.invoke("app:set-startup-prefs", prefs) as Promise<{ ok: boolean }>,
  openExternal: (url: string) => ipcRenderer.invoke("app:open-external", url) as Promise<void>,
  listClipboardFiles: () =>
    ipcRenderer.invoke("clipboard:list-files") as Promise<Array<{ path: string; name: string; size: number }>>,
  readClipboardFile: (filePath: string) =>
    ipcRenderer.invoke("clipboard:read-file", filePath) as Promise<{ name: string; data: ArrayBuffer } | null>,
  stageClipboardFile: (batch: string, name: string, data: ArrayBuffer) =>
    ipcRenderer.invoke("clipboard:stage-file", { batch, name, data }) as Promise<string | null>,
  commitClipboardFiles: (paths: string[]) => ipcRenderer.invoke("clipboard:commit-files", paths) as Promise<boolean>,
  saveIncomingFile: (name: string, data: ArrayBuffer) =>
    ipcRenderer.invoke("file:save", { name, data }) as Promise<{ saved: boolean; path?: string }>,
  listDrives: () =>
    ipcRenderer.invoke("fs:list-drives") as Promise<{
      ok: boolean;
      entries?: Array<{ name: string; isDir: boolean; size: number; modifiedAt: number | null }>;
      error?: string;
    }>,
  listDir: (dirPath: string) =>
    ipcRenderer.invoke("fs:list-dir", dirPath) as Promise<{
      ok: boolean;
      entries?: Array<{ name: string; isDir: boolean; size: number; modifiedAt: number | null }>;
      error?: string;
    }>,
  readFileForTransfer: (filePath: string) =>
    ipcRenderer.invoke("fs:read-file", filePath) as Promise<{ ok: boolean; name?: string; data?: ArrayBuffer; error?: string }>,
  writeFileToDir: (dir: string, name: string, data: ArrayBuffer) =>
    ipcRenderer.invoke("fs:write-to-dir", { dir, name, data }) as Promise<{ ok: boolean; path?: string; error?: string }>,
  saveToDownloads: (name: string, data: ArrayBuffer) =>
    ipcRenderer.invoke("fs:save-to-downloads", { name, data }) as Promise<{ saved: boolean; path?: string }>,
  pickFile: () => ipcRenderer.invoke("fs:pick-file") as Promise<{ ok: boolean; path?: string; name?: string }>,
  setPrivacyMode: (on: boolean) => ipcRenderer.invoke("agent:set-privacy", on) as Promise<{ ok: boolean }>,
  privacyHeartbeat: () => ipcRenderer.send("agent:privacy-heartbeat"),
  showOverlay: () => ipcRenderer.invoke("overlay:show") as Promise<{ ok: boolean }>,
  hideOverlay: () => ipcRenderer.invoke("overlay:hide") as Promise<{ ok: boolean }>,
  overlayDraw: (stroke: unknown) => ipcRenderer.send("overlay:draw", stroke),
  startRecording: (suggestedName: string) =>
    ipcRenderer.invoke("recording:start", suggestedName) as Promise<{ ok: boolean; path?: string; error?: string }>,
  recordingChunk: (data: ArrayBuffer) => ipcRenderer.send("recording:chunk", data),
  stopRecording: () => ipcRenderer.invoke("recording:stop") as Promise<{ ok: boolean; path?: string }>,
  revealRecording: (filePath: string) => ipcRenderer.invoke("recording:reveal", filePath) as Promise<void>,
  getNetworkInfo: () => ipcRenderer.invoke("net:info") as Promise<{ mac: string; subnet: string }>,
  sendWakePacket: (mac: string) => ipcRenderer.invoke("wake:send", mac) as Promise<{ ok: boolean }>
});
