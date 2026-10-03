// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { SubNav } from "../../app/components/SubNav";

afterEach(cleanup);

const show = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe("SubNav", () => {
  it("links to the next stop by anchor when it is on this page", () => {
    show(<SubNav title="Git basics" titleTo="/git" done={2} total={7} next="#history" />);
    expect(screen.getByText("2 of 7 done")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Next stop" }).getAttribute("href")).toBe("#history");
  });

  it("links to the next stop's part page when it is elsewhere", () => {
    show(<SubNav title="Git basics" titleTo="/git" done={2} total={7} next="/git/share#branch" />);
    expect(screen.getByRole("link", { name: "Next stop" }).getAttribute("href")).toBe("/git/share#branch");
  });

  it("links the title to the route overview", () => {
    show(<SubNav title="Git basics" titleTo="/git" done={0} total={1} next={null} />);
    expect(screen.getByRole("link", { name: "Git basics" }).getAttribute("href")).toBe("/git");
  });

  it("shows Complete instead of the link when nothing is left", () => {
    show(<SubNav title="Git basics" titleTo="/git" done={7} total={7} next={null} />);
    expect(screen.queryByRole("link", { name: "Next stop" })).toBeNull();
    expect(screen.getByText("Complete")).toBeTruthy();
  });

  it("renders children in the right-hand cluster", () => {
    show(
      <SubNav title="T" titleTo="/t" done={0} total={1} next="#a">
        <button type="button">Parts</button>
      </SubNav>,
    );
    expect(screen.getByRole("button", { name: "Parts" })).toBeTruthy();
  });
});
