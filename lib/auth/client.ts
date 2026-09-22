"use client";

// Browser-side auth client. Talks to /api/auth/[...path] on this origin (never
// to the Neon Auth host directly), so no auth URL or secret reaches the bundle.
import { createAuthClient } from "@neondatabase/auth/next";

export const authClient = createAuthClient();
