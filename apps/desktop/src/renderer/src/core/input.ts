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
  private readonly cleanups: (() => void)[] = [];

  constructor(
    private readonly surface: HTMLElement,
    private readonly emit: (command: ControlCommand) => void
  ) {}

  setEnabled(on: boolean): void {
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
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      const p = this.norm(e);
      this.emit({ type: "pointer", x: p.x, y: p.y, button: BUTTONS[e.button] ?? "left", down: true });
    });
    on(this.surface, "pointerup", (e: PointerEvent) => {
      if (!this.enabled) return;
      const p = this.norm(e);
      this.emit({ type: "pointer", x: p.x, y: p.y, button: BUTTONS[e.button] ?? "left", down: false });
    });
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
