// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RailDrawer } from "../../app/components/RailDrawer";
import type { PartOutline } from "../../content/view";

afterEach(cleanup);

const parts: PartOutline[] = [
  { id: "local", title: "Work locally", goal: "", kind: "part", number: 1, stops: [{ id: "init", title: "Init" }] },
];

const drawer = () =>
  render(
    <MemoryRouter>
      <RailDrawer slug="git" parts={parts} current="local" doneIds={new Set()} nextId={null} />
    </MemoryRouter>,
  );

describe("RailDrawer", () => {
  it("is closed until the Parts button is pressed", () => {
    drawer();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Parts" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Work locally/ }).getAttribute("href")).toBe("/git/local");
  });

  it("closes when a part is chosen", () => {
    drawer();
    fireEvent.click(screen.getByRole("button", { name: "Parts" }));
    fireEvent.click(screen.getByRole("link", { name: /Work locally/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("scrolls to the chosen part once closed", async () => {
    const target = document.createElement("section");
    target.id = "init";
    document.body.append(target);
    const scrollIntoView = vi.fn();
    target.scrollIntoView = scrollIntoView;

    drawer();
    fireEvent.click(screen.getByRole("button", { name: "Parts" }));
    window.location.hash = "#init";
    fireEvent.click(screen.getByRole("link", { name: /Init/ }));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    target.remove();
  });

  it("closes with the close button", () => {
    drawer();
    fireEvent.click(screen.getByRole("button", { name: "Parts" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
