import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import { getStripeServerClient } from "@/lib/stripe";

export const runtime = "nodejs";

export async function POST(): Promise<NextResponse> {
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
    .select("stripe_subscription_id")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError) {
    return NextResponse.json({ error: "Unable to load profile" }, { status: 500 });
  }

  if (!profile?.stripe_subscription_id) {
    return NextResponse.json({ error: "No active subscription found" }, { status: 400 });
  }

  const stripe = getStripeServerClient();

  try {
    const subscription = await stripe.subscriptions.update(profile.stripe_subscription_id, {
      cancel_at_period_end: true,
      expand: ["items"],
    });

    const periodEndUnix = subscription.items.data[0]?.current_period_end;
    if (periodEndUnix == null) {
      return NextResponse.json(
        { error: "Could not read subscription billing period end" },
        { status: 500 },
      );
    }

    const { error: updateError } = await supabase
      .from("profiles")
      .update({
        subscription_status: "cancel_pending",
        updated_at: new Date().toISOString(),
      })
      .eq("id", user.id);

    if (updateError) {
      console.error("[stripe/cancel] profile update error", updateError);
      return NextResponse.json({ error: "Could not update subscription status" }, { status: 500 });
    }

    const cancelDate = new Date(periodEndUnix * 1000);

    return NextResponse.json({
      success: true,
      cancel_date: cancelDate.toLocaleDateString(),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unable to cancel subscription";
    console.error("[stripe/cancel]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
