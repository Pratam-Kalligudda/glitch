// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RailDrawer } from "../../app/components/RailDrawer";
import type { PartView } from "../../content/view";

afterEach(cleanup);

const parts: PartView[] = [
  {
    id: "local",
    title: "Work locally",
    goal: "",
    kind: "part",
    number: 1,
    introHtml: "",
    stops: [{ id: "init", title: "Init", html: "", doneWhenHtml: null, isStep: false }],
  },
];

describe("RailDrawer", () => {
  it("is closed until the Parts button is pressed", () => {
    render(<RailDrawer parts={parts} doneIds={new Set()} active={null} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Parts" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Work locally/ }).getAttribute("href")).toBe("#part-local");
  });

  it("closes when a part is chosen", () => {
    render(<RailDrawer parts={parts} doneIds={new Set()} active={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Parts" }));
    fireEvent.click(screen.getByRole("link", { name: /Work locally/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("scrolls to the chosen part once closed", async () => {
    const target = document.createElement("section");
    target.id = "part-local";
    document.body.append(target);
    const scrollIntoView = vi.fn();
    target.scrollIntoView = scrollIntoView;

    render(<RailDrawer parts={parts} doneIds={new Set()} active={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Parts" }));
    window.location.hash = "#part-local";
    fireEvent.click(screen.getByRole("link", { name: /Work locally/ }));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    target.remove();
  });

  it("closes with the close button", () => {
    render(<RailDrawer parts={parts} doneIds={new Set()} active={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Parts" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
