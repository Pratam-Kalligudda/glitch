/**
 * Client navigations read the prerendered data file. A path that was never prerendered
 * has no data file, so report it as a 404 instead of a decoding error.
 */
export async function prerenderedOr404<T>(serverLoader: () => Promise<T>): Promise<T> {
  try {
    return await serverLoader();
  } catch (error) {
    if (error instanceof Response) throw error;
    throw new Response("Not found", { status: 404 });
  }
}
