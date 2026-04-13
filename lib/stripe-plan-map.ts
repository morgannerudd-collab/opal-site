export function getPlanFromPriceId(priceId: string): string {
  const planMap: Record<string, string> = {
    [process.env.STRIPE_PRICE_OPAL_OPERATOR || ""]: "operator",
    [process.env.STRIPE_PRICE_OPAL_OPERATOR_ANNUAL || ""]: "operator",
    [process.env.STRIPE_PRICE_OPAL_STUDIO || ""]: "studio",
    [process.env.STRIPE_PRICE_OPAL_STUDIO_ANNUAL || ""]: "studio",
    [process.env.NEXT_PUBLIC_STRIPE_OPERATOR_PRICE_ID || ""]: "operator",
    [process.env.NEXT_PUBLIC_STRIPE_STUDIO_PRICE_ID || ""]: "studio",
    [process.env.NEXT_PUBLIC_STRIPE_ENTERPRISE_PRICE_ID || ""]: "enterprise",
  };
  return planMap[priceId] || "operator";
}
