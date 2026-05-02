"use client";

import { useState } from "react";
import { NhCover } from "./Primitives";
import type { Item, ReadLog } from "../lib/data";
import type { Dataset } from "./HeaderFilter";

export function StatsView({ collection, dataset, onTagClick, readLogs }: {
  collection: Item[]; dataset: Dataset; onTagClick: (t: string) => void; readLogs: ReadLog[];
}) {
  const [tagsDir, setTagsDir] = useState<"desc" | "asc">("desc");
  const [tagsShowAll, setTagsShowAll] = useState(false);
  const [artistsDir, setArtistsDir] = useState<"desc" | "asc">("desc");
  const [artistsShowAll, setArtistsShowAll] = useState(false);
  const [groupsDir, setGroupsDir] = useState<"desc" | "asc">("desc");
  const [groupsShowAll, setGroupsShowAll] = useState(false);

  const total = collection.length;
  const totalPages = collection.reduce((s, c) => s + c.pages, 0);
  const totalReads = collection.reduce((s, c) => s + c.readCount, 0);
  const readPages = collection.reduce((s, c) => s + (c.readCount > 0 ? c.pages * c.readCount : 0), 0);
  const unread = collection.filter(c => c.readCount === 0).length;
  const avgPages = total ? Math.round(totalPages / total) : 0;
  const longestStreak = total ? Math.max(...collection.map(c => c.pages)) : 0;
  const mostRead = [...collection].sort((a, b) => b.readCount - a.readCount).slice(0, 5);

  const topN = (counts: Record<string, number>, n: number) => Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n);
  const topParodies = topN(dataset.parodyCounts, 6);

  const allTagEntries = Object.entries(dataset.tagCounts).sort((a, b) => tagsDir === "desc" ? b[1] - a[1] : a[1] - b[1]);
  const topTags = tagsShowAll ? allTagEntries : allTagEntries.slice(0, 12);
  const topMaxTag = Math.max(...Object.values(dataset.tagCounts), 1);

  const allArtistEntries = Object.entries(dataset.artistCounts).sort((a, b) => artistsDir === "desc" ? b[1] - a[1] : a[1] - b[1]);
  const topArtists = artistsShowAll ? allArtistEntries : allArtistEntries.slice(0, 10);
  const topMaxArtist = Math.max(...Object.values(dataset.artistCounts), 1);

  const allGroupEntries = Object.entries(dataset.groupCounts).sort((a, b) => groupsDir === "desc" ? b[1] - a[1] : a[1] - b[1]);
  const topGroups = groupsShowAll ? allGroupEntries : allGroupEntries.slice(0, 10);
  const topMaxGroup = Math.max(...Object.values(dataset.groupCounts), 1);

  const buckets = [
    { label: "<25", min: 0, max: 24 },
    { label: "25–49", min: 25, max: 49 },
    { label: "50–99", min: 50, max: 99 },
    { label: "100–149", min: 100, max: 149 },
    { label: "150+", min: 150, max: 9e9 },
  ].map(b => ({ ...b, count: collection.filter(c => c.pages >= b.min && c.pages <= b.max).length }));
  const bucketMax = Math.max(...buckets.map(b => b.count), 1);

  const now = Date.now();
  const months = Array.from({ length: 12 }, (_, i) => {
    const msStart = now - (12 - i) * 30 * 86400000;
    const msEnd = now - (11 - i) * 30 * 86400000;
    const count = readLogs.filter(l => {
      const t = new Date(l.readAt).getTime();
      return t >= msStart && t < msEnd;
    }).length;
    return { idx: i, count };
  });
  const monthMax = Math.max(...months.map(m => m.count), 1);

  const hourBins = Array.from({ length: 24 }, (_, h) => ({
    h,
    count: readLogs.filter(l => new Date(l.readAt).getHours() === h).length,
  }));
  const hourMax = Math.max(...hourBins.map(b => b.count), 1);

  const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const dowBins = Array.from({ length: 7 }, (_, d) => ({
    label: DOW_LABELS[d],
    count: readLogs.filter(l => {
      const day = new Date(l.readAt).getDay();
      return (day === 0 ? 6 : day - 1) === d;
    }).length,
  }));
  const dowMax = Math.max(...dowBins.map(b => b.count), 1);

  const titleMap = new Map(collection.map(c => [c.hashtag, c.alterName || c.titleName]));
  const recentSessions = readLogs.slice(0, 20);

  const adds = Array.from({ length: 6 }, (_, i) => {
    const start = (5 - i) * 60;
    const count = collection.filter(c => c.addedAt >= start && c.addedAt < start + 60).length;
    return { count, label: `${start + 60}d` };
  });
  const addMax = Math.max(...adds.map(a => a.count), 1);

  return (
    <div style={{ paddingBottom: 60 }}>
      <div style={{ padding: "6px 12px 14px" }}>
        <div style={{ fontFamily: "var(--nh-font-display)", fontSize: 22, fontWeight: 800, color: "var(--nh-text-1)", letterSpacing: "-0.02em", marginBottom: 2 }}>library analysis</div>
        <div style={{ fontFamily: "var(--nh-font-mono)", fontSize: 10, color: "var(--nh-text-3)", letterSpacing: "0.04em" }}>since you started this collection</div>
      </div>

      <div style={{
        display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1,
        margin: "0 12px",
        background: "var(--nh-border)",
        border: "1px solid var(--nh-border)",
        borderRadius: 10, overflow: "hidden",
      }}>
        <BigStat label="titles" value={total} sub="total" />
        <BigStat label="pages" value={totalPages.toLocaleString()} sub="archived" />
        <BigStat label="reads" value={totalReads} sub={`${readPages.toLocaleString()} pages traversed`} accent />
        <BigStat label="unread" value={unread} sub={`${total ? Math.round(unread / total * 100) : 0}% of library`} />
      </div>

      <Section title="reading activity · last 12 months">
        <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 64, padding: "4px 0 8px" }}>
          {months.map(m => (
            <div key={m.idx} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
              <div style={{
                width: "100%",
                height: `${(m.count / monthMax) * 56 + 2}px`,
                background: m.count > 0 ? "var(--nh-accent)" : "var(--nh-border-strong)",
                borderRadius: 2,
                opacity: m.count > 0 ? 1 : 0.4,
              }} />
              {m.idx % 3 === 0 && (
                <div style={{ fontFamily: "var(--nh-font-mono)", fontSize: 8, color: "var(--nh-text-3)", letterSpacing: "0.04em" }}>{11 - m.idx}m</div>
              )}
            </div>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "var(--nh-font-mono)", fontSize: 10, color: "var(--nh-text-3)", marginTop: 2 }}>
          <span>peak: {monthMax} sessions</span>
          <span>{readLogs.length} total sessions</span>
        </div>
      </Section>

      <Section title="by time of day">
        <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 56, padding: "4px 0 0" }}>
          {hourBins.map(b => (
            <div key={b.h} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
              <div style={{
                width: "100%",
                height: `${(b.count / hourMax) * 44 + 2}px`,
                background: b.count > 0 ? "var(--nh-accent)" : "var(--nh-border-strong)",
                borderRadius: 2,
                opacity: b.count > 0 ? 0.5 + (b.count / hourMax) * 0.5 : 0.25,
              }} />
              {b.h % 6 === 0 && (
                <div style={{ fontFamily: "var(--nh-font-mono)", fontSize: 7.5, color: "var(--nh-text-3)", letterSpacing: "0.02em" }}>{b.h}h</div>
              )}
            </div>
          ))}
        </div>
        {readLogs.length === 0 && (
          <div style={{ fontFamily: "var(--nh-font-mono)", fontSize: 11, color: "var(--nh-text-3)", paddingTop: 6 }}>no sessions yet</div>
        )}
      </Section>

      <Section title="by day of week">
        <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 60 }}>
          {dowBins.map(b => (
            <div key={b.label} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
              <div style={{
                width: "100%",
                height: `${(b.count / dowMax) * 40 + 2}px`,
                background: b.count > 0 ? "var(--nh-accent)" : "var(--nh-border-strong)",
                borderRadius: 2,
                opacity: b.count > 0 ? 0.5 + (b.count / dowMax) * 0.5 : 0.25,
              }} />
              <div style={{ fontFamily: "var(--nh-font-mono)", fontSize: 8.5, color: "var(--nh-text-3)", letterSpacing: "0.02em" }}>{b.label}</div>
            </div>
          ))}
        </div>
        {readLogs.length === 0 && (
          <div style={{ fontFamily: "var(--nh-font-mono)", fontSize: 11, color: "var(--nh-text-3)" }}>no sessions yet</div>
        )}
      </Section>

      {recentSessions.length > 0 && (
        <Section title={`recent sessions · last ${recentSessions.length}`}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {recentSessions.map((s, i) => {
              const d = new Date(s.readAt);
              const dateStr = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
              const timeStr = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
              const name = titleMap.get(s.hashtag);
              return (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderBottom: i < recentSessions.length - 1 ? "1px solid var(--nh-border)" : "none" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {name && (
                      <div style={{ fontFamily: "var(--nh-font-display)", fontSize: 12, fontWeight: 600, color: "var(--nh-text-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
                    )}
                    <div style={{ fontFamily: "var(--nh-font-mono)", fontSize: 9.5, color: "var(--nh-text-3)" }}>#{s.hashtag}</div>
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <div style={{ fontFamily: "var(--nh-font-mono)", fontSize: 10, color: "var(--nh-text-2)" }}>{timeStr}</div>
                    <div style={{ fontFamily: "var(--nh-font-mono)", fontSize: 9.5, color: "var(--nh-text-3)" }}>{dateStr}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </Section>
      )}

      <Section title="page count distribution">
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          {buckets.map(b => (
            <div key={b.label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 56, flexShrink: 0, fontFamily: "var(--nh-font-mono)", fontSize: 10, color: "var(--nh-text-3)", textAlign: "right" }}>{b.label}p</div>
              <div style={{ flex: 1, height: 14, position: "relative", background: "var(--nh-pill-bg)", borderRadius: 3 }}>
                <div style={{
                  position: "absolute", left: 0, top: 0, bottom: 0,
                  width: `${(b.count / bucketMax) * 100}%`,
                  background: "var(--nh-accent)", borderRadius: 3,
                  display: "flex", alignItems: "center", justifyContent: "flex-end",
                  paddingRight: 4,
                }}>
                  {b.count > 0 && (b.count / bucketMax) > 0.2 && (
                    <span style={{ fontFamily: "var(--nh-font-mono)", fontSize: 9, fontWeight: 700, color: "#0a0a0a" }}>{b.count}</span>
                  )}
                </div>
                {(b.count / bucketMax) <= 0.2 && b.count > 0 && (
                  <span style={{
                    position: "absolute", left: `${(b.count / bucketMax) * 100}%`, top: 0, bottom: 0,
                    paddingLeft: 5, display: "flex", alignItems: "center",
                    fontFamily: "var(--nh-font-mono)", fontSize: 9, fontWeight: 600,
                    color: "var(--nh-text-2)",
                  }}>{b.count}</span>
                )}
              </div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--nh-border)", display: "flex", justifyContent: "space-between", fontFamily: "var(--nh-font-mono)", fontSize: 10, color: "var(--nh-text-3)" }}>
          <span>avg <span style={{ color: "var(--nh-text-1)" }}>{avgPages}p</span></span>
          <span>median ~ <span style={{ color: "var(--nh-text-1)" }}>{[...collection].sort((a, b) => a.pages - b.pages)[Math.floor(total / 2)]?.pages || 0}p</span></span>
          <span>longest <span style={{ color: "var(--nh-accent)" }}>{longestStreak}p</span></span>
        </div>
      </Section>

      <Section
        title={`tags · ${dataset.allTags.length} unique`}
        action={
          <div style={{ display: "flex", gap: 4 }}>
            <SortToggle dir={tagsDir} onToggle={() => setTagsDir(d => d === "desc" ? "asc" : "desc")} />
            <ShowToggle showAll={tagsShowAll} total={dataset.allTags.length} limit={12} onToggle={() => setTagsShowAll(v => !v)} />
          </div>
        }
      >
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {topTags.map(([t, n]) => {
            const pct = n / topMaxTag;
            return (
              <button key={t} onClick={() => onTagClick(t)} style={{
                appearance: "none", border: 0, cursor: "pointer",
                padding: "5px 8px", borderRadius: 4,
                background: `linear-gradient(90deg, var(--nh-accent-soft) ${pct * 100}%, var(--nh-pill-bg) ${pct * 100}%)`,
                display: "inline-flex", alignItems: "center", gap: 6,
              }}>
                <span style={{ fontFamily: "var(--nh-font-mono)", fontSize: 11, color: "var(--nh-text-1)" }}>{t}</span>
                <span style={{ fontFamily: "var(--nh-font-mono)", fontSize: 10, fontWeight: 600, color: "var(--nh-accent)" }}>{n}</span>
              </button>
            );
          })}
        </div>
      </Section>

      <Section
        title={`artists · ${dataset.allArtists.length} unique`}
        action={
          <div style={{ display: "flex", gap: 4 }}>
            <SortToggle dir={artistsDir} onToggle={() => setArtistsDir(d => d === "desc" ? "asc" : "desc")} />
            <ShowToggle showAll={artistsShowAll} total={dataset.allArtists.length} limit={10} onToggle={() => setArtistsShowAll(v => !v)} />
          </div>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          {topArtists.map(([a, n], i) => (
            <div key={a} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 18, flexShrink: 0, fontFamily: "var(--nh-font-mono)", fontSize: 9, fontWeight: 700, color: "var(--nh-text-3)" }}>{String(i + 1).padStart(2, "0")}</div>
              <div style={{ flex: 1, minWidth: 0, fontFamily: "var(--nh-font-mono)", fontSize: 11, color: "var(--nh-text-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a}</div>
              <div style={{ width: 80, height: 4, borderRadius: 2, background: "var(--nh-pill-bg)", position: "relative" }}>
                <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${(n / topMaxArtist) * 100}%`, background: "var(--nh-accent)", borderRadius: 2 }} />
              </div>
              <div style={{ width: 26, flexShrink: 0, textAlign: "right", fontFamily: "var(--nh-font-mono)", fontSize: 11, fontWeight: 600, color: "var(--nh-accent)" }}>{n}</div>
            </div>
          ))}
        </div>
      </Section>

      {allGroupEntries.length > 0 && (
        <Section
          title={`groups · ${dataset.allGroups.length} unique`}
          action={
            <div style={{ display: "flex", gap: 4 }}>
              <SortToggle dir={groupsDir} onToggle={() => setGroupsDir(d => d === "desc" ? "asc" : "desc")} />
              <ShowToggle showAll={groupsShowAll} total={dataset.allGroups.length} limit={10} onToggle={() => setGroupsShowAll(v => !v)} />
            </div>
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {topGroups.map(([g, n], i) => (
              <div key={g} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ width: 18, flexShrink: 0, fontFamily: "var(--nh-font-mono)", fontSize: 9, fontWeight: 700, color: "var(--nh-text-3)" }}>{String(i + 1).padStart(2, "0")}</div>
                <div style={{ flex: 1, minWidth: 0, fontFamily: "var(--nh-font-mono)", fontSize: 11, color: "var(--nh-text-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g}</div>
                <div style={{ width: 80, height: 4, borderRadius: 2, background: "var(--nh-pill-bg)", position: "relative" }}>
                  <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${(n / topMaxGroup) * 100}%`, background: "var(--nh-accent)", borderRadius: 2 }} />
                </div>
                <div style={{ width: 26, flexShrink: 0, textAlign: "right", fontFamily: "var(--nh-font-mono)", fontSize: 11, fontWeight: 600, color: "var(--nh-accent)" }}>{n}</div>
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section title="top parodies">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {topParodies.map(([p, n]) => (
            <div key={p} style={{ display: "flex", alignItems: "baseline", gap: 5, padding: "5px 8px", borderRadius: 4, background: "var(--nh-pill-bg)" }}>
              <span style={{ fontFamily: "var(--nh-font-display)", fontSize: 11, fontWeight: 600, color: "var(--nh-text-1)" }}>{p}</span>
              <span style={{ fontFamily: "var(--nh-font-mono)", fontSize: 10, color: "var(--nh-text-3)" }}>{n}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="most-read titles">
        <div style={{ display: "flex", flexDirection: "column" }}>
          {mostRead.filter(m => m.readCount > 0).map((m, i) => (
            <div key={m.hashtag} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: i < mostRead.length - 1 ? "1px solid var(--nh-border)" : "none" }}>
              <div style={{ width: 30, height: 42, flexShrink: 0, borderRadius: 4, overflow: "hidden" }}>
                <NhCover item={m} size="sm" />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: "var(--nh-font-display)", fontSize: 12, fontWeight: 600, color: "var(--nh-text-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.titleName}</div>
                <div style={{ fontFamily: "var(--nh-font-mono)", fontSize: 10, color: "var(--nh-text-3)" }}>{m.artists[0]} · {m.pages}p</div>
              </div>
              <div style={{ fontFamily: "var(--nh-font-display)", fontSize: 18, fontWeight: 800, color: "var(--nh-accent)", letterSpacing: "-0.02em" }}>{m.readCount}<span style={{ fontSize: 10, color: "var(--nh-text-3)", fontWeight: 500 }}>×</span></div>
            </div>
          ))}
          {mostRead.filter(m => m.readCount > 0).length === 0 && (
            <div style={{ fontFamily: "var(--nh-font-mono)", fontSize: 11, color: "var(--nh-text-3)", padding: "8px 0" }}>nothing read yet</div>
          )}
        </div>
      </Section>

      <Section title="additions · last 360 days">
        <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 50 }}>
          {adds.map((a, i) => (
            <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
              <div style={{ width: "100%", height: `${(a.count / addMax) * 38 + 2}px`, background: "var(--nh-accent)", opacity: 0.4 + (a.count / addMax) * 0.6, borderRadius: 2 }} />
              <div style={{ fontFamily: "var(--nh-font-mono)", fontSize: 8, color: "var(--nh-text-3)" }}>{a.label}</div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="counts">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <Mini label="characters" value={dataset.allCharacters.length} />
          <Mini label="parodies" value={dataset.allParodies.length} />
          <Mini label="artists" value={dataset.allArtists.length} />
          <Mini label="groups" value={dataset.allGroups.length} />
          <Mini label="tags" value={dataset.allTags.length} />
        </div>
      </Section>
    </div>
  );
}

function BigStat({ label, value, sub, accent }: { label: string; value: React.ReactNode; sub: string; accent?: boolean }) {
  return (
    <div style={{ background: "var(--nh-surface-2)", padding: "14px 12px", display: "flex", flexDirection: "column", gap: 2 }}>
      <div style={{ fontFamily: "var(--nh-font-mono)", fontSize: 9.5, color: "var(--nh-text-3)", letterSpacing: "0.08em", textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontFamily: "var(--nh-font-display)", fontSize: 28, fontWeight: 800, color: accent ? "var(--nh-accent)" : "var(--nh-text-1)", letterSpacing: "-0.03em", lineHeight: 1, marginTop: 2 }}>{value}</div>
      <div style={{ fontFamily: "var(--nh-font-mono)", fontSize: 9.5, color: "var(--nh-text-3)", marginTop: 2 }}>{sub}</div>
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ padding: "14px 12px 0" }}>
      <div style={{ fontFamily: "var(--nh-font-mono)", fontSize: 9.5, color: "var(--nh-text-3)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ width: 4, height: 4, borderRadius: 2, background: "var(--nh-accent)", flexShrink: 0 }} />
        <span style={{ flex: 1 }}>{title}</span>
        {action}
      </div>
      <div style={{ background: "var(--nh-surface)", border: "1px solid var(--nh-border)", borderRadius: 10, padding: 12 }}>{children}</div>
    </div>
  );
}

function SortToggle({ dir, onToggle }: { dir: "desc" | "asc"; onToggle: () => void }) {
  return (
    <button onClick={onToggle} style={{
      appearance: "none", border: "1px solid var(--nh-border)", cursor: "pointer",
      padding: "2px 7px", borderRadius: 4,
      background: "var(--nh-pill-bg)",
      fontFamily: "var(--nh-font-mono)", fontSize: 9,
      color: "var(--nh-accent)", letterSpacing: "0.04em",
      display: "inline-flex", alignItems: "center", gap: 3,
      textTransform: "none",
    }}>
      {dir === "desc" ? "↓ most" : "↑ least"}
    </button>
  );
}

function ShowToggle({ showAll, total, limit, onToggle }: { showAll: boolean; total: number; limit: number; onToggle: () => void }) {
  if (total <= limit) return null;
  return (
    <button onClick={onToggle} style={{
      appearance: "none", border: "1px solid var(--nh-border)", cursor: "pointer",
      padding: "2px 7px", borderRadius: 4,
      background: "var(--nh-pill-bg)",
      fontFamily: "var(--nh-font-mono)", fontSize: 9,
      color: "var(--nh-text-2)", letterSpacing: "0.04em",
      textTransform: "none",
    }}>
      {showAll ? `top ${limit}` : `all ${total}`}
    </button>
  );
}

function Mini({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ padding: "8px 10px", borderRadius: 6, background: "var(--nh-pill-bg)" }}>
      <div style={{ fontFamily: "var(--nh-font-mono)", fontSize: 9, color: "var(--nh-text-3)", letterSpacing: "0.06em", textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontFamily: "var(--nh-font-display)", fontSize: 20, fontWeight: 800, color: "var(--nh-text-1)", letterSpacing: "-0.02em", lineHeight: 1.1, marginTop: 3 }}>{value}</div>
    </div>
  );
}
