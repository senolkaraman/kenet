import { useEffect, useState } from "react";
import { session } from "../core/session";
import { useStore } from "../core/store";
import { Button } from "../components/primitives";
import { Icon } from "../components/Icon";

const fmtBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

const join = (dir: string, name: string): string => (dir.endsWith("\\") ? `${dir}${name}` : `${dir}\\${name}`);
const parentOf = (dir: string): string | null => {
  const trimmed = dir.replace(/\\+$/, "");
  const i = trimmed.lastIndexOf("\\");
  if (i < 0) return null;
  const parent = trimmed.slice(0, i + 1);
  return /^[A-Za-z]:\\?$/.test(parent) ? parent : parent || null;
};

interface Entry {
  name: string;
  isDir: boolean;
  size: number;
  modifiedAt: number | null;
}

/**
 * Lets the viewer browse the connected host's file system, pull a file down (auto-saved
 * to this PC's Downloads folder) or push a local file up into the folder currently open.
 * Only reachable while the host has offered control — see the guard in session.ts.
 */
export function RemoteFiles() {
  const controlOffered = useStore(session.store, (s) => s.controlOffered);
  const [path, setPath] = useState<string | null>(null); // null = drive list
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState<string | null>(null); // name currently downloading, or "__upload__"
  const [pathDraft, setPathDraft] = useState("");

  const load = (target: string | null) => {
    setLoading(true);
    setError(undefined);
    void session.listRemoteDir(target).then((r) => {
      setEntries(r.entries);
      setError(r.error);
      setLoading(false);
    });
  };

  useEffect(() => {
    load(path);
    setPathDraft(path ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  if (!controlOffered) {
    return (
      <div className="fm-empty">
        <Icon name="shield" size={20} />
        <p className="muted center">
          Karşı taraf denetime izin vermeden dosya gezinemezsiniz — bu yetki, uzaktan denetimle aynı onaya bağlı.
        </p>
      </div>
    );
  }

  const dirs = entries.filter((e) => e.isDir);
  const files = entries.filter((e) => !e.isDir);

  return (
    <div className="fm-pane">
      <div className="fm-crumbs">
        <Button icon size="sm" variant="ghost" disabled={path === null} onClick={() => setPath(path ? parentOf(path) : null)}>
          <Icon name="arrowLeft" size={14} />
        </Button>
        <form
          className="fm-path-form"
          onSubmit={(e) => {
            e.preventDefault();
            const next = pathDraft.trim();
            setPath(next ? next : null);
          }}
        >
          <input
            className="fm-path"
            value={pathDraft}
            placeholder="Bu Bilgisayar"
            onChange={(e) => setPathDraft(e.target.value)}
          />
        </form>
        <Button icon size="sm" variant="ghost" title="Yenile" onClick={() => load(path)}>
          <Icon name="refresh" size={14} />
        </Button>
      </div>

      {path && (
        <Button
          block
          variant="subtle"
          disabled={busy !== null}
          onClick={async () => {
            setBusy("__upload__");
            try {
              await session.uploadToRemoteDir(path);
            } finally {
              setBusy(null);
              window.setTimeout(() => load(path), 600);
            }
          }}
        >
          {busy === "__upload__" ? <span className="spinner" /> : <Icon name="upload" size={15} />} Bu klasöre dosya yükle
        </Button>
      )}

      <div className="fm-list">
        {loading && <p className="muted center">Yükleniyor…</p>}
        {!loading && error && <p className="muted center">{error}</p>}
        {!loading && !error && entries.length === 0 && <p className="muted center">Bu klasör boş.</p>}
        {!loading &&
          !error &&
          dirs.map((e) => (
            <button key={e.name} className="fm-entry" onClick={() => setPath(path ? join(path, e.name) : e.name)}>
              <Icon name="folder" size={16} />
              <span className="fm-name">{e.name}</span>
            </button>
          ))}
        {!loading &&
          !error &&
          files.map((e) => (
            <div key={e.name} className="fm-entry fm-file">
              <Icon name="file" size={16} />
              <div className="fm-main">
                <span className="fm-name">{e.name}</span>
                <span className="fm-meta">{fmtBytes(e.size)}</span>
              </div>
              <Button
                icon
                size="sm"
                variant="ghost"
                title="İndir (İndirilenler klasörüne kaydedilir)"
                disabled={busy !== null}
                onClick={() => {
                  setBusy(e.name);
                  session.downloadRemoteFile(join(path ?? "", e.name));
                  window.setTimeout(() => setBusy(null), 2000);
                }}
              >
                {busy === e.name ? <span className="spinner" /> : <Icon name="download" size={14} />}
              </Button>
            </div>
          ))}
      </div>
    </div>
  );
}
