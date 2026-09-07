import { useEffect, useRef, useState } from "react";
import { session } from "../core/session";
import { useStore } from "../core/store";
import { Button } from "../components/primitives";
import { Icon } from "../components/Icon";
import { RemoteFiles } from "./RemoteFiles";

type Tab = "chat" | "files" | "browse" | "stats";

const fmtBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

export function SidePanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("chat");
  const chat = useStore(session.store, (s) => s.chat);
  const transfers = useStore(session.store, (s) => s.transfers);
  const stats = useStore(session.store, (s) => s.stats);
  const startedAt = useStore(session.store, (s) => s.startedAt);
  const [draft, setDraft] = useState("");
  const [dragging, setDragging] = useState(false);
  const [sendingClip, setSendingClip] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [chat, tab]);

  const pendingIn = transfers.filter((t) => t.direction === "in" && t.state === "offered");

  return (
    <aside className="side-panel">
      <div className="side-tabs">
        <button data-on={tab === "chat"} onClick={() => setTab("chat")}>
          <Icon name="chat" size={15} /> Sohbet
        </button>
        <button data-on={tab === "files"} onClick={() => setTab("files")}>
          <Icon name="file" size={15} /> Dosyalar{pendingIn.length > 0 && <span className="tab-badge">{pendingIn.length}</span>}
        </button>
        <button data-on={tab === "browse"} onClick={() => setTab("browse")}>
          <Icon name="folder" size={15} /> Karşı PC
        </button>
        <button data-on={tab === "stats"} onClick={() => setTab("stats")}>
          <Icon name="wifi" size={15} /> Durum
        </button>
        <div className="spacer" />
        <Button icon variant="ghost" onClick={onClose} title="Paneli gizle">
          <Icon name="x" size={15} />
        </Button>
      </div>

      {tab === "chat" && (
        <>
          <div className="chat-log" ref={logRef}>
            {chat.length === 0 && <p className="muted center">Oturum boyunca mesajlaşabilirsiniz.</p>}
            {chat.map((m) => (
              <div key={m.id} className={`bubble ${m.mine ? "mine" : ""}`}>
                {m.text}
                <time>{new Date(m.at).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}</time>
              </div>
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
            <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Mesaj yaz…" maxLength={1000} />
            <Button icon variant="primary" type="submit" disabled={!draft.trim()}>
              <Icon name="send" size={15} />
            </Button>
          </form>
        </>
      )}

      {tab === "files" && (
        <div
          className={`files-pane ${dragging ? "drag-over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            for (const file of Array.from(e.dataTransfer.files)) session.offerFile(file);
          }}
        >
          <input
            ref={fileRef}
            type="file"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) session.offerFile(file);
              e.target.value = "";
            }}
          />
          <Button block variant="subtle" onClick={() => fileRef.current?.click()}>
            <Icon name="plus" /> Dosya gönder ya da buraya sürükle
          </Button>
          <Button
            block
            variant="ghost"
            disabled={sendingClip}
            title="Kendi bilgisayarında kopyaladığın dosyayı karşı tarafın panosuna koyar — sonra orada Ctrl+V / Yapıştır"
            onClick={async () => {
              setSendingClip(true);
              try {
                await session.sendClipboardFiles();
              } finally {
                setSendingClip(false);
              }
            }}
          >
            {sendingClip ? <span className="spinner" /> : <Icon name="clipboard" />} Panomdaki dosyayı karşıya yapıştır
          </Button>
          <div className="transfer-list">
            {transfers.length === 0 && <p className="muted center">Henüz aktarım yok.</p>}
            {transfers.map((t) => (
              <div key={t.id} className="transfer">
                <Icon name="file" size={16} />
                <div className="transfer-main">
                  <span className="transfer-name">{t.name}</span>
                  <span className="transfer-meta">
                    {t.direction === "in" ? "Gelen" : "Giden"} · {fmtBytes(t.size)}
                    {t.state === "offered" && t.direction === "out" && " · onay bekleniyor"}
                    {t.state === "offered" && t.direction === "in" && " · yanıt bekliyor"}
                    {t.state === "active" && " · aktarılıyor"}
                    {t.state === "rejected" && " · reddedildi"}
                    {t.state === "done" && " · tamam"}
                  </span>
                  {(t.state === "active" || t.state === "done") && (
                    <div className="progress">
                      <span style={{ width: `${Math.min(100, (t.received / t.size) * 100)}%` }} />
                    </div>
                  )}
                </div>
                {t.direction === "in" && t.state === "offered" && (
                  <div className="transfer-actions">
                    <Button size="sm" variant="primary" onClick={() => session.respondToFile(t.id, true)}>
                      Al
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => session.respondToFile(t.id, false)}>
                      Yok
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === "browse" && <RemoteFiles />}

      {tab === "stats" && (
        <div className="stats-pane">
          <StatRow label="Gecikme" value={stats.rttMs != null ? `${stats.rttMs} ms` : "—"} />
          <StatRow label="Kare hızı" value={stats.fps != null ? `${stats.fps} fps` : "—"} />
          <StatRow label="Bant genişliği" value={stats.kbps != null ? `${(stats.kbps / 1000).toFixed(1)} Mbps` : "—"} />
          <StatRow
            label="Çözünürlük"
            value={stats.width && stats.height ? `${stats.width}×${stats.height}` : "—"}
          />
          <StatRow label="Paket kaybı" value={stats.packetLoss != null ? `%${stats.packetLoss}` : "—"} />
          <StatRow
            label="Bağlantı türü"
            value={stats.transport === "relay" ? "TURN üzerinden" : stats.transport === "direct" ? "Doğrudan (P2P)" : "—"}
          />
          <StatRow
            label="Süre"
            value={startedAt ? fmtDuration(Date.now() - startedAt) : "—"}
          />
        </div>
      )}
    </aside>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}s ${m % 60}dk` : `${m}dk ${s % 60}sn`;
}
