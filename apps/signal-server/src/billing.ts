import type Stripe from "stripe";
import { env, billingEnabled } from "./env.js";
import { query } from "./db.js";
import { stripe } from "./stripe.js";
import { HttpError, requireUser, type Ctx } from "./http.js";

const successUrl = () => `${env.publicUrl || "https://kenet.app"}/billing/return?ok=1`;
const cancelUrl = () => `${env.publicUrl || "https://kenet.app"}/billing/return?ok=0`;

const ensureCustomer = async (userId: string, email: string): Promise<string> => {
  const row = (await query<{ stripe_customer_id: string | null }>(
    "select stripe_customer_id from users where id = $1",
    [userId]
  )).rows[0];
  if (row?.stripe_customer_id) return row.stripe_customer_id;

  const customer = await stripe().customers.create({ email, metadata: { userId } });
  await query("update users set stripe_customer_id = $1 where id = $2", [customer.id, userId]);
  return customer.id;
};

export const checkoutHandler = async (ctx: Ctx): Promise<{ url: string }> => {
  if (!billingEnabled()) throw new HttpError(503, "Faturalama yapılandırılmadı.");
  const { userId, email } = requireUser(ctx);
  const { plan, orgName, seats } = (ctx.body ?? {}) as { plan?: unknown; orgName?: unknown; seats?: unknown };

  const customerId = await ensureCustomer(userId, email);

  if (plan === "pro") {
    const session = await stripe().checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: env.stripe.pricePro, quantity: 1 }],
      success_url: successUrl(),
      cancel_url: cancelUrl(),
      metadata: { userId, kind: "personal" }
    });
    return { url: session.url ?? "" };
  }

  if (plan === "team") {
    if (!env.stripe.priceTeam) throw new HttpError(503, "Ekip planı yapılandırılmadı.");
    const quantity = Math.max(2, Math.min(50, Number(seats) || 3));
    const name = typeof orgName === "string" && orgName.trim() ? orgName.trim().slice(0, 80) : `${email} ekibi`;

    const org = (
      await query<{ id: string }>(
        "insert into organizations (name, owner_user_id, stripe_customer_id, seats) values ($1, $2, $3, $4) returning id",
        [name, userId, customerId, quantity]
      )
    ).rows[0];
    await query("insert into org_members (org_id, user_id, role) values ($1, $2, 'owner')", [org.id, userId]);

    const session = await stripe().checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: env.stripe.priceTeam, quantity }],
      success_url: successUrl(),
      cancel_url: cancelUrl(),
      metadata: { userId, orgId: org.id, kind: "team" }
    });
    return { url: session.url ?? "" };
  }

  throw new HttpError(400, "Bilinmeyen plan.");
};

export const portalHandler = async (ctx: Ctx): Promise<{ url: string }> => {
  if (!billingEnabled()) throw new HttpError(503, "Faturalama yapılandırılmadı.");
  const { userId, email } = requireUser(ctx);
  const customerId = await ensureCustomer(userId, email);
  const session = await stripe().billingPortal.sessions.create({
    customer: customerId,
    return_url: `${env.publicUrl || "https://kenet.app"}/billing/return`
  });
  return { url: session.url };
};

// ---- webhook ----

const upsertFromSubscription = async (sub: Stripe.Subscription): Promise<void> => {
  const status = sub.status;
  const renewsAt = new Date(sub.current_period_end * 1000).toISOString();
  const orgId = sub.metadata?.orgId;
  const userId = sub.metadata?.userId;

  if (orgId) {
    await query(
      "update organizations set stripe_subscription_id = $1, subscription_status = $2, plan_renews_at = $3, seats = $4 where id = $5",
      [sub.id, status, renewsAt, sub.items.data[0]?.quantity ?? 1, orgId]
    );
  } else if (userId) {
    await query(
      "update users set plan = $1, subscription_status = $2, plan_renews_at = $3 where id = $4",
      [status === "canceled" ? "free" : "pro", status, renewsAt, userId]
    );
  }
};

export const handleWebhookEvent = async (rawBody: Buffer, signature: string): Promise<void> => {
  const event = stripe().webhooks.constructEvent(rawBody, signature, env.stripe.webhookSecret);

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.subscription) {
        const sub = await stripe().subscriptions.retrieve(session.subscription as string);
        sub.metadata = { ...sub.metadata, ...session.metadata };
        await stripe().subscriptions.update(sub.id, { metadata: sub.metadata });
        await upsertFromSubscription(sub);
      }
      break;
    }
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await upsertFromSubscription(event.data.object as Stripe.Subscription);
      break;
    default:
      break;
  }
};
