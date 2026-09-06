import type { ControlCommand } from "./messages";

/**
 * Turns typed characters into the same `{type:"key"}` ControlCommand stream the desktop
 * client sends, so the Windows agent (which maps `code`/`key` -> virtual key via
 * `VkKeyScan`) types them on the remote PC. US-layout assumptions; characters that
 * aren't on a US keyboard (e.g. Turkish ç/ğ/ş/ı) fall back to the agent's best guess
 * and may not type — a Unicode `{type:"text"}` path is a planned follow-up.
 */

// Shifted symbol -> its unshifted base key on a US keyboard.
const SHIFT_MAP: Record<string, string> = {
  "!": "1",
  "@": "2",
  "#": "3",
  $: "4",
  "%": "5",
  "^": "6",
  "&": "7",
  "*": "8",
  "(": "9",
  ")": "0",
  _: "-",
  "+": "=",
  "{": "[",
  "}": "]",
  "|": "\\",
  ":": ";",
  '"': "'",
  "<": ",",
  ">": ".",
  "?": "/",
  "~": "`"
};

const codeFor = (c: string): string => {
  if (/^[a-z]$/.test(c)) return "Key" + c.toUpperCase();
  if (/^[0-9]$/.test(c)) return "Digit" + c;
  return "";
};

const keyEvent = (key: string, code: string, down: boolean, modifiers: string[]): ControlCommand => ({
  type: "key",
  key,
  code,
  down,
  modifiers
});

/** Emits the key-down/up sequence (with Shift wrapping when needed) for one character. */
export function charToKeyEvents(ch: string): ControlCommand[] {
  if (ch === "\n" || ch === "\r") return keyPress("Enter", "Enter");
  if (ch === "\t") return keyPress("Tab", "Tab");

  let base = ch;
  let needsShift = false;
  if (/^[A-Z]$/.test(ch)) {
    base = ch.toLowerCase();
    needsShift = true;
  } else if (SHIFT_MAP[ch]) {
    base = SHIFT_MAP[ch];
    needsShift = true;
  }
  const code = codeFor(base);
  const mods = needsShift ? ["Shift"] : [];
  const out: ControlCommand[] = [];
  if (needsShift) out.push(keyEvent("Shift", "ShiftLeft", true, []));
  out.push(keyEvent(base, code, true, mods));
  out.push(keyEvent(base, code, false, mods));
  if (needsShift) out.push(keyEvent("Shift", "ShiftLeft", false, []));
  return out;
}

/** A single named key press (down then up), e.g. Enter / Backspace / ArrowLeft. */
export function keyPress(key: string, code = ""): ControlCommand[] {
  return [keyEvent(key, code, true, []), keyEvent(key, code, false, [])];
}

/** A chord — the agent presses every key in order, then releases in reverse. Use for
 *  modifier combos (Ctrl+C, Ctrl+Alt+Del, Ctrl+Shift+Esc, …). Key names match the agent:
 *  "Control" "Alt" "Shift" "Meta" plus named keys ("Delete", "Escape", "Tab", …) or a
 *  single character. */
export function comboCmd(keys: string[]): ControlCommand {
  return { type: "combo", keys };
}

/** Wrap a key/char with the currently-armed sticky modifiers. Returns a combo when mods are
 *  active (and the caller should then clear them), otherwise a plain press. `key` may be a
 *  named key or a single character. */
export function keyWithMods(key: string, mods: string[], code = ""): ControlCommand[] {
  if (mods.length) return [comboCmd([...mods, key])];
  if (key.length === 1) return charToKeyEvents(key);
  return keyPress(key, code);
}
