import { contextBridge, ipcRenderer } from "electron";

/** Bridge for the transparent always-on-top annotation overlay window (see assets/overlay/). */
contextBridge.exposeInMainWorld("overlayBridge", {
  onDraw: (cb: (data: { strokeId: string; x: number; y: number; phase: "start" | "move" | "end" }) => void) =>
    ipcRenderer.on("draw", (_event, data) => cb(data))
});
