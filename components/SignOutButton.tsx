"use client";

import { useState } from "react";
import { LogOut } from "lucide-react";
import { authClient } from "@/lib/auth/client";
import { SIGN_IN_PATH } from "@/lib/auth/paths";
import { Button } from "@/components/ui/button";

export function SignOutButton() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  async function signOut() {
    setPending(true);
    setError(false);
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error("Sign-out failed");
      // A full navigation discards all user-specific React/router state.
      window.location.replace(SIGN_IN_PATH);
    } catch {
      setError(true);
      setPending(false);
    }
  }
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        variant="outline" size="sm" onClick={signOut} disabled={pending}
        className="gap-1.5 rounded-lg border-nh-border-strong bg-transparent px-3 font-mono text-[11px] tracking-wide text-nh-text-2 outline-hidden hover:bg-nh-pill hover:text-nh-text-1 focus-visible:ring-2 focus-visible:ring-nh-accent focus-visible:ring-offset-2 focus-visible:ring-offset-nh-bg pointer-coarse:h-9"
      >
        <LogOut aria-hidden className="size-3.5" />
        {pending ? "Signing out…" : "Sign out"}
      </Button>
      {error && <span role="alert" className="text-sm text-destructive">Could not sign out. Try again.</span>}
    </span>
  );
}
