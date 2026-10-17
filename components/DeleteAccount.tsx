"use client";

import { useLayoutEffect, useState } from "react";
import { unstable_rethrow } from "next/navigation";
import { deleteAccountAction } from "@/app/account/delete-action";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Alert, AlertDescription } from "@/components/ui/alert";

export function DeleteAccount() {
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  // Activity retains this page. A destructive confirmation must not survive a visit.
  useLayoutEffect(() => () => { setConfirmation(""); setError(""); }, []);

  async function remove() {
    if (pending || confirmation !== "DELETE") return;
    setPending(true);
    setError("");
    try {
      const result = await deleteAccountAction(confirmation);
      setError(result.error);
    } catch (error) {
      unstable_rethrow(error);
      setError("Could not finish the request. Check your account before trying again.");
    } finally { setPending(false); }
  }

  return (
    <section aria-labelledby="delete-account-heading" className="flex flex-col gap-4 rounded-2xl border border-nh-border bg-nh-surface p-5">
      <h2 id="delete-account-heading" className="font-display text-lg font-bold">Delete my account</h2>
      <p className="text-sm text-nh-text-2">
        Permanently delete your entire collection, reading history and scraper hosts.
        This cannot be undone. Export your collection first if you want a copy.
      </p>
      <p className="text-sm text-nh-text-2">Usage counters remain until their windows end, so deletion cannot reset limits.</p>
      <p className="text-sm text-nh-text-2">
        We then request deletion of your login and sign you out. If the auth service cannot
        delete it, your login remains; contact the operator. The result is shown after sign-out.
      </p>
      <form action={remove}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="delete-confirmation">Type DELETE to confirm</FieldLabel>
            <Input id="delete-confirmation" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} disabled={pending} autoComplete="off" />
            <FieldDescription>Only your account’s data will be deleted.</FieldDescription>
          </Field>
          {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
          <Button type="submit" variant="destructive" disabled={pending || confirmation !== "DELETE"}>
            {pending ? "Deleting…" : "Permanently delete my account"}
          </Button>
        </FieldGroup>
      </form>
    </section>
  );
}
