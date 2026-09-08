import { useEffect, useRef, useState } from "react";
import { session } from "../core/session";
import { useStore } from "../core/store";
import { settingsStore, updateSettings } from "../core/settings";
import { Button } from "../components/primitives";
import { Icon } from "../components/Icon";
import { toast } from "../components/toast";
import { SafetyCodeButton } from "../components/SafetyCode";
import { RecordButton } from "../components/RecordButton";
import type { InputBridge } from "../core/input";

interface Props {
  bridge: InputBridge | null;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  annotating: boolean;
  onToggleAnnotate: () => void;
}

export function RemoteToolbar({ bridge, fullscreen, onToggleFullscreen, annotating, onToggleAnnotate }: Props) {
  const controlActive = useStore(session.store, (s) => s.controlActive);
  const controlOffered = useStore(session.store, (s) => s.controlOffered);
  const stats = useStore(session.store, (s) => s.stats);
  const videoMode = useStore(session.store, (s) => s.videoMode);
  const videoStats = useStore(session.store, (s) => s.videoStats);
  const quality = useStore(session.store, (s) => s.quality);
  const qualityMode = useStore(settingsStore, (s) => s.quality);
  const [screensOpen, setScreensOpen] = useState(false);
  const [screens, setScreens] = useState<Array<{ id: string; label: string; thumbnail: string }>>([]);
  const [sendingClipboardFiles, setSendingClipboardFiles] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!screensOpen) return;
    void window.kenetControl.listScreens?.().then((list) => setScreens(list ?? []));
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setScreensOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [screensOpen]);

  const toggleControl = () => {
    const next = !controlActive;
    session.setControlActive(next);
    bridge?.setEnabled(next);
    toast(next ? "Uzak denetim etkin" : "Yalnızca görüntüleme", next ? "ok" : "info");
  };

  const cycleQuality = () => {
    const order = ["auto", "sharp", "smooth"] as const;
    const next = order[(order.indexOf(qualityMode) + 1) % order.length];
    updateSettings({ quality: next });
    session.requestQuality(next);
    toast(`Kalite: ${next === "auto" ? "Otomatik" : next === "sharp" ? "Net" : "Akıcı"}`);
  };

  return (
    <div className="remote-toolbar" onMouseDown={(e) => e.stopPropagation()}>
      <span
        className={`link-pill ${quality}`}
        title={videoMode === "webcodecs" ? `Donanım hızlandırmalı: ${videoStats?.codec ?? "video"}` : "Bağlantı kalitesi"}
      >
        <Icon name="wifi" size={14} />
        {stats.rttMs != null ? `${stats.rttMs} ms` : "—"}
        <span className="sep" />
        {videoMode === "webcodecs" ? `${videoStats?.fps ?? 0} fps` : stats.fps != null ? `${stats.fps} fps` : "—"}
        <span className="sep" />
        {videoMode === "webcodecs"
          ? "HW"
          : stats.transport === "relay"
            ? "TURN"
            : stats.transport === "direct"
              ? "P2P"
              : "…"}
      </span>

      <div className="toolbar-group">
        <Button
          icon
          variant={controlActive ? "primary" : "subtle"}
          className={!controlActive && controlOffered ? "nudge" : undefined}
          title={
            controlActive
              ? "Denetimi durdur"
              : controlOffered
                ? "Fare/klavye denetimini al"
                : "Karşı taraf denetime izin vermedi"
          }
          disabled={!controlActive && !controlOffered}
          onClick={toggleControl}
        >
          <Icon name="cursor" />
        </Button>
        <Button icon variant="subtle" title="Ctrl+Alt+Del gönder" onClick={() => bridge?.sendCombo(["Control", "Alt", "Delete"])}>
          <Icon name="keyboard" />
        </Button>
        <Button icon variant="subtle" title="Panodaki metni gönder" onClick={() => void session.syncClipboard()}>
          <Icon name="clipboard" />
        </Button>
        <Button
          icon
          variant="subtle"
          title="Panodaki dosyayı karşı tarafın panosuna gönder (kopyala-yapıştır)"
          disabled={sendingClipboardFiles}
          onClick={async () => {
            setSendingClipboardFiles(true);
            try {
              await session.sendClipboardFiles();
            } finally {
              setSendingClipboardFiles(false);
            }
          }}
        >
          {sendingClipboardFiles ? <span className="spinner" /> : <Icon name="file" />}
        </Button>
        <Button icon variant="subtle" title={`Kalite: ${qualityMode}`} onClick={cycleQuality}>
          <Icon name="bolt" />
        </Button>
        <Button
          icon
          variant={annotating ? "primary" : "subtle"}
          title={annotating ? "Ekrana çizmeyi durdur" : "Ekrana çiz (karşı tarafın ekranında görünür)"}
          onClick={onToggleAnnotate}
        >
          <Icon name="pencil" />
        </Button>
        <div ref={menuRef} className="screen-menu-wrap">
          <Button icon variant="subtle" title="Monitör seç" onClick={() => setScreensOpen((v) => !v)}>
            <Icon name="monitor" />
          </Button>
          {screensOpen && (
            <div className="screen-menu">
              {screens.length === 0 && <span className="muted">Monitör bulunamadı</span>}
              {screens.map((s) => (
                <button
                  key={s.id}
                  onClick={() => {
                    session.pickRemoteScreen(s.id);
                    setScreensOpen(false);
                    toast("Monitör değiştiriliyor…");
                  }}
                >
                  <img src={s.thumbnail} alt="" />
                  <span>{s.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <Button icon variant="subtle" title={fullscreen ? "Tam ekrandan çık" : "Tam ekran"} onClick={onToggleFullscreen}>
          <Icon name="fullscreen" />
        </Button>
        <SafetyCodeButton />
        <RecordButton />
      </div>

      <Button variant="danger" size="sm" onClick={() => session.endSession()}>
        <Icon name="power" size={15} /> Ayrıl
      </Button>
    </div>
  );
}
