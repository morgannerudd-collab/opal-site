import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import { getStripeServerClient, resolveAppBaseUrl } from "@/lib/stripe";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("stripe_customer_id")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError) {
    return NextResponse.json({ error: "Unable to load profile" }, { status: 500 });
  }

  if (!profile?.stripe_customer_id) {
    return NextResponse.json(
      {
        error: "No billing account found. Please complete your subscription setup first.",
      },
      { status: 400 },
    );
  }

  const stripe = getStripeServerClient();
  const baseUrl = resolveAppBaseUrl(request.headers.get("origin"));
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || baseUrl;

  try {
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: `${appUrl}/dashboard/settings?tab=billing`,
    });

    const url = portalSession.url;
    if (!url) {
      return NextResponse.json(
        { error: "Billing portal session did not return a URL" },
        { status: 500 },
      );
    }

    return NextResponse.json({ url });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create portal session";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
