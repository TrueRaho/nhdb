import { NextResponse } from "next/server";
import { deleteTitle, getTitle, markRead, updateAlterName } from "@/lib/titles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ hashtag: string }> }) {
  const { hashtag } = await ctx.params;
  const id = parseInt(hashtag, 10);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "Invalid hashtag" }, { status: 400 });
  }
  const title = await getTitle(id);
  if (!title) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ title });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ hashtag: string }> }) {
  const { hashtag } = await ctx.params;
  const id = parseInt(hashtag, 10);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "Invalid hashtag" }, { status: 400 });
  }
  await deleteTitle(id);
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ hashtag: string }> }) {
  const { hashtag } = await ctx.params;
  const id = parseInt(hashtag, 10);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "Invalid hashtag" }, { status: 400 });
  }
  let body: { alterName?: string } = {};
  try { body = await req.json(); } catch { /* no body → mark read */ }
  if ("alterName" in body) {
    await updateAlterName(id, body.alterName ?? "");
  } else {
    await markRead(id);
  }
  return NextResponse.json({ ok: true });
}
