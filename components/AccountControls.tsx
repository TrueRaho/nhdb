"use client";

import { useEffect } from "react";
import Link from "next/link";
import { authClient } from "@/lib/auth/client";
import { SIGN_IN_PATH } from "@/lib/auth/paths";
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

  return (
    <div className="flex items-center justify-end gap-3 border-b border-border px-4 py-2">
      <span className="truncate text-sm text-muted-foreground">{email}</span>
      {/* prefetch={false}: /account is a rarely-visited settings screen, and
          prefetching it would pull its chunk into every library page load. */}
      <Link
        href="/account"
        prefetch={false}
        className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
      >
        Account
      </Link>
      <SignOutButton />
    </div>
  );
}
