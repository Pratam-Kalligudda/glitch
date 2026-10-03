// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { PartList } from "../../app/components/PartList";
import type { PartOutline } from "../../content/view";

afterEach(cleanup);

const parts: PartOutline[] = [
  { id: "types", title: "Types", goal: "Know values.", kind: "part", number: 1, stops: [{ id: "a", title: "A" }, { id: "b", title: "B" }] },
  { id: "project", title: "Capstone", goal: "Build it.", kind: "capstone", number: null, stops: [{ id: "spec", title: "Spec" }] },
];

const show = (doneIds: string[]) =>
  render(
    <MemoryRouter>
      <PartList slug="go" parts={parts} doneIds={new Set(doneIds)} />
    </MemoryRouter>,
  );

describe("PartList", () => {
  it("shows one card per part, linking to its page, with its goal and progress", () => {
    show(["a"]);
    const cards = screen.getAllByRole("listitem");
    expect(cards).toHaveLength(2);
    const types = within(cards[0]);
    expect(types.getByRole("link", { name: /Types/ }).getAttribute("href")).toBe("/go/types");
    expect(types.getByText("Know values.")).toBeTruthy();
    expect(types.getByText("1 of 2 stops done")).toBeTruthy();
  });

  it("labels parts by number and the capstone by name", () => {
    show([]);
    const [first, capstone] = screen.getAllByRole("listitem");
    expect(within(first).getByText("Part 1")).toBeTruthy();
    expect(within(capstone).getByText("Capstone", { selector: ".eyebrow" })).toBeTruthy();
    expect(capstone.className).toContain("is-capstone");
  });

  it("marks a part whose stops are all done", () => {
    show(["spec"]);
    expect(screen.getAllByRole("listitem")[1].className).toContain("is-complete");
  });
});
