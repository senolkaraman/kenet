/** Messages carried over the WebRTC data channel (peer-to-peer, never touches the server). */

export type ControlCommand =
  | { type: "pointer"; x: number; y: number; button?: "left" | "right" | "middle"; down?: boolean }
  | { type: "scroll"; x: number; y: number; dx: number; dy: number }
  | { type: "key"; key: string; code: string; down: boolean; modifiers: string[] }
  | { type: "combo"; keys: string[] };

/** One entry in a directory listing returned by the remote-file-manager feature. */
export interface FsEntry {
  name: string;
  isDir: boolean;
  size: number;
  modifiedAt: number | null;
}

export type DataMessage =
  | { type: "chat"; text: string; at: number }
  | { type: "bye" }
  | {
      type: "file-offer";
      id: string;
      name: string;
      size: number;
      mime: string;
      clipboardBatch?: string;
      /** Set on manager-initiated uploads: the receiving (host) side writes straight into this
       *  remote folder instead of showing a save dialog, then both sides refresh their listing. */
      remoteWritePath?: string;
      /** Set on manager-initiated downloads: the receiving (viewer) side auto-accepts and saves
       *  straight into its own Downloads folder instead of prompting. */
      autoSaveDownload?: boolean;
    }
  | { type: "file-decision"; id: string; accepted: boolean }
  | { type: "file-end"; id: string }
  | { type: "control"; command: ControlCommand }
  | { type: "clipboard"; text: string }
  | { type: "cursor"; x: number; y: number }
  | { type: "quality"; mode: "auto" | "sharp" | "smooth" }
  | { type: "screens"; list: { id: string; label: string }[]; active: string }
  | { type: "screen-pick"; id: string }
  | { type: "clipboard-files-begin"; batch: string; count: number }
  | { type: "clipboard-files-ready"; batch: string; count: number }
  // ---- remote file manager: browse the host's disk from the viewer side ----
  | { type: "fs-list"; reqId: string; path: string | null }
  | { type: "fs-list-result"; reqId: string; path: string | null; entries: FsEntry[]; error?: string }
  | { type: "fs-download"; reqId: string; path: string }
  | { type: "fs-download-error"; reqId: string; error: string }
  // ---- on-screen annotation: the viewer draws, it appears live on the host's real screen ----
  | { type: "annotate"; strokeId: string; x: number; y: number; phase: "start" | "move" | "end" }
  // ---- WebCodecs video path negotiation (the encoded frames themselves ride the "kenet-video"
  //      data channel as binary, not here) ----
  | { type: "video-caps"; caps: unknown }
  | { type: "video-mode"; mode: "webrtc" | "webcodecs"; codec?: string; from?: "host" | "viewer"; why?: string };

export const encode = (m: DataMessage): string => JSON.stringify(m);
export const decode = (raw: string): DataMessage | null => {
  try {
    return JSON.parse(raw) as DataMessage;
  } catch {
    return null;
  }
};
