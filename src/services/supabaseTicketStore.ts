/**
 * Supabase Ticket Store
 *
 * Implements the TicketStore interface using Supabase (PostgreSQL).
 * Each method maps to one or more database queries.
 */

import { supabase } from '../plugins/supabase.js';
import { generateQRToken } from './qrService.js';
import type { Ticket, TicketStore } from './ticketStore.js';

export class SupabaseTicketStore implements TicketStore {

  /**
   * Creates individual tickets for an order.
   * If someone buys 2 female + 1 male, this creates 3 rows.
   */
  async createTicketsForOrder(
    paymentIntentId: string,
    femaleQty: number,
    maleQty: number
  ): Promise<Ticket[]> {
    // Build an array of ticket objects to insert
    const ticketsToInsert: Array<{
      payment_intent_id: string;
      qr_token: string;
      ticket_type: 'female' | 'male';
      status: 'valid';
    }> = [];

    // Create one ticket per female
    for (let i = 0; i < femaleQty; i++) {
      ticketsToInsert.push({
        payment_intent_id: paymentIntentId,
        qr_token: generateQRToken(),
        ticket_type: 'female',
        status: 'valid',
      });
    }

    // Create one ticket per male
    for (let i = 0; i < maleQty; i++) {
      ticketsToInsert.push({
        payment_intent_id: paymentIntentId,
        qr_token: generateQRToken(),
        ticket_type: 'male',
        status: 'valid',
      });
    }

    // Insert all tickets in one database call (efficient)
    const { data, error } = await supabase
      .from('tickets')
      .insert(ticketsToInsert)
      .select();

    if (error) {
      console.error('[TicketStore] Failed to create tickets:', error);
      throw new Error(`Failed to create tickets: ${error.message}`);
    }

    // Convert database column names (snake_case) to our TypeScript names (camelCase)
    return (data || []).map(row => ({
      id: row.id,
      paymentIntentId: row.payment_intent_id,
      qrToken: row.qr_token,
      ticketType: row.ticket_type,
      status: row.status,
      scannedAt: row.scanned_at ? new Date(row.scanned_at) : null,
      createdAt: new Date(row.created_at),
    }));
  }

  /**
   * Gets all tickets for a specific order (for the frontend carousel).
   */
  async getTicketsByPaymentIntentId(paymentIntentId: string): Promise<Ticket[]> {
    const { data, error } = await supabase
      .from('tickets')
      .select('*')
      .eq('payment_intent_id', paymentIntentId)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[TicketStore] Failed to fetch tickets:', error);
      throw new Error(`Failed to fetch tickets: ${error.message}`);
    }

    return (data || []).map(row => ({
      id: row.id,
      paymentIntentId: row.payment_intent_id,
      qrToken: row.qr_token,
      ticketType: row.ticket_type,
      status: row.status,
      scannedAt: row.scanned_at ? new Date(row.scanned_at) : null,
      createdAt: new Date(row.created_at),
    }));
  }

  /**
   * Gets ALL valid tickets (for the scanner's in-memory Map).
   * Returns only qrToken and ticketType — minimal data for speed.
   */
  async getAllValidTickets(): Promise<Array<{
    qrToken: string;
    ticketType: 'female' | 'male';
  }>> {
    const { data, error } = await supabase
      .from('tickets')
      .select('qr_token, ticket_type')
      .eq('status', 'valid');

    if (error) {
      console.error('[TicketStore] Failed to fetch valid tickets:', error);
      throw new Error(`Failed to fetch valid tickets: ${error.message}`);
    }

    return (data || []).map(row => ({
      qrToken: row.qr_token,
      ticketType: row.ticket_type,
    }));
  }

  /**
   * Marks a ticket as "used" when scanned at the door.
   * Returns whether it succeeded or was already used (duplicate scan).
   */
  async markTicketAsUsed(qrToken: string): Promise<{
    success: boolean;
    ticketType?: 'female' | 'male';
    alreadyUsed?: boolean;
  }> {
    // First, try to update the ticket from 'valid' to 'used'
    const { data, error } = await supabase
      .from('tickets')
      .update({
        status: 'used',
        scanned_at: new Date().toISOString(),
      })
      .eq('qr_token', qrToken)
      .eq('status', 'valid')   // Only update if currently valid
      .select('ticket_type');

    if (error) {
      console.error('[TicketStore] Failed to mark ticket as used:', error);
      throw new Error(`Failed to mark ticket as used: ${error.message}`);
    }

    // If we got a row back, the ticket was valid and is now marked as used
    if (data && data.length > 0) {
      return {
        success: true,
        ticketType: data[0].ticket_type,
        alreadyUsed: false,
      };
    }

    // No row updated — check if the ticket exists but was already used
    const { data: existingTicket } = await supabase
      .from('tickets')
      .select('status, ticket_type')
      .eq('qr_token', qrToken)
      .single();

    if (existingTicket && existingTicket.status === 'used') {
      return {
        success: false,
        ticketType: existingTicket.ticket_type,
        alreadyUsed: true,
      };
    }

    // Ticket doesn't exist at all
    return {
      success: false,
      alreadyUsed: false,
    };
  }
}

// Create a single instance to use throughout the app
export const ticketStore = new SupabaseTicketStore();