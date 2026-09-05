import { useEffect, useState } from "react";
import { PLAN_LIMITS, type Plan } from "@kenet/protocol";
import { authStore } from "../core/auth";
import { useStore } from "../core/store";
import { openBillingPortal, startCheckout } from "../core/billing";
import { orgStore, refreshOrgs, listMembers, inviteMember, removeMember } from "../core/orgs";
import { Button, TextField } from "../components/primitives";
import { Icon } from "../components/Icon";
import { Modal } from "../components/Modal";
import { toast } from "../components/toast";
import type { OrgMember } from "@kenet/protocol";

const PLAN_NAMES: Record<Plan, string> = { free: "Ücretsiz", pro: "Pro", team: "Ekip" };

const featureRows = (plan: Plan) => {
  const l = PLAN_LIMITS[plan];
  return [
    l.maxDevices > 1000 ? "Sınırsız cihaz" : `${l.maxDevices} cihaz`,
    l.unattendedAccess ? "Gözetimsiz erişim" : "Gözetimsiz erişim yok",
    l.sessionRecording ? "Oturum kaydı" : "Oturum kaydı yok",
    `${l.concurrentSessions} eşzamanlı oturum`,
    plan === "team" ? `${l.teamMembers} kişiye kadar ekip` : "Tek kullanıcı"
  ];
};

export function BillingModal({ onClose }: { onClose: () => void }) {
  const user = useStore(authStore, (s) => s.user);
  const { orgs } = useStore(orgStore, (s) => s);
  const [tab, setTab] = useState<"plan" | "team">("plan");
  const [seats, setSeats] = useState(3);
  const [orgName, setOrgName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void refreshOrgs();
  }, []);

  const current = user?.plan ?? "free";
  const myOrg = orgs[0];
  const isOwnerOrAdmin = user?.orgRole === "owner" || user?.orgRole === "admin";

  const go = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast(e instanceof Error ? e.message : "İşlem başarısız", "warn");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Plan ve ekip" icon={<Icon name="bolt" />} onClose={onClose}>
      <div className="seg" style={{ alignSelf: "flex-start" }}>
        <button data-on={tab === "plan"} onClick={() => setTab("plan")}>
          Plan
        </button>
        <button data-on={tab === "team"} onClick={() => setTab("team")}>
          Ekip
        </button>
      </div>

      {tab === "plan" && (
        <>
          <p className="muted small">
            Şu anki planın: <strong style={{ color: "var(--text-1)" }}>{PLAN_NAMES[current]}</strong>
            {user?.planRenewsAt && ` · ${new Date(user.planRenewsAt).toLocaleDateString("tr-TR")} tarihinde yenilenir`}
          </p>
          <div className="plan-grid">
            {(["free", "pro", "team"] as Plan[]).map((p) => (
              <div key={p} className={`plan-card ${current === p ? "current" : ""}`}>
                <h4>{PLAN_NAMES[p]}</h4>
                <ul>
                  {featureRows(p).map((f) => (
                    <li key={f} className={f.includes("yok") ? "off" : undefined}>
                      <Icon name={f.includes("yok") ? "x" : "shield"} size={12} /> {f}
                    </li>
                  ))}
                </ul>
                {current === p ? (
                  <span className="badge ok">Aktif</span>
                ) : p === "pro" ? (
                  <Button size="sm" variant="primary" disabled={busy} onClick={() => go(() => startCheckout("pro"))}>
                    Pro'ya geç
                  </Button>
                ) : p === "team" ? (
                  <div className="plan-team-cta">
                    <TextField placeholder="Ekip adı" value={orgName} onChange={(e) => setOrgName(e.target.value)} />
                    <label className="seats">
                      Koltuk
                      <input
                        type="number"
                        min={2}
                        max={50}
                        value={seats}
                        onChange={(e) => setSeats(Math.max(2, Math.min(50, Number(e.target.value) || 2)))}
                      />
                    </label>
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={busy}
                      onClick={() => go(() => startCheckout("team", { orgName, seats }))}
                    >
                      Ekip kur
                    </Button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
          {current !== "free" && (
            <Button variant="subtle" disabled={busy} onClick={() => go(openBillingPortal)}>
              <Icon name="gear" size={14} /> Aboneliği yönet (ödeme, fatura, iptal)
            </Button>
          )}
          <p className="muted small">Ödeme Stripe üzerinden tarayıcıda açılır; tamamlanınca uygulamaya dön.</p>
        </>
      )}

      {tab === "team" && <TeamPanel busy={busy} go={go} isOwnerOrAdmin={isOwnerOrAdmin} />}
    </Modal>
  );
}

function TeamPanel({
  busy,
  go,
  isOwnerOrAdmin
}: {
  busy: boolean;
  go: (fn: () => Promise<void>) => Promise<void>;
  isOwnerOrAdmin: boolean;
}) {
  const { orgs } = useStore(orgStore, (s) => s);
  const user = useStore(authStore, (s) => s.user);
  const org = orgs[0];
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [email, setEmail] = useState("");

  useEffect(() => {
    if (org) void listMembers(org.id).then((r) => setMembers(r.members));
  }, [org?.id]);

  if (!org) {
    return <p className="muted center">Henüz bir ekibin yok. "Plan" sekmesinden ekip kurabilirsin.</p>;
  }

  const reload = () => listMembers(org.id).then((r) => setMembers(r.members));

  return (
    <>
      <div className="settings-row">
        <span>
          <strong>{org.name}</strong> · {org.memberCount}/{org.seats} koltuk
        </span>
        <span className={`badge ${org.subscriptionStatus === "active" ? "ok" : "warn"}`}>
          {org.subscriptionStatus === "active" ? "Aktif" : (org.subscriptionStatus ?? "beklemede")}
        </span>
      </div>

      <div className="member-list">
        {members.map((m) => (
          <div key={m.userId} className="member-row">
            <Icon name="shield" size={14} />
            <span className="member-email">{m.email}</span>
            <span className="badge">{m.role}</span>
            {isOwnerOrAdmin && m.role !== "owner" && m.userId !== user?.id && (
              <Button
                size="sm"
                variant="ghost"
                icon
                title="Çıkar"
                onClick={() => go(async () => void (await removeMember(org.id, m.userId), await reload()))}
              >
                <Icon name="x" size={13} />
              </Button>
            )}
          </div>
        ))}
      </div>

      {isOwnerOrAdmin && (
        <form
          className="invite-form"
          onSubmit={(e) => {
            e.preventDefault();
            void go(async () => {
              await inviteMember(org.id, email.trim(), "member");
              setEmail("");
              toast("Davet oluşturuldu", "ok");
              await refreshOrgs();
            });
          }}
        >
          <input
            type="email"
            placeholder="davet@ornek.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <Button size="sm" variant="primary" type="submit" disabled={busy || !email.trim()}>
            <Icon name="plus" size={14} /> Davet et
          </Button>
        </form>
      )}
    </>
  );
}
