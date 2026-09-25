"use client";

import { useEffect } from "react";
import Link from "next/link";
import { authClient } from "@/lib/auth/client";
import { SIGN_IN_PATH } from "@/lib/auth/paths";
import { identityPalette, seedFromString } from "@/lib/cover-art";
import { SignOutButton } from "./SignOutButton";

export function AccountControls({ userId, email }: { userId: string; email: string }) {
  const session = authClient.useSession();
  const currentUserId = session.data?.user.id;
  useEffect(() => {
    // Better Auth broadcasts session changes across tabs. Reload on account
    // changes to discard the previous user's collection and pending UI state.
    if (session.isPending || session.error || currentUserId === userId) return;
    window.location.replace(currentUserId ? "/" : SIGN_IN_PATH);
  }, [session.isPending, session.error, currentUserId, userId]);

  // Same colour as the avatar on /account, so the chip reads as "you".
  const [a, b] = identityPalette(seedFromString(email));

  return (
    <div className="flex items-center justify-end gap-2 border-b border-nh-border bg-nh-bg px-4 py-1.5 lg:px-6">
      {/* prefetch={false}: /account is a rarely-visited settings screen, and
          prefetching it would pull its chunk into every library page load. */}
      <Link
        href="/account"
        prefetch={false}
        className="group inline-flex min-w-0 items-center gap-2 rounded-lg py-1 pr-2 pl-1 outline-hidden hover:bg-nh-pill focus-visible:ring-2 focus-visible:ring-nh-accent"
      >
        <span
          aria-hidden
          className="grid size-6 shrink-0 place-items-center rounded-md font-display text-[11px] font-bold text-white uppercase"
          style={{ background: `linear-gradient(135deg, ${a}, ${b})` }}
        >
          {Array.from(email)[0] ?? "?"}
        </span>
        <span className="truncate font-mono text-[11px] text-nh-text-2 group-hover:text-nh-text-1">{email}</span>
        <span className="sr-only">— account settings</span>
      </Link>
      <SignOutButton />
    </div>
  );
}
