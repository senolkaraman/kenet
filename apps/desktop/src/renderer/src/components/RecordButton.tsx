import { useEffect, useState } from "react";
import { PLAN_LIMITS } from "@kenet/protocol";
import { session } from "../core/session";
import { authStore } from "../core/auth";
import { useStore } from "../core/store";
import { Button } from "./primitives";
import { Icon } from "./Icon";
import { toast } from "./toast";

/** Local-only session recording toggle — records this side's own view of the session to disk.
 *  Shared between the viewer toolbar and the host view. Gated by plan (Pro/Team). */
export function RecordButton() {
  const recordingActive = useStore(session.store, (s) => s.recordingActive);
  const plan = useStore(authStore, (s) => s.user?.plan ?? "free");
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!recordingActive) {
      setElapsed(0);
      return;
    }
    const start = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [recordingActive]);

  const toggle = async () => {
    if (recordingActive) {
      setBusy(true);
      const { path } = await session.stopRecording();
      setBusy(false);
      if (path) {
        toast("Kayıt tamamlandı", "ok");
        void window.kenetControl.revealRecording?.(path);
      }
      return;
    }
    if (!PLAN_LIMITS[plan].sessionRecording) {
      toast("Oturum kaydı Pro ve Ekip planlarında kullanılabilir — Ayarlar'dan yükseltebilirsin.", "warn");
      return;
    }
    setBusy(true);
    const result = await session.startRecording();
    setBusy(false);
    if (!result.ok) toast(result.error ?? "Kayıt başlatılamadı.", "warn");
  };

  const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;

  return (
    <span className="record-btn-wrap">
      <Button
        icon
        variant={recordingActive ? "danger" : "subtle"}
        title={recordingActive ? "Kaydı durdur" : "Oturumu kaydet (bu cihaza, .webm)"}
        disabled={busy}
        onClick={() => void toggle()}
      >
        {busy ? <span className="spinner" /> : <Icon name="record" />}
      </Button>
      {recordingActive && <span className="record-timer">{fmt(elapsed)}</span>}
    </span>
  );
}
