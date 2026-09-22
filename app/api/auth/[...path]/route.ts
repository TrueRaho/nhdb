// Catch-all proxy for every Managed Better Auth call the browser makes: sign
// in/up, sign out, session refresh, email verification, password reset.
//
// This route is deliberately NOT session-gated (proxy.ts skips /api/auth) —
// it is how a request gets a session in the first place.
import { auth } from "@/lib/auth/server";

export const { GET, POST } = auth.handler();
