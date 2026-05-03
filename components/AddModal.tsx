"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { NhCover } from "./Primitives";
import { PALETTES, type Item } from "../lib/data";

export function AddModal({ open, onClose, recentAdds, embedded, onAdd }: {
  open: boolean; onClose: () => void; recentAdds: Item[]; embedded?: boolean;
  onAdd?: (items: Item[]) => void;
}) {
  const [input, setInput] = useState("");
  const [scraping, setScraping] = useState(false);
  const [previews, setPreviews] = useState<Item[]>([]);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const prevOpenRef = useRef(open);
  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;
    if (wasOpen && !open) { setInput(""); setScraping(false); setPreviews([]); setAdding(false); setError(null); }
  }, [open]);

  const onConfirmAdd = async () => {
    if (previews.length === 0) return;
    setAdding(true);
    try {
      await Promise.all(
        previews.map(p =>
          fetch("/api/scrape", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ input: String(p.hashtag) }),
          })
        )
      );
      onAdd?.(previews);
      onClose();
    } catch (e) {
      console.error("add error:", e);
      setAdding(false);
    }
  };

  if (!open) return null;

  const inputs = input.split(/[, \n]+/).map(s => s.trim()).filter(Boolean);

  const onScrape = async () => {
    if (inputs.length === 0) return;
    setScraping(true);
    setPreviews([]);
    setError(null);
    try {
      const results = await Promise.all(
        inputs.map(async (raw) => {
          const res = await fetch("/api/scrape", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ input: raw, persist: false }),
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({ error: res.statusText }));
            throw new Error(err.error ?? res.statusText);
          }
          const { scraped } = await res.json() as {
            scraped: {
              hashtag: number; title_name: string; alter_name: string | null;
              image_link: string; pages: number; uploaded_at: string;
              tags: { name: string }[]; artists: { name: string }[];
              groups: { name: string }[]; characters: { name: string }[];
              parodies: { name: string }[];
            };
          };
          const seed = scraped.hashtag;
          const palette = PALETTES[seed % PALETTES.length];
          const uploadedAt = Math.floor((Date.now() - new Date(scraped.uploaded_at).getTime()) / 86400000);
          return {
            hashtag: scraped.hashtag,
            titleName: scraped.title_name,
            alterName: scraped.alter_name ?? "",
            imageLink: scraped.image_link,
            pages: scraped.pages,
            tags: scraped.tags.map(t => t.name),
            artists: scraped.artists.map(a => a.name),
            groups: scraped.groups.map(g => g.name),
            characters: scraped.characters.map(c => c.name),
            parodies: scraped.parodies.map(p => p.name),
            uploadedAt, addedAt: 0, readCount: 0, lastReadAt: null,
            palette, seed,
          } satisfies Item;
        })
      );
      setPreviews(results);
    } catch (e) {
      setError(e instanceof Error ? e.message : "scrape failed");
    } finally {
      setScraping(false);
    }
  };

  return (
    <div
      onClick={embedded ? undefined : onClose}
      className={embedded ? "relative w-full h-full" : "fixed inset-0 z-[120] flex flex-col justify-end"}
      style={{
        background: embedded ? "transparent" : "rgba(0,0,0,0.6)",
        animation: embedded ? "none" : "nhFadeIn 200ms ease",
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="flex flex-col bg-nh-surface relative"
        style={{
          borderTopLeftRadius: embedded ? 14 : 18,
          borderTopRightRadius: embedded ? 14 : 18,
          borderBottomLeftRadius: embedded ? 14 : 0,
          borderBottomRightRadius: embedded ? 14 : 0,
          height: embedded ? "100%" : "calc(100% - 30px)",
          animation: embedded ? "none" : "nhSlideUp 320ms cubic-bezier(0.2, 0.8, 0.2, 1)",
          borderTop: embedded ? "none" : "1px solid var(--nh-border)",
        }}
      >
        {!embedded && (
          <div className="flex justify-center pt-2 pb-1">
            <div className="w-9 h-1 rounded-sm bg-nh-border-strong" />
          </div>
        )}
        <div className="flex items-center px-4 pt-1.5 pb-3 border-b border-nh-border">
          <div
            className="font-display font-bold text-[17px] text-nh-text-1 flex-1"
            style={{ letterSpacing: "-0.02em" }}
          >
            add to collection
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="size-7 rounded-md bg-nh-pill text-nh-text-2 hover:bg-nh-pill/80"
          >
            <X className="size-3.5" />
          </Button>
        </div>

        <div className="flex-1 overflow-auto min-h-0 p-4">
          <div className="font-mono text-[9.5px] uppercase tracking-widest text-nh-text-3 mb-1.5">
            nhentai url or hashtag · supports comma-separated
          </div>
          <Textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder={"177013\nnhentai.net/g/895243\n820175, 831895, 563281"}
            className="min-h-20 w-full rounded-lg bg-nh-input border-nh-border px-3 py-2.5 font-mono text-xs tracking-wide text-nh-text-1 resize-y"
          />
          {error && (
            <Alert
              variant="destructive"
              className="mt-2.5 rounded-md py-2 px-2.5 font-mono text-[11px]"
              style={{ background: "rgba(255,60,60,0.08)", borderColor: "rgba(255,60,60,0.25)", color: "#ff6b6b" }}
            >
              <AlertDescription className="text-[#ff6b6b]">{error}</AlertDescription>
            </Alert>
          )}
          <div className="flex items-center gap-2 mt-2.5">
            <div className="flex-1 font-mono text-[10px] tracking-wide text-nh-text-3">
              {inputs.length} {inputs.length === 1 ? "entry" : "entries"} detected
            </div>
            <Button
              onClick={onScrape}
              disabled={inputs.length === 0 || scraping}
              className="h-9 px-3.5 rounded-lg font-display font-bold text-xs gap-1.5 disabled:opacity-100"
              style={{
                background: inputs.length === 0 ? "var(--nh-pill-bg)" : "var(--nh-accent)",
                color: inputs.length === 0 ? "var(--nh-text-3)" : "#0a0a0a",
                letterSpacing: "-0.01em",
              }}
            >
              {scraping ? (
                <><span className="nh-dot-pulse"/> scraping…</>
              ) : (
                <>
                  <ArrowRight className="size-3.5" strokeWidth={2.2} />
                  scrape
                </>
              )}
            </Button>
          </div>

          {previews.length > 0 && (
            <div className="mt-4">
              <div className="flex justify-between font-mono text-[9.5px] uppercase tracking-widest text-nh-text-3 mb-2">
                <span>scraped · review before adding</span>
                <span className="text-nh-accent">{previews.length} ready</span>
              </div>
              <div className="flex flex-col gap-2">
                {previews.map(p => <PreviewRow key={p.hashtag} item={p} />)}
              </div>
              <Button
                onClick={onConfirmAdd}
                disabled={adding}
                className="mt-3 w-full h-[42px] rounded-lg bg-nh-accent text-[#0a0a0a] font-display font-extrabold text-[13px] gap-1.5 disabled:opacity-70 hover:bg-nh-accent/90"
                style={{ letterSpacing: "-0.01em" }}
              >
                {adding ? <><span className="nh-dot-pulse"/> saving…</> : `add ${previews.length} title${previews.length > 1 ? "s" : ""} to collection`}
              </Button>
            </div>
          )}

          {previews.length === 0 && !scraping && (
            <div className="mt-6">
              <div className="font-mono text-[9.5px] uppercase tracking-widest text-nh-text-3 mb-2">recently added</div>
              <div className="flex flex-col">
                {recentAdds.map(r => (
                  <div key={r.hashtag} className="flex items-center gap-2.5 py-2 border-b border-nh-border">
                    <div className="w-8 h-11 shrink-0 rounded-sm overflow-hidden">
                      <NhCover item={r} size="sm"/>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-display font-semibold text-xs text-nh-text-1 truncate">{r.titleName}</div>
                      <div className="font-mono text-[10px] text-nh-text-3">
                        #{r.hashtag} · {r.pages}p · {r.addedAt === 0 ? "today" : `${r.addedAt}d ago`}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PreviewRow({ item }: { item: Item }) {
  return (
    <div className="flex gap-2.5 p-2 rounded-lg bg-nh-surface-2 border border-nh-border">
      <div className="w-14 shrink-0">
        <NhCover item={item} size="sm"/>
      </div>
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <div className="font-mono text-[9.5px] tracking-wider text-nh-accent">#{item.hashtag}</div>
        <div
          className="font-display font-bold text-[13px] text-nh-text-1 truncate"
          style={{ letterSpacing: "-0.01em" }}
        >
          {item.titleName}
        </div>
        <div className="font-mono text-[10px] text-nh-text-3">
          {item.artists[0]} · {item.pages}p · {item.tags.length} tags
        </div>
        <div className="flex gap-[3px] flex-wrap mt-0.5">
          {item.tags.slice(0, 4).map(t => (
            <Badge
              key={t}
              variant="secondary"
              className="h-auto rounded-sm border-0 bg-nh-pill px-1.5 py-0.5 font-mono text-[9px] text-nh-text-3"
            >
              {t}
            </Badge>
          ))}
        </div>
      </div>
      <div className="flex items-center px-1 text-nh-accent">
        <Check className="size-4" strokeWidth={2.4} />
      </div>
    </div>
  );
}
