// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SubNav } from "../../app/components/SubNav";

afterEach(cleanup);

describe("SubNav", () => {
  it("shows the title, the count and a link to the next stop", () => {
    render(<SubNav title="Git basics" done={2} total={7} nextId="history" />);
    expect(screen.getByText("Git basics")).toBeTruthy();
    expect(screen.getByText("2 of 7 done")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Next stop" }).getAttribute("href")).toBe("#history");
  });

  it("shows Complete instead of the link when nothing is left", () => {
    render(<SubNav title="Git basics" done={7} total={7} nextId={null} />);
    expect(screen.queryByRole("link", { name: "Next stop" })).toBeNull();
    expect(screen.getByText("Complete")).toBeTruthy();
  });

  it("renders children in the right-hand cluster", () => {
    render(
      <SubNav title="T" done={0} total={1} nextId="a">
        <button type="button">Parts</button>
      </SubNav>,
    );
    expect(screen.getByRole("button", { name: "Parts" })).toBeTruthy();
  });
});
