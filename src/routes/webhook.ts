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
import { ticketStore } from '../services/supabaseTicketStore.js'; // NEW
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
    // Get the raw body (Buffer) - not parsed JSON
    const rawBody = request.body as Buffer;

    // Get the Stripe signature header
    const signature = request.headers['stripe-signature'] as string;

    if (!signature) {
      console.error('[Webhook] Missing stripe-signature header');
      return reply.status(400).send({ error: 'Missing stripe-signature header' });
    }

    let event: Stripe.Event;

    try {
      // Verify the webhook signature
      // This will throw if verification fails
      event = verifyWebhookSignature(rawBody, signature);
    } catch (error) {
      console.error('[Webhook] Signature verification failed:', error);
      return reply.status(400).send({ error: 'Webhook signature verification failed' });
    }

    console.log(`[Webhook] Received event: ${event.type} (${event.id})`);

    // Handle specific event types
    switch (event.type) {
      case 'payment_intent.succeeded':
        await handlePaymentIntentSucceeded(event.data.object as Stripe.PaymentIntent);
        break;

      // Add more event handlers as needed
      default:
        console.log(`[Webhook] Unhandled event type: ${event.type}`);
    }

    // Always return 200 to acknowledge receipt
    return reply.status(200).send({ received: true });
  });
}

/**
 * Handles the payment_intent.succeeded event.
 *
 * This is where we:
 * 1. Check if we've already processed this payment (idempotency)
 * 2. Generate a QR token
 * 3. Store the order
 * 4. Create individual tickets (one QR per person) — NEW
 */
async function handlePaymentIntentSucceeded(paymentIntent: Stripe.PaymentIntent): Promise<void> {
  const paymentIntentId = paymentIntent.id;

  console.log(`[Webhook] Processing payment_intent.succeeded: ${paymentIntentId}`);

  // IDEMPOTENCY CHECK: Have we already processed this PaymentIntent?
  const alreadyProcessed = await orderStore.isPaymentIntentProcessed(paymentIntentId);

  if (alreadyProcessed) {
    console.log(`[Webhook] PaymentIntent already processed (idempotency): ${paymentIntentId}`);
    return;
  }

  // Mark as processed BEFORE doing anything else
  // This prevents race conditions with duplicate webhooks
  await orderStore.markPaymentIntentProcessed(paymentIntentId);

  // Extract metadata from PaymentIntent
  const metadata = paymentIntent.metadata;
  const femaleQty = parseInt(metadata.femaleQty || '0', 10);
  const maleQty = parseInt(metadata.maleQty || '0', 10);

  // Generate a secure QR token (kept for backwards compatibility on the order)
  const qrToken = generateQRToken();

  // Store the order (unchanged — still tracks the payment)
  await orderStore.saveOrder({
    paymentIntentId,
    qrToken,
    status: 'valid',
    createdAt: new Date(),
    femaleQty,
    maleQty
  });

  console.log(`[Webhook] Order created for PaymentIntent: ${paymentIntentId}`);
  console.log(`[Webhook] QR Token (first 8 chars): ${qrToken.substring(0, 8)}...`);

  // NEW: Create individual tickets (one QR code per person)
  // femaleQty=2, maleQty=1 → creates 3 rows in the tickets table
  try {
    const tickets = await ticketStore.createTicketsForOrder(
      paymentIntentId,
      femaleQty,
      maleQty
    );
    console.log(`[Webhook] Created ${tickets.length} individual tickets for ${paymentIntentId}`);
  } catch (ticketError) {
    console.error('[Webhook] Failed to create tickets:', ticketError);
    // Don't fail the webhook — the order is still saved
    // We can manually create tickets later if needed
  }
}