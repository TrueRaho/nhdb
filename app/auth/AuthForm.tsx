"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { authClient } from "@/lib/auth/client";
import { authPath, safeReturnPath, SIGN_IN_PATH, VERIFY_PATH } from "@/lib/auth/paths";
import { SignOutButton } from "@/components/SignOutButton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";

export type AuthMode = "sign-in" | "sign-up" | "verify-email";

export function AuthForm({ mode, next, initialEmail = "" }: { mode: AuthMode; next: string; initialEmail?: string }) {
  const [email, setEmail] = useState(initialEmail);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const destination = safeReturnPath(next);
  const signingUp = mode === "sign-up";
  const verifying = mode === "verify-email";
  const signInUrl = authPath(SIGN_IN_PATH, destination);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const fields = new FormData(event.currentTarget);
    setPending(true);
    setError("");
    setMessage("");
    try {
      // Email links must return to this origin; `next` is validated separately.
      const callbackURL = new URL(destination, window.location.origin).href;
      if (verifying) {
        const result = await authClient.sendVerificationEmail({ email: email.trim(), callbackURL });
        if (result.error) {
          setError(result.error.message ?? "Could not send verification email.");
          return;
        }
        setMessage("If this address needs verification, an email is on its way. Check your inbox and spam folder.");
        return;
      }
      const credentials = { email: email.trim(), password: String(fields.get("password") ?? "") };
      const result = signingUp
        ? await authClient.signUp.email({ ...credentials, name: String(fields.get("name") ?? "").trim(), callbackURL })
        : await authClient.signIn.email(credentials);
      if (result.error) {
        if (result.error.code === "EMAIL_NOT_VERIFIED") {
          window.location.replace(authPath(VERIFY_PATH, destination));
          return;
        }
        setError(result.error.message ?? "Authentication failed. Try again.");
        return;
      }
      window.location.replace(signingUp && !result.data?.user.emailVerified
        ? authPath(VERIFY_PATH, destination)
        : destination);
    } catch {
      setError("Could not reach the sign-in service. Please try again.");
    } finally {
      setPending(false);
    }
  }

  async function checkVerification() {
    setPending(true);
    setError("");
    try {
      const result = await authClient.getSession({ query: { disableCookieCache: true } });
      if (result.error) {
        setError("Could not check verification. Please try again.");
      } else if (!result.data) {
        window.location.replace(signInUrl);
      } else if (result.data.user.emailVerified) {
        window.location.replace(destination);
      } else {
        setError("Your email is not verified yet. Open the link in your verification email first.");
      }
    } catch {
      setError("Could not check verification. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>{verifying ? "Verify your email" : signingUp ? "Create your nhdb account" : "Sign in to nhdb"}</CardTitle>
        <CardDescription>{verifying ? "Verify your email before opening your collection." : "Your collection, saved privately to your account."}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <FieldGroup>
            {signingUp && <Field><FieldLabel htmlFor="name">Name</FieldLabel><Input id="name" name="name" autoComplete="name" required maxLength={100} disabled={pending} /></Field>}
            <Field>
              <FieldLabel htmlFor="email">Email</FieldLabel>
              <Input id="email" name="email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} disabled={pending} />
            </Field>
            {!verifying && <Field>
              <FieldLabel htmlFor="password">Password</FieldLabel>
              <Input id="password" name="password" type="password" autoComplete={signingUp ? "new-password" : "current-password"} required minLength={signingUp ? 8 : undefined} disabled={pending} />
            </Field>}
          </FieldGroup>
          {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
          {message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
          <Button type="submit" disabled={pending}>{pending ? "Please wait…" : verifying ? "Send verification email" : signingUp ? "Create account" : "Sign in"}</Button>
          {verifying && <Button type="button" variant="outline" onClick={checkVerification} disabled={pending}>Continue after verification</Button>}
        </form>
      </CardContent>
      <CardFooter className="flex flex-col items-start gap-3">
        <Link className="text-sm text-primary underline-offset-4 hover:underline" href={signingUp || verifying ? signInUrl : authPath("/auth/sign-up", destination)}>
          {signingUp || verifying ? "Back to sign in" : "Create an account"}
        </Link>
        {verifying && <SignOutButton />}
      </CardFooter>
    </Card>
  );
}
