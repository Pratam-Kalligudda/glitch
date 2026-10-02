import { getRouteView } from "../content.server";
import type { Route } from "./+types/route";

export async function loader({ params }: Route.LoaderArgs) {
  const route = await getRouteView(params.slug);
  if (!route) throw new Response("Not found", { status: 404 });
  return { route };
}

export default function RoutePage({ loaderData }: Route.ComponentProps) {
  return (
    <section className="tile tile-light">
      <h1 className="hero-title">{loaderData.route.title}</h1>
    </section>
  );
}
