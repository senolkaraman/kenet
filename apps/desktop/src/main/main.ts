import { app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, Menu, Notification, screen, session, shell, Tray } from "electron";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createSocket } from "node:dgram";
import { networkInterfaces } from "node:os";
import path from "node:path";
import electronUpdater from "electron-updater";

// Must run before any app.getPath() call so userData lands at %APPDATA%\Kenet (not the ugly
// scoped-package default). This is the deliberate rename point — existing installs get a fresh
// userData dir (one re-login), which is fine pre-launch.
app.setName("Kenet");

const MAX_CLIPBOARD_BYTES = 250 * 1024 * 1024; // guard rail for the in-memory IPC round trip

/** Runs a PowerShell command and resolves with trimmed stdout. Windows-only helper. */
const runPowerShell = (script: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `powershell exited with code ${code}`));
    });
  });

const psQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`;

const maskToBits = (netmask: string): number =>
  netmask
    .split(".")
    .reduce((bits, octet) => bits + ((Number(octet) >>> 0).toString(2).match(/1/g)?.length ?? 0), 0);

/**
 * Picks this machine's primary LAN interface and returns its MAC + network address. Prefers a
 * wired adapter (Wake-on-LAN over Wi-Fi is rare and unreliable) and skips the obvious virtual ones.
 */
const localNetworkInfo = (): { mac: string; subnet: string } => {
  const virtualRe = /(vEthernet|VirtualBox|VMware|Hyper-V|Loopback|Docker|WSL|TAP|Tailscale|ZeroTier)/i;
  const candidates: Array<{ mac: string; subnet: string; wired: boolean }> = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (virtualRe.test(name)) continue;
    for (const addr of addrs ?? []) {
      if (addr.family !== "IPv4" || addr.internal || !addr.mac || addr.mac === "00:00:00:00:00:00") continue;
      const net = addr.address
        .split(".")
        .map((o, i) => Number(o) & Number(addr.netmask.split(".")[i]))
        .join(".");
      candidates.push({
        mac: addr.mac.toLowerCase(),
        subnet: `${net}/${maskToBits(addr.netmask)}`,
        wired: !/wi-?fi|wireless|wlan/i.test(name)
      });
    }
  }
  candidates.sort((a, b) => Number(b.wired) - Number(a.wired));
  return candidates[0] ?? { mac: "", subnet: "" };
};

const sendMagicPacket = (mac: string): { ok: boolean } => {
  const clean = mac.replace(/[^a-fA-F0-9]/g, "");
  if (clean.length !== 12) return { ok: false };
  const macBytes = Buffer.from(clean, "hex");
  const packet = Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => macBytes)]);
  const socket = createSocket("udp4");
  socket.once("error", () => socket.close());
  socket.bind(() => {
    try {
      socket.setBroadcast(true);
      for (const port of [9, 7]) socket.send(packet, port, "255.255.255.255");
    } catch {
      /* ignore — best effort */
    }
    setTimeout(() => socket.close(), 600);
  });
  return { ok: true };
};

const MAX_FS_READ_BYTES = 200 * 1024 * 1024; // matches the peer-to-peer transfer cap in session.ts

const sanitizeFileName = (name: string): string => name.replace(/[/\\:*?"<>|]/g, "_").slice(0, 200) || "dosya";

/** Appends " (1)", " (2)", … to `target` until it lands on a path that doesn't exist yet. */
const uniquePath = async (target: string): Promise<string> => {
  const ext = path.extname(target);
  const base = target.slice(0, target.length - ext.length);
  let candidate = target;
  let n = 1;
  // eslint-disable-next-line no-await-in-loop
  while (await stat(candidate).then(() => true).catch(() => false)) {
    candidate = `${base} (${n})${ext}`;
    n += 1;
  }
  return candidate;
};

let inputAgent: ChildProcessWithoutNullStreams | undefined;
let mainWindow: BrowserWindow | undefined;
let overlayWindow: BrowserWindow | undefined;
let recordingStream: WriteStream | null = null;
let recordingPath: string | null = null;
let tray: Tray | undefined;
let preferredScreenId: string | undefined;
let runInBackground = true;
let quitting = false;
let privacyActive = false;
const startedHidden = process.argv.includes("--hidden") || app.getLoginItemSettings().wasOpenedAtLogin;

const iconPath = () =>
  app.isPackaged
    ? path.join(process.resourcesPath, "assets", "icon.ico")
    : path.join(app.getAppPath(), "assets", "icon.ico");

// Single instance: a second launch (incl. autostart while running) focuses the window.
if (!app.requestSingleInstanceLock()) app.quit();

const auditEvents = new Set([
  "connection-requested",
  "connection-approved",
  "connection-rejected",
  "session-started",
  "session-ended",
  "file-sent",
  "file-received",
  "elevation-requested"
]);
const auditPath = () => path.join(app.getPath("userData"), "audit.jsonl");

const recordAudit = async (event: string, details: string) => {
  if (!auditEvents.has(event)) return;
  await mkdir(app.getPath("userData"), { recursive: true });
  await appendFile(
    auditPath(),
    `${JSON.stringify({ timestamp: new Date().toISOString(), event, details: details.slice(0, 200) })}\n`
  );
};

const overlayAssetPath = (...segments: string[]) =>
  app.isPackaged
    ? path.join(process.resourcesPath, "assets", "overlay", ...segments)
    : path.join(app.getAppPath(), "assets", "overlay", ...segments);

/** Transparent, click-through, always-on-top window that renders the viewer's live annotations
 *  directly onto this machine's real screen — see assets/overlay/. Created lazily, one at a time. */
const createOverlayWindow = (): BrowserWindow => {
  if (overlayWindow) return overlayWindow;
  const bounds = screen.getPrimaryDisplay().bounds;
  const win = new BrowserWindow({
    ...bounds,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(app.getAppPath(), "dist", "overlay-preload.js")
    }
  });
  win.setIgnoreMouseEvents(true);
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  void win.loadFile(overlayAssetPath("overlay.html"));
  win.on("closed", () => {
    overlayWindow = undefined;
  });
  overlayWindow = win;
  return win;
};

const startInputAgent = () => {
  const agentPath = app.isPackaged
    ? path.join(process.resourcesPath, "agent", "Kenet.WindowsAgent.exe")
    : path.join(app.getAppPath(), "..", "windows-agent", "bin", "Debug", "net10.0-windows", "win-x64", "Kenet.WindowsAgent.exe");
  inputAgent = spawn(agentPath, [], { windowsHide: true });
  inputAgent.on("error", (error) => console.error("Windows input agent could not start:", error.message));
};

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: "#0d1014",
    titleBarStyle: "hiddenInset",
    autoHideMenuBar: true,
    show: !startedHidden,
    icon: iconPath(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // Keep the signalling socket + its heartbeat alive when the window is hidden in
      // the tray, so incoming connection requests still arrive.
      backgroundThrottling: false,
      preload: path.join(app.getAppPath(), "dist", "preload.js")
    }
  });

  mainWindow.on("close", (event) => {
    if (runInBackground && !quitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  if (process.env.NODE_ENV === "development") void mainWindow.loadURL("http://localhost:5173");
  else void mainWindow.loadFile(path.join(app.getAppPath(), "renderer", "index.html"));
};

const showWindow = () => {
  if (!mainWindow) createWindow();
  mainWindow?.show();
  mainWindow?.focus();
};

const createTray = () => {
  if (tray) return;
  tray = new Tray(iconPath());
  tray.setToolTip("Kenet");
  tray.on("click", showWindow);
  tray.on("double-click", showWindow);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Kenet'i aç", click: showWindow },
      { type: "separator" },
      {
        label: "Çıkış",
        click: () => {
          quitting = true;
          app.quit();
        }
      }
    ])
  );
};

app.on("second-instance", showWindow);

// --- screen-share / capture tuning (must be set before app is ready) ---
// Turn on hardware video encode/decode for WebCodecs + WebRTC where the GPU supports it.
app.commandLine.appendSwitch(
  "enable-features",
  "PlatformHEVCEncoderSupport,MediaFoundationH264Encoding,MediaFoundationVP9Encoding,MediaFoundationD3D11VideoCapture"
);
app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("enable-zero-copy");
// MediaStreamTrackProcessor (the clean way to feed frames to a VideoEncoder) is flag-gated in
// some Chromium builds — turn it on; the encoder has a <video>+rVFC fallback if it's still absent.
app.commandLine.appendSwitch("enable-blink-features", "MediaStreamInsertableStreams");
// The host is routinely minimised / covered while it shares its screen. Chromium's default is to
// throttle — or entirely suspend the capture of — an occluded window, which freezes the stream
// the instant the user clicks "minimise". Disable every layer of that.
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion,WebRtcAllowLegacyTLSProtocols");

app.whenReady().then(() => {
  startInputAgent();

  ipcMain.handle("app:request-elevation", () => {
    if (process.platform !== "win32" || !app.isPackaged) {
      return { started: false, reason: "Yönetici modu yalnızca yüklenmiş Windows uygulamasında kullanılabilir." };
    }
    const executable = process.execPath.replace(/'/g, "''");
    spawn("powershell.exe", ["-NoProfile", "-Command", `Start-Process -FilePath '${executable}' -Verb RunAs`], {
      detached: true,
      windowsHide: true
    });
    void recordAudit("elevation-requested", "Yerel UAC onayı istendi");
    return { started: true };
  });

  ipcMain.on("audit:record", (_event, entry: { event?: unknown; details?: unknown }) => {
    if (typeof entry.event === "string" && typeof entry.details === "string") void recordAudit(entry.event, entry.details);
  });

  // A device wants to connect and the user needs to approve it. If the window is hidden in
  // the tray or not focused, make it impossible to miss: OS notification + bring the window
  // to the front + flash the taskbar entry.
  ipcMain.on("session:incoming", (_event, name: unknown) => {
    const who = typeof name === "string" && name.trim() ? name.trim().slice(0, 60) : "Bir cihaz";
    const wasVisible = mainWindow?.isVisible() && mainWindow.isFocused();
    showWindow();
    if (!wasVisible) mainWindow?.flashFrame(true);
    if (Notification.isSupported()) {
      const note = new Notification({
        title: "Kenet — bağlantı isteği",
        body: `${who} bilgisayarına bağlanmak istiyor. Onaylamak için pencereyi aç.`,
        icon: iconPath()
      });
      note.on("click", () => {
        showWindow();
        mainWindow?.flashFrame(false);
      });
      note.show();
    }
  });
  ipcMain.on("session:attention-clear", () => mainWindow?.flashFrame(false));

  // The connected peer is pushing a file to us. It auto-saves into Downloads (the connection was
  // already approved), so this is a heads-up, not a prompt — but make it visible even from the tray.
  ipcMain.on("session:incoming-file", (_event, payload: { name?: unknown; from?: unknown }) => {
    const name = typeof payload?.name === "string" && payload.name.trim() ? payload.name.trim().slice(0, 80) : "Bir dosya";
    const from = typeof payload?.from === "string" && payload.from.trim() ? payload.from.trim().slice(0, 40) : null;
    if (!Notification.isSupported()) return;
    const note = new Notification({
      title: "Kenet — dosya alınıyor",
      body: from
        ? `${from}, "${name}" dosyasını gönderdi. İndirilenler klasörüne kaydediliyor.`
        : `"${name}" alınıyor — İndirilenler klasörüne kaydedilecek.`,
      icon: iconPath()
    });
    note.on("click", () => shell.openPath(app.getPath("downloads")));
    note.show();
  });
  ipcMain.handle("audit:list", async () => {
    try {
      return (await readFile(auditPath(), "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .slice(-40)
        .map((line) => JSON.parse(line))
        .reverse();
    } catch {
      return [];
    }
  });

  ipcMain.on("control:input", (_event, command) => {
    if (typeof command === "object" && command !== null) inputAgent?.stdin.write(`${JSON.stringify(command)}\n`);
  });

  // ---- Wake-on-LAN: report our own MAC/subnet, and relay magic packets for offline devices ----
  ipcMain.handle("net:info", () => localNetworkInfo());
  ipcMain.handle("wake:send", (_event, mac: unknown) => (typeof mac === "string" ? sendMagicPacket(mac) : { ok: false }));

  // ---- Privacy mode: blank the local monitor + block local input while hosting a session ----
  ipcMain.handle("agent:set-privacy", (_event, on: unknown) => {
    if (typeof on !== "boolean" || !inputAgent) return { ok: false };
    privacyActive = on;
    inputAgent.stdin.write(`${JSON.stringify({ type: "privacy", down: on })}\n`);
    return { ok: true };
  });
  // Renderer pings this every 2s while the screen is blanked; the agent restores the screen on
  // its own if these stop arriving (renderer crashed/hung, or the session dropped uncleanly).
  ipcMain.on("agent:privacy-heartbeat", () => {
    inputAgent?.stdin.write(`${JSON.stringify({ type: "privacy-ping" })}\n`);
  });

  // ---- On-screen annotation: the viewer draws, it's rendered live on this (host) screen ----
  ipcMain.handle("overlay:show", () => {
    createOverlayWindow().showInactive();
    return { ok: true };
  });
  ipcMain.handle("overlay:hide", () => {
    overlayWindow?.close();
    return { ok: true };
  });
  ipcMain.on("overlay:draw", (_event, stroke: unknown) => {
    if (typeof stroke === "object" && stroke !== null) overlayWindow?.webContents.send("draw", stroke);
  });

  ipcMain.handle("file:save", async (_event, payload: { name?: unknown; data?: unknown }) => {
    if (typeof payload.name !== "string" || !(payload.data instanceof ArrayBuffer)) return { saved: false };
    const target = mainWindow
      ? await dialog.showSaveDialog(mainWindow, { defaultPath: payload.name })
      : await dialog.showSaveDialog({ defaultPath: payload.name });
    if (target.canceled || !target.filePath) return { saved: false };
    await writeFile(target.filePath, Buffer.from(payload.data));
    return { saved: true, path: target.filePath };
  });

  ipcMain.handle("clipboard:read", () => clipboard.readText());
  ipcMain.handle("clipboard:write", (_event, text: unknown) => {
    if (typeof text === "string") clipboard.writeText(text);
  });

  // ---- OS clipboard file list: real "copy a file → paste it on the other PC" ----
  ipcMain.handle("clipboard:list-files", async () => {
    if (process.platform !== "win32") return [];
    try {
      const out = await runPowerShell("Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }");
      const paths = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const entries = await Promise.all(
        paths.map(async (p) => {
          try {
            const s = await stat(p);
            return s.isFile() ? { path: p, name: path.basename(p), size: s.size } : null;
          } catch {
            return null;
          }
        })
      );
      return entries.filter((e): e is { path: string; name: string; size: number } => e !== null);
    } catch {
      return [];
    }
  });

  ipcMain.handle("clipboard:read-file", async (_event, filePath: unknown) => {
    if (typeof filePath !== "string") return null;
    const info = await stat(filePath).catch(() => null);
    if (!info || info.size > MAX_CLIPBOARD_BYTES) return null;
    const buffer = await readFile(filePath);
    return { name: path.basename(filePath), data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) };
  });

  ipcMain.handle(
    "clipboard:stage-file",
    async (_event, payload: { batch?: unknown; name?: unknown; data?: unknown }) => {
      if (typeof payload.batch !== "string" || typeof payload.name !== "string" || !(payload.data instanceof ArrayBuffer)) {
        return null;
      }
      const dir = path.join(app.getPath("temp"), "Kenet", "clipboard", payload.batch);
      await mkdir(dir, { recursive: true });
      const safeName = payload.name.replace(/[/\\:*?"<>|]/g, "_");
      const target = path.join(dir, safeName);
      await writeFile(target, Buffer.from(payload.data));
      return target;
    }
  );

  ipcMain.handle("clipboard:commit-files", async (_event, paths: unknown) => {
    if (process.platform !== "win32" || !Array.isArray(paths) || paths.length === 0) return false;
    const list = paths.filter((p): p is string => typeof p === "string");
    if (!list.length) return false;
    try {
      await runPowerShell(`Set-Clipboard -Path ${list.map(psQuote).join(",")}`);
      return true;
    } catch (error) {
      console.error("Set-Clipboard failed:", error instanceof Error ? error.message : error);
      return false;
    }
  });

  // ---- Remote file manager: browse/download/upload the other side's disk over the session ----
  ipcMain.handle("fs:list-drives", async () => {
    if (process.platform !== "win32") return { ok: false, error: "Yalnızca Windows'ta destekleniyor." };
    try {
      const out = await runPowerShell("Get-PSDrive -PSProvider FileSystem | Select-Object -ExpandProperty Root");
      const roots = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const entries = roots.map((root) => ({ name: root, isDir: true, size: 0, modifiedAt: null }));
      return { ok: true, entries };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Sürücüler listelenemedi." };
    }
  });

  ipcMain.handle("fs:list-dir", async (_event, dirPath: unknown) => {
    if (typeof dirPath !== "string" || !dirPath) return { ok: false, error: "Geçersiz klasör." };
    try {
      const items = await readdir(dirPath, { withFileTypes: true });
      const entries = await Promise.all(
        items.map(async (item) => {
          const full = path.join(dirPath, item.name);
          const isDir = item.isDirectory();
          let size = 0;
          let modifiedAt: number | null = null;
          try {
            const info = await stat(full);
            size = isDir ? 0 : info.size;
            modifiedAt = info.mtimeMs;
          } catch {
            /* permission-denied or a broken link on this one entry — still list it, just no metadata */
          }
          return { name: item.name, isDir, size, modifiedAt };
        })
      );
      entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, "tr") : a.isDir ? -1 : 1));
      return { ok: true, entries: entries.slice(0, 2000) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Klasör okunamadı." };
    }
  });

  ipcMain.handle("fs:read-file", async (_event, filePath: unknown) => {
    if (typeof filePath !== "string" || !filePath) return { ok: false, error: "Geçersiz dosya." };
    try {
      const info = await stat(filePath);
      if (!info.isFile()) return { ok: false, error: "Bu bir dosya değil." };
      if (info.size > MAX_FS_READ_BYTES) return { ok: false, error: "Dosya çok büyük (200 MB üzeri)." };
      const buffer = await readFile(filePath);
      return {
        ok: true,
        name: path.basename(filePath),
        data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Dosya okunamadı." };
    }
  });

  ipcMain.handle(
    "fs:write-to-dir",
    async (_event, payload: { dir?: unknown; name?: unknown; data?: unknown }) => {
      if (
        typeof payload.dir !== "string" ||
        typeof payload.name !== "string" ||
        !(payload.data instanceof ArrayBuffer)
      ) {
        return { ok: false, error: "Geçersiz istek." };
      }
      try {
        const target = await uniquePath(path.join(payload.dir, sanitizeFileName(payload.name)));
        await writeFile(target, Buffer.from(payload.data));
        return { ok: true, path: target };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "Dosya yazılamadı." };
      }
    }
  );

  ipcMain.handle("fs:save-to-downloads", async (_event, payload: { name?: unknown; data?: unknown }) => {
    if (typeof payload.name !== "string" || !(payload.data instanceof ArrayBuffer)) return { saved: false };
    try {
      const target = await uniquePath(path.join(app.getPath("downloads"), sanitizeFileName(payload.name)));
      await writeFile(target, Buffer.from(payload.data));
      return { saved: true, path: target };
    } catch {
      return { saved: false };
    }
  });

  // ---- Session recording: MediaRecorder chunks stream in from the renderer, we just append ----
  ipcMain.handle("recording:start", async (_event, suggestedName: unknown) => {
    if (recordingStream) return { ok: false, error: "Zaten kayıt yapılıyor." };
    try {
      const name = typeof suggestedName === "string" && suggestedName.trim() ? suggestedName.trim() : `oturum-${Date.now()}`;
      const dir = path.join(app.getPath("videos"), "Kenet");
      await mkdir(dir, { recursive: true });
      const target = await uniquePath(path.join(dir, `${sanitizeFileName(name)}.webm`));
      recordingStream = createWriteStream(target);
      recordingPath = target;
      return { ok: true, path: target };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Kayıt başlatılamadı." };
    }
  });

  ipcMain.on("recording:chunk", (_event, data: unknown) => {
    if (recordingStream && data instanceof ArrayBuffer) recordingStream.write(Buffer.from(data));
  });

  ipcMain.handle("recording:stop", async () => {
    if (!recordingStream) return { ok: false };
    const finishedPath = recordingPath;
    const stream = recordingStream;
    recordingStream = null;
    recordingPath = null;
    await new Promise<void>((resolve) => stream.end(() => resolve()));
    return { ok: true, path: finishedPath ?? undefined };
  });

  ipcMain.handle("recording:reveal", (_event, filePath: unknown) => {
    if (typeof filePath === "string") shell.showItemInFolder(filePath);
  });

  ipcMain.handle("fs:pick-file", async () => {
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, { properties: ["openFile"] })
      : await dialog.showOpenDialog({ properties: ["openFile"] });
    if (result.canceled || !result.filePaths[0]) return { ok: false };
    return { ok: true, path: result.filePaths[0], name: path.basename(result.filePaths[0]) };
  });

  ipcMain.handle("screen:list", async () => {
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 320, height: 180 } });
    const displays = screen.getAllDisplays();
    return sources.map((source, index) => ({
      id: source.id,
      label: displays[index]
        ? `Monitör ${index + 1} · ${displays[index].size.width}×${displays[index].size.height}`
        : source.name,
      thumbnail: source.thumbnail.toDataURL()
    }));
  });
  ipcMain.handle("screen:prefer", (_event, id: unknown) => {
    if (typeof id === "string") preferredScreenId = id;
  });

  ipcMain.handle("window:fullscreen", (_event, on: unknown) => {
    if (!mainWindow) return false;
    mainWindow.setFullScreen(Boolean(on));
    return mainWindow.isFullScreen();
  });
  ipcMain.on("window:minimize", () => mainWindow?.minimize());
  ipcMain.on("window:close", () => mainWindow?.close());

  ipcMain.handle("app:open-external", (_event, url: unknown) => {
    if (typeof url === "string" && /^https:\/\//.test(url)) void shell.openExternal(url);
  });

  ipcMain.handle("app:startup-prefs", () => ({
    startWithWindows: app.getLoginItemSettings().openAtLogin,
    runInBackground
  }));
  ipcMain.handle(
    "app:set-startup-prefs",
    (_event, prefs: { startWithWindows?: unknown; runInBackground?: unknown }) => {
      if (typeof prefs.runInBackground === "boolean") runInBackground = prefs.runInBackground;
      if (typeof prefs.startWithWindows === "boolean" && process.platform === "win32") {
        app.setLoginItemSettings({
          openAtLogin: prefs.startWithWindows,
          args: ["--hidden"]
        });
      }
      return { ok: true };
    }
  );

  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sources = await desktopCapturer.getSources({ types: ["screen"] });
    const chosen = sources.find((s) => s.id === preferredScreenId) ?? sources[0];
    callback({ video: chosen, audio: "loopback" });
  });

  createTray();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });

  // Auto-update: only when packaged and a real feed is configured (electron-builder
  // writes app-update.yml when a `publish` target is set). Silently no-ops otherwise.
  if (app.isPackaged) {
    const { autoUpdater } = electronUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.on("update-downloaded", () => {
      dialog
        .showMessageBox({
          type: "info",
          buttons: ["Şimdi yeniden başlat", "Sonra"],
          defaultId: 0,
          message: "Kenet güncellemesi hazır",
          detail: "Yeni sürümü uygulamak için yeniden başlatın."
        })
        .then((r) => {
          if (r.response === 0) {
            quitting = true;
            autoUpdater.quitAndInstall();
          }
        });
    });
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
  }
});

app.on("window-all-closed", () => {
  // Keep running in the tray; only a real Quit ends the process.
});

app.on("before-quit", (event) => {
  quitting = true;
  if (recordingStream) {
    recordingStream.end();
    recordingStream = null;
    recordingPath = null;
  }
  // A killed child process doesn't get a graceful chance to run its own stdin-EOF cleanup —
  // if privacy mode is on, explicitly tell the agent to release it before we cut its pipe.
  if (privacyActive && inputAgent) {
    event.preventDefault();
    privacyActive = false;
    inputAgent.stdin.write(`${JSON.stringify({ type: "privacy", down: false })}\n`);
    setTimeout(() => {
      inputAgent?.kill();
      app.quit();
    }, 250);
    return;
  }
  inputAgent?.kill();
});
