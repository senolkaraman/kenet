import { api } from "./api";
import { authStore, refreshMe } from "./auth";

const openExternal = (url: string) => {
  if (window.kenetControl.openExternal) void window.kenetControl.openExternal(url);
  else window.open(url, "_blank");
};

export const startCheckout = async (plan: "pro" | "team", opts?: { orgName?: string; seats?: number }): Promise<void> => {
  const token = authStore.get().token;
  if (!token) return;
  const { url } = await api<{ url: string }>("/billing/checkout", { method: "POST", token, body: { plan, ...opts } });
  if (url) openExternal(url);
};

export const openBillingPortal = async (): Promise<void> => {
  const token = authStore.get().token;
  if (!token) return;
  const { url } = await api<{ url: string }>("/billing/portal", { method: "POST", token, body: {} });
  if (url) openExternal(url);
};

/** After returning from Stripe, the plan may have changed — refresh on focus. */
export const watchForPlanChange = (): (() => void) => {
  const onFocus = () => void refreshMe();
  window.addEventListener("focus", onFocus);
  return () => window.removeEventListener("focus", onFocus);
};
