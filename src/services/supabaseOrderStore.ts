/**
 * Supabase Order Store
 * 
 * Implements the OrderStore interface using Supabase (PostgreSQL).
 * This replaces InMemoryOrderStore for production use.
 * 
 * Data is stored permanently in the database and survives server restarts.
 * 
 * Tables used:
 *   - orders: Stores completed orders with QR tokens
 *   - processed_payment_intents: Tracks which payments have been processed (idempotency)
 */

import { Order, OrderStore } from './orderStore.js';
import { supabase } from '../plugins/supabase.js';

export class SupabaseOrderStore implements OrderStore {
  
  /**
   * Save a new order to the database
   * 
   * Uses "upsert" which means:
   * - If the order doesn't exist → INSERT it (create new)
   * - If the order already exists → UPDATE it (overwrite)
   * This makes it safe to call multiple times with the same data.
   */
  async saveOrder(order: Order): Promise<void> {
    const { error } = await supabase
      .from('orders')
      .upsert({
        payment_intent_id: order.paymentIntentId,
        qr_token: order.qrToken,
        status: order.status,
        created_at: order.createdAt.toISOString(),
        female_qty: order.femaleQty,
        male_qty: order.maleQty,
      });

    if (error) {
      console.error('[SupabaseOrderStore] Failed to save order:', error.message);
      throw new Error(`Failed to save order: ${error.message}`);
    }

    console.log(`[SupabaseOrderStore] Saved order for PaymentIntent: ${order.paymentIntentId}`);
  }

  /**
   * Get an order by its PaymentIntent ID
   * 
   * Returns null if no order exists yet (payment hasn't completed)
   */
  async getOrderByPaymentIntentId(paymentIntentId: string): Promise<Order | null> {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('payment_intent_id', paymentIntentId)
      .single();

    // "PGRST116" means "no rows found" — that's not an error, just means the order doesn't exist yet
    if (error) {
      if (error.code === 'PGRST116') {
        return null;
      }
      console.error('[SupabaseOrderStore] Failed to get order:', error.message);
      throw new Error(`Failed to get order: ${error.message}`);
    }

    if (!data) {
      return null;
    }

    // Convert database row format (snake_case) back to our TypeScript format (camelCase)
    return {
      paymentIntentId: data.payment_intent_id,
      qrToken: data.qr_token,
      status: data.status as 'valid' | 'used' | 'cancelled',
      createdAt: new Date(data.created_at),
      femaleQty: data.female_qty,
      maleQty: data.male_qty,
    };
  }

  /**
   * Check if a PaymentIntent has already been processed
   * 
   * This is crucial for IDEMPOTENCY:
   * Stripe might send the same webhook event multiple times.
   * We check this table to avoid creating duplicate QR codes.
   */
  async isPaymentIntentProcessed(paymentIntentId: string): Promise<boolean> {
    const { data, error } = await supabase
      .from('processed_payment_intents')
      .select('payment_intent_id')
      .eq('payment_intent_id', paymentIntentId)
      .single();

    // "PGRST116" = not found = not processed yet
    if (error && error.code === 'PGRST116') {
      return false;
    }

    if (error) {
      console.error('[SupabaseOrderStore] Failed to check processed status:', error.message);
      throw new Error(`Failed to check processed status: ${error.message}`);
    }

    return !!data;
  }

  /**
   * Mark a PaymentIntent as processed
   * 
   * Called right after we successfully handle a webhook event,
   * so we know not to process it again if Stripe resends it.
   */
  async markPaymentIntentProcessed(paymentIntentId: string): Promise<void> {
    const { error } = await supabase
      .from('processed_payment_intents')
      .upsert({
        payment_intent_id: paymentIntentId,
        processed_at: new Date().toISOString(),
      });

    if (error) {
      console.error('[SupabaseOrderStore] Failed to mark as processed:', error.message);
      throw new Error(`Failed to mark as processed: ${error.message}`);
    }

    console.log(`[SupabaseOrderStore] Marked PaymentIntent as processed: ${paymentIntentId}`);
  }
}

// Create a single instance to be used throughout the application
export const orderStore = new SupabaseOrderStore();