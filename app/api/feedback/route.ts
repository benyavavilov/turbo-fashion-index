import { NextResponse } from "next/server";

import { createBrowserSupabase } from "@/lib/supabase";

export const runtime = "nodejs";

const MAX_NAME = 120;
const MAX_EMAIL = 254;
const MAX_MESSAGE = 4000;

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * POST /api/feedback — insert into user_feedback (name, email, message).
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      name?: unknown;
      email?: unknown;
      message?: unknown;
    };

    const name =
      typeof body.name === "string" ? body.name.trim().slice(0, MAX_NAME) : "";
    const email =
      typeof body.email === "string"
        ? body.email.trim().slice(0, MAX_EMAIL)
        : "";
    const message =
      typeof body.message === "string"
        ? body.message.trim().slice(0, MAX_MESSAGE)
        : "";

    if (!message) {
      return NextResponse.json(
        { error: "Message is required." },
        { status: 400 }
      );
    }
    if (email && !isValidEmail(email)) {
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

    const { error } = await supabase.from("user_feedback").insert({
      name: name || null,
      email: email || null,
      message,
    });

    if (error) {
      console.error("[api/feedback]", error);
      return NextResponse.json(
        { error: error.message || "Failed to save feedback." },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[api/feedback]", err);
    const message = err instanceof Error ? err.message : "Feedback failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
