import type { PartView } from "../../content/view";

export function PartHeader({ part }: { part: PartView }) {
  const capstone = part.kind === "capstone";
  return (
    <header className={capstone ? "part-head part-head-capstone reveal" : "part-head reveal"}>
      <p className="eyebrow">{capstone ? "Capstone" : `Part ${part.number}`}</p>
      <h2 className="part-title">{part.title}</h2>
      <p className="part-goal">{part.goal}</p>
      {part.introHtml && (
        <div className="prose part-intro" dangerouslySetInnerHTML={{ __html: part.introHtml }} />
      )}
    </header>
  );
}
