import { useEffect } from "react";
import { Store, useStore } from "../core/store";
import { Icon } from "./Icon";

export type ToastTone = "info" | "ok" | "warn" | "error";
interface Toast {
  id: string;
  tone: ToastTone;
  text: string;
}

const store = new Store<{ items: Toast[] }>({ items: [] });

export const toast = (text: string, tone: ToastTone = "info"): void => {
  const items = store.get().items;
  if (items.some((t) => t.text === text)) return;
  const id = crypto.randomUUID();
  store.set({ items: [...items.slice(-3), { id, tone, text }] });
  window.setTimeout(() => store.set((s) => ({ items: s.items.filter((t) => t.id !== id) })), 4200);
};

export function Toaster() {
  const items = useStore(store, (s) => s.items);
  return (
    <div className="toasts">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`} role="status">
          <span className="accent" />
          <Icon name={t.tone === "error" ? "x" : t.tone === "ok" ? "shield" : "bolt"} size={15} />
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

/** Bridges the session controller's `message` field into transient toasts. */
export function useMessageToasts(message: string) {
  useEffect(() => {
    if (message) toast(message);
  }, [message]);
}
