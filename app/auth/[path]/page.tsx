import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { authPath, safeReturnPath, VERIFY_PATH } from "@/lib/auth/paths";
import { AuthForm, type AuthMode } from "../AuthForm";

type Props = {
  params: Promise<{ path: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

async function AuthScreen({ params, searchParams }: Props) {
  const [{ path }, query] = await Promise.all([params, searchParams]);
  if (!["sign-in", "sign-up", "verify-email"].includes(path)) notFound();
  const next = safeReturnPath(query.next);
  const user = await getSessionUser();
  if (user?.emailVerified) redirect(next);
  if (user && path !== "verify-email") redirect(authPath(VERIFY_PATH, next));
  return <AuthForm mode={path as AuthMode} next={next} initialEmail={user?.email ?? ""} />;
}

export default function AuthPage(props: Props) {
  return (
    <main className="flex min-h-dvh items-center justify-center p-5">
      <Suspense fallback={<p role="status">Loading account…</p>}>
        <AuthScreen {...props} />
      </Suspense>
    </main>
  );
}
