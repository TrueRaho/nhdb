"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { Dataset } from "./HeaderFilter";
import type { StatsPayload } from "../lib/titles";
import { getStatsAction } from "../app/actions";

export function StatsView({ dataset, onTagClick }: {
  dataset: Dataset; onTagClick: (t: string) => void;
}) {
  const [stats, setStats] = useState<StatsPayload | null>(null);
  const [tagsDir, setTagsDir] = useState<"desc" | "asc">("desc");
  const [tagsShowAll, setTagsShowAll] = useState(false);
  const [artistsDir, setArtistsDir] = useState<"desc" | "asc">("desc");
  const [artistsShowAll, setArtistsShowAll] = useState(false);
  const [groupsDir, setGroupsDir] = useState<"desc" | "asc">("desc");
  const [groupsShowAll, setGroupsShowAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Bucket the wall-clock charts in the viewer's zone — they are rendered as
    // local time below. Read here rather than at module scope so it is always
    // the browser's zone (this component is client-only, never prerendered).
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    getStatsAction(timeZone).then((s) => { if (!cancelled) setStats(s); }).catch(console.error);
    return () => { cancelled = true; };
  }, []);

  if (!stats) {
    return <div className="p-10 text-center font-mono text-xs text-nh-text-3">loading analysis…</div>;
  }

  const topN = (counts: Record<string, number>, n: number) =>
    Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n);
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

  const monthMax = Math.max(...stats.monthlyReads.map(m => m.count), 1);
  const hourMax = Math.max(...stats.hourlyReads.map(b => b.count), 1);
  const dowMax = Math.max(...stats.dowReads.map(b => b.count), 1);
  const bucketMax = Math.max(...stats.pageBuckets.map(b => b.count), 1);
  const addMax = Math.max(...stats.additions.map(a => a.count), 1);

  const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const totalSessions = stats.monthlyReads.reduce((s, m) => s + m.count, 0);

  return (
    <div className="pb-16">
      <div className="px-3 pt-1.5 pb-3.5">
        <div
          className="font-display font-extrabold text-nh-text-1"
          style={{ fontSize: 22, letterSpacing: "-0.02em", marginBottom: 2 }}
        >
          library analysis
        </div>
        <div className="font-mono text-[10px] tracking-wide text-nh-text-3">since you started this collection</div>
      </div>

      <div
        className="grid grid-cols-2 gap-px mx-3 rounded-[10px] overflow-hidden border border-nh-border"
        style={{ background: "var(--nh-border)" }}
      >
        <BigStat label="titles" value={stats.total} sub="total" />
        <BigStat label="pages" value={stats.totalPages.toLocaleString()} sub="archived" />
        <BigStat label="reads" value={stats.totalReads} sub={`${stats.readPages.toLocaleString()} pages traversed`} accent />
        <BigStat label="unread" value={stats.unread} sub={`${stats.total ? Math.round(stats.unread / stats.total * 100) : 0}% of library`} />
      </div>

      <Section title="reading activity · last 12 months">
        <div className="flex items-end gap-1 h-16 pt-1 pb-2">
          {stats.monthlyReads.map(m => (
            <div key={m.idx} className="flex-1 flex flex-col items-center gap-1">
              <div
                className="w-full rounded-sm"
                style={{
                  height: `${(m.count / monthMax) * 56 + 2}px`,
                  background: m.count > 0 ? "var(--nh-accent)" : "var(--nh-border-strong)",
                  opacity: m.count > 0 ? 1 : 0.4,
                }}
              />
              {m.idx % 3 === 0 && (
                <div className="font-mono text-[8px] tracking-wide text-nh-text-3">{11 - m.idx}m</div>
              )}
            </div>
          ))}
        </div>
        <div className="flex justify-between font-mono text-[10px] text-nh-text-3 mt-0.5">
          <span>peak: {monthMax} sessions</span>
          <span>{totalSessions} total sessions</span>
        </div>
      </Section>

      <Section title="by time of day">
        <div className="flex items-end gap-0.5 h-14 pt-1">
          {stats.hourlyReads.map(b => (
            <div key={b.h} className="flex-1 flex flex-col items-center gap-[3px]">
              <div
                className="w-full rounded-sm"
                style={{
                  height: `${(b.count / hourMax) * 44 + 2}px`,
                  background: b.count > 0 ? "var(--nh-accent)" : "var(--nh-border-strong)",
                  opacity: b.count > 0 ? 0.5 + (b.count / hourMax) * 0.5 : 0.25,
                }}
              />
              {b.h % 6 === 0 && (
                <div className="font-mono text-[7.5px] text-nh-text-3">{b.h}h</div>
              )}
            </div>
          ))}
        </div>
        {totalSessions === 0 && (
          <div className="font-mono text-[11px] text-nh-text-3 pt-1.5">no sessions yet</div>
        )}
      </Section>

      <Section title="by day of week">
        <div className="flex items-end gap-1.5 h-[60px]">
          {stats.dowReads.map((b, i) => (
            <div key={i} className="flex-1 flex flex-col items-center gap-1">
              <div
                className="w-full rounded-sm"
                style={{
                  height: `${(b.count / dowMax) * 40 + 2}px`,
                  background: b.count > 0 ? "var(--nh-accent)" : "var(--nh-border-strong)",
                  opacity: b.count > 0 ? 0.5 + (b.count / dowMax) * 0.5 : 0.25,
                }}
              />
              <div className="font-mono text-[8.5px] text-nh-text-3">{DOW_LABELS[i]}</div>
            </div>
          ))}
        </div>
        {totalSessions === 0 && (
          <div className="font-mono text-[11px] text-nh-text-3">no sessions yet</div>
        )}
      </Section>

      {stats.recentSessions.length > 0 && (
        <Section title={`recent sessions · last ${stats.recentSessions.length}`}>
          <div className="flex flex-col">
            {stats.recentSessions.map((s, i) => {
              const d = new Date(s.readAt);
              const dateStr = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
              const timeStr = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
              return (
                <div
                  key={i}
                  className="flex items-center gap-2.5 py-1.5"
                  style={{ borderBottom: i < stats.recentSessions.length - 1 ? "1px solid var(--nh-border)" : undefined }}
                >
                  <div className="flex-1 min-w-0">
                    <div className="font-display font-semibold text-xs text-nh-text-1 truncate">{s.name}</div>
                    <div className="font-mono text-[9.5px] text-nh-text-3">{s.label}</div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-mono text-[10px] text-nh-text-2">{timeStr}</div>
                    <div className="font-mono text-[9.5px] text-nh-text-3">{dateStr}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </Section>
      )}

      <Section title="page count distribution">
        <div className="flex flex-col gap-[7px]">
          {stats.pageBuckets.map(b => (
            <div key={b.label} className="flex items-center gap-2">
              <div className="w-14 shrink-0 font-mono text-[10px] text-nh-text-3 text-right">{b.label}p</div>
              <div className="flex-1 h-3.5 relative bg-nh-pill rounded-sm">
                <div
                  className="absolute left-0 top-0 bottom-0 bg-nh-accent rounded-sm flex items-center justify-end pr-1"
                  style={{ width: `${(b.count / bucketMax) * 100}%` }}
                >
                  {b.count > 0 && (b.count / bucketMax) > 0.2 && (
                    <span className="font-mono text-[9px] font-bold text-[#0a0a0a]">{b.count}</span>
                  )}
                </div>
                {(b.count / bucketMax) <= 0.2 && b.count > 0 && (
                  <span
                    className="absolute top-0 bottom-0 pl-1.5 flex items-center font-mono text-[9px] font-semibold text-nh-text-2"
                    style={{ left: `${(b.count / bucketMax) * 100}%` }}
                  >
                    {b.count}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-2.5 pt-2.5 border-t border-nh-border flex justify-between font-mono text-[10px] text-nh-text-3">
          <span>avg <span className="text-nh-text-1">{stats.avgPages}p</span></span>
          <span>median ~ <span className="text-nh-text-1">{stats.medianPages}p</span></span>
          <span>longest <span className="text-nh-accent">{stats.longestPages}p</span></span>
        </div>
      </Section>

      <Section
        title={`tags · ${dataset.allTags.length} unique`}
        action={
          <div className="flex gap-1">
            <SortToggle dir={tagsDir} onToggle={() => setTagsDir(d => d === "desc" ? "asc" : "desc")} />
            <ShowToggle showAll={tagsShowAll} total={dataset.allTags.length} limit={12} onToggle={() => setTagsShowAll(v => !v)} />
          </div>
        }
      >
        <div className="flex flex-wrap gap-1">
          {topTags.map(([t, n]) => {
            const pct = n / topMaxTag;
            return (
              <Badge
                key={t}
                onClick={() => onTagClick(t)}
                className="h-auto cursor-pointer rounded-sm border-0 px-2 py-1 gap-1.5 hover:opacity-90"
                style={{
                  background: `linear-gradient(90deg, var(--nh-accent-soft) ${pct * 100}%, var(--nh-pill-bg) ${pct * 100}%)`,
                }}
              >
                <span className="font-mono text-[11px] text-nh-text-1">{t}</span>
                <span className="font-mono text-[10px] font-semibold text-nh-accent">{n}</span>
              </Badge>
            );
          })}
        </div>
      </Section>

      <Section
        title={`artists · ${dataset.allArtists.length} unique`}
        action={
          <div className="flex gap-1">
            <SortToggle dir={artistsDir} onToggle={() => setArtistsDir(d => d === "desc" ? "asc" : "desc")} />
            <ShowToggle showAll={artistsShowAll} total={dataset.allArtists.length} limit={10} onToggle={() => setArtistsShowAll(v => !v)} />
          </div>
        }
      >
        <div className="flex flex-col gap-[7px]">
          {topArtists.map(([a, n], i) => (
            <div key={a} className="flex items-center gap-2">
              <div className="w-[18px] shrink-0 font-mono text-[9px] font-bold text-nh-text-3">{String(i + 1).padStart(2, "0")}</div>
              <div className="flex-1 min-w-0 font-mono text-[11px] text-nh-text-1 truncate">{a}</div>
              <div className="w-20 h-1 rounded-sm bg-nh-pill relative">
                <div className="absolute left-0 top-0 bottom-0 bg-nh-accent rounded-sm" style={{ width: `${(n / topMaxArtist) * 100}%` }} />
              </div>
              <div className="w-[26px] shrink-0 text-right font-mono text-[11px] font-semibold text-nh-accent">{n}</div>
            </div>
          ))}
        </div>
      </Section>

      {allGroupEntries.length > 0 && (
        <Section
          title={`groups · ${dataset.allGroups.length} unique`}
          action={
            <div className="flex gap-1">
              <SortToggle dir={groupsDir} onToggle={() => setGroupsDir(d => d === "desc" ? "asc" : "desc")} />
              <ShowToggle showAll={groupsShowAll} total={dataset.allGroups.length} limit={10} onToggle={() => setGroupsShowAll(v => !v)} />
            </div>
          }
        >
          <div className="flex flex-col gap-[7px]">
            {topGroups.map(([g, n], i) => (
              <div key={g} className="flex items-center gap-2">
                <div className="w-[18px] shrink-0 font-mono text-[9px] font-bold text-nh-text-3">{String(i + 1).padStart(2, "0")}</div>
                <div className="flex-1 min-w-0 font-mono text-[11px] text-nh-text-1 truncate">{g}</div>
                <div className="w-20 h-1 rounded-sm bg-nh-pill relative">
                  <div className="absolute left-0 top-0 bottom-0 bg-nh-accent rounded-sm" style={{ width: `${(n / topMaxGroup) * 100}%` }} />
                </div>
                <div className="w-[26px] shrink-0 text-right font-mono text-[11px] font-semibold text-nh-accent">{n}</div>
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section title="top parodies">
        <div className="flex flex-wrap gap-1.5">
          {topParodies.map(([p, n]) => (
            <Badge
              key={p}
              variant="secondary"
              className="h-auto rounded-sm border-0 bg-nh-pill px-2 py-1 gap-1.5 items-baseline"
            >
              <span className="font-display font-semibold text-[11px] text-nh-text-1">{p}</span>
              <span className="font-mono text-[10px] text-nh-text-3">{n}</span>
            </Badge>
          ))}
        </div>
      </Section>

      <Section title="most-read titles">
        <div className="flex flex-col">
          {stats.mostRead.map((m, i) => (
            <div
              key={m.hashtag}
              className="flex items-center gap-2.5 py-2"
              style={{ borderBottom: i < stats.mostRead.length - 1 ? "1px solid var(--nh-border)" : undefined }}
            >
              <div className="w-[30px] h-[42px] shrink-0 rounded-sm overflow-hidden relative">
                {m.imageLink && (
                  <Image src={m.imageLink} alt="" fill sizes="30px" className="object-cover object-top" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-display font-semibold text-xs text-nh-text-1 truncate">{m.alterName || m.titleName}</div>
                <div className="font-mono text-[10px] text-nh-text-3">{m.firstArtist} · {m.pages}p</div>
              </div>
              <div
                className="font-display font-extrabold text-[18px] text-nh-accent"
                style={{ letterSpacing: "-0.02em" }}
              >
                {m.readCount}
                <span className="text-[10px] font-medium text-nh-text-3">×</span>
              </div>
            </div>
          ))}
          {stats.mostRead.length === 0 && (
            <div className="font-mono text-[11px] text-nh-text-3 py-2">nothing read yet</div>
          )}
        </div>
      </Section>

      <Section title="additions · last 360 days">
        <div className="flex items-end gap-1.5 h-[50px]">
          {stats.additions.map((a, i) => (
            <div key={i} className="flex-1 flex flex-col items-center gap-[3px]">
              <div
                className="w-full rounded-sm bg-nh-accent"
                style={{ height: `${(a.count / addMax) * 38 + 2}px`, opacity: 0.4 + (a.count / addMax) * 0.6 }}
              />
              <div className="font-mono text-[8px] text-nh-text-3">{a.label}</div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="counts">
        <div className="grid grid-cols-2 gap-2">
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
    <div className="bg-nh-surface-2 px-3 py-3.5 flex flex-col gap-0.5">
      <div className="font-mono text-[9.5px] uppercase tracking-widest text-nh-text-3">{label}</div>
      <div
        className="font-display font-extrabold mt-0.5"
        style={{ fontSize: 28, letterSpacing: "-0.03em", lineHeight: 1, color: accent ? "var(--nh-accent)" : "var(--nh-text-1)" }}
      >
        {value}
      </div>
      <div className="font-mono text-[9.5px] text-nh-text-3 mt-0.5">{sub}</div>
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="px-3 pt-3.5">
      <div className="flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-widest text-nh-text-3 mb-2">
        <span className="w-1 h-1 rounded-sm bg-nh-accent shrink-0" />
        <span className="flex-1">{title}</span>
        {action}
      </div>
      <div className="rounded-[10px] border border-nh-border bg-nh-surface p-3">
        {children}
      </div>
    </div>
  );
}

function SortToggle({ dir, onToggle }: { dir: "desc" | "asc"; onToggle: () => void }) {
  return (
    <Button
      onClick={onToggle}
      variant="outline"
      className="h-auto py-0.5 px-1.5 rounded-sm border border-nh-border bg-nh-pill font-mono text-[9px] text-nh-accent gap-0.5 hover:bg-nh-pill/80"
      style={{ letterSpacing: "0.04em", textTransform: "none" }}
    >
      {dir === "desc" ? "↓ most" : "↑ least"}
    </Button>
  );
}

function ShowToggle({ showAll, total, limit, onToggle }: { showAll: boolean; total: number; limit: number; onToggle: () => void }) {
  if (total <= limit) return null;
  return (
    <Button
      onClick={onToggle}
      variant="outline"
      className="h-auto py-0.5 px-1.5 rounded-sm border border-nh-border bg-nh-pill font-mono text-[9px] text-nh-text-2 hover:bg-nh-pill/80"
      style={{ letterSpacing: "0.04em", textTransform: "none" }}
    >
      {showAll ? `top ${limit}` : `all ${total}`}
    </Button>
  );
}

function Mini({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="px-2.5 py-2 rounded-md bg-nh-pill">
      <div className="font-mono text-[9px] uppercase tracking-wider text-nh-text-3">{label}</div>
      <div
        className="font-display font-extrabold text-[20px] text-nh-text-1 mt-[3px]"
        style={{ letterSpacing: "-0.02em", lineHeight: 1.1 }}
      >
        {value}
      </div>
    </div>
  );
}
