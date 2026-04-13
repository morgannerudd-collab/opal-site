/** Maps Stripe Price IDs (from env) to internal plan keys for webhooks and billing. */
export function buildStripePlanPriceMap(): Record<string, string> {
  const map: Record<string, string> = {};
  const add = (priceId: string | undefined, plan: string) => {
    const id = priceId?.trim();
    if (id) map[id] = plan;
  };

  add(process.env.STRIPE_PRICE_OPAL_OPERATOR, "operator");
  add(process.env.STRIPE_PRICE_OPAL_OPERATOR_ANNUAL, "operator");
  add(process.env.STRIPE_PRICE_OPAL_STUDIO, "studio");
  add(process.env.STRIPE_PRICE_OPAL_STUDIO_ANNUAL, "studio");
  add(process.env.STRIPE_PRICE_OPAL_ENTERPRISE, "enterprise");
  add(process.env.NEXT_PUBLIC_STRIPE_OPERATOR_PRICE_ID, "operator");
  add(process.env.NEXT_PUBLIC_STRIPE_STUDIO_PRICE_ID, "studio");
  add(process.env.NEXT_PUBLIC_STRIPE_ENTERPRISE_PRICE_ID, "enterprise");

  return map;
}
