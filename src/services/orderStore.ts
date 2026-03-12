/**
 * Order Store Interface
 *
 * Defines the contract for storing order data.
 * This interface allows us to easily swap the implementation
 * from in-memory storage to a database (like Postgres) later.
 *
 * CHANGE: Added optional `orderReference` field to Order.
 *         This is the human-friendly NMD-XXXX-XXXX code sent in emails.
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
  email?: string;
  orderReference?: string; // NEW — e.g. "NMD-2847-XK9Q", generated at webhook time
}

/**
 * Interface for order storage operations.
 * Implement this interface to create different storage backends.
 */
export interface OrderStore {
  saveOrder(order: Order): Promise<void>;
  getOrderByPaymentIntentId(paymentIntentId: string): Promise<Order | null>;
  isPaymentIntentProcessed(paymentIntentId: string): Promise<boolean>;
  markPaymentIntentProcessed(paymentIntentId: string): Promise<void>;
  tryClaimPaymentIntent(paymentIntentId: string): Promise<boolean>;
}