/**
 * Ticket Store Interface
 *
 * Defines the shape of a Ticket and all operations
 * needed to manage individual per-person tickets.
 *
 * This follows the same pattern as OrderStore —
 * if we ever switch databases, we only rewrite the implementation,
 * not every file that uses it.
 */

export interface Ticket {
  id: string;
  paymentIntentId: string;
  qrToken: string;
  ticketType: 'female' | 'male';
  status: 'valid' | 'used' | 'cancelled';
  scannedAt: Date | null;
  createdAt: Date;
}

export interface TicketStore {
  /**
   * Called by the webhook handler after payment succeeds.
   * Creates one ticket row per person.
   * Example: femaleQty=2, maleQty=1 → creates 3 rows.
   */
  createTicketsForOrder(
    paymentIntentId: string,
    femaleQty: number,
    maleQty: number
  ): Promise<Ticket[]>;

  /**
   * Called by the frontend after payment.
   * Returns all tickets for an order so we can show the QR carousel.
   */
  getTicketsByPaymentIntentId(paymentIntentId: string): Promise<Ticket[]>;

  /**
   * Called by the scanner app on startup and every 10-minute refresh.
   * Returns ALL valid (unscanned) tickets for the in-memory Map.
   */
  getAllValidTickets(): Promise<Array<{
    qrToken: string;
    ticketType: 'female' | 'male';
  }>>;

  /**
   * Called by the scanner app when a QR code is scanned.
   * Marks the ticket as "used" and sets the scanned_at timestamp.
   */
  markTicketAsUsed(qrToken: string): Promise<{
    success: boolean;
    ticketType?: 'female' | 'male';
    alreadyUsed?: boolean;
  }>;
}