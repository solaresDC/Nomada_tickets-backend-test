/**
 * Supabase Order Store
 *
 * Implements OrderStore using Supabase (PostgreSQL).
 * This is the production storage backend.
 */

import { supabase } from '../plugins/supabase.js';
import type { Order, OrderStore } from './orderStore.js';

// Environment validation
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL) {
  throw new Error(
    '[Supabase] Missing SUPABASE_URL environment variable. ' +
    'Add it to your .env file. Get it from: Supabase Dashboard > Settings > API'
  );
}

if (!SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    '[Supabase] Missing SUPABASE_SERVICE_ROLE_KEY environment variable. ' +
    'Add it to your .env file. Get it from: Supabase Dashboard > Settings > API'
  );
}

export class SupabaseOrderStore implements OrderStore {

  /**
   * Save a new order to the database
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
        email: order.email || null,
        order_reference: order.orderReference || null, // NEW — save the NMD-XXXX-XXXX code
      });

    if (error) {
      console.error('[SupabaseOrderStore] Failed to save order:', error.message);
      throw new Error(`Failed to save order: ${error.message}`);
    }

    console.log(`[SupabaseOrderStore] Saved order: ${order.paymentIntentId} (ref: ${order.orderReference || 'none'})`);
  }

  /**
   * Get an order by its PaymentIntent ID
   * Returns null if no order exists yet (payment hasn't completed)
   */
  async getOrderByPaymentIntentId(paymentIntentId: string): Promise<Order | null> {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('payment_intent_id', paymentIntentId)
      .single();

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

    return {
      paymentIntentId: data.payment_intent_id,
      qrToken: data.qr_token,
      status: data.status as 'valid' | 'used' | 'cancelled',
      createdAt: new Date(data.created_at),
      femaleQty: data.female_qty,
      maleQty: data.male_qty,
      email: data.email || undefined,
    };
  }

  /**
   * Check if a PaymentIntent has already been processed
   * 
   * ⚠️  DEPRECATED — kept for backward compatibility.
   * Use tryClaimPaymentIntent() instead for race-safe idempotency.
   */
  async isPaymentIntentProcessed(paymentIntentId: string): Promise<boolean> {
    const { data, error } = await supabase
      .from('processed_payment_intents')
      .select('payment_intent_id')
      .eq('payment_intent_id', paymentIntentId)
      .single();

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
   * ⚠️  DEPRECATED — kept for backward compatibility.
   * Use tryClaimPaymentIntent() instead for race-safe idempotency.
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

  /**
   * Atomically try to claim a PaymentIntent for processing.
   * 
   * This replaces the old two-step pattern that had a race condition:
   *   OLD: isPaymentIntentProcessed() → false → markPaymentIntentProcessed()
   *   PROBLEM: Two webhooks could both get "false" before either marks it.
   * 
   * NEW: Single database operation — the database itself ensures only
   * one of two simultaneous calls succeeds and returns data.
   * 
   * How it works:
   *   - ignoreDuplicates: true tells Supabase to use INSERT ... ON CONFLICT DO NOTHING
   *   - If the row doesn't exist yet → inserts it → .select() returns the new row → claimed = true
   *   - If the row already exists → does nothing → .select() returns empty array → claimed = false
   * 
   * Returns true if THIS call claimed it (proceed with ticket creation).
   * Returns false if already claimed by a previous webhook (skip).
   */
  async tryClaimPaymentIntent(paymentIntentId: string): Promise<boolean> {
    const { data, error } = await supabase
      .from('processed_payment_intents')
      .upsert(
        {
          payment_intent_id: paymentIntentId,
          processed_at: new Date().toISOString(),
        },
        {
          onConflict: 'payment_intent_id',
          ignoreDuplicates: true,
        }
      )
      .select();

    if (error) {
      console.error('[SupabaseOrderStore] Failed to claim PaymentIntent:', error.message);
      throw new Error(`Failed to claim PaymentIntent: ${error.message}`);
    }

    const claimed = data !== null && data.length > 0;

    if (claimed) {
      console.log(`[SupabaseOrderStore] ✅ Claimed PaymentIntent: ${paymentIntentId}`);
    } else {
      console.log(`[SupabaseOrderStore] ⏭️  Already claimed: ${paymentIntentId}`);
    }

    return claimed;
  }
}

// Create a single instance to be used throughout the application
export const orderStore = new SupabaseOrderStore();