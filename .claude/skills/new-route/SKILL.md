---
name: new-route
description: Write a new learning route (guide) for the Glitch site. Use when asked to add, create or write a route, guide or course on a topic.
---

# New route

Follow the content rules in `CLAUDE.md`. Work through these steps in order.

## 1. Ask

Ask the owner, one question at a time:

1. What is the topic, and what should the reader be able to do at the end?
2. What does the reader already know?
3. What should the capstone project be? Offer a suggestion.

## 2. Outline and wait

Propose an outline and wait for the owner's approval before writing any stop:

- the route slug, title, number (next free number) and summary;
- parts in order, each with its goal line;
- the stops in each part, by title;
- the capstone: its spec and its steps, each with a draft `done_when`;
- prerequisites, if another route should be read first. A prerequisite must have a lower number.

Order parts from foundations to application. Each non-capstone part should teach something the capstone uses.

## 3. Write

Create `routes/<slug>/route.yaml` with `draft: true`, then the parts and stops.

- One idea per stop: one to three short paragraphs, one working example, an optional note.
- Check every command and API against official documentation. Pin versions. Do not write from memory alone.
- Capstone steps list tasks, refer back to earlier stops with `[[stop-id]]` (or `[[route-slug/stop-id]]` for another route), show the code as it stands at the end of the step, and end with `done_when`.
- Put images in `routes/<slug>/assets/` and reference them by filename.
- Set `checked` to the current month as `YYYY-MM`.

## 4. Validate

A draft route is skipped by validation, so set `draft: false` first.

Run `npm run validate`. Fix every problem it reports and run it again until it prints `OK`. Then run `npm test`; `tests/content/routes.test.ts` renders every route and fails on unresolved references or images.

## 5. Preview

Run `npm run dev`, open the route in the browser, and read it top to bottom. Check that code blocks, callouts, tables, images and references render as intended, and that the route appears on the landing page and in "Where to start". Give the owner the preview URL.

## 6. Commit

Commit the route. Push only when the owner asks; a push to `main` publishes the site.
