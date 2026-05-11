"use client";

import { useActionState } from "react";
import { loginAction } from "./actions";

export default function AdminLoginPage() {
  const [state, formAction, pending] = useActionState(loginAction, null);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="pointer-events-none absolute left-1/2 top-1/3 -translate-x-1/2 h-64 w-64 rounded-full bg-primary/8 blur-[100px]" />

        <div className="relative rounded-2xl border border-outline-variant/20 bg-surface-low/50 p-8 backdrop-blur-xl">
          <div className="mb-8 text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10">
              <svg aria-hidden="true" className="h-6 w-6 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
              </svg>
            </div>
            <h1 className="font-display-ui text-2xl font-semibold tracking-[-0.04em]">
              Admin Access
            </h1>
            <p className="mt-2 font-label-ui text-[11px] uppercase tracking-[0.2em] text-foreground-muted">
              Restricted Area
            </p>
          </div>

          <form action={formAction}>
            <div>
              <label
                className="mb-2 block font-label-ui text-[11px] uppercase tracking-[0.18em] text-foreground-muted"
                htmlFor="password"
              >
                Password
              </label>
              <input
                autoComplete="current-password"
                autoFocus
                className="w-full rounded-xl border border-outline-variant/30 bg-surface-high/40 px-4 py-3 text-sm text-foreground outline-none transition-colors placeholder:text-foreground-muted/40 focus:border-primary/30 focus:ring-1 focus:ring-primary/20"
                id="password"
                name="password"
                placeholder="••••••••"
                required
                type="password"
              />
            </div>

            {state?.error && (
              <p className="mt-3 text-sm text-red-400">{state.error}</p>
            )}

            <button
              className="mt-6 w-full rounded-xl bg-primary/90 px-4 py-3 font-label-ui text-[11px] font-semibold uppercase tracking-[0.18em] text-white dark:text-black transition-colors hover:bg-primary disabled:opacity-50"
              disabled={pending}
              type="submit"
            >
              {pending ? "Verifying…" : "Enter"}
            </button>
          </form>
        </div>

        <p className="mt-6 text-center font-label-ui text-[10px] uppercase tracking-[0.3em] text-foreground-muted/30">
          AI Site · Admin Console
        </p>
      </div>
    </main>
  );
}
