"use client";

import { useEffect, useRef, useState } from "react";
import { NhCover, NhIcon } from "./Primitives";
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
    <div onClick={embedded ? undefined : onClose} style={{
      position: embedded ? "relative" : "fixed",
      inset: embedded ? "auto" : 0,
      zIndex: embedded ? "auto" as never : 120,
      background: embedded ? "transparent" : "rgba(0,0,0,0.6)",
      display: "flex", flexDirection: "column", justifyContent: "flex-end",
      animation: embedded ? "none" : "nhFadeIn 200ms ease",
      width: embedded ? "100%" : undefined,
      height: embedded ? "100%" : undefined,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: "var(--nh-surface)",
        borderTopLeftRadius: embedded ? 14 : 18, borderTopRightRadius: embedded ? 14 : 18,
        borderBottomLeftRadius: embedded ? 14 : 0, borderBottomRightRadius: embedded ? 14 : 0,
        height: embedded ? "100%" : "calc(100% - 30px)",
        display: "flex", flexDirection: "column",
        animation: embedded ? "none" : "nhSlideUp 320ms cubic-bezier(0.2, 0.8, 0.2, 1)",
        borderTop: embedded ? "none" : "1px solid var(--nh-border)",
        position: "relative",
      }}>
        {!embedded && (
          <div style={{ display: "flex", justifyContent: "center", padding: "8px 0 4px" }}>
            <div style={{ width: 36, height: 4, borderRadius: 2, background: "var(--nh-border-strong)" }} />
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", padding: "6px 16px 12px", borderBottom: "1px solid var(--nh-border)" }}>
          <div style={{ fontFamily: "var(--nh-font-display)", fontSize: 17, fontWeight: 700, color: "var(--nh-text-1)", letterSpacing: "-0.02em", flex: 1 }}>add to collection</div>
          <button onClick={onClose} style={{
            appearance: "none", border: 0, cursor: "pointer",
            width: 28, height: 28, borderRadius: 7,
            background: "var(--nh-pill-bg)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <NhIcon name="close" size={14} color="var(--nh-text-2)"/>
          </button>
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: "16px" }}>
          <div style={{ fontFamily: "var(--nh-font-mono)", fontSize: 9.5, color: "var(--nh-text-3)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>nhentai url or hashtag · supports comma-separated</div>
          <textarea value={input} onChange={e => setInput(e.target.value)}
            placeholder={"177013\nnhentai.net/g/895243\n820175, 831895, 563281"}
            style={{
              width: "100%", minHeight: 80, resize: "vertical",
              background: "var(--nh-input-bg)",
              border: "1px solid var(--nh-border)",
              borderRadius: 8, padding: "10px 12px",
              color: "var(--nh-text-1)",
              fontFamily: "var(--nh-font-mono)", fontSize: 12,
              outline: "none", letterSpacing: "0.01em",
              boxSizing: "border-box",
            }}
          />
          {error && (
            <div style={{
              marginTop: 10, padding: "8px 10px", borderRadius: 7,
              background: "rgba(255,60,60,0.08)", border: "1px solid rgba(255,60,60,0.25)",
              fontFamily: "var(--nh-font-mono)", fontSize: 11, color: "#ff6b6b",
              display: "flex", alignItems: "flex-start", gap: 6,
            }}>
              <span style={{ flexShrink: 0 }}>✕</span>
              <span>{error}</span>
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
            <div style={{ fontFamily: "var(--nh-font-mono)", fontSize: 10, color: "var(--nh-text-3)", letterSpacing: "0.04em", flex: 1 }}>{inputs.length} {inputs.length === 1 ? "entry" : "entries"} detected</div>
            <button onClick={onScrape} disabled={inputs.length === 0 || scraping} style={{
              height: 36, padding: "0 14px", borderRadius: 8,
              background: inputs.length === 0 ? "var(--nh-pill-bg)" : "var(--nh-accent)",
              color: inputs.length === 0 ? "var(--nh-text-3)" : "#0a0a0a",
              border: 0, cursor: inputs.length === 0 ? "default" : "pointer",
              fontFamily: "var(--nh-font-display)", fontSize: 12, fontWeight: 700,
              letterSpacing: "-0.01em",
              display: "flex", alignItems: "center", gap: 6,
            }}>
              {scraping ? (
                <><span className="nh-dot-pulse"/> scraping…</>
              ) : (
                <><NhIcon name="arrow-right" size={13} color={inputs.length === 0 ? "var(--nh-text-3)" : "#0a0a0a"} stroke={2.2}/> scrape</>
              )}
            </button>
          </div>

          {previews.length > 0 && (
            <div style={{ marginTop: 18 }}>
              <div style={{ fontFamily: "var(--nh-font-mono)", fontSize: 9.5, color: "var(--nh-text-3)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8, display: "flex", justifyContent: "space-between" }}>
                <span>scraped · review before adding</span>
                <span style={{ color: "var(--nh-accent)" }}>{previews.length} ready</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {previews.map(p => <PreviewRow key={p.hashtag} item={p} />)}
              </div>
              <button onClick={onConfirmAdd} disabled={adding} style={{
                marginTop: 12, width: "100%", height: 42, borderRadius: 8,
                background: "var(--nh-accent)", color: "#0a0a0a", border: 0,
                cursor: adding ? "default" : "pointer",
                opacity: adding ? 0.7 : 1,
                fontFamily: "var(--nh-font-display)", fontSize: 13, fontWeight: 800,
                letterSpacing: "-0.01em",
                display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              }}>
                {adding ? <><span className="nh-dot-pulse"/> saving…</> : `add ${previews.length} title${previews.length > 1 ? "s" : ""} to collection`}
              </button>
            </div>
          )}

          {previews.length === 0 && !scraping && (
            <div style={{ marginTop: 24 }}>
              <div style={{ fontFamily: "var(--nh-font-mono)", fontSize: 9.5, color: "var(--nh-text-3)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>recently added</div>
              <div style={{ display: "flex", flexDirection: "column" }}>
                {recentAdds.map(r => (
                  <div key={r.hashtag} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--nh-border)" }}>
                    <div style={{ width: 32, height: 44, flexShrink: 0, borderRadius: 4, overflow: "hidden" }}>
                      <NhCover item={r} size="sm"/>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: "var(--nh-font-display)", fontSize: 12, fontWeight: 600, color: "var(--nh-text-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.titleName}</div>
                      <div style={{ fontFamily: "var(--nh-font-mono)", fontSize: 10, color: "var(--nh-text-3)" }}>#{r.hashtag} · {r.pages}p · {r.addedAt === 0 ? "today" : `${r.addedAt}d ago`}</div>
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
    <div style={{ display: "flex", gap: 10, padding: 8, background: "var(--nh-surface-2)", border: "1px solid var(--nh-border)", borderRadius: 8 }}>
      <div style={{ width: 56, flexShrink: 0 }}>
        <NhCover item={item} size="sm"/>
      </div>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ fontFamily: "var(--nh-font-mono)", fontSize: 9.5, color: "var(--nh-accent)", letterSpacing: "0.06em" }}>#{item.hashtag}</div>
        <div style={{ fontFamily: "var(--nh-font-display)", fontSize: 13, fontWeight: 700, color: "var(--nh-text-1)", letterSpacing: "-0.01em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.titleName}</div>
        <div style={{ fontFamily: "var(--nh-font-mono)", fontSize: 10, color: "var(--nh-text-3)" }}>{item.artists[0]} · {item.pages}p · {item.tags.length} tags</div>
        <div style={{ display: "flex", gap: 3, flexWrap: "wrap", marginTop: 2 }}>
          {item.tags.slice(0, 4).map(t => (
            <span key={t} style={{ padding: "2px 5px", borderRadius: 3, background: "var(--nh-pill-bg)", fontFamily: "var(--nh-font-mono)", fontSize: 9, color: "var(--nh-text-3)" }}>{t}</span>
          ))}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", padding: "0 4px", color: "var(--nh-accent)" }}>
        <NhIcon name="check" size={16} color="var(--nh-accent)" stroke={2.4}/>
      </div>
    </div>
  );
}
