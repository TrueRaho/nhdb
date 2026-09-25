"use client";

import { useLayoutEffect, useState, type ComponentProps, type FormEvent, type MouseEvent, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { ArrowRight, Eye, EyeOff, MailCheck } from "lucide-react";
import { authClient } from "@/lib/auth/client";
import { AUTH_TITLES, authPath, safeReturnPath, SIGN_IN_PATH, SIGN_UP_PATH, VERIFY_PATH } from "@/lib/auth/paths";
import { SignOutButton } from "@/components/SignOutButton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type AuthMode = "sign-in" | "sign-up" | "verify-email";
type EntryMode = Exclude<AuthMode, "verify-email">;

const COPY: Record<AuthMode, { title: string; lede: string }> = {
  "sign-in": { title: "Welcome back", lede: "Sign in to open your library." },
  "sign-up": { title: "Start your library", lede: "Titles, tags and reading history — private to your account." },
  "verify-email": { title: "Verify your email", lede: "" },
};

/** Which request is in flight, so only the control that started it shows progress. */
type Busy = null | "auth" | "send" | "verify" | "check";

// Solid 2px ring with an offset: the halo the primitives ship with composites
// to ~2.6:1 on this background, and on an accent-filled control it vanishes.
const FOCUS_RING = "outline-hidden focus-visible:ring-2 focus-visible:ring-nh-accent focus-visible:ring-offset-2 focus-visible:ring-offset-nh-bg";

export function AuthForm({ mode, next, initialEmail = "", signedIn = false }: {
  mode: AuthMode;
  next: string;
  initialEmail?: string;
  /** Whether a (still unverified) session exists — only then is signing out meaningful. */
  signedIn?: boolean;
}) {
  // Sign-in and sign-up are one form: the switch flips this in place (and
  // rewrites the URL), rather than navigating to the other route and
  // re-rendering the page — which is what made the switch feel like a button.
  //
  // Initialised from the URL, not only from `mode`: after a switch Next keeps
  // the served route's tree, so a remount (e.g. a back/forward entry evicted
  // from the router's cache) would otherwise come back as the other form.
  const pathname = usePathname();
  const [entry, setEntry] = useState<EntryMode>(() =>
    pathname === SIGN_UP_PATH ? "sign-up" : pathname === SIGN_IN_PATH ? "sign-in" : mode === "sign-up" ? "sign-up" : "sign-in");
  // Animate the heading only after a switch, not on first paint.
  const [switched, setSwitched] = useState(false);
  const [email, setEmail] = useState(initialEmail);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  // With the address already known (a session, or straight after sign-up), the
  // code is usually in the inbox: lead with the code field and keep "send" as a
  // resend. Without it, ask for the address first.
  const [askEmail, setAskEmail] = useState(initialEmail === "");
  const pending = busy !== null;
  const destination = safeReturnPath(next);
  const verifying = mode === "verify-email";
  const current: AuthMode = verifying ? mode : entry;
  const signingUp = current === "sign-up";
  const signInUrl = authPath(SIGN_IN_PATH, destination);

  function switchEntry(next: EntryMode, href: string) {
    if (next === entry || pending) return;
    setEntry(next);
    setSwitched(true);
    setError("");
    setMessage("");
    // Keep the address bar, reloads and the back button honest. Next's router
    // picks up native history calls (docs: linking-and-navigating, "Native
    // History API"); the title is set by the layout effect below.
    window.history.replaceState(null, "", href);
  }

  // The route announcer reads document.title, and back/forward re-applies the
  // served route's metadata title ("Sign in") over a switched form. A layout
  // effect runs in the same commit, before paint and before the announcer.
  useLayoutEffect(() => {
    if (!verifying) document.title = AUTH_TITLES[entry];
  }, [entry, verifying]);

  function start(kind: Exclude<Busy, null>) {
    setBusy(kind);
    setError("");
    setMessage("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const fields = new FormData(event.currentTarget);
    start("auth");
    try {
      // Email links must return to this origin; `next` is validated separately.
      const callbackURL = new URL(destination, window.location.origin).href;
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
      setBusy(null);
    }
  }

  async function sendCode() {
    if (pending) return;
    start("send");
    try {
      const callbackURL = new URL(destination, window.location.origin).href;
      const result = await authClient.sendVerificationEmail({ email: email.trim(), callbackURL });
      if (result.error) {
        setError(result.error.message ?? "Could not send verification email.");
        return;
      }
      setMessage("If this address needs verification, an email is on its way. Check your inbox and spam folder.");
    } catch {
      setError("Could not reach the sign-in service. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  // Neon Auth's shared email provider can only send numeric codes; links need a
  // custom SMTP provider. Accept both, so the screen works whichever the branch
  // is configured for.
  async function verifyCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const otp = String(new FormData(event.currentTarget).get("code") ?? "").trim();
    start("verify");
    try {
      const result = await authClient.emailOtp.verifyEmail({ email: email.trim(), otp });
      if (result.error) {
        setError(result.error.message ?? "That code did not work. Check it or send a new one.");
        setBusy(null);
        return;
      }
    } catch {
      setError("Could not reach the sign-in service. Please try again.");
      setBusy(null);
      return;
    }
    await checkVerification("verify");
  }

  async function checkVerification(kind: "check" | "verify" = "check") {
    setBusy(kind);
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
        setError("Your email is not verified yet. Enter the code or open the link from your verification email first.");
      }
    } catch {
      setError("Could not check verification. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  const feedback = (
    <>
      {error && (
        <p role="alert" className="rounded-lg border border-destructive/25 bg-destructive/10 px-3.5 py-2.5 text-sm leading-snug text-destructive">
          {error}
        </p>
      )}
      {/* Always mounted: a live region created together with its text is often
          skipped by screen readers, and this is the only send confirmation. */}
      <p
        role="status"
        className={message
          ? "rounded-lg border border-nh-border bg-nh-surface px-3.5 py-2.5 text-sm leading-snug text-nh-text-2"
          : "sr-only"}
      >
        {message}
      </p>
    </>
  );

  const emailField = (
    <TextField
      id="email" label="Email" name="email" type="email" autoComplete="email" required
      value={email} onChange={(event) => setEmail(event.target.value)} readOnly={pending}
      placeholder="you@example.com" hideLabel={verifying}
    />
  );

  const codeForm = (
    <form onSubmit={verifyCode} aria-busy={busy === "verify"} className="flex flex-col gap-3">
      <TextField
        id="code" label="Verification code" name="code" inputMode="numeric" autoComplete="one-time-code"
        required maxLength={12} readOnly={pending} placeholder="••••••" hideLabel={askEmail}
        className="h-14 text-center indent-[0.5em] font-mono text-2xl tracking-[0.5em] md:text-2xl"
      />
      <PrimaryButton busy={busy === "verify"} disabled={pending}>Verify code</PrimaryButton>
    </form>
  );

  return (
    <div className="flex flex-col gap-7">
      {!verifying && <ModeSwitch mode={entry} destination={destination} onSwitch={switchEntry} />}

      <header
        key={current}
        className={cn(
          "flex flex-col gap-2",
          switched && "motion-safe:animate-in motion-safe:fade-in-30 motion-safe:slide-in-from-bottom-1 motion-safe:duration-200 motion-safe:ease-[cubic-bezier(0.32,0.72,0,1)]",
        )}
      >
        {verifying && (
          <span className="mb-2 hidden size-12 place-items-center rounded-2xl border border-nh-accent/25 bg-nh-accent-soft text-nh-accent lg:grid">
            <MailCheck className="size-5" strokeWidth={2} />
          </span>
        )}
        <h1 className="font-display text-[30px] leading-[1.1] font-bold tracking-[-0.03em] text-nh-text-1">
          {COPY[current].title}
        </h1>
        {/* Two lines reserved on the sign-in/sign-up pair, so the longer lede
            does not shove the form down in the frame the switch happens. */}
        <p className={cn("text-[15px] leading-relaxed text-pretty text-nh-text-2", !verifying && "min-h-[2lh]")}>
          {!verifying ? COPY[current].lede : askEmail ? (
            "Enter your address to get a code, then type it below — or open the link in that email."
          ) : (
            <>Enter the code we emailed to <span className="font-mono text-[14px] break-all text-nh-text-1">{email}</span>. Codes expire after 15 minutes.</>
          )}
        </p>
      </header>

      {!verifying && (
        <form onSubmit={submit} aria-busy={pending} className="flex flex-col gap-4">
          <Reveal open={signingUp}>
            <TextField id="name" label="Name" name="name" autoComplete="name" required={signingUp} maxLength={100} readOnly={pending} placeholder="what should we call you" />
          </Reveal>
          {emailField}
          <TextField
            id="password" label="Password" name="password" type={showPassword ? "text" : "password"}
            autoComplete={signingUp ? "new-password" : "current-password"} required
            minLength={signingUp ? 8 : undefined} readOnly={pending}
            hint="At least 8 characters."
            hintOpen={signingUp}
            className="pr-11"
            trailing={
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label="Show password"
                aria-pressed={showPassword}
                aria-controls="password"
                className="absolute inset-y-0 right-0 grid w-11 place-items-center rounded-r-lg text-nh-text-3 outline-hidden hover:text-nh-text-1 focus-visible:ring-2 focus-visible:ring-nh-accent focus-visible:ring-inset"
              >
                {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            }
          />
          {feedback}
          <PrimaryButton busy={busy === "auth"} disabled={pending}>{signingUp ? "Create account" : "Sign in"}</PrimaryButton>
        </form>
      )}

      {verifying && askEmail && (
        <ol className="flex flex-col gap-6">
          <Step n={1} title="Get a code">
            <form onSubmit={(e) => { e.preventDefault(); void sendCode(); }} aria-busy={busy === "send"} className="flex flex-col gap-3">
              {emailField}
              <Button
                type="submit" variant="outline" disabled={pending} focusableWhenDisabled
                className={cn("h-10 rounded-lg border-nh-border-strong bg-transparent font-display text-[13px] font-semibold text-nh-text-1 hover:bg-nh-pill data-disabled:opacity-50", FOCUS_RING)}
              >
                {busy === "send" ? <><span className="nh-dot-pulse" /> Sending…</> : "Send verification email"}
              </Button>
            </form>
          </Step>
          <Step n={2} title="Enter it here" last>
            {codeForm}
          </Step>
        </ol>
      )}

      {verifying && !askEmail && (
        <div className="flex flex-col gap-3">
          {codeForm}
          <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-nh-text-2">
            Didn&apos;t get it?
            <InlineAction onClick={sendCode} disabled={pending}>
              {busy === "send" ? "Sending…" : "Resend code"}
            </InlineAction>
            <span aria-hidden className="text-nh-text-3">·</span>
            <InlineAction onClick={() => { setAskEmail(true); setMessage(""); setError(""); }} disabled={pending}>
              Use another email
            </InlineAction>
          </p>
        </div>
      )}

      {verifying && (
        <>
          {feedback}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-nh-border pt-4">
            <div className="flex flex-wrap items-center gap-x-1">
              <span className="text-sm text-nh-text-3">Opened the link instead?</span>
              <InlineAction onClick={() => checkVerification()} disabled={pending}>
                {busy === "check" ? "Checking…" : "Continue after verification"}
              </InlineAction>
            </div>
            {signedIn ? (
              <SignOutButton />
            ) : (
              <Link href={signInUrl} className={cn("inline-flex min-h-10 items-center rounded-md font-mono text-[11px] text-nh-text-3 underline-offset-4 hover:text-nh-text-1 hover:underline", FOCUS_RING)}>
                <span aria-hidden>←&nbsp;</span>back to sign in
              </Link>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function ModeSwitch({ mode, destination, onSwitch }: {
  mode: EntryMode;
  destination: string;
  onSwitch: (mode: EntryMode, href: string) => void;
}) {
  const tabs = [
    { mode: "sign-in" as const, label: "Sign in", href: authPath(SIGN_IN_PATH, destination) },
    { mode: "sign-up" as const, label: "Create account", href: authPath(SIGN_UP_PATH, destination) },
  ];
  const index = tabs.findIndex((t) => t.mode === mode);

  function click(event: MouseEvent<HTMLAnchorElement>, tab: (typeof tabs)[number]) {
    // Real links underneath, so they work before hydration and with a
    // modifier (new tab/window); a plain click switches in place.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onSwitch(tab.mode, tab.href);
  }

  return (
    <nav aria-label="Account access" className="relative isolate grid grid-cols-2 rounded-xl border border-nh-border bg-nh-input p-1">
      {/* One thumb that slides under both links; the same construction as the
          app's Segmented control (components/Primitives.tsx). */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-1 left-1 -z-10 w-[calc(50%-0.25rem)] rounded-lg bg-nh-accent-soft shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--nh-accent)_35%,transparent)] transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none"
        style={{ transform: `translateX(${index * 100}%)` }}
      />
      {tabs.map((t) => {
        const active = t.mode === mode;
        return (
          <Link
            key={t.mode}
            href={t.href}
            prefetch={false}
            onClick={(event) => click(event, t)}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-lg py-2 text-center font-mono text-[11px] font-semibold tracking-wider uppercase transition-colors duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
              "touch-manipulation outline-hidden [-webkit-tap-highlight-color:transparent] focus-visible:ring-2 focus-visible:ring-nh-accent focus-visible:ring-inset",
              active ? "text-nh-accent" : "text-nh-text-2 hover:text-nh-text-1",
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * Height-animated show/hide for a form row. Collapsed content stays mounted
 * (so a typed name survives switching back and forth) but inert, and the
 * negative margin (`collapse`, matching the parent's gap) leaves no empty slot.
 * The clip box is padded out by 4px so a focused input's ring is not cut off.
 */
function Reveal({ open, collapse = "-mb-4", children }: { open: boolean; collapse?: string; children: ReactNode }) {
  return (
    <div
      inert={!open}
      className={cn(
        "grid transition-[grid-template-rows,opacity,margin] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
        open ? "grid-rows-[1fr] opacity-100" : cn(collapse, "grid-rows-[0fr] opacity-0"),
      )}
    >
      <div className="-m-1 min-h-0 overflow-hidden p-1">{children}</div>
    </div>
  );
}

function TextField({ id, label, hint, hintOpen = true, hideLabel = false, trailing, className, ...input }: ComponentProps<"input"> & {
  id: string;
  label: string;
  hint?: string;
  /** Shows/hides the hint with the same height animation as a form row. */
  hintOpen?: boolean;
  /** Keep the label for assistive tech only, where a step title already names the field. */
  hideLabel?: boolean;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className={hideLabel ? "sr-only" : "font-mono text-[10px] tracking-[0.14em] text-nh-text-3 uppercase"}>
        {label}
      </label>
      <div className="relative">
        <Input
          id={id}
          aria-describedby={hint && hintOpen ? `${id}-hint` : undefined}
          className={cn(
            // 16px on phones (iOS zooms into anything smaller on focus); the md:
            // size must be restated or the primitive's md:text-sm wins.
            "h-11 rounded-lg border-nh-border bg-nh-input px-3.5 text-base text-nh-text-1 placeholder:text-nh-text-3 read-only:opacity-80 focus-visible:border-nh-accent focus-visible:ring-nh-accent/30 md:text-[15px]",
            className,
          )}
          {...input}
        />
        {trailing}
      </div>
      {hint && (
        <Reveal open={hintOpen} collapse="-mt-1.5">
          <p id={`${id}-hint`} className="font-mono text-[10px] tracking-wide text-nh-text-3">{hint}</p>
        </Reveal>
      )}
    </div>
  );
}

function PrimaryButton({ busy, disabled, children }: { busy: boolean; disabled: boolean; children: ReactNode }) {
  return (
    <Button
      type="submit"
      disabled={disabled}
      // Keeps focus on the button while a request runs; a natively disabled
      // control drops it to <body>, and the next Tab starts from the top.
      focusableWhenDisabled
      className={cn(
        "h-11 w-full gap-2 rounded-lg bg-nh-accent font-display text-[14px] font-bold tracking-[-0.01em] text-[#0a0a0a] hover:bg-nh-accent/90 data-disabled:opacity-60",
        FOCUS_RING,
      )}
    >
      {busy ? (
        <><span className="nh-dot-pulse" /> Please wait…</>
      ) : (
        <>{children} <ArrowRight className="size-4" strokeWidth={2.4} /></>
      )}
    </Button>
  );
}

function InlineAction({ onClick, disabled, children }: { onClick: () => void; disabled: boolean; children: ReactNode }) {
  return (
    <Button
      type="button" variant="ghost" onClick={onClick} disabled={disabled} focusableWhenDisabled
      className={cn(
        "h-8 px-1.5 font-display text-sm font-semibold text-nh-accent hover:bg-nh-accent-soft hover:text-nh-accent data-disabled:opacity-50 pointer-coarse:h-10",
        FOCUS_RING,
      )}
    >
      {children}
    </Button>
  );
}

function Step({ n, title, last = false, children }: { n: number; title: string; last?: boolean; children: ReactNode }) {
  return (
    <li className="relative grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3">
      <span aria-hidden className="grid size-7 place-items-center rounded-full border border-nh-accent/40 bg-nh-accent-soft font-mono text-[11px] font-semibold text-nh-accent">
        {n}
      </span>
      {!last && <span aria-hidden className="absolute top-8 bottom-[-1.25rem] left-3.5 w-px bg-nh-border-strong" />}
      <div className="flex min-w-0 flex-col gap-3">
        <span className="pt-1 font-display text-[14px] font-semibold text-nh-text-1">{title}</span>
        {children}
      </div>
    </li>
  );
}
