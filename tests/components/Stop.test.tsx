// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Stop } from "../../app/components/Stop";
import type { StopView } from "../../content/view";

afterEach(cleanup);

const stop: StopView = {
  id: "init",
  title: "Create a repository",
  html: "<p>Body text.</p>",
  doneWhenHtml: null,
  isStep: false,
};

describe("Stop", () => {
  it("renders an anchored article with a self-linking title and the body", () => {
    const { container } = render(<Stop stop={stop} done={false} onToggle={() => {}} />);
    expect(container.querySelector("article#init")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Create a repository" }).getAttribute("href")).toBe("#init");
    expect(screen.getByText("Body text.")).toBeTruthy();
  });

  it("calls onToggle with the stop id when the checkbox is clicked", () => {
    const onToggle = vi.fn();
    render(<Stop stop={stop} done={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onToggle).toHaveBeenCalledWith("init");
  });

  it("reflects the done state and names the checkbox after the stop", () => {
    render(<Stop stop={stop} done onToggle={() => {}} />);
    const box = screen.getByRole("checkbox", { name: "Mark Create a repository as done" });
    expect(box.getAttribute("aria-checked")).toBe("true");
  });

  it("shows the Done when callout only when the stop has one", () => {
    render(<Stop stop={stop} done={false} onToggle={() => {}} />);
    expect(screen.queryByText("Done when")).toBeNull();
    cleanup();
    render(
      <Stop stop={{ ...stop, doneWhenHtml: "<p>It works.</p>" }} done={false} onToggle={() => {}} />,
    );
    expect(screen.getByText("Done when")).toBeTruthy();
    expect(screen.getByText("It works.")).toBeTruthy();
  });
});
