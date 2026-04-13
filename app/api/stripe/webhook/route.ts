import Stripe from "stripe";
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sendEmail } from "@/lib/email";
import { getPlanFromPriceId } from "@/lib/stripe-plan-map";

export const runtime = "nodejs";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2024-06-20",
});

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function getUserByCustomerId(customerId: string) {
  const { data } = await supabaseAdmin
    .from("profiles")
    .select("id, email")
    .eq("stripe_customer_id", customerId)
    .single();
  return data;
}

async function getUserByEmail(email: string) {
  const { data } = await supabaseAdmin.from("profiles").select("id, email").eq("email", email).single();
  return data;
}

export async function POST(request: Request): Promise<NextResponse> {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return NextResponse.json({ error: "STRIPE_WEBHOOK_SECRET missing" }, { status: 500 });
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
    const message = error instanceof Error ? error.message : "Invalid signature";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const customerId = session.customer as string;
        const subscriptionId = session.subscription as string;
        const customerEmail = session.customer_details?.email || session.customer_email;

        if (!customerEmail) break;

        let user = await getUserByCustomerId(customerId);
        if (!user) user = await getUserByEmail(customerEmail);
        if (!user) {
          console.error(`checkout: no user for ${customerEmail}`);
          break;
        }

        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const priceId = subscription.items.data[0]?.price.id;
        const plan = getPlanFromPriceId(priceId ?? "");
        const billing =
          subscription.items.data[0]?.price.recurring?.interval === "year" ? "annual" : "monthly";
        const trialEndsAt = subscription.trial_end
          ? new Date(subscription.trial_end * 1000).toISOString()
          : null;

        await supabaseAdmin
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

        await supabaseAdmin.from("subscription_events").insert({
          user_id: user.id,
          event_type: "checkout.completed",
          stripe_customer_id: customerId,
          stripe_subscription_id: subscriptionId,
          plan,
          billing_interval: billing,
          status: subscription.status,
          amount: session.amount_total,
          created_at: new Date().toISOString(),
        });

        console.log(`checkout.session.completed: user ${user.id} → ${plan}`);
        break;
      }

      case "invoice.payment_succeeded": {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = invoice.customer as string;
        const user = await getUserByCustomerId(customerId);
        if (!user) break;

        await supabaseAdmin
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

        await supabaseAdmin.from("subscription_events").insert({
          user_id: user.id,
          event_type: "payment.succeeded",
          stripe_customer_id: customerId,
          stripe_subscription_id: invoice.subscription as string,
          status: "active",
          amount: invoice.amount_paid,
          created_at: new Date().toISOString(),
        });

        if (invoice.billing_reason === "subscription_cycle") {
          await sendEmail({
            to: user.email as string,
            subject: "Your Opal subscription has renewed",
            type: "payment_succeeded",
            data: {
              amount: (invoice.amount_paid / 100).toFixed(2),
              period_end: new Date((invoice.period_end || 0) * 1000).toLocaleDateString(),
            },
          });
        }

        console.log(`invoice.payment_succeeded: cleared issues for user ${user.id}`);
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = invoice.customer as string;
        const user = await getUserByCustomerId(customerId);
        if (!user) break;

        const gracePeriodEnd = new Date();
        gracePeriodEnd.setDate(gracePeriodEnd.getDate() + 7);

        await supabaseAdmin
          .from("profiles")
          .update({
            subscription_status: "past_due",
            payment_status: "past_due",
            grace_period_end: gracePeriodEnd.toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", user.id);

        await supabaseAdmin.from("subscription_events").insert({
          user_id: user.id,
          event_type: "payment.failed",
          stripe_customer_id: customerId,
          stripe_subscription_id: invoice.subscription as string,
          status: "past_due",
          amount: invoice.amount_due,
          created_at: new Date().toISOString(),
        });

        await sendEmail({
          to: user.email as string,
          subject: "Action required: Your Opal payment didn't go through",
          type: "payment_failed",
          data: {
            amount: (invoice.amount_due / 100).toFixed(2),
            grace_period_end: gracePeriodEnd.toLocaleDateString(),
            update_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/settings?tab=billing`,
          },
        });

        console.log(`invoice.payment_failed: past_due for user ${user.id}`);
        break;
      }

      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId = subscription.customer as string;
        const user = await getUserByCustomerId(customerId);
        if (!user) break;

        const priceId = subscription.items.data[0]?.price.id;
        const plan = getPlanFromPriceId(priceId ?? "");

        const updateData: Record<string, unknown> = {
          subscription_status: subscription.cancel_at_period_end ? "cancel_pending" : subscription.status,
          plan,
          updated_at: new Date().toISOString(),
        };

        await supabaseAdmin.from("profiles").update(updateData).eq("id", user.id);
        await supabaseAdmin.from("subscription_events").insert({
          user_id: user.id,
          event_type: "subscription.updated",
          stripe_customer_id: customerId,
          stripe_subscription_id: subscription.id,
          plan,
          status: subscription.status,
          created_at: new Date().toISOString(),
        });

        console.log(`subscription.updated: user ${user.id} → ${subscription.status}`);
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId = subscription.customer as string;
        const user = await getUserByCustomerId(customerId);
        if (!user) break;

        const deletionDate = new Date();
        deletionDate.setDate(deletionDate.getDate() + 30);

        await supabaseAdmin
          .from("profiles")
          .update({
            subscription_status: "cancelled",
            payment_status: "cancelled",
            account_status: "cancelled",
            deletion_scheduled_date: deletionDate.toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", user.id);

        await supabaseAdmin.from("subscription_events").insert({
          user_id: user.id,
          event_type: "subscription.cancelled",
          stripe_customer_id: customerId,
          stripe_subscription_id: subscription.id,
          status: "cancelled",
          created_at: new Date().toISOString(),
        });

        await sendEmail({
          to: user.email as string,
          subject: "Your Opal subscription has been cancelled",
          type: "subscription_cancelled",
          data: {
            deletion_date: deletionDate.toLocaleDateString(),
            reactivate_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/settings?tab=billing`,
          },
        });

        console.log(`subscription.deleted: cancelled user ${user.id}`);
        break;
      }

      default:
        console.log(`[Stripe webhook] unhandled event: ${event.type}`);
    }
  } catch (err) {
    console.error(`[Stripe webhook] error processing ${event.type}:`, err);
  }

  return NextResponse.json({ received: true });
}
