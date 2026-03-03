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

// Type for route parameters
interface OrderParams {
  paymentIntentId: string;
}

export async function orderRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/orders/:paymentIntentId/qr
   * 
   * Retrieves the QR code for a completed order.
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
}