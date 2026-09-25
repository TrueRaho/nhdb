"use client";
// TEMPORARY design harness — delete before committing.
import { useState } from "react";
import { FilterSheet, defaultFilters, type Dataset, type Filters } from "@/components/HeaderFilter";

const DATASET: Dataset = {
  allTags: ["tag A", "tag B", "tag C"], allCharacters: ["a"], allParodies: ["parody A"], allArtists: ["x"], allGroups: ["g"],
  tagCounts: { "tag A": 50, "tag B": 30, "tag C": 20 }, charCounts: { a: 1 }, parodyCounts: { "parody A": 40 },
  artistCounts: { x: 3 }, groupCounts: { g: 2 }, pageMin: 4, pageMax: 400, matchingCount: 100,
};

export default function Preview() {
  const [filters, setFilters] = useState<Filters>(() => ({ ...defaultFilters(4, 400), artists: ["x"] }));
  const [section, setSection] = useState("status");
  return (
    <div className="min-h-dvh bg-nh-bg">
      <FilterSheet open onClose={() => {}} filters={filters} setFilters={setFilters} dataset={DATASET}
        activeSection={section} setActiveSection={setSection} />
    </div>
  );
}
