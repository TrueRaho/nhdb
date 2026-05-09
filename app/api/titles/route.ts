import { NextResponse } from "next/server";
import { listTitles } from "@/lib/titles";

export async function GET() {
  const titles = await listTitles();
  return NextResponse.json({ titles });
}
