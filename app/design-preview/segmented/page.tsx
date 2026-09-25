"use client";
// TEMPORARY design harness — delete before committing.
import { useState } from "react";
import { BarChart3, LayoutGrid } from "lucide-react";
import { ON_OFF, Segmented, SegmentedToggle } from "@/components/Primitives";
import { READ_OPTIONS, SORT_DIRECTIONS } from "@/components/HeaderFilter";

export default function Preview() {
  const [view, setView] = useState<"gallery" | "stats">("gallery");
  const [read, setRead] = useState<"all" | "unread" | "read">("all");
  const [dir, setDir] = useState<"desc" | "asc">("desc");
  const [ghost, setGhost] = useState(false);
  const [match, setMatch] = useState<"and" | "or">("and");
  return (
    <div className="min-h-dvh bg-nh-bg p-8 text-nh-text-1 flex flex-col gap-8 max-w-md">
      <div className="h-14 flex items-center border-b border-nh-border">
        <Segmented label="View" kind="tab" tone="soft" size="tab" bare value={view}
          options={[{ id: "gallery", label: "library", icon: LayoutGrid }, { id: "stats", label: "analysis", icon: BarChart3 }]}
          onChange={setView} />
      </div>
      <div className="flex items-center gap-1.5" id="xs">
        <span className="font-mono text-[9.5px] uppercase tracking-widest text-nh-text-3">ghosts</span>
        <SegmentedToggle label="Ghost tags" value={ghost} options={ON_OFF} onChange={setGhost} />
        <span className="font-mono text-[9px] uppercase tracking-wider text-nh-text-3 ml-4">match</span>
        <SegmentedToggle label="Match" value={match} options={[{ id: "and", label: "all" }, { id: "or", label: "any" }]} onChange={setMatch} />
      </div>
      <div className="w-64 flex flex-col gap-2" id="sm">
        <Segmented label="Read status" fullWidth value={read} options={READ_OPTIONS.map(({ id, label }) => ({ id, label }))} onChange={setRead} />
        <Segmented label="Sort direction" fullWidth value={dir} options={SORT_DIRECTIONS.map(({ id, label }) => ({ id, label }))} onChange={setDir} />
        <Segmented label="Sort direction (random)" fullWidth disabled value={dir} options={SORT_DIRECTIONS.map(({ id, label }) => ({ id, label }))} onChange={setDir} />
      </div>
      <div className="flex flex-col gap-3" id="md">
        <Segmented label="Read status" size="md" fullWidth value={read} options={READ_OPTIONS} onChange={setRead} />
        <Segmented label="Sort direction" size="md" fullWidth value={dir} options={SORT_DIRECTIONS} onChange={setDir} />
      </div>
    </div>
  );
}
