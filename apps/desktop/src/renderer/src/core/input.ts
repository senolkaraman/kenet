import type { ControlCommand } from "./messages";

const BUTTONS: Record<number, "left" | "right" | "middle"> = { 0: "left", 1: "middle", 2: "right" };

const activeModifiers = (e: KeyboardEvent | PointerEvent): string[] => {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Control");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Meta");
  return mods;
};

/**
 * Binds mouse + keyboard capture on the remote-view surface and emits normalised
 * ControlCommands. Pointer moves are coalesced to one frame to keep the data channel light.
 */
export class InputBridge {
  private raf = 0;
  private pending: { x: number; y: number } | null = null;
  private enabled = false;
  private down: "left" | "right" | "middle" | null = null;
  private readonly cleanups: (() => void)[] = [];

  constructor(
    private readonly surface: HTMLElement,
    private readonly emit: (command: ControlCommand) => void
  ) {}

  setEnabled(on: boolean): void {
    if (!on && this.down) {
      this.emit({ type: "pointer", x: this.pending?.x ?? 0.5, y: this.pending?.y ?? 0.5, button: this.down, down: false });
      this.down = null;
    }
    this.enabled = on;
    this.surface.classList.toggle("controlling", on);
  }

  private norm(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const r = this.surface.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))
    };
  }

  private flush = (): void => {
    this.raf = 0;
    if (this.pending) {
      this.emit({ type: "pointer", x: this.pending.x, y: this.pending.y });
      this.pending = null;
    }
  };

  attach(): void {
    const on = <K extends keyof HTMLElementEventMap>(
      target: HTMLElement | Window,
      type: K | string,
      handler: (e: never) => void,
      opts?: AddEventListenerOptions
    ) => {
      target.addEventListener(type, handler as EventListener, opts);
      this.cleanups.push(() => target.removeEventListener(type, handler as EventListener, opts));
    };

    on(this.surface, "pointermove", (e: PointerEvent) => {
      if (!this.enabled) return;
      this.pending = this.norm(e);
      if (!this.raf) this.raf = requestAnimationFrame(this.flush);
    });
    on(this.surface, "pointerdown", (e: PointerEvent) => {
      if (!this.enabled) return;
      // Without this, pressing on the <video> and moving makes Chromium start a native
      // image/video drag-and-drop: pointermove stops firing and pointerup never arrives, so the
      // remote side is left with the mouse button held down mid-drag — the "screen froze" bug.
      e.preventDefault();
      this.surface.setPointerCapture?.(e.pointerId);
      this.down = BUTTONS[e.button] ?? "left";
      const p = this.norm(e);
      this.emit({ type: "pointer", x: p.x, y: p.y, button: this.down, down: true });
    });
    const release = (e: PointerEvent) => {
      if (!this.enabled || !this.down) return;
      const button = this.down;
      this.down = null;
      const p = this.norm(e);
      this.emit({ type: "pointer", x: p.x, y: p.y, button, down: false });
    };
    on(this.surface, "pointerup", release);
    // If the OS/browser yanks the pointer (drag-and-drop kicked in, window lost focus, tab hidden),
    // still tell the remote side the button is up so it never stays stuck.
    on(this.surface, "pointercancel", release);
    on(this.surface, "lostpointercapture", release);
    on(this.surface, "dragstart", (e: Event) => e.preventDefault());
    on(this.surface, "contextmenu", (e: Event) => e.preventDefault());
    on(this.surface, "wheel", (e: WheelEvent) => {
      if (!this.enabled) return;
      e.preventDefault();
      const p = this.norm(e);
      this.emit({ type: "scroll", x: p.x, y: p.y, dx: e.deltaX, dy: e.deltaY });
    }, { passive: false });

    on(window, "keydown", (e: KeyboardEvent) => {
      if (!this.enabled || !this.surface.classList.contains("focused")) return;
      if (e.key === "F11") return; // let the app own fullscreen
      e.preventDefault();
      this.emit({ type: "key", key: e.key, code: e.code, down: true, modifiers: activeModifiers(e) });
    });
    on(window, "keyup", (e: KeyboardEvent) => {
      if (!this.enabled || !this.surface.classList.contains("focused")) return;
      e.preventDefault();
      this.emit({ type: "key", key: e.key, code: e.code, down: false, modifiers: activeModifiers(e) });
    });
  }

  sendCombo(keys: string[]): void {
    this.emit({ type: "combo", keys });
  }

  detach(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    for (const c of this.cleanups) c();
    this.cleanups.length = 0;
  }
}
