/**
 * Checkout Routes
 * 
 * Handles the checkout process:
 * - Creating Stripe PaymentIntents
 * - Validating ticket quantities
 * - Calculating pricing
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { stripe } from '../plugins/stripe.js';
import { calculatePricing, dollarsToCents } from '../services/pricingService.js';

// Validation schema for create-intent request
const createIntentSchema = z.object({
  femaleQty: z.number().int().min(0, 'Female quantity cannot be negative'),
  maleQty: z.number().int().min(0, 'Male quantity cannot be negative'),
  language: z.enum(['en', 'es', 'pt-BR']).default('en'),
  email: z.string().email('Invalid email address').optional()
}).refine(
  // Custom validation: at least one ticket must be selected
  (data) => data.femaleQty > 0 || data.maleQty > 0,
  { message: 'At least one ticket must be selected' }
);

// Type for validated request body
type CreateIntentBody = z.infer<typeof createIntentSchema>;

export async function checkoutRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /api/checkout/create-intent
   * 
   * Creates a Stripe PaymentIntent for the ticket order.
   * 
   * Request body:
   * {
   *   "femaleQty": number (>= 0),
   *   "maleQty": number (>= 0),
   *   "language": "en" | "es" | "pt-BR"
   * }
   * 
   * Response:
   * {
   *   "clientSecret": string,
   *   "paymentIntentId": string,
   *   "pricing": { "subtotal": number, "fee": number, "total": number }
   * }
   */
  app.post('/api/checkout/create-intent', async (
    request: FastifyRequest<{ Body: CreateIntentBody }>,
    reply: FastifyReply
  ) => {
    try {
      // Validate request body
      const validationResult = createIntentSchema.safeParse(request.body);
      
      if (!validationResult.success) {
        // Return validation errors
        return reply.status(400).send({
          error: 'Validation failed',
          details: validationResult.error.errors.map(e => ({
            field: e.path.join('.'),
            message: e.message
          }))
        });
      }
      
      const { femaleQty, maleQty, language, email } = validationResult.data;
      
      // Calculate pricing
      const pricing = calculatePricing(femaleQty, maleQty);
      
      // Convert total to cents for Stripe
      const amountInCents = dollarsToCents(pricing.total);
      
      console.log(`[Checkout] Creating PaymentIntent: ${femaleQty} female, ${maleQty} male, total: $${pricing.total} CAD`);
      
      // Create Stripe PaymentIntent
      // Note: email is NOT stored here — it is written via PATCH /update-intent-email
      // right before the user confirms payment, so we always get the latest value.
      const paymentIntent = await stripe.paymentIntents.create({
        amount: amountInCents,
        currency: 'cad',
        automatic_payment_methods: {
          enabled: true,
        },
        metadata: {
          femaleQty: femaleQty.toString(),
          maleQty: maleQty.toString(),
          subtotal: pricing.subtotal.toString(),
          fee: pricing.fee.toString(),
          language: language,
          email: email || ''
        },
        ...(email ? { receipt_email: email } : {})
      });
      
      console.log(`[Checkout] PaymentIntent created: ${paymentIntent.id}`);
      
      // Return response
      return reply.status(200).send({
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        pricing: {
          subtotal: pricing.subtotal,
          fee: pricing.fee,
          total: pricing.total
        }
      });
      
    } catch (error) {
      console.error('[Checkout] Error creating PaymentIntent:', error);
      
      // Handle Stripe-specific errors
      if (error instanceof Error && 'type' in error) {
        return reply.status(500).send({
          error: 'Payment service error',
          message: 'Failed to create payment. Please try again.'
        });
      }
      
      // Generic error
      return reply.status(500).send({
        error: 'Internal server error',
        message: 'An unexpected error occurred.'
      });
    }
  });

  /**
   * PATCH /api/checkout/update-intent-email
   * 
   * Updates the email metadata on an existing PaymentIntent.
   * Called by the frontend right before the user confirms payment,
   * so the webhook always receives the email the user actually typed.
   * 
   * Request body:
   * {
   *   "paymentIntentId": string,
   *   "email": string
   * }
   * 
   * Response:
   * { "ok": true }
   */
  app.patch('/api/checkout/update-intent-email', async (
    request: FastifyRequest<{ Body: { paymentIntentId: string; email: string } }>,
    reply: FastifyReply
  ) => {
    try {
      const { paymentIntentId, email } = request.body as { paymentIntentId: string; email: string };

      if (!paymentIntentId || !email) {
        return reply.status(400).send({ error: 'Missing paymentIntentId or email' });
      }

      console.log(`[Checkout] Updating email on PaymentIntent: ${paymentIntentId}`);

      await stripe.paymentIntents.update(paymentIntentId, {
        metadata: { email },
        receipt_email: email
      });

      console.log(`[Checkout] Email updated on PaymentIntent: ${paymentIntentId}`);

      return reply.status(200).send({ ok: true });

    } catch (error) {
      console.error('[Checkout] Failed to update intent email:', error);
      return reply.status(500).send({ error: 'Failed to update email' });
    }
  });
}