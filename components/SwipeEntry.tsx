"use client";

import dynamic from "next/dynamic";

// Client-only: the deck reads its deletion list from localStorage as it sets
// up, which the server cannot render — and a server render would not match
// the client's on hydration. A server page cannot ask for ssr: false itself,
// hence this one-line client boundary.
export const SwipeEntry = dynamic(() => import("./Swipe").then((m) => ({ default: m.SwipeDeck })), {
  ssr: false,
  loading: () => <div className="h-dvh bg-nh-bg" />,
});
