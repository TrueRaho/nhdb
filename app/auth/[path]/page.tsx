import { Suspense } from "react";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { AUTH_TITLES, authPath, safeReturnPath, VERIFY_PATH } from "@/lib/auth/paths";
import { AuthForm, type AuthMode } from "../AuthForm";
import { AuthShell } from "../AuthShell";

type Props = {
  params: Promise<{ path: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Pick<Props, "params">): Promise<Metadata> {
  const { path } = await params;
  return { title: AUTH_TITLES[path] ?? "nhdb" };
}

async function AuthScreen({ params, searchParams }: Props) {
  const [{ path }, query] = await Promise.all([params, searchParams]);
  if (!["sign-in", "sign-up", "verify-email"].includes(path)) notFound();
  const next = safeReturnPath(query.next);
  const user = await getSessionUser();
  if (user?.emailVerified) redirect(next);
  if (user && path !== "verify-email") redirect(authPath(VERIFY_PATH, next));
  return <AuthForm mode={path as AuthMode} next={next} initialEmail={user?.email ?? ""} signedIn={user !== null} />;
}

/** Roughly the form's footprint, so switching tabs does not collapse the page. */
function AuthSkeleton() {
  return (
    <div role="status" className="flex flex-col gap-7">
      <span className="sr-only">Loading…</span>
      <div className="h-10.5 rounded-xl border border-nh-border bg-nh-input" />
      <div className="flex flex-col gap-3">
        <div className="h-8 w-2/3 rounded-md bg-nh-pill motion-safe:animate-pulse" />
        <div className="h-4 w-4/5 rounded bg-nh-pill motion-safe:animate-pulse" />
      </div>
      <div className="flex flex-col gap-4">
        <div className="h-11 rounded-lg border border-nh-border bg-nh-input" />
        <div className="h-11 rounded-lg border border-nh-border bg-nh-input" />
        <div className="h-11 rounded-lg bg-nh-accent/25" />
      </div>
    </div>
  );
}

export default function AuthPage(props: Props) {
  return (
    <AuthShell>
      <Suspense fallback={<AuthSkeleton />}>
        <AuthScreen {...props} />
      </Suspense>
    </AuthShell>
  );
}
