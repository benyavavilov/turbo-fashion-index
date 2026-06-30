import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let supabaseInstance: SupabaseClient | null = null;

export function getSupabasePublicEnv(): { url: string; anonKey: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();

  if (!url || !anonKey) {
    return null;
  }

  return { url, anonKey };
}

export function getSupabase(): SupabaseClient | null {
  if (supabaseInstance) {
    return supabaseInstance;
  }

  const config = getSupabasePublicEnv();
  if (!config) {
    return null;
  }

  supabaseInstance = createClient(config.url, config.anonKey);
  return supabaseInstance;
}

/** Lazy singleton — resolves on first access when public env vars are present. */
export const supabase = {
  get client(): SupabaseClient | null {
    return getSupabase();
  },
};
