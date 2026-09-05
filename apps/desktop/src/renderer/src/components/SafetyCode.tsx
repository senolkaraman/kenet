import { useEffect, useRef, useState } from "react";
import { session } from "../core/session";
import { Button } from "./primitives";
import { Icon } from "./Icon";

/**
 * A small popover showing the connection's safety code (see session.ts's getSafetyCode) —
 * both sides should see the exact same code if they read it out to each other; a mismatch
 * would mean the "peer" isn't who the other side thinks it's connected to.
 */
export function SafetyCodeButton() {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setCode(null);
    void session.getSafetyCode().then(setCode);
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  return (
    <div ref={wrapRef} className="screen-menu-wrap">
      <Button icon variant="subtle" title="Güvenlik kodu" onClick={() => setOpen((v) => !v)}>
        <Icon name="shield" />
      </Button>
      {open && (
        <div className="screen-menu safety-code-pop">
          <p className="muted small" style={{ margin: "2px 6px 8px" }}>
            Karşı tarafla bu kodu telefonda/sohbette karşılaştır. İkisi de aynıysa bağlantınız
            doğrudan ve şifreli — araya biri giremez.
          </p>
          {code ? (
            <strong className="safety-code-value">{code}</strong>
          ) : (
            <span className="muted small" style={{ padding: "0 6px" }}>
              Hesaplanıyor…
            </span>
          )}
        </div>
      )}
    </div>
  );
}
