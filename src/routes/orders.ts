/**
 * Orders Routes
 *
 * Provides endpoints to retrieve order information and QR codes.
 * The QR code is ONLY available after the webhook has processed
 * the successful payment.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { orderStore } from '../services/supabaseOrderStore.js';
import { generateQRCodeDataUrl } from '../services/qrService.js';
import { ticketStore } from '../services/supabaseTicketStore.js'; // NEW

// Type for route parameters
interface OrderParams {
  paymentIntentId: string;
}

export async function orderRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/orders/:paymentIntentId/qr
   *
   * Retrieves the QR code for a completed order.
   * (Legacy endpoint — returns a single QR for the whole order)
   *
   * Response (if order not found / payment not yet confirmed):
   * { "status": "pending" }
   *
   * Response (if order found):
   * {
   *   "status": "ready",
   *   "qrToken": string,
   *   "qrImageDataUrl": "data:image/png;base64,..."
   * }
   *
   * NOTE: This endpoint is meant to be polled by the frontend
   * after payment confirmation, while waiting for the webhook
   * to process.
   */
  app.get('/api/orders/:paymentIntentId/qr', async (
    request: FastifyRequest<{ Params: OrderParams }>,
    reply: FastifyReply
  ) => {
    const { paymentIntentId } = request.params;

    // Validate PaymentIntent ID format (basic check)
    if (!paymentIntentId || !paymentIntentId.startsWith('pi_')) {
      return reply.status(400).send({
        error: 'Invalid PaymentIntent ID format'
      });
    }

    console.log(`[Orders] QR request for PaymentIntent: ${paymentIntentId}`);

    // Try to get the order from storage
    const order = await orderStore.getOrderByPaymentIntentId(paymentIntentId);

    if (!order) {
      // Order not found - payment might still be processing
      console.log(`[Orders] Order not found (pending): ${paymentIntentId}`);
      return reply.status(200).send({
        status: 'pending'
      });
    }

    // Order found - generate QR code image
    try {
      const qrImageDataUrl = await generateQRCodeDataUrl(order.qrToken);

      console.log(`[Orders] QR code generated for PaymentIntent: ${paymentIntentId}`);

      return reply.status(200).send({
        status: 'ready',
        qrToken: order.qrToken,
        qrImageDataUrl: qrImageDataUrl
      });
    } catch (error) {
      console.error(`[Orders] Failed to generate QR code: ${error}`);
      return reply.status(500).send({
        error: 'Failed to generate QR code'
      });
    }
  });

  /**
   * GET /api/orders/:paymentIntentId/tickets
   *
   * NEW: Returns all individual tickets for an order.
   * Each ticket has its own QR code (one per person).
   * Used by the frontend to display the ticket carousel after payment.
   *
   * Response (if webhook hasn't run yet):
   * { "status": "pending" }
   *
   * Response (if tickets are ready):
   * {
   *   "status": "ready",
   *   "tickets": [
   *     {
   *       "id": string,
   *       "ticketType": "female" | "male",
   *       "qrToken": string,
   *       "qrImageDataUrl": "data:image/png;base64,..."
   *     },
   *     ...
   *   ]
   * }
   */
  app.get('/api/orders/:paymentIntentId/tickets', async (
    request: FastifyRequest<{ Params: OrderParams }>,
    reply: FastifyReply
  ) => {
    const { paymentIntentId } = request.params;

    // Validate PaymentIntent ID format (basic check)
    if (!paymentIntentId || !paymentIntentId.startsWith('pi_')) {
      return reply.status(400).send({
        error: 'Invalid PaymentIntent ID format'
      });
    }

    console.log(`[Orders] Tickets request for PaymentIntent: ${paymentIntentId}`);

    try {
      const tickets = await ticketStore.getTicketsByPaymentIntentId(paymentIntentId);

      // No tickets yet — webhook probably hasn't fired yet
      if (tickets.length === 0) {
        console.log(`[Orders] No tickets yet (pending): ${paymentIntentId}`);
        return reply.send({ status: 'pending' });
      }

      // Generate a QR image for each individual ticket
      const ticketsWithImages = await Promise.all(
        tickets.map(async (ticket) => ({
          id: ticket.id,
          ticketType: ticket.ticketType,
          qrToken: ticket.qrToken,
          qrImageDataUrl: await generateQRCodeDataUrl(ticket.qrToken),
        }))
      );

      console.log(`[Orders] Returning ${ticketsWithImages.length} tickets for PaymentIntent: ${paymentIntentId}`);

      return reply.send({
        status: 'ready',
        tickets: ticketsWithImages,
      });

    } catch (error) {
      console.error('[Orders] Failed to fetch tickets:', error);
      return reply.status(500).send({ error: 'Failed to fetch tickets.' });
    }
  });
}