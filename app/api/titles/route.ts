import { NextResponse } from "next/server";
import { listTitles } from "@/app/lib/titles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const titles = await listTitles();
  return NextResponse.json({ titles });
}
