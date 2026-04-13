import type { SupabaseClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import { NextResponse } from "next/server";
import { sendEmail } from "@/lib/email";
import { createSupabaseAdminClient } from "@/lib/server/create-supabase-admin";
import { buildStripePlanPriceMap } from "@/lib/stripe-plan-map";
import { getStripeServerClient } from "@/lib/stripe";

export const runtime = "nodejs";

const PLAN_MAP = buildStripePlanPriceMap();

function stripeCustomerId(obj: Stripe.Checkout.Session | Stripe.Invoice | Stripe.Subscription): string | null {
  const c = obj.customer;
  if (typeof c === "string") return c;
  if (c && typeof c === "object" && "id" in c && typeof (c as { id?: string }).id === "string") {
    return (c as { id: string }).id;
  }
  return null;
}

function stripeSubscriptionId(
  sub: string | Stripe.Subscription | null | undefined,
): string | null {
  if (typeof sub === "string") return sub;
  if (sub && typeof sub === "object" && "id" in sub) return sub.id;
  return null;
}

/** Subscription id on invoices (Stripe API versions nest this under `parent`). */
function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const nested = invoice.parent?.subscription_details?.subscription;
  const fromNested = stripeSubscriptionId(nested ?? undefined);
  if (fromNested) return fromNested;
  const legacy = invoice as Stripe.Invoice & {
    subscription?: string | Stripe.Subscription | null;
  };
  return stripeSubscriptionId(legacy.subscription);
}

async function getAuthEmail(supabaseAdmin: SupabaseClient, userId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
  if (error || !data.user) return null;
  return data.user.email ?? null;
}

async function getUserByCustomerId(
  supabaseAdmin: SupabaseClient,
  customerId: string,
): Promise<{ id: string; email: string | null } | null> {
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();

  if (error || !data) {
    console.error(`No user found for Stripe customer ${customerId}`);
    return null;
  }
  const email = await getAuthEmail(supabaseAdmin, data.id);
  return { id: data.id, email };
}

async function getUserByEmail(
  supabaseAdmin: SupabaseClient,
  email: string,
): Promise<{ id: string; email: string } | null> {
  const { data: userId, error } = await supabaseAdmin.rpc("lookup_user_id_by_email", {
    lookup_email: email,
  });

  if (error || userId == null || userId === "") {
    console.error(`No user found for email ${email}`, error);
    return null;
  }
  const id = String(userId);
  return { id, email };
}

export async function POST(request: Request): Promise<NextResponse> {
  const stripe = getStripeServerClient();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return NextResponse.json({ error: "STRIPE_WEBHOOK_SECRET is missing" }, { status: 500 });
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing Stripe signature" }, { status: 400 });
  }

  const payload = await request.text();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(payload, signature, webhookSecret);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid webhook signature";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const supabaseAdmin = createSupabaseAdminClient();
  if (!supabaseAdmin) {
    console.error("[Stripe webhook] Supabase admin client unavailable (check service role env)");
    return NextResponse.json({ received: true });
  }

  switch (event.type) {
    case "checkout.session.completed": {
      try {
        await handleCheckoutSessionCompleted(stripe, supabaseAdmin, event);
      } catch (e) {
        console.error("[Stripe webhook] checkout.session.completed", e);
      }
      break;
    }
    case "invoice.payment_succeeded": {
      try {
        await handleInvoicePaymentSucceeded(stripe, supabaseAdmin, event);
      } catch (e) {
        console.error("[Stripe webhook] invoice.payment_succeeded", e);
      }
      break;
    }
    case "invoice.payment_failed": {
      try {
        await handleInvoicePaymentFailed(supabaseAdmin, event);
      } catch (e) {
        console.error("[Stripe webhook] invoice.payment_failed", e);
      }
      break;
    }
    case "customer.subscription.updated": {
      try {
        await handleCustomerSubscriptionUpdated(supabaseAdmin, event);
      } catch (e) {
        console.error("[Stripe webhook] customer.subscription.updated", e);
      }
      break;
    }
    case "customer.subscription.deleted": {
      try {
        await handleCustomerSubscriptionDeleted(supabaseAdmin, event);
      } catch (e) {
        console.error("[Stripe webhook] customer.subscription.deleted", e);
      }
      break;
    }
    default: {
      console.log("[Stripe webhook] unhandled event", event.type);
    }
  }

  return NextResponse.json({ received: true });
}

async function handleCheckoutSessionCompleted(
  stripe: Stripe,
  supabaseAdmin: SupabaseClient,
  event: Stripe.Event,
) {
  const session = event.data.object as Stripe.Checkout.Session;
  const customerId = stripeCustomerId(session);
  const subscriptionId = stripeSubscriptionId(session.subscription);

  const customerEmail =
    session.customer_details?.email?.trim() ||
    (typeof session.customer_email === "string" ? session.customer_email.trim() : "") ||
    null;

  if (!customerEmail) {
    console.error("checkout.session.completed: no customer email");
    return;
  }

  if (!customerId || !subscriptionId) {
    console.error("checkout.session.completed: missing customer or subscription id");
    return;
  }

  let user: { id: string; email: string | null } | null = null;
  const metaUid = session.metadata?.supabase_user_id?.trim();
  if (metaUid) {
    const emailFromAuth = await getAuthEmail(supabaseAdmin, metaUid);
    user = { id: metaUid, email: emailFromAuth ?? customerEmail };
  } else {
    user = await getUserByCustomerId(supabaseAdmin, customerId);
    if (!user) {
      const byEmail = await getUserByEmail(supabaseAdmin, customerEmail);
      user = byEmail ? { id: byEmail.id, email: byEmail.email } : null;
    }
  }

  if (!user) {
    console.error(`checkout.session.completed: no user found for ${customerEmail}`);
    return;
  }

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const priceId = subscription.items.data[0]?.price.id;
  const plan =
    (priceId && PLAN_MAP[priceId]) ||
    session.metadata?.onboarding_plan ||
    session.metadata?.plan ||
    session.metadata?.planId ||
    "operator";

  const interval = subscription.items.data[0]?.price.recurring?.interval;
  const billing = interval === "year" ? "annual" : "monthly";

  const trialEndsAt = subscription.trial_end
    ? new Date(subscription.trial_end * 1000).toISOString()
    : null;

  const { error: updateError } = await supabaseAdmin
    .from("profiles")
    .update({
      stripe_customer_id: customerId,
      stripe_subscription_id: subscriptionId,
      subscription_status: subscription.status,
      plan,
      billing_interval: billing,
      trial_ends_at: trialEndsAt,
      payment_status: "active",
      account_status: "active",
      updated_at: new Date().toISOString(),
    })
    .eq("id", user.id);

  if (updateError) {
    console.error("checkout.session.completed: profile update error", updateError);
  }

  const { error: insertError } = await supabaseAdmin.from("subscription_events").insert({
    user_id: user.id,
    event_type: "checkout_completed",
    stripe_customer_id: customerId,
    stripe_subscription_id: subscriptionId,
    plan,
    billing_interval: billing,
    amount_cents: session.amount_total,
    metadata: { stripe_status: subscription.status },
  });

  if (insertError) {
    console.error("checkout.session.completed: subscription_events insert error", insertError);
  }

  console.log(`checkout.session.completed: updated user ${user.id} to plan ${plan}`);
}

async function handleInvoicePaymentSucceeded(
  _stripe: Stripe,
  supabaseAdmin: SupabaseClient,
  event: Stripe.Event,
) {
  const invoice = event.data.object as Stripe.Invoice;
  const customerId = stripeCustomerId(invoice);
  if (!customerId) return;

  const user = await getUserByCustomerId(supabaseAdmin, customerId);
  if (!user) return;

  const subId = invoiceSubscriptionId(invoice);

  const { error: updateError } = await supabaseAdmin
    .from("profiles")
    .update({
      subscription_status: "active",
      payment_status: "active",
      account_status: "active",
      suspension_date: null,
      grace_period_end: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", user.id);

  if (updateError) {
    console.error("invoice.payment_succeeded: profile update error", updateError);
  }

  const { error: insertError } = await supabaseAdmin.from("subscription_events").insert({
    user_id: user.id,
    event_type: "payment_succeeded",
    stripe_customer_id: customerId,
    stripe_subscription_id: subId,
    stripe_invoice_id: invoice.id,
    amount_cents: invoice.amount_paid,
    metadata: { stripe_status: "active" },
  });

  if (insertError) {
    console.error("invoice.payment_succeeded: subscription_events insert error", insertError);
  }

  const renewalEmail = user.email ?? (await getAuthEmail(supabaseAdmin, user.id));
  if (invoice.billing_reason === "subscription_cycle" && renewalEmail) {
    await sendEmail({
      to: renewalEmail,
      subject: "Your Opal subscription has renewed",
      type: "payment_succeeded",
      data: {
        amount: (invoice.amount_paid / 100).toFixed(2),
        period_end: new Date((invoice.period_end || 0) * 1000).toLocaleDateString(),
      },
    });
  }

  console.log(`invoice.payment_succeeded: cleared payment issues for user ${user.id}`);
}

async function handleInvoicePaymentFailed(supabaseAdmin: SupabaseClient, event: Stripe.Event) {
  const invoice = event.data.object as Stripe.Invoice;
  const customerId = stripeCustomerId(invoice);
  if (!customerId) return;

  const user = await getUserByCustomerId(supabaseAdmin, customerId);
  if (!user) return;

  const gracePeriodEnd = new Date();
  gracePeriodEnd.setDate(gracePeriodEnd.getDate() + 7);

  const { error: updateError } = await supabaseAdmin
    .from("profiles")
    .update({
      subscription_status: "past_due",
      payment_status: "past_due",
      grace_period_end: gracePeriodEnd.toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", user.id);

  if (updateError) {
    console.error("invoice.payment_failed: profile update error", updateError);
  }

  const subId = invoiceSubscriptionId(invoice);

  const { error: insertError } = await supabaseAdmin.from("subscription_events").insert({
    user_id: user.id,
    event_type: "payment_failed",
    stripe_customer_id: customerId,
    stripe_subscription_id: subId,
    stripe_invoice_id: invoice.id,
    amount_cents: invoice.amount_due,
    metadata: { stripe_status: "past_due" },
  });

  if (insertError) {
    console.error("invoice.payment_failed: subscription_events insert error", insertError);
  }

  const email = user.email ?? (await getAuthEmail(supabaseAdmin, user.id));
  if (email) {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    await sendEmail({
      to: email,
      subject: "Action required: Your Opal payment didn't go through",
      type: "payment_failed",
      data: {
        amount: (invoice.amount_due / 100).toFixed(2),
        grace_period_end: gracePeriodEnd.toLocaleDateString(),
        update_url: `${appUrl}/dashboard/settings?tab=billing`,
      },
    });
  } else {
    console.error("invoice.payment_failed: no email for user", user.id);
  }

  console.log(
    `invoice.payment_failed: set past_due for user ${user.id}, grace period ends ${gracePeriodEnd.toISOString()}`,
  );
}

async function handleCustomerSubscriptionUpdated(supabaseAdmin: SupabaseClient, event: Stripe.Event) {
  const subscription = event.data.object as Stripe.Subscription;
  const customerId = stripeCustomerId(subscription);
  if (!customerId) return;

  const user = await getUserByCustomerId(supabaseAdmin, customerId);
  if (!user) return;

  const priceId = subscription.items.data[0]?.price.id;
  const plan = (priceId && PLAN_MAP[priceId]) || "operator";

  let subscriptionStatus: string = subscription.status;
  if (subscription.cancel_at_period_end) {
    subscriptionStatus = "cancel_pending";
  }

  const updateData: Record<string, unknown> = {
    subscription_status: subscriptionStatus,
    plan,
    updated_at: new Date().toISOString(),
  };

  if (subscription.status === "trialing" && subscription.trial_end) {
    updateData.trial_ends_at = new Date(subscription.trial_end * 1000).toISOString();
  }
  if (subscription.status === "active" && !subscription.trial_end) {
    updateData.payment_status = "active";
    updateData.trial_ends_at = null;
  }

  const { error: updateError } = await supabaseAdmin.from("profiles").update(updateData).eq("id", user.id);

  if (updateError) {
    console.error("customer.subscription.updated: profile update error", updateError);
  }

  const { error: insertError } = await supabaseAdmin.from("subscription_events").insert({
    user_id: user.id,
    event_type: "subscription_updated",
    stripe_customer_id: customerId,
    stripe_subscription_id: subscription.id,
    plan,
    metadata: { stripe_status: subscription.status, cancel_at_period_end: subscription.cancel_at_period_end },
  });

  if (insertError) {
    console.error("customer.subscription.updated: subscription_events insert error", insertError);
  }

  console.log(
    `customer.subscription.updated: updated user ${user.id} status to ${subscription.status}`,
  );
}

async function handleCustomerSubscriptionDeleted(supabaseAdmin: SupabaseClient, event: Stripe.Event) {
  const subscription = event.data.object as Stripe.Subscription;
  const customerId = stripeCustomerId(subscription);
  if (!customerId) return;

  const user = await getUserByCustomerId(supabaseAdmin, customerId);
  if (!user) return;

  const deletionScheduledDate = new Date();
  deletionScheduledDate.setDate(deletionScheduledDate.getDate() + 30);

  const { error: updateError } = await supabaseAdmin
    .from("profiles")
    .update({
      subscription_status: "cancelled",
      payment_status: "cancelled",
      account_status: "cancelled",
      deletion_scheduled_date: deletionScheduledDate.toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", user.id);

  if (updateError) {
    console.error("customer.subscription.deleted: profile update error", updateError);
  }

  const { error: insertError } = await supabaseAdmin.from("subscription_events").insert({
    user_id: user.id,
    event_type: "subscription_cancelled",
    stripe_customer_id: customerId,
    stripe_subscription_id: subscription.id,
    metadata: { stripe_status: "canceled" },
  });

  if (insertError) {
    console.error("customer.subscription.deleted: subscription_events insert error", insertError);
  }

  const email = user.email ?? (await getAuthEmail(supabaseAdmin, user.id));
  if (email) {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    await sendEmail({
      to: email,
      subject: "Your Opal subscription has been cancelled",
      type: "subscription_cancelled",
      data: {
        deletion_date: deletionScheduledDate.toLocaleDateString(),
        reactivate_url: `${appUrl}/dashboard/settings?tab=billing`,
      },
    });
  } else {
    console.error("customer.subscription.deleted: no email for user", user.id);
  }

  console.log(
    `customer.subscription.deleted: cancelled user ${user.id}, data deletion scheduled for ${deletionScheduledDate.toISOString()}`,
  );
}
