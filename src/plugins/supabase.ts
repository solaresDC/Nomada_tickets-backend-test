/**
 * Supabase Client Plugin
 * 
 * Creates and exports a Supabase client using the service_role key.
 * The service_role key bypasses Row Level Security (RLS),
 * which is what we want because only our backend server should
 * access the database directly.
 * 
 * SECURITY: The service_role key must NEVER be exposed to the frontend.
 * It lives only in the .env file and in this server-side code.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Read credentials from environment variables
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Validate that credentials exist (crash early with a clear message if missing)
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

/**
 * The Supabase client instance.
 * Uses the service_role key so it can bypass RLS.
 * 
 * Usage in other files:
 *   import { supabase } from '../plugins/supabase.js';
 *   const { data, error } = await supabase.from('orders').select('*');
 */
export const supabase: SupabaseClient = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      // We don't need auth features — this is a server-side client
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);

console.log('[Supabase] Client initialized successfully');