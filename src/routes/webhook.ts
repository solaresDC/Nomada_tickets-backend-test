/**
 * Stripe Webhook Routes
 *
 * Handles webhook events from Stripe.
 *
 * CRITICAL SECURITY NOTES:
 * 1. The webhook signature MUST be verified using the RAW request body
 * 2. Never parse the body as JSON before verification
 * 3. This route uses a special "raw" content type parser
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { verifyWebhookSignature } from '../plugins/stripe.js';
import { orderStore } from '../services/supabaseOrderStore.js';
import { generateQRToken } from '../services/qrService.js';
import { ticketStore } from '../services/supabaseTicketStore.js';
import Stripe from 'stripe';

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

    // Low-noise log for unimportant events (charge.updated, payment_intent.created, etc.)
    // These fire constantly and clutter the terminal — just skip them quietly
    if (event.type !== 'payment_intent.succeeded') {
      console.log(`[Webhook] Skipped: ${event.type}`);
      return reply.status(200).send({ received: true });
    }

    // Only payment_intent.succeeded gets the full treatment
    await handlePaymentIntentSucceeded(event.data.object as Stripe.PaymentIntent);

    return reply.status(200).send({ received: true });
  });
}

/**
 * Handles the payment_intent.succeeded event.
 *
 * This is where we:
 * 1. Check if we've already processed this payment (idempotency)
 * 2. Generate a QR token and save the order
 * 3. Create individual tickets (one QR per person)
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

  // IDEMPOTENCY CHECK: Have we already processed this PaymentIntent?
  const alreadyProcessed = await orderStore.isPaymentIntentProcessed(paymentIntentId);

  if (alreadyProcessed) {
    console.log(`[Webhook] ⏭️  Already processed — skipping (idempotency)`);
    console.log('='.repeat(60) + '\n');
    return;
  }

  // Mark as processed BEFORE doing anything else
  // This prevents race conditions with duplicate webhooks
  await orderStore.markPaymentIntentProcessed(paymentIntentId);

  // Extract metadata from PaymentIntent
  const metadata = paymentIntent.metadata;
  const femaleQty = parseInt(metadata.femaleQty || '0', 10);
  const maleQty = parseInt(metadata.maleQty || '0', 10);

  console.log(`[Webhook]    Quantities → female: ${femaleQty}, male: ${maleQty}`);

  // Warn clearly if both are 0 — this almost always means stripe trigger
  // was used without --override flags, so metadata arrived empty
  if (femaleQty === 0 && maleQty === 0) {
    console.warn(`[Webhook] ⚠️  Both quantities are 0. Metadata was likely empty.`);
    console.warn(`[Webhook]    Use this command instead of plain stripe trigger:`);
    console.warn(`[Webhook]    stripe trigger payment_intent.succeeded \\`);
    console.warn(`[Webhook]      --override payment_intent:metadata.femaleQty=2 \\`);
    console.warn(`[Webhook]      --override payment_intent:metadata.maleQty=1`);
  }

  // Generate a QR token and save the order
  // (qrToken on the order is kept for backwards compatibility but is now legacy)
  const qrToken = generateQRToken();

  await orderStore.saveOrder({
    paymentIntentId,
    qrToken,
    status: 'valid',
    createdAt: new Date(),
    femaleQty,
    maleQty
  });

  console.log(`[Webhook]    Order saved ✓`);
  console.log(`[Webhook]    Legacy QR: ${qrToken.substring(0, 8)}...`);

  // Create individual tickets — one QR code per person
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
      tickets.forEach((t, i) => {
        console.log(`[Webhook]      [${i + 1}] ${t.ticketType.padEnd(6)} → ${t.qrToken.substring(0, 8)}...`);
      });
    }
  } catch (ticketError) {
    console.error('[Webhook] ❌ Failed to create tickets:', ticketError);
    // Don't fail the webhook — the order is still saved
    // Tickets can be manually created later if needed
  }

console.log('='.repeat(60));
console.log(`[Webhook] ✅ DONE — ${paymentIntentId}`);
console.log('='.repeat(60) + '\n\n');
}