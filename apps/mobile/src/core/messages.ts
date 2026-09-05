/** Messages carried over the WebRTC data channel (peer-to-peer, never touches the server).
 *  Mobile is viewer-only for now, so this is a subset of the desktop message set. */

export type ControlCommand =
  | { type: "pointer"; x: number; y: number; button?: "left" | "right" | "middle"; down?: boolean }
  | { type: "scroll"; x: number; y: number; dx: number; dy: number }
  | { type: "key"; key: string; code: string; down: boolean; modifiers: string[] }
  | { type: "combo"; keys: string[] };

export type DataMessage =
  | { type: "chat"; text: string; at: number }
  | { type: "bye" }
  | { type: "control"; command: ControlCommand }
  | { type: "clipboard"; text: string }
  | { type: "quality"; mode: "auto" | "sharp" | "smooth" }
  | { type: "screens"; list: { id: string; label: string }[]; active: string }
  | { type: "screen-pick"; id: string };

export const encode = (m: DataMessage): string => JSON.stringify(m);
export const decode = (raw: string): DataMessage | null => {
  try {
    return JSON.parse(raw) as DataMessage;
  } catch {
    return null;
  }
};
