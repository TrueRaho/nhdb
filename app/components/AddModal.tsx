"use client";

import { useEffect, useState } from "react";
import { NhCover, NhIcon } from "./Primitives";
import { mulberry32, PALETTES, TAGS_POOL, ARTIST_POOL, PARODY_POOL, CHARACTER_POOL, type Item } from "../lib/data";

export function AddModal({ open, onClose, recentAdds, embedded }: {
  open: boolean; onClose: () => void; recentAdds: Item[]; embedded?: boolean;
}) {
  const [input, setInput] = useState("");
  const [scraping, setScraping] = useState(false);
  const [previews, setPreviews] = useState<Item[]>([]);

  useEffect(() => {
    if (!open) { setInput(""); setScraping(false); setPreviews([]); }
  }, [open]);

  if (!open) return null;

  const inputs = input.split(/[, \n]+/).map(s => s.trim()).filter(Boolean);

  const onScrape = () => {
    if (inputs.length === 0) return;
    setScraping(true);
    setPreviews([]);
    setTimeout(() => {
      const titleNames = ["Sunday Notebook", "Counter Sketch", "Soft Static", "Late Pages", "Open Studio", "Tape Echo"];
      const previews = inputs.slice(0, 6).map((raw, idx) => {
        const m = raw.match(/(\d{5,7})/);
        const hashtag = m ? +m[1] : 100000 + (raw.charCodeAt(0) * 1000) % 800000;
        const seed = hashtag;
        const rng = mulberry32(seed);
        const palette = PALETTES[idx % PALETTES.length];
        return {
          hashtag,
          titleName: titleNames[idx % titleNames.length],
          alterName: `vol. ${1 + idx % 3}`,
          pages: 18 + Math.floor(rng() * 80),
          tags: [...TAGS_POOL].sort(() => rng() - 0.5).slice(0, 5),
          artists: [ARTIST_POOL[idx % ARTIST_POOL.length]],
          parodies: [PARODY_POOL[idx % PARODY_POOL.length]],
          characters: [CHARACTER_POOL[idx % CHARACTER_POOL.length]],
          groups: [] as string[],
          uploadedAt: 200, addedAt: 0, readCount: 0, lastReadAt: null,
          imageLink: "", palette, seed,
        } satisfies Item;
      });
      setPreviews(previews);
      setScraping(false);
    }, 1100);
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
              <button style={{
                marginTop: 12, width: "100%", height: 42, borderRadius: 8,
                background: "var(--nh-accent)", color: "#0a0a0a", border: 0, cursor: "pointer",
                fontFamily: "var(--nh-font-display)", fontSize: 13, fontWeight: 800,
                letterSpacing: "-0.01em",
              }}>add {previews.length} title{previews.length > 1 ? "s" : ""} to collection</button>
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
