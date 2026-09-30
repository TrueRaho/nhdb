import { Suspense } from "react";
import type { Metadata } from "next";
import { requireUserIdOrRedirect } from "@/lib/session";
import { SwipeEntry } from "@/components/SwipeEntry";

// The swipe deck: every title without a custom name, one full-screen cover at a
// time (lib/swipe.ts has the rules). Its own route segment, like /add/<id>, so
// it ships none of the gallery — and it has a URL a home-screen shortcut can open.
export const metadata: Metadata = {
  title: "swipe · nhdb",
  robots: { index: false, follow: false },
};

export default function SwipePage() {
  // The session read is dynamic, so it resolves inside a Suspense boundary.
  return (
    <Suspense fallback={<div className="h-dvh bg-nh-bg" />}>
      <Deck />
    </Suspense>
  );
}

async function Deck() {
  const userId = await requireUserIdOrRedirect("/swipe");
  return <SwipeEntry key={userId} userId={userId} />;
}
