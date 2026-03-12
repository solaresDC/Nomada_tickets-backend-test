/**
 * Stripe Webhook Routes
 *
 * Handles webhook events from Stripe.
 *
 * CRITICAL SECURITY NOTES:
 * 1. The webhook signature MUST be verified using the RAW request body
 * 2. Never parse the body as JSON before verification
 * 3. This route uses a special "raw" content type parser
 *
 * CHANGES FROM ORIGINAL:
 * - generateOrderReference() added — creates a human-friendly NMD-XXXX-XXXX code
 * - saveOrder() now also saves order_reference to the orders table
 * - sendTicketEmail() now receives orderReference for inclusion in the email
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { verifyWebhookSignature } from '../plugins/stripe.js';
import { orderStore } from '../services/supabaseOrderStore.js';
import { generateQRToken, generateQRCodeDataUrl } from '../services/qrService.js';
import { ticketStore } from '../services/supabaseTicketStore.js';
import Stripe from 'stripe';
import { sendTicketEmail } from '../services/emailService.js';
import crypto from 'node:crypto';

// ─── Order Reference Generator ───────────────────────────────

/**
 * Generates a human-friendly, cryptographically random order reference code.
 * Format: NMD-XXXX-XXXX where X is an uppercase letter or digit.
 *
 * Uses crypto.randomBytes() — NOT Math.random() — so the output is
 * genuinely unpredictable and safe to use as a customer-facing reference.
 *
 * Example outputs: NMD-2847-XK9Q, NMD-A3F2-8BPR, NMD-7Z1C-QW4M
 *
 * Security: 36^8 ≈ 2.8 trillion combinations. Combined with email
 * verification and escalating lockout, this is sufficient for a
 * ticketing platform at Nomada's scale.
 */
function generateOrderReference(): string {
  const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const SEGMENT_LENGTH = 4;
  const NUM_SEGMENTS = 2;

  let result = 'NMD';

  for (let s = 0; s < NUM_SEGMENTS; s++) {
    result += '-';
    // Generate cryptographically random bytes — 1 byte per character
    const bytes = crypto.randomBytes(SEGMENT_LENGTH);
    for (let i = 0; i < SEGMENT_LENGTH; i++) {
      // Map each byte to a character.
      // Using modulo 36 — slight bias but negligible for this use case.
      result += CHARS[bytes[i] % CHARS.length];
    }
  }

  return result; // e.g. "NMD-2847-XK9Q"
}

// ─── Route Registration ───────────────────────────────────────

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  // Add a content type parser for raw bodies
  // This is REQUIRED for Stripe webhook signature verification
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_req, body, done) => {
      done(null, body);
    }
  );

  /**
   * POST /api/webhooks/stripe
   *
   * Receives webhook events from Stripe.
   * Currently handles: payment_intent.succeeded
   *
   * IMPORTANT: Always return 200 quickly to acknowledge receipt.
   * Stripe will retry failed webhooks, so we need idempotency.
   */
  app.post('/api/webhooks/stripe', async (
    request: FastifyRequest,
    reply: FastifyReply
  ) => {
    const rawBody = request.body as Buffer;
    const signature = request.headers['stripe-signature'] as string;

    if (!signature) {
      console.error('[Webhook] Missing stripe-signature header');
      return reply.status(400).send({ error: 'Missing stripe-signature header' });
    }

    let event: Stripe.Event;

    try {
      event = verifyWebhookSignature(rawBody, signature);
    } catch (error) {
      console.error('[Webhook] Signature verification failed:', error);
      return reply.status(400).send({ error: 'Webhook signature verification failed' });
    }

    // Low-noise log for unimportant events
    if (event.type !== 'payment_intent.succeeded') {
      console.log(`[Webhook] Skipped: ${event.type}`);
      return reply.status(200).send({ received: true });
    }

    // Only payment_intent.succeeded gets the full treatment
    await handlePaymentIntentSucceeded(event.data.object as Stripe.PaymentIntent);

    return reply.status(200).send({ received: true });
  });
}

// ─── Handler ──────────────────────────────────────────────────

/**
 * Handles the payment_intent.succeeded event.
 *
 * This is where we:
 * 1. Atomically claim the payment (race-safe idempotency)
 * 2. Generate a human-friendly order reference (NMD-XXXX-XXXX)
 * 3. Save the order with the reference code
 * 4. Create individual tickets (one QR per person)
 * 5. Send confirmation email including the order reference
 *
 * ⚠️  IMPORTANT FOR LOCAL TESTING:
 * "stripe trigger payment_intent.succeeded" without overrides sends
 * empty metadata → femaleQty=0, maleQty=0 → 0 tickets created.
 *
 * Always use:
 *   stripe trigger payment_intent.succeeded \
 *     --override payment_intent:metadata.femaleQty=2 \
 *     --override payment_intent:metadata.maleQty=1
 */
async function handlePaymentIntentSucceeded(paymentIntent: Stripe.PaymentIntent): Promise<void> {
  const paymentIntentId = paymentIntent.id;

  console.log('\n' + '='.repeat(60));
  console.log(`[Webhook] ✅ payment_intent.succeeded`);
  console.log(`[Webhook]    ID: ${paymentIntentId}`);
  console.log('='.repeat(60));

  // ── Atomic idempotency check ───────────────────────────────
  const claimed = await orderStore.tryClaimPaymentIntent(paymentIntentId);

  if (!claimed) {
    console.log(`[Webhook] ⏭️  Already processed — skipping (idempotency)`);
    console.log('='.repeat(60) + '\n');
    return;
  }

  // ── Extract metadata ──────────────────────────────────────
  const metadata = paymentIntent.metadata;
  const femaleQty = parseInt(metadata.femaleQty || '0', 10);
  const maleQty = parseInt(metadata.maleQty || '0', 10);
  const buyerEmail = metadata.email || '';
  const language = metadata.language || 'en';

  console.log(`[Webhook]    Quantities → female: ${femaleQty}, male: ${maleQty}`);

  if (femaleQty === 0 && maleQty === 0) {
    console.warn(`[Webhook] ⚠️  Both quantities are 0.`);
    console.warn(`[Webhook]    Metadata was likely empty.`);
    console.warn(`[Webhook]    Use --override flags with stripe trigger.`);
  }

  // ── Generate order reference ──────────────────────────────
  // This is the human-friendly code (e.g. NMD-2847-XK9Q) that will be:
  //   1. Saved to the orders table
  //   2. Included in the confirmation email
  //   3. Used by customers to look up their tickets
  const orderReference = generateOrderReference();
  console.log(`[Webhook]    Order reference: ${orderReference}`);

  // ── Save the order ────────────────────────────────────────
  const qrToken = generateQRToken(); // Legacy field — kept for backwards compat

  await orderStore.saveOrder({
    paymentIntentId,
    qrToken,
    status: 'valid',
    createdAt: new Date(),
    femaleQty,
    maleQty,
    email: buyerEmail,
    orderReference, // NEW — saved to orders.order_reference column
  });

  console.log(`[Webhook]    Order saved ✓ (ref: ${orderReference})`);

  // ── Create individual tickets ─────────────────────────────
  try {
    const tickets = await ticketStore.createTicketsForOrder(
      paymentIntentId,
      femaleQty,
      maleQty
    );

    if (tickets.length === 0) {
      console.warn(`[Webhook] ⚠️  0 tickets created — see quantity warning above`);
    } else {
      console.log(`[Webhook]    Individual tickets created: ${tickets.length} ✓`);
      tickets.forEach((tk, i) => {
        console.log(`[Webhook]      [${i + 1}] ${tk.ticketType.padEnd(6)} → ${tk.qrToken.substring(0, 8)}...`);
      });

      // ── Send confirmation email ──────────────────────────
      if (buyerEmail) {
        console.log(`[Webhook]    Sending email to: ${buyerEmail}`);
        try {
          const ticketsWithImages = await Promise.all(
            tickets.map(async (tk) => ({
              ticketType: tk.ticketType,
              qrToken: tk.qrToken,
              qrImageDataUrl: await generateQRCodeDataUrl(tk.qrToken),
            }))
          );

          const emailSent = await sendTicketEmail({
            to: buyerEmail,
            eventName: 'Nómada',
            tickets: ticketsWithImages,
            language,
            orderReference, // NEW — passed to email template
          });

          if (emailSent) {
            console.log(`[Webhook]    Email sent ✓`);
          } else {
            console.warn(`[Webhook]    Email skipped or failed (see logs above)`);
          }
        } catch (emailError) {
          console.error('[Webhook] ❌ Email error (tickets still created):', emailError);
        }
      } else {
        console.log(`[Webhook]    No email provided — skipping email delivery`);
      }
    }
  } catch (ticketError) {
    console.error('[Webhook] ❌ Failed to create tickets:', ticketError);
  }

  console.log('='.repeat(60));
  console.log(`[Webhook] ✅ DONE — ${paymentIntentId}`);
  console.log('='.repeat(60) + '\n\n');
}