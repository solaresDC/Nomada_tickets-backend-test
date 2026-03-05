/**
 * Order Store Interface
 * 
 * Defines the contract for storing order data.
 * This interface allows us to easily swap the implementation
 * from in-memory storage to a database (like Postgres) later.
 */

/**
 * Represents a completed order with QR code
 */
export interface Order {
  paymentIntentId: string;
  qrToken: string;
  status: 'valid' | 'used' | 'cancelled';
  createdAt: Date;
  femaleQty: number;
  maleQty: number;
}

/**
 * Interface for order storage operations.
 * Implement this interface to create different storage backends.
 */
export interface OrderStore {
  /**
   * Save a new order
   */
  saveOrder(order: Order): Promise<void>;

  /**
   * Get an order by PaymentIntent ID
   */
  getOrderByPaymentIntentId(paymentIntentId: string): Promise<Order | null>;

  /**
   * Check if a PaymentIntent has already been processed
   * Used for webhook idempotency
   */
  isPaymentIntentProcessed(paymentIntentId: string): Promise<boolean>;

  /**
   * Mark a PaymentIntent as processed
   */
  markPaymentIntentProcessed(paymentIntentId: string): Promise<void>;

  /**
   * Atomically try to claim a PaymentIntent for processing.
   * Returns true if THIS call claimed it (proceed with processing).
   * Returns false if it was already claimed (skip — duplicate).
   * 
   * This replaces the old two-step pattern of:
   *   1. isPaymentIntentProcessed() → check
   *   2. markPaymentIntentProcessed() → mark
   * 
   * The old pattern had a race condition: two webhooks arriving
   * milliseconds apart could both pass the check before either
   * finished marking. This single atomic call prevents that.
   */
  tryClaimPaymentIntent(paymentIntentId: string): Promise<boolean>;
}