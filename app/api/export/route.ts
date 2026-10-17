import { requireUserId, UnauthorizedError } from "../../../lib/session";
import { prisma } from "../../../lib/db";
import { exportCollection } from "../../../lib/collection-export";
import { UsageLimitError } from "../../../lib/usage-limits";

export async function GET() {
  const headers = { "Cache-Control": "private, no-store" };
  try {
    const userId = await requireUserId();
    const stream = await exportCollection(prisma, userId);
    return new Response(stream, {
      headers: {
        ...headers, "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": 'attachment; filename="nhdb-collection.json"',
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof UnauthorizedError) return Response.json({ error: error.message }, { status: 401, headers });
    if (error instanceof UsageLimitError) return Response.json({ error: error.message }, {
      status: 429, headers: { ...headers, "Retry-After": String(error.retryAfterSeconds) },
    });
    return Response.json({ error: "Could not export your collection. Try again." }, { status: 503, headers });
  }
}
