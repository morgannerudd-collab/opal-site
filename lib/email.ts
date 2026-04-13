export async function sendEmail({
  to,
  subject,
  type,
  data,
}: {
  to: string;
  subject: string;
  type: string;
  data: Record<string, unknown>;
}) {
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Opal <info@myopal.io>",
        to: [to],
        subject,
        html: generateEmailHtml(type, data),
      }),
    });
    if (!response.ok) {
      console.error(`Email send failed [${type}]:`, await response.text());
    }
  } catch (err) {
    console.error(`Email send error [${type}]:`, err);
  }
}

function generateEmailHtml(type: string, data: Record<string, unknown>): string {
  const base = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:40px 24px;color:#141C20;">
    <div style="margin-bottom:32px;font-size:20px;font-weight:500;">OPAL</div>`;
  const footer = `<div style="margin-top:40px;padding-top:24px;border-top:1px solid #E8E4DC;font-size:12px;color:#888;">
    <p>Opal · <a href="https://www.myopal.io" style="color:#4A8A70;">myopal.io</a></p>
    <p>Questions? <a href="mailto:info@myopal.io" style="color:#4A8A70;">info@myopal.io</a></p>
    </div></div>`;

  const templates: Record<string, string> = {
    payment_failed: `${base}
      <h2 style="font-size:22px;font-weight:500;margin-bottom:16px;">Your payment didn't go through</h2>
      <p style="line-height:1.7;margin-bottom:16px;">We couldn't process your payment of <strong>$${data.amount}</strong>.</p>
      <p style="line-height:1.7;margin-bottom:24px;">Update your payment method before <strong>${data.grace_period_end}</strong> to keep access.</p>
      <a href="${data.update_url}" style="background:#4A8A70;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;">Update payment method</a>
      ${footer}`,
    payment_succeeded: `${base}
      <h2 style="font-size:22px;font-weight:500;margin-bottom:16px;">Your subscription has renewed</h2>
      <p style="line-height:1.7;">Amount charged: <strong>$${data.amount}</strong>. Next billing date: <strong>${data.period_end}</strong>.</p>
      ${footer}`,
    subscription_cancelled: `${base}
      <h2 style="font-size:22px;font-weight:500;margin-bottom:16px;">Your subscription has been cancelled</h2>
      <p style="line-height:1.7;margin-bottom:16px;">Your data will be permanently deleted on <strong>${data.deletion_date}</strong>.</p>
      <a href="${data.reactivate_url}" style="background:#4A8A70;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;">Reactivate my account</a>
      ${footer}`,
  };

  return templates[type] || `${base}<p>Your Opal account has been updated.</p>${footer}`;
}
