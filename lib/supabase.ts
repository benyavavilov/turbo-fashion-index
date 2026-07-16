import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Global singleton for the browser/anon Supabase client.
 * Prevents "Multiple GoTrueClient instances detected" in Next.js HMR /
 * repeated server-action + API route calls within the same JS context.
 */
const globalForSupabase = globalThis as typeof globalThis & {
  __turboFashionSupabase?: SupabaseClient | null;
  __turboFashionSupabaseConfigured?: boolean;
};

function readSupabaseEnv(): { url: string; anonKey: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey || url.includes("your-project-id")) {
    return null;
  }

  return { url, anonKey };
}

export function createBrowserSupabase(): SupabaseClient | null {
  if (globalForSupabase.__turboFashionSupabase !== undefined) {
    return globalForSupabase.__turboFashionSupabase;
  }

  const env = readSupabaseEnv();
  if (!env) {
    globalForSupabase.__turboFashionSupabase = null;
    globalForSupabase.__turboFashionSupabaseConfigured = false;
    return null;
  }

  const client = createClient(env.url, env.anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  globalForSupabase.__turboFashionSupabase = client;
  globalForSupabase.__turboFashionSupabaseConfigured = true;
  return client;
}

export function isSupabaseConfigured(): boolean {
  if (globalForSupabase.__turboFashionSupabaseConfigured != null) {
    return globalForSupabase.__turboFashionSupabaseConfigured;
  }
  return createBrowserSupabase() !== null;
}
