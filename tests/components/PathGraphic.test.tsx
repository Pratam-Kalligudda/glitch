// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PathGraphic } from "../../app/components/PathGraphic";

afterEach(cleanup);

const dots = (c: HTMLElement) => c.querySelectorAll(".path-dot").length;
const filled = (c: HTMLElement) => c.querySelectorAll(".path-dot-done").length;

describe("PathGraphic", () => {
  it("draws one dot per stop up to eight, and at least two", () => {
    expect(dots(render(<PathGraphic total={5} done={0} />).container)).toBe(5);
    expect(dots(render(<PathGraphic total={40} done={0} />).container)).toBe(8);
    expect(dots(render(<PathGraphic total={1} done={0} />).container)).toBe(2);
  });

  it("fills nothing at zero and everything when complete", () => {
    expect(filled(render(<PathGraphic total={4} done={0} />).container)).toBe(0);
    expect(filled(render(<PathGraphic total={4} done={4} />).container)).toBe(4);
  });

  it("fills in proportion and labels itself", () => {
    const { container, getByRole } = render(<PathGraphic total={44} done={22} />);
    expect(filled(container)).toBe(4);
    expect(getByRole("img").getAttribute("aria-label")).toBe("22 of 44 stops done");
  });
});
