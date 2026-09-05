import Stripe from "stripe";
import { env } from "./env.js";

let client: Stripe | undefined;

export const stripe = (): Stripe => {
  if (!client) {
    if (!env.stripe.secretKey) throw new Error("Stripe is not configured (STRIPE_SECRET_KEY missing).");
    client = new Stripe(env.stripe.secretKey, { apiVersion: "2025-02-24.acacia" });
  }
  return client;
};
