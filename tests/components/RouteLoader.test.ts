import { describe, expect, it } from "vitest";
import { clientLoader } from "../../app/routes/route";

type Args = Parameters<typeof clientLoader>[0];
const args = (serverLoader: () => Promise<unknown>) => ({ serverLoader }) as unknown as Args;

describe("route clientLoader", () => {
  it("returns the prerendered data when it exists", async () => {
    const data = { route: { slug: "x" } };
    await expect(clientLoader(args(async () => data))).resolves.toBe(data);
  });

  it("turns missing prerendered data into a 404", async () => {
    const thrown = await clientLoader(
      args(async () => {
        throw new Error('No result found for routeId "routes/route"');
      }),
    ).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(404);
  });

  it("passes thrown responses through unchanged", async () => {
    const gone = new Response("Gone", { status: 410 });
    const thrown = await clientLoader(
      args(async () => {
        throw gone;
      }),
    ).catch((e: unknown) => e);
    expect(thrown).toBe(gone);
  });
});
