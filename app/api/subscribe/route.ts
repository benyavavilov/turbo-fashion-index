import { NextResponse } from "next/server";

import { createBrowserSupabase } from "@/lib/supabase";

export const runtime = "nodejs";

const MAX_EMAIL = 254;

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * POST /api/subscribe — insert email into subscribers.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { email?: unknown };
    const email =
      typeof body.email === "string"
        ? body.email.trim().toLowerCase().slice(0, MAX_EMAIL)
        : "";

    if (!email) {
      return NextResponse.json(
        { error: "Email is required." },
        { status: 400 }
      );
    }
    if (!isValidEmail(email)) {
      return NextResponse.json(
        { error: "Please enter a valid email address." },
        { status: 400 }
      );
    }

    const supabase = createBrowserSupabase();
    if (!supabase) {
      return NextResponse.json(
        { error: "Supabase is not configured." },
        { status: 500 }
      );
    }

    const { error } = await supabase.from("subscribers").insert({ email });

    if (error) {
      // Unique violation — already on the list
      if (
        error.code === "23505" ||
        /duplicate|unique/i.test(error.message ?? "")
      ) {
        return NextResponse.json({
          ok: true,
          alreadySubscribed: true,
          message: "You are already subscribed!",
        });
      }
      console.error("[api/subscribe]", error);
      return NextResponse.json(
        { error: error.message || "Failed to subscribe." },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      message: "Welcome to the list!",
    });
  } catch (err) {
    console.error("[api/subscribe]", err);
    const message = err instanceof Error ? err.message : "Subscribe failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
