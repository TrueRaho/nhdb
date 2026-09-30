// @vitest-environment jsdom
import { Activity } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../app/actions", () => ({
  getSwipeDeckAction: vi.fn(),
  getSwipeCardsAction: vi.fn(),
  updateAlterNameAction: vi.fn(async () => ({})),
  deleteTitlesAction: vi.fn(async (hs: number[]) => hs),
}));
import { deleteTitlesAction, getSwipeCardsAction, getSwipeDeckAction, updateAlterNameAction } from "../app/actions";
import { SwipeDeck } from "./Swipe";
import { DELETE_BATCH, POSTPONE_GAP, trashKey } from "../lib/swipe";
import type { Item } from "../lib/data";

const USER = "user-a";

const item = (hashtag: number): Item => ({
  hashtag, titleName: `title ${hashtag}`, alterName: "", imageLink: "", pages: 20 + hashtag,
  uploadedAt: 300, addedAt: 40, readCount: 0, lastReadAt: null,
  tags: ["tag one"], artists: ["someone"], groups: [], parodies: [], characters: [],
});

function deck(...hashtags: number[]) {
  vi.mocked(getSwipeDeckAction).mockResolvedValue(hashtags);
  vi.mocked(getSwipeCardsAction).mockImplementation(async (hs: number[]) => hs.map(item));
}

// The card on top, by its accessible name.
const onTop = (hashtag: number) => screen.findByRole("group", { name: new RegExp(`^title ${hashtag} —`) });
const card = () => screen.getByRole("group", { name: /tap to open on nhentai/ });
const nameField = () => screen.getByLabelText(/custom name/) as HTMLInputElement;
const trashList = () => JSON.parse(localStorage.getItem(trashKey(USER)) ?? "[]") as { hashtag: number }[];

let opened: string[] = [];

beforeEach(() => {
  localStorage.clear();
  opened = [];
  vi.spyOn(window, "open").mockImplementation((url) => { opened.push(String(url)); return null; });
  // Math.random just under 1 makes Fisher–Yates the identity: the deck keeps its order.
  vi.spyOn(Math, "random").mockReturnValue(0.999999);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("SwipeDeck", () => {
  it("draws the titles without a name, minus the deletion list", async () => {
    localStorage.setItem(trashKey(USER), JSON.stringify([{ hashtag: 2, titleName: "title 2", imageLink: "", pages: 22 }]));
    deck(1, 2, 3);
    render(<SwipeDeck userId={USER} />);
    await onTop(1);
    expect(screen.getByText("2 without a name")).toBeTruthy();
    expect(screen.getByRole("button", { name: /deletion list, 1 title/ })).toBeTruthy();
  });

  it("will not keep a title without a name, and keeps it with one", async () => {
    deck(1, 2);
    render(<SwipeDeck userId={USER} />);
    await onTop(1);

    fireEvent.click(screen.getByRole("button", { name: "keep" }));
    expect(await screen.findByText(/type a name to keep it/)).toBeTruthy();
    expect(updateAlterNameAction).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(nameField());

    fireEvent.change(nameField(), { target: { value: "  First one  " } });
    fireEvent.keyDown(nameField(), { key: "Enter" });
    await onTop(2);
    expect(updateAlterNameAction).toHaveBeenCalledWith(1, "First one");
    expect(nameField().value).toBe("");
  });

  it("puts a title back on top when its name could not be saved", async () => {
    vi.mocked(updateAlterNameAction).mockRejectedValueOnce(new Error("offline"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    deck(1, 2);
    render(<SwipeDeck userId={USER} />);
    await onTop(1);
    fireEvent.change(nameField(), { target: { value: "Keep me" } });
    fireEvent.click(screen.getByRole("button", { name: "keep" }));
    expect(await screen.findByText(/couldn't save “Keep me”/)).toBeTruthy();
    await onTop(1);
  });

  it("sends a title to the deletion list without deleting anything", async () => {
    deck(1, 2);
    render(<SwipeDeck userId={USER} />);
    await onTop(1);
    fireEvent.click(screen.getByRole("button", { name: "delete list" }));
    await onTop(2);
    expect(trashList().map((e) => e.hashtag)).toEqual([1]);
    expect(deleteTitlesAction).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /deletion list, 1 title/ })).toBeTruthy();
  });

  it(`brings a postponed title back after ${POSTPONE_GAP} others`, async () => {
    deck(1, 2, 3, 4, 5, 6, 7);
    render(<SwipeDeck userId={USER} />);
    await onTop(1);
    fireEvent.click(screen.getByRole("button", { name: "later" }));
    for (const next of [2, 3, 4, 5]) {
      await onTop(next);
      fireEvent.change(nameField(), { target: { value: `name ${next}` } });
      fireEvent.click(screen.getByRole("button", { name: "keep" }));
    }
    await onTop(1);
  });

  it("will not postpone the last title", async () => {
    deck(1);
    render(<SwipeDeck userId={USER} />);
    await onTop(1);
    fireEvent.click(screen.getByRole("button", { name: "later" }));
    expect(await screen.findByText(/it's the last one/)).toBeTruthy();
    expect(card()).toBeTruthy();
  });

  it("opens the title on a tap, without counting a read", async () => {
    deck(1, 2);
    render(<SwipeDeck userId={USER} />);
    await onTop(1);
    fireEvent.pointerDown(card(), { pointerId: 1, clientX: 200, clientY: 300 });
    fireEvent.pointerUp(card(), { pointerId: 1, clientX: 201, clientY: 301 });
    expect(opened).toEqual(["https://nhentai.net/g/1/"]);
    expect(updateAlterNameAction).not.toHaveBeenCalled();
    expect(screen.getByText("2 without a name")).toBeTruthy();
  });

  it("reads a drag: left to the list, up to nothing", async () => {
    deck(1, 2);
    render(<SwipeDeck userId={USER} />);
    await onTop(1);
    const drag = (dx: number, dy: number) => {
      const el = card();
      fireEvent.pointerDown(el, { pointerId: 2, clientX: 200, clientY: 300 });
      fireEvent.pointerMove(el, { pointerId: 2, clientX: 200 + dx, clientY: 300 + dy });
      fireEvent.pointerUp(el, { pointerId: 2, clientX: 200 + dx, clientY: 300 + dy });
    };
    drag(0, -200);
    expect(await screen.findByText("swiping up does nothing yet")).toBeTruthy();
    drag(-200, 10);
    await onTop(2);
    expect(trashList().map((e) => e.hashtag)).toEqual([1]);
  });

  it("answers the arrow keys, but not while typing", async () => {
    deck(1, 2, 3);
    render(<SwipeDeck userId={USER} />);
    await onTop(1);
    fireEvent.keyDown(nameField(), { key: "ArrowLeft" });
    expect(card().getAttribute("aria-label")).toMatch(/^title 1/);
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    await onTop(2);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(await screen.findByText(/type a name to keep it/)).toBeTruthy();
  });

  it("empties the deletion list in one call, only after a second tap", async () => {
    localStorage.setItem(trashKey(USER), JSON.stringify([
      { hashtag: 7, titleName: "seven", imageLink: "", pages: 7 },
      { hashtag: 8, titleName: "eight", imageLink: "", pages: 8 },
    ]));
    deck(1);
    render(<SwipeDeck userId={USER} />);
    await onTop(1);
    fireEvent.click(screen.getByRole("button", { name: /deletion list, 2 titles/ }));
    fireEvent.click(await screen.findByRole("button", { name: "delete 2 titles…" }));
    expect(deleteTitlesAction).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "delete 2" })));
    expect(deleteTitlesAction).toHaveBeenCalledOnce();
    expect(deleteTitlesAction).toHaveBeenCalledWith([7, 8]);
    expect(trashList()).toEqual([]);
    expect(await screen.findByText("deleted 2 titles")).toBeTruthy();
  });

  it("restores a title from the list into this deck", async () => {
    localStorage.setItem(trashKey(USER), JSON.stringify([{ hashtag: 7, titleName: "seven", imageLink: "", pages: 7 }]));
    deck(1, 7);
    render(<SwipeDeck userId={USER} />);
    await onTop(1);
    expect(screen.getByText("1 without a name")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /deletion list, 1 title/ }));
    fireEvent.click(await screen.findByRole("button", { name: "restore seven" }));
    expect(trashList()).toEqual([]);
    await waitFor(() => expect(screen.getByText("2 without a name")).toBeTruthy());
  });

  it("says so when every title has a name", async () => {
    deck();
    render(<SwipeDeck userId={USER} />);
    expect(await screen.findByText("every title has a name")).toBeTruthy();
  });

  it("offers a retry when the deck cannot be drawn", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(getSwipeDeckAction).mockRejectedValueOnce(new Error("offline"));
    vi.mocked(getSwipeCardsAction).mockImplementation(async (hs: number[]) => hs.map(item));
    render(<SwipeDeck userId={USER} />);
    const retry = await screen.findByRole("button", { name: "retry" });
    vi.mocked(getSwipeDeckAction).mockResolvedValue([4]);
    fireEvent.click(retry);
    await onTop(4);
  });

  it("shuffles anew on every launch", async () => {
    deck(1, 2, 3);
    const first = render(<SwipeDeck userId={USER} />);
    await onTop(1); // Math.random ~1: the identity order
    first.unmount();
    // Math.random 0 moves every item down: [1,2,3] -> [2,3,1]
    vi.mocked(Math.random).mockReturnValue(0);
    render(<SwipeDeck userId={USER} />);
    await onTop(2);
  });

  it("starts a fresh, reshuffled session when Next brings the page back from hiding", async () => {
    deck(1, 2, 3);
    const view = (mode: "visible" | "hidden") => <Activity mode={mode}><SwipeDeck userId={USER} /></Activity>;
    const { rerender } = render(view("visible"));
    await onTop(1);
    fireEvent.click(screen.getByRole("button", { name: "delete list" }));
    await onTop(2);
    expect(getSwipeDeckAction).toHaveBeenCalledTimes(1);

    vi.mocked(Math.random).mockReturnValue(0);
    rerender(view("hidden"));
    rerender(view("visible"));
    // no flash of the old session while the new draw is on its way
    expect(screen.queryByRole("group", { name: /tap to open on nhentai/ })).toBeNull();
    // a new draw, a new order — #1 sits on the deletion list now
    await waitFor(() => expect(getSwipeDeckAction).toHaveBeenCalledTimes(2));
    await onTop(3); // [2,3] shuffled with 0 -> [3,2]
    expect(screen.getByText("2 without a name")).toBeTruthy();
  });

  it("keeps the name the swipe started with, even if the field is cleared mid-flight", async () => {
    deck(1, 2);
    render(<SwipeDeck userId={USER} />);
    await onTop(1);
    fireEvent.change(nameField(), { target: { value: "Final name" } });
    fireEvent.keyDown(nameField(), { key: "Enter" });
    fireEvent.change(nameField(), { target: { value: "" } });
    await onTop(2);
    expect(updateAlterNameAction).toHaveBeenCalledWith(1, "Final name");
  });

  it("skips a title that got a name somewhere else since the draw", async () => {
    vi.mocked(getSwipeDeckAction).mockResolvedValue([1, 2]);
    vi.mocked(getSwipeCardsAction).mockImplementation(async (hs: number[]) =>
      hs.map((h) => (h === 1 ? { ...item(1), alterName: "named in another tab" } : item(h))));
    render(<SwipeDeck userId={USER} />);
    await onTop(2);
    expect(screen.getByText("1 without a name")).toBeTruthy();
  });

  it("empties a long list in chunks, one after another", async () => {
    const long = Array.from({ length: DELETE_BATCH + 1 }, (_, i) => ({ hashtag: 1000 + i, titleName: `t${i}`, imageLink: "", pages: 1 }));
    localStorage.setItem(trashKey(USER), JSON.stringify(long));
    deck(1);
    render(<SwipeDeck userId={USER} />);
    await onTop(1);
    fireEvent.click(screen.getByRole("button", { name: /deletion list, 501 titles/ }));
    fireEvent.click(await screen.findByRole("button", { name: "delete 501 titles…" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "delete 501" })));
    expect(vi.mocked(deleteTitlesAction).mock.calls.map(([hs]) => hs.length)).toEqual([DELETE_BATCH, 1]);
    expect(trashList()).toEqual([]);
    expect(await screen.findByText(`deleted ${DELETE_BATCH + 1} titles`)).toBeTruthy();
  });

  it("follows one finger, and recovers from a lost pointer", async () => {
    deck(1, 2);
    render(<SwipeDeck userId={USER} />);
    await onTop(1);
    const el = card();
    // a second finger mid-drag does not take over: its fling to the left is ignored
    fireEvent.pointerDown(el, { pointerId: 1, clientX: 200, clientY: 300 });
    fireEvent.pointerDown(el, { pointerId: 2, clientX: 400, clientY: 300 });
    fireEvent.pointerMove(el, { pointerId: 2, clientX: 100, clientY: 300 });
    fireEvent.pointerUp(el, { pointerId: 2, clientX: 100, clientY: 300 });
    await new Promise((r) => setTimeout(r, 300)); // longer than a fly-out
    expect(screen.getByText("2 without a name")).toBeTruthy();
    expect(trashList()).toEqual([]);
    // the browser takes the pointer away: the drag ends instead of blocking the next one
    fireEvent.lostPointerCapture(el, { pointerId: 1 });
    fireEvent.pointerDown(el, { pointerId: 3, clientX: 200, clientY: 300 });
    fireEvent.pointerMove(el, { pointerId: 3, clientX: 0, clientY: 300 });
    fireEvent.pointerUp(el, { pointerId: 3, clientX: 0, clientY: 300 });
    await onTop(2);
    expect(trashList().map((e) => e.hashtag)).toEqual([1]);
  });
});
