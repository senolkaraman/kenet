import type { Plan } from "@kenet/protocol";
import { PLAN_LIMITS } from "@kenet/protocol";
import { query } from "./db.js";

const ACTIVE = new Set(["active", "trialing", "past_due"]);

export interface EffectivePlan {
  plan: Plan;
  planRenewsAt: string | null;
  orgId: string | null;
  orgRole: "owner" | "admin" | "member" | null;
}

interface UserPlanRow {
  plan: string;
  subscription_status: string | null;
  plan_renews_at: Date | null;
}

interface OrgRow {
  id: string;
  role: string;
  subscription_status: string | null;
  plan_renews_at: Date | null;
}

/** Resolves a user's real entitlement: team membership wins, then personal Pro, else Free. */
export const resolvePlan = async (userId: string): Promise<EffectivePlan> => {
  const org = (
    await query<OrgRow>(
      `select o.id, m.role, o.subscription_status, o.plan_renews_at
         from org_members m join organizations o on o.id = m.org_id
        where m.user_id = $1
        order by (o.subscription_status = 'active') desc
        limit 1`,
      [userId]
    )
  ).rows[0];

  if (org && org.subscription_status && ACTIVE.has(org.subscription_status)) {
    return {
      plan: "team",
      planRenewsAt: org.plan_renews_at?.toISOString() ?? null,
      orgId: org.id,
      orgRole: org.role as EffectivePlan["orgRole"]
    };
  }

  const user = (
    await query<UserPlanRow>("select plan, subscription_status, plan_renews_at from users where id = $1", [userId])
  ).rows[0];

  const personalPro = user && user.plan === "pro" && user.subscription_status && ACTIVE.has(user.subscription_status);

  return {
    plan: personalPro ? "pro" : "free",
    planRenewsAt: personalPro ? (user.plan_renews_at?.toISOString() ?? null) : null,
    orgId: org?.id ?? null,
    orgRole: (org?.role as EffectivePlan["orgRole"]) ?? null
  };
};

export const limitsFor = (plan: Plan) => PLAN_LIMITS[plan];
