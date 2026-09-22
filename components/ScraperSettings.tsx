"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { saveScraperEndpointsAction } from "@/app/account/actions";
import type { ScraperEndpointView } from "@/lib/scraper-endpoints";

/**
 * A row being edited.
 *
 * `secret` is three-valued in the same way the server side is: a string sets a
 * new token, `""` clears it, and `null` means "leave the stored one alone".
 * That is what lets the screen show a host HAS a secret without the secret ever
 * being sent to the browser — `hasSecret` is all it receives.
 */
type Row = {
  key: number;
  label: string;
  url: string;
  secret: string | null;
  hasSecret: boolean;
};

let nextKey = 0;
const blankRow = (): Row => ({ key: nextKey++, label: "", url: "", secret: "", hasSecret: false });

function toRows(endpoints: ScraperEndpointView[]): Row[] {
  return endpoints.map((e) => ({ key: nextKey++, label: e.label, url: e.url, secret: null, hasSecret: e.hasSecret }));
}

export function ScraperSettings({
  initialEndpoints, limit, secretStorageReady,
}: {
  initialEndpoints: ScraperEndpointView[];
  limit: number;
  secretStorageReady: boolean;
}) {
  const [rows, setRows] = useState<Row[]>(() =>
    initialEndpoints.length ? toRows(initialEndpoints) : [blankRow()]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const patch = (key: number, change: Partial<Row>) => {
    setSaved(false);
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...change } : r)));
  };

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= rows.length) return;
    setSaved(false);
    setRows((prev) => {
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  async function save() {
    if (pending) return;
    setPending(true);
    setError("");
    setSaved(false);
    try {
      // Blank rows are dropped rather than rejected — the form always keeps a
      // spare empty row, and making the user delete it before saving would be
      // busywork.
      const payload = rows
        .filter((r) => r.url.trim())
        .map((r) => ({ label: r.label.trim() || undefined, url: r.url.trim(), secret: r.secret }));
      const result = await saveScraperEndpointsAction(payload);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setRows(result.endpoints.length ? toRows(result.endpoints) : [blankRow()]);
      setSaved(true);
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="font-display text-base font-bold">Scraper hosts</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The collection is shared infrastructure; the scraper is yours. Run{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">pnpm scraper</code> and register it
          here. The first host is tried first — put the fast one on top — and the rest are used only when it is
          unreachable.
        </p>
      </div>

      {!secretStorageReady && (
        <Alert variant="destructive">
          <AlertDescription>
            Secret storage is not configured on this deployment (<code>SCRAPER_CRED_KEY</code> is missing), so a
            host that needs a bearer token cannot be saved. Hosts without a secret still work.
          </AlertDescription>
        </Alert>
      )}

      <ol className="flex flex-col gap-4">
        {rows.map((row, index) => (
          <li key={row.key} className="rounded-lg border border-border p-3">
            <div className="mb-2 flex items-center gap-2">
              <Badge variant={index === 0 ? "default" : "secondary"} className="font-mono text-[10px]">
                {index === 0 ? "primary" : `fallback ${index}`}
              </Badge>
              <span className="flex-1" />
              <Button
                type="button" variant="ghost" size="icon"
                aria-label={`Move host ${index + 1} up`}
                disabled={index === 0} onClick={() => move(index, -1)}
              >
                <ArrowUp className="size-4" />
              </Button>
              <Button
                type="button" variant="ghost" size="icon"
                aria-label={`Move host ${index + 1} down`}
                disabled={index === rows.length - 1} onClick={() => move(index, 1)}
              >
                <ArrowDown className="size-4" />
              </Button>
              <Button
                type="button" variant="ghost" size="icon"
                aria-label={`Remove host ${index + 1}`}
                onClick={() => {
                  setSaved(false);
                  setRows((prev) => (prev.length === 1 ? [blankRow()] : prev.filter((r) => r.key !== row.key)));
                }}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>

            <div className="flex flex-col gap-3">
              <Field>
                <FieldLabel htmlFor={`url-${row.key}`}>URL</FieldLabel>
                <Input
                  id={`url-${row.key}`}
                  value={row.url}
                  onChange={(e) => patch(row.key, { url: e.target.value })}
                  placeholder="https://scraper.example.com"
                  autoComplete="off" spellCheck={false} inputMode="url"
                />
              </Field>

              <Field>
                <FieldLabel htmlFor={`label-${row.key}`}>Name · optional</FieldLabel>
                <Input
                  id={`label-${row.key}`}
                  value={row.label}
                  onChange={(e) => patch(row.key, { label: e.target.value })}
                  placeholder="mac mini"
                  autoComplete="off"
                />
              </Field>

              <Field>
                <FieldLabel htmlFor={`secret-${row.key}`}>
                  SCRAPER_SECRET {row.hasSecret && row.secret === null && "· saved"}
                </FieldLabel>
                {row.hasSecret && row.secret === null ? (
                  <div className="flex items-center gap-2">
                    <Input id={`secret-${row.key}`} value="••••••••••••" readOnly disabled />
                    <Button type="button" variant="outline" size="sm" onClick={() => patch(row.key, { secret: "" })}>
                      Replace
                    </Button>
                  </div>
                ) : (
                  <Input
                    id={`secret-${row.key}`}
                    type="password"
                    value={row.secret ?? ""}
                    onChange={(e) => patch(row.key, { secret: e.target.value })}
                    placeholder={row.hasSecret ? "leave empty to remove the secret" : "same value as on your scraper"}
                    autoComplete="new-password" spellCheck={false}
                  />
                )}
                <FieldDescription>
                  Must match <code>SCRAPER_SECRET</code> on that machine. Stored encrypted; it is never sent back
                  to the browser. Leave empty only for a local scraper started without one.
                </FieldDescription>
              </Field>
            </div>
          </li>
        ))}
      </ol>

      {error && (
        <Alert variant="destructive">
          <AlertDescription role="alert">{error}</AlertDescription>
        </Alert>
      )}
      {saved && <p role="status" className="text-sm text-muted-foreground">Saved.</p>}

      <div className="flex items-center gap-2">
        <Button
          type="button" variant="outline"
          disabled={rows.length >= limit}
          onClick={() => { setSaved(false); setRows((prev) => [...prev, blankRow()]); }}
        >
          <Plus className="size-4" /> Add fallback
        </Button>
        <span className="flex-1" />
        <Button type="button" onClick={save} disabled={pending}>
          {pending ? "Saving…" : "Save hosts"}
        </Button>
      </div>
    </div>
  );
}
