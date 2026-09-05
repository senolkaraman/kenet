import { useEffect, useState } from "react";
import { fetchActivity, activityLabel, type ActivityEvent } from "../core/activity";
import { devicesStore } from "../core/devices";
import { useStore } from "../core/store";
import { Icon } from "../components/Icon";
import { Modal } from "../components/Modal";

export function ActivityModal({ onClose }: { onClose: () => void }) {
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const { devices } = useStore(devicesStore, (s) => s);
  const nameOf = (id: string | null) => (id ? (devices.find((d) => d.id === id)?.name ?? id) : "—");

  useEffect(() => {
    void fetchActivity().then(setEvents);
  }, []);

  return (
    <Modal title="Hesap etkinliği" icon={<Icon name="shield" />} onClose={onClose}>
      <p className="muted small">Bu hesaba bağlı cihazlar arasındaki tüm oturumlar sunucuda kayıtlıdır.</p>
      <div className="activity-list">
        {events === null && <span className="spinner" />}
        {events?.length === 0 && <p className="muted center">Henüz oturum kaydı yok.</p>}
        {events?.map((e) => (
          <div key={e.id} className="activity-item">
            <span className={`activity-dot ${e.kind}`} />
            <div className="activity-body">
              <strong>{activityLabel(e.kind)}</strong>
              <span className="muted small">
                {nameOf(e.actorDeviceId)} → {nameOf(e.targetDeviceId)}
              </span>
            </div>
            <time>{new Date(e.at).toLocaleString("tr-TR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</time>
          </div>
        ))}
      </div>
    </Modal>
  );
}
