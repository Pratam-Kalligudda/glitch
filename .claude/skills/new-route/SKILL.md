---
name: new-route
description: Write a new learning route (guide) for the Glitch site. Use when asked to add, create or write a route, guide or course on a topic.
---

# New route

Read `docs/writing-a-route.md` in full before anything else. It defines the depth, the
structure, the anatomy of a stop and of a capstone step, and the final checklist. The
short validator rules are in `CLAUDE.md`. Work through these steps in order.

## 1. Ask

Ask the owner, one question at a time:

1. What is the topic, and what should the reader be able to build or do at the end?
2. What does the reader already know?
3. What should the capstone project be? Offer a suggestion that needs most of the topic.

There is no size limit (guide, section 1): plan as many stops, parts and capstone steps
as the topic needs to be complete. If part of the topic is reusable by other routes,
skippable for many readers, or has its own outcome, propose splitting it into a series of
routes (guide, "Splitting a topic into a series"). Never split only because of length.

## 2. Research

Read the current official documentation for every tool the route covers. Note the
versions to pin. Run commands where you can. Do not write from memory alone.

## 3. Outline and wait

Propose the outline in the format of guide section 8 and wait for the owner's approval
before writing any stop. It must include the capstone coverage list showing that every
part is used by the capstone.

## 4. Write

Create `routes/<slug>/route.yaml` with `draft: true`, then the parts and stops.

- Each stop follows the anatomy in guide section 5: what and why, a complete runnable
  example, how it works, then a second example, warning, table or note as needed.
- Each capstone step follows guide section 6.3: tasks with `[[stop-id]]` links, full code
  as it stands at the end of the step, how to run it, and an observable `done_when`.
- Put images in `routes/<slug>/assets/` and reference them by filename.
- Set `checked` to the current month as `YYYY-MM`.

Write the route part by part. After each part, reread its stops against the guide's
"Vague versus in depth" table (section 5.4) and deepen any stop that falls short.

## 5. Validate

A draft route is skipped by validation, so remove `draft: true` first.

Run `npm run validate`. Fix every problem it reports and run it again until it prints
`OK`. Then run `npm test`; `tests/content/routes.test.ts` renders every route and fails on
unresolved references or images.

## 6. Preview

Run `npm run dev`, open the route in the browser, and read it top to bottom. Check that
code blocks, callouts, tables, images and references render as intended, and that the
route card shows the right "Start here" or "After ..." line. Walk the guide's checklist
(section 9). Give the owner the preview URL.

## 7. Commit

Commit the route. Push only when the owner asks; a push to `main` publishes the site.
