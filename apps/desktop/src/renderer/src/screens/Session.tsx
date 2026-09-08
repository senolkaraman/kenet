import { useEffect, useMemo, useRef, useState } from "react";
import { session } from "../core/session";
import { useStore } from "../core/store";
import { settingsStore } from "../core/settings";
import { InputBridge } from "../core/input";
import { Button, Switch } from "../components/primitives";
import { Icon } from "../components/Icon";
import { RemoteToolbar } from "./RemoteToolbar";
import { SidePanel } from "./SidePanel";
import { SafetyCodeButton } from "../components/SafetyCode";
import { RecordButton } from "../components/RecordButton";

const fmtBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

export function Session() {
  const role = useStore(session.store, (s) => s.role);
  const phase = useStore(session.store, (s) => s.phase);

  if (phase === "connecting" || phase === "reconnecting") return <ConnectingView />;
  if (role === "host") return <HostView />;
  return <ViewerView />;
}

function ConnectingView() {
  const phase = useStore(session.store, (s) => s.phase);
  const peerName = useStore(session.store, (s) => s.peerName);
  return (
    <main className="session-stage centered">
      <div className="connecting-card">
        <span className="spinner big" />
        <h2>{phase === "reconnecting" ? "Yeniden bağlanılıyor" : "Güvenli bağlantı kuruluyor"}</h2>
        <p className="muted">{peerName} · uçtan uca şifreli WebRTC oturumu</p>
        <Button variant="subtle" onClick={() => session.endSession("İptal edildi.")}>
          İptal
        </Button>
      </div>
    </main>
  );
}

function ViewerView() {
  const remoteStream = useStore(session.store, (s) => s.remoteStream);
  const controlActive = useStore(session.store, (s) => s.controlActive);
  const videoMode = useStore(session.store, (s) => s.videoMode);
  const autoFullscreen = useStore(settingsStore, (s) => s.autoFullscreen);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const bridgeRef = useRef<InputBridge | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [annotating, setAnnotating] = useState(false);

  useEffect(() => {
    if (videoRef.current && remoteStream) videoRef.current.srcObject = remoteStream;
  }, [remoteStream]);

  // Hand the canvas to the session so the WebCodecs decoder can paint into it.
  useEffect(() => {
    session.setVideoCanvas(canvasRef.current);
    return () => session.setVideoCanvas(null);
  }, []);

  useEffect(() => {
    if (!surfaceRef.current) return;
    const bridge = new InputBridge(surfaceRef.current, (cmd) => session.sendControl(cmd));
    bridge.attach();
    bridgeRef.current = bridge;
    return () => {
      bridge.detach();
      bridgeRef.current = null;
    };
  }, []);

  useEffect(() => {
    surfaceRef.current?.classList.toggle("focused", focused);
  }, [focused]);

  useEffect(() => {
    bridgeRef.current?.setEnabled(controlActive);
  }, [controlActive]);

  useEffect(() => {
    surfaceRef.current?.classList.toggle("annotating", annotating);
    if (!annotating || !surfaceRef.current) return;
    const el = surfaceRef.current;
    let strokeId: string | null = null;
    const norm = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      return {
        x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
        y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))
      };
    };
    const onDown = (e: PointerEvent) => {
      strokeId = crypto.randomUUID();
      el.setPointerCapture?.(e.pointerId);
      const p = norm(e);
      session.sendAnnotation(strokeId, p.x, p.y, "start");
    };
    const onMove = (e: PointerEvent) => {
      if (!strokeId) return;
      const p = norm(e);
      session.sendAnnotation(strokeId, p.x, p.y, "move");
    };
    const onUp = (e: PointerEvent) => {
      if (!strokeId) return;
      const p = norm(e);
      session.sendAnnotation(strokeId, p.x, p.y, "end");
      strokeId = null;
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
    };
  }, [annotating]);

  const toggleAnnotate = () => {
    const next = !annotating;
    setAnnotating(next);
    if (next && controlActive) session.setControlActive(false);
  };

  useEffect(() => {
    if (autoFullscreen) {
      void window.kenetControl.setFullscreen?.(true).then((v) => setFullscreen(Boolean(v)));
    }
  }, [autoFullscreen]);

  const toggleFullscreen = () => {
    void window.kenetControl.setFullscreen?.(!fullscreen).then((v) => setFullscreen(Boolean(v)));
  };

  return (
    <main className={`session-stage viewer ${fullscreen ? "is-fullscreen" : ""}`}>
      <div
        ref={surfaceRef}
        className="remote-surface"
        tabIndex={0}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      >
        {/* video stays mounted (and audible) even on the WebCodecs path — the canvas just covers it */}
        <video ref={videoRef} autoPlay playsInline draggable={false} />
        <canvas
          ref={canvasRef}
          className="remote-canvas"
          style={{ display: videoMode === "webcodecs" ? "block" : "none" }}
        />
        {!remoteStream && videoMode !== "webcodecs" && (
          <div className="surface-empty">
            <span className="spinner" />
            <p>Görüntü bekleniyor…</p>
          </div>
        )}
        {!focused && remoteStream && (
          <div className="focus-hint">
            <Icon name="cursor" size={14} /> Klavye girişini yakalamak için tıklayın
          </div>
        )}
      </div>

      <RemoteToolbar
        bridge={bridgeRef.current}
        fullscreen={fullscreen}
        onToggleFullscreen={toggleFullscreen}
        annotating={annotating}
        onToggleAnnotate={toggleAnnotate}
      />

      {panelOpen ? (
        <SidePanel onClose={() => setPanelOpen(false)} />
      ) : (
        <button className="panel-reveal" onClick={() => setPanelOpen(true)} title="Paneli göster">
          <Icon name="chat" />
        </button>
      )}
    </main>
  );
}

function HostView() {
  const peerName = useStore(session.store, (s) => s.peerName);
  const controlOffered = useStore(session.store, (s) => s.controlOffered);
  const privacyActive = useStore(session.store, (s) => s.privacyActive);
  const unattended = useStore(session.store, (s) => s.unattendedSession);
  const stats = useStore(session.store, (s) => s.stats);
  const videoMode = useStore(session.store, (s) => s.videoMode);
  const videoStats = useStore(session.store, (s) => s.videoStats);
  const videoDiag = useStore(session.store, (s) => s.videoDiag);
  const transfers = useStore(session.store, (s) => s.transfers);
  const [screens, setScreens] = useState<Array<{ id: string; label: string; thumbnail: string }>>([]);
  const [sendingClipboardFiles, setSendingClipboardFiles] = useState(false);

  useEffect(() => {
    void window.kenetControl.listScreens?.().then((list) => setScreens(list ?? []));
  }, []);

  const rtt = useMemo(() => (stats.rttMs != null ? `${stats.rttMs} ms` : "—"), [stats.rttMs]);

  return (
    <main className="session-stage host">
      <div className="host-grid">
        <div className="card host-status">
          <div className="host-live">
            <span className="rec-dot" /> {unattended ? "GÖZETİMSİZ OTURUM" : "EKRAN PAYLAŞILIYOR"}
          </div>
          <div className="host-title-row">
            <h2>{peerName} bağlı</h2>
            <SafetyCodeButton />
            <RecordButton />
          </div>
          {unattended && (
            <p className="unattended-note">
              <Icon name="shield" size={13} /> Bu bağlantı gözetimsiz erişim şifresiyle kuruldu. İstediğin an
              sonlandırabilirsin.
            </p>
          )}
          <p className="muted">Bu cihazın ekranı yalnızca bu oturum boyunca aktarılıyor. İstediğiniz an sonlandırabilirsiniz.</p>

          <div className="host-control-toggle">
            <div>
              <strong>Uzaktan fare ve klavye denetimi</strong>
              <p className="muted">{controlOffered ? "Karşı taraf girdi gönderebilir." : "Yalnızca görüntüleme."}</p>
            </div>
            <Switch checked={controlOffered} onChange={(v) => session.setControlOffered(v)} />
          </div>

          <div className="host-control-toggle">
            <div>
              <strong>Gizlilik modu</strong>
              <p className="muted">
                {privacyActive
                  ? "Bu bilgisayarın ekranı karanlık, klavye/fare kilitli. Ctrl+Alt+Del her zaman çalışır."
                  : "Açarsan bu ekranın monitörü kararır, yerel klavye/fare kilitlenir — yanından geçen kimse göremez."}
              </p>
            </div>
            <Switch checked={privacyActive} onChange={(v) => void session.setPrivacyMode(v)} />
          </div>

          <div className="host-actions">
            <Button
              variant="subtle"
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
              {sendingClipboardFiles ? <span className="spinner" /> : <Icon name="file" size={15} />}
              Panodaki dosyayı gönder
            </Button>
            <Button variant="danger" onClick={() => session.endSession()}>
              <Icon name="power" size={15} /> Oturumu sonlandır
            </Button>
          </div>

          {transfers.length > 0 && (
            <div className="host-transfers">
              <h4><Icon name="file" size={13} /> Dosya aktarımları</h4>
              {transfers.slice(-5).map((t) => (
                <div key={t.id} className="stat-row">
                  <span title={t.name}>{t.name}</span>
                  <strong>
                    {fmtBytes(t.size)}
                    {t.state === "active" && " · alınıyor"}
                    {t.state === "done" && " · İndirilenler'e kaydedildi"}
                    {t.state === "rejected" && " · başarısız"}
                  </strong>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card host-side">
          <div className="stat-row"><span>Gecikme</span><strong>{rtt}</strong></div>
          <div className="stat-row"><span>Görüntü yolu</span><strong>{videoMode === "webcodecs" ? `${videoStats?.hardware ? "Donanım" : "Yazılım"} · ${videoStats?.codec ?? ""}` : "WebRTC (klasik)"}</strong></div>
          <div className="stat-row">
            <span>Gönderim</span>
            <strong>
              {videoMode === "webcodecs"
                ? videoStats?.kbps
                  ? `${(videoStats.kbps / 1000).toFixed(1)} Mbps`
                  : "—"
                : stats.kbps != null
                  ? `${(stats.kbps / 1000).toFixed(1)} Mbps`
                  : "—"}
            </strong>
          </div>
          <div className="stat-row">
            <span>Kare / çözünürlük</span>
            <strong>
              {videoMode === "webcodecs"
                ? `${videoStats?.fps ?? 0} fps${videoStats?.width ? ` · ${videoStats.width}×${videoStats.height}` : ""}`
                : `${stats.fps ?? "—"} fps${stats.width ? ` · ${stats.width}×${stats.height}` : ""}`}
            </strong>
          </div>
          <div className="stat-row"><span>Bağlantı</span><strong>{stats.transport === "relay" ? "TURN" : stats.transport === "direct" ? "P2P" : "—"}</strong></div>
          {stats.packetLoss != null && stats.packetLoss > 0 && (
            <div className="stat-row"><span>Paket kaybı</span><strong style={{ color: stats.packetLoss > 2 ? "var(--danger)" : "var(--warn)" }}>%{stats.packetLoss}</strong></div>
          )}
          {videoMode !== "webcodecs" && stats.limited && (
            <div className="stat-row"><span>Sınırlayan</span><strong style={{ color: "var(--warn)" }}>
              {stats.limited === "cpu" ? "İşlemci (encode yetişemiyor)" : stats.limited === "bandwidth" ? "Bant genişliği" : stats.limited}
            </strong></div>
          )}
          {videoDiag && (
            <div className="stat-row" style={{ alignItems: "flex-start" }}>
              <span>Video tanı</span>
              <strong style={{ fontSize: 11, fontWeight: 500, color: "var(--text-3)", textAlign: "right", maxWidth: "62%" }}>{videoDiag}</strong>
            </div>
          )}
          {screens.length > 0 && (
            <>
              <h4 style={{ marginTop: 16 }}>Paylaşılabilir monitörler</h4>
              <div className="host-screens">
                {screens.map((s) => (
                  <button key={s.id} onClick={() => void window.kenetControl.setPreferredScreen?.(s.id)}>
                    <img src={s.thumbnail} alt="" />
                    <span>{s.label}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
      <HostChatDock />
    </main>
  );
}

function HostChatDock() {
  const chat = useStore(session.store, (s) => s.chat);
  const [draft, setDraft] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => logRef.current?.scrollTo({ top: logRef.current.scrollHeight }), [chat]);

  return (
    <div className="card host-chat">
      <h4><Icon name="chat" size={14} /> Sohbet</h4>
      <div className="chat-log" ref={logRef}>
        {chat.length === 0 && <p className="muted center">Mesaj yok.</p>}
        {chat.map((m) => (
          <div key={m.id} className={`bubble ${m.mine ? "mine" : ""}`}>{m.text}</div>
        ))}
      </div>
      <form
        className="chat-compose"
        onSubmit={(e) => {
          e.preventDefault();
          session.sendChat(draft);
          setDraft("");
        }}
      >
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Mesaj yaz…" />
        <Button icon variant="primary" type="submit" disabled={!draft.trim()}>
          <Icon name="send" size={15} />
        </Button>
      </form>
    </div>
  );
}
