/**
 * In-Memory Order Store
 * 
 * Stores orders in memory using JavaScript Maps.
 * 
 * WARNING: Data is lost when the server restarts!
 * This is only for development/testing.
 * 
 * For production, replace with PostgresOrderStore.
 */

import { Order, OrderStore } from './orderStore.js';

export class InMemoryOrderStore implements OrderStore {
  // Map of PaymentIntent ID -> Order
  private orders: Map<string, Order> = new Map();
  
  // Set of processed PaymentIntent IDs (for idempotency)
  private processedPaymentIntents: Set<string> = new Set();
  
  /**
   * Save a new order to memory
   */
  async saveOrder(order: Order): Promise<void> {
    this.orders.set(order.paymentIntentId, order);
    console.log(`[OrderStore] Saved order for PaymentIntent: ${order.paymentIntentId}`);
  }
  
  /**
   * Get an order by PaymentIntent ID
   */
  async getOrderByPaymentIntentId(paymentIntentId: string): Promise<Order | null> {
    const order = this.orders.get(paymentIntentId);
    return order || null;
  }
  
  /**
   * Check if a PaymentIntent has already been processed
   */
  async isPaymentIntentProcessed(paymentIntentId: string): Promise<boolean> {
    return this.processedPaymentIntents.has(paymentIntentId);
  }
  
  /**
   * Mark a PaymentIntent as processed
   */
  async markPaymentIntentProcessed(paymentIntentId: string): Promise<void> {
    this.processedPaymentIntents.add(paymentIntentId);
    console.log(`[OrderStore] Marked PaymentIntent as processed: ${paymentIntentId}`);
  }

    /**
   * Atomically try to claim a PaymentIntent for processing.
   * In-memory version: uses Set.has() check + add in one step.
   * No real race condition risk in single-threaded Node, but
   * mirrors the Supabase version for interface compliance.
   */
  async tryClaimPaymentIntent(paymentIntentId: string): Promise<boolean> {
    if (this.processedPaymentIntents.has(paymentIntentId)) {
      console.log(`[OrderStore] ⏭️  Already claimed: ${paymentIntentId}`);
      return false;
    }
    this.processedPaymentIntents.add(paymentIntentId);
    console.log(`[OrderStore] ✅ Claimed PaymentIntent: ${paymentIntentId}`);
    return true;
  }
}

// Create a single instance to be used throughout the application
export const orderStore = new InMemoryOrderStore();