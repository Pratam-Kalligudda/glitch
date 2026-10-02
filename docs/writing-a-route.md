# Writing a route

This is the full guide to writing a route for Glitch. Read all of it before creating or
editing anything under `routes/`. `CLAUDE.md` holds the short rules; this file explains how
to apply them and what "good" looks like.

## 1. What a route is

A route takes one topic and turns it into a complete, hands-on walkthrough: from what the
reader already knows to building and shipping a real project with it. It is not an
overview, a cheat sheet or a list of links. Someone who finishes a route should be able to
use the topic at work without opening another tutorial first.

The bar is <https://harsh07may.github.io/build-routes/python-fastapi/>. That route starts
from Python essentials, teaches every tool the project needs (project setup, typing,
Pydantic, async, dependency injection, SQLAlchemy, Alembic, Redis, testing), and ends with
a seven-step capstone that grows one URL shortener from a 50-line file to a hardened,
containerised service.

### One topic, in depth

Pick one topic and go deep, rather than several topics thinly.

| Too vague | One topic, in depth |
|---|---|
| "Web development" | "Build REST APIs with FastAPI" |
| "Learn Docker" (commands only) | "Containers with Docker and Compose", from images to a multi-service app |
| "Databases" | "PostgreSQL for application developers" |
| "Git" (init, commit, push) | "Git for working on a team": history, branching, rebasing, recovery, review |

### No size limit

There is no target or maximum number of parts, stops, words or capstone steps. A route is
as long as its topic needs: a small tool may take a dozen stops, a large framework a
hundred. The measure is completeness, not length. A route is finished when a reader who
starts from the stated baseline can do the stated outcome without another tutorial.

Length is managed by granularity, not by cutting: one idea per stop, as many stops as
there are ideas, grouped into as many parts as the topic has stages. The reader learns them
one by one, in order. Never drop, merge or skim a concept to make a route shorter.

## 2. Before writing

1. **Define the outcome.** One sentence: "At the end you can ...". It must name something
   the reader can build or do, not something they "understand".
2. **Define the reader.** What they already know, and what they do not. Anything the route
   relies on and the reader may lack goes in a prerequisites part (see 3.1), or in another
   route listed under `prerequisites`.
3. **Design the capstone first.** Choose one real project that needs most of the topic.
   List its features. Every part of the route then exists to teach something the capstone
   uses. When the topic has an important concept the capstone does not use yet, extend the
   capstone with a step that uses it rather than leaving the concept out.
4. **Research against official sources.** Read the current official documentation for
   every tool. Note the versions you will pin. Do not write commands or APIs from memory
   alone; run them where you can.
5. **Outline, then get approval.** Write the outline (section 8) and have the owner
   approve it before writing any stop.

## 3. The shape of a route

Order parts from foundations to application. The FastAPI route is one example; use as
many parts as the topic has stages:

| Part | Purpose | Example (FastAPI route) |
|---|---|---|
| 1. Prerequisites | Only what the reader may lack and the route needs | Python essentials: mutability, f-strings, unpacking, closures |
| 2. Foundations | The language or platform features the topic leans on | Project setup with uv, modules, exceptions, context managers, decorators, generators, pytest |
| 3. Core toolkit | The topic itself, one concept per stop | Type hints, Pydantic, settings, async, routing, dependencies, testing endpoints |
| 4. Real-world concerns | What production needs | Postgres, SQLAlchemy, migrations, Redis, caching |
| Capstone | One project, built in steps | URL shortener: in-memory, validated, structured and tested, persisted, cached, hardened, shipped |

### 3.1 Prerequisites part

Include one when the topic sits on something many readers half-know. Teach only the
pieces the route uses, at the depth it uses them. "Names, mutability and truthiness"
belongs in a FastAPI route because later stops rely on it; "the history of Python" does
not.

### 3.2 Ordering rules

- A stop may only rely on earlier stops (or a prerequisite route).
- When a stop prepares for a later one, say so in a sentence: "FastAPI dependencies use
  exactly this pattern; see [[dependencies]]."
- Group stops so that each part has one goal you can state in a line. That line is the
  part's `goal`.

## 4. Files and folders

```
routes/<route-slug>/
  route.yaml
  assets/                       optional images, referenced by filename
  01-<part-id>/
    part.md
    01-<stop-id>.md
    02-<stop-id>.md
  02-<part-id>/
    ...
  05-capstone/
    part.md                     kind: capstone
    01-spec.md
    02-step-1-<name>.md
    03-step-2-<name>.md
```

- The folder name is the slug: lowercase letters, digits and single hyphens.
- Numeric prefixes set the order and are not part of the id. The stop id is the file name
  without prefix and `.md`: `03-closures.md` has the id `closures`.
- A stop id is the page anchor and the key under which progress is saved. Choose it once;
  renaming the file later loses readers' progress for that stop.
- In a capstone, a stop whose id starts with `step-` is a step and must have `done_when`.

### 4.1 route.yaml

```yaml
title: FastAPI from zero to production
number: 3
summary: "Build, test and ship REST APIs with FastAPI, Pydantic and PostgreSQL. Capstone: a URL shortener with caching and auth."
hero: From a Python file to a service in a container.
lede: Thirty-two stops, each one idea with code you run. Then one project, built in seven steps.
prerequisites: [python-basics]
checked: 2026-10
draft: true
```

| Field | Required | Notes |
|---|---|---|
| `title` | yes | Shown on the route card and page |
| `number` | yes | Unique. Sets the order on the landing page |
| `summary` | yes | One or two sentences, ending with "Capstone: ..." |
| `hero` | no | The big headline on the route page |
| `lede` | no | One or two sentences under the headline |
| `prerequisites` | no | Route slugs to read first; each must have a lower `number` |
| `checked` | no | `YYYY-MM` when the commands were last verified |
| `draft` | no | `true` hides the route and skips validation |

Quote any value that contains `: `.

### 4.2 part.md

````markdown
---
title: The FastAPI toolkit
goal: Declare, validate and configure data the way FastAPI expects.
---
FastAPI is mostly type hints doing work. This part covers the three pieces that make
that possible before you write a single endpoint.
````

The body is optional: two or three sentences on why this part exists and how it connects
to the parts around it. A capstone part adds `kind: capstone`.

## 5. Writing a stop

A stop teaches **one idea, completely**. "One idea" decides where a stop ends and the next
begins; "completely" means it takes as much explanation and as many examples as that idea
needs, however long that is. The reader should finish a stop able to use the idea, knowing
why it works the way it does, and knowing the mistake people usually make with it.

### 5.1 Anatomy

Use these elements in this order. Not every stop needs every element, but every stop needs
the first three.

1. **What and why** (required). Name the idea, say what problem it solves, and define any
   new term on first use.
2. **A working example** (required). Complete and runnable: imports included, nothing
   elided with `...` that the reader would need to type. Use `title="path/to/file"` when
   the code is a file. Show the command to run it and its output when the output teaches
   something.
3. **How it works** (required). What happens when the example runs, step by step if the
   order matters. This is where depth lives: the rule behind the behaviour, not only the
   behaviour.
4. **A second example** (when useful). The common variation, the real-world form, or how
   the idea is used by the route's main tool.
5. **Watch out** (when there is a common mistake). A `> [!WARNING]` callout naming the
   mistake, its symptom, and the fix.
6. **Reference table** (when there are several related options). Command or option, and
   what it does.
7. **Note** (optional). A `> [!NOTE]` for a version difference, a related tool or a pointer
   to official docs.
8. **Forward link** (when it applies). One sentence on where this idea returns later.

### 5.2 Front matter

```yaml
---
title: Dependency injection with Depends
done_when: "A request without the header returns 401, and the test for it passes."
---
```

`title` is required. `done_when` is optional in ordinary stops; use it when the stop ends
with something the reader can check. It is required in capstone steps.

### 5.3 A complete stop

````markdown
---
title: Mutable default arguments
---
A default value is evaluated once, when the function is defined, not each time it is
called. For numbers and strings that never matters. For a list or a dict it means every
call shares the same object.

```python title="defaults.py"
def add_tag(tag, tags=[]):
    tags.append(tag)
    return tags

print(add_tag("a"))
print(add_tag("b"))
```

```bash
python defaults.py
```

```text
['a']
['a', 'b']
```

The second call did not start with an empty list. Python created `tags=[]` once, when it
ran the `def` statement, and stored it on the function. Both calls appended to that one
list.

Use `None` as the default and create the object inside the function:

```python title="defaults.py"
def add_tag(tag, tags=None):
    if tags is None:
        tags = []
    tags.append(tag)
    return tags
```

> [!WARNING]
> The bug only shows on the second call, so a single test passes. In a web app the shared
> list lives as long as the process: data from one request leaks into the next.

FastAPI request models avoid this problem by copying defaults per request; you will see
why in [[pydantic]].
````

### 5.4 Vague versus in depth

| Vague | In depth |
|---|---|
| "Use `async def` for async endpoints." | Explains the event loop, what blocks it, what happens to a sync `def` endpoint (thread pool), and shows a blocking call freezing other requests |
| A snippet with `...` in the middle | A complete file the reader can run, plus the command and the output |
| "Indexes make queries faster." | Shows `EXPLAIN` before and after, says when an index is not used, and what it costs on writes |
| "Be careful with mutable defaults." | Shows the bug, its output, why it happens, the fix, and where it bites in a real app |
| "See the docs for more." | States the rule here; links to the docs only for further reading |

### 5.5 Style

- Address the reader as "you". Present tense, active voice, short sentences.
- Explain why, not only how. Every rule gets its reason.
- Define a term the first time you use it. Do not use a term before its stop.
- Show real output. If the reader will see an error, show the error text.
- Pin versions in install commands (`uv add fastapi==0.115.*`, `image: postgres:17`).
- Use the same project names, file names and variables across stops, so examples feel
  continuous.
- No filler: no "In this stop we will learn", no "Simply", no "As you can see".
- Link back with `[[stop-id]]` instead of re-explaining; link to another route with
  `[[route-slug/stop-id]]`. The link text becomes the target's title.

## 6. The capstone

The capstone is one project, built in steps. Each step adds a capability to the same code;
no step throws earlier work away. By the end the reader has used almost every part of the
route on something real.

### 6.1 Choosing the project

- It must need most of the route. List each part and the capstone feature that uses it.
- It must be one project, grown step by step, so the reader always has something running.
- It must be real: something the reader could keep using or show to someone.

### 6.2 The spec stop

The first capstone stop, `01-spec.md`, describes what will be built and how to check it.

````markdown
---
title: The spec
---
You will build a URL shortener: a service that turns a long URL into a short code and
redirects anyone who visits the code.

| Endpoint | Does |
|---|---|
| `POST /links` | Create a short code for a URL |
| `GET /{code}` | Redirect to the URL |
| `GET /links/{code}` | Show the link and its visit count |
| `DELETE /links/{code}` | Remove the link |

| Requirement | How to check |
|---|---|
| Invalid URLs are rejected with 422 | `curl -X POST ... -d '{"url": "nope"}'` |
| Codes survive a restart | Restart the service, then visit a code |
| Popular codes are served from Redis | The service log shows a cache hit |
| Only callers with the API key can create links | A request without the key gets 401 |
| The service runs with one command | `docker compose up` |

Stack: Python 3.13, FastAPI 0.115, SQLAlchemy 2.0, PostgreSQL 17, Redis 7.
````

### 6.3 Steps

One common progression, adapted to the topic. Add as many steps as the project needs; a
large topic may need several steps for each stage:

1. **Minimal working version.** Everything in one file, in-memory.
2. **Validation and errors.** Reject bad input; return useful errors.
3. **Structure and tests.** Split into modules; lock behaviour with tests before larger
   changes.
4. **Persistence.** Replace in-memory state with a real store.
5. **Performance.** Caching, indexes, or whatever the topic offers.
6. **Hardening.** Authentication, limits, expiry, edge cases.
7. **Ship it.** Package and run it the way it would run for real.

Each step file contains, in order:

1. One sentence on what this step adds.
2. "Do this yourself first, then compare." followed by a numbered task list, each item
   pointing to the stop that taught it with `[[stop-id]]`.
3. The code **as it stands at the end of the step**: complete files with `title=`, so the
   reader can compare or catch up.
4. How to run and check it: commands and the expected output.
5. `done_when` in the front matter: concrete and observable, never "you understand X".

````markdown
---
title: "Step 4: persistence"
done_when: "Links created before `docker compose restart api` still redirect, and `pytest` passes against the test database."
---
Links now live in PostgreSQL instead of a dict, so they survive restarts.

Do this yourself first, then compare.

1. Start Postgres with Compose as in [[local-services]].
2. Define the `Link` model and session as in [[sqlalchemy]].
3. Move every database write into the service layer as in [[services-own-transactions]].
4. Create the first migration with Alembic as in [[migrations]].
5. Point the tests at a separate database.

```python title="app/models.py"
from datetime import datetime

from sqlalchemy import String, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Link(Base):
    __tablename__ = "links"

    code: Mapped[str] = mapped_column(String(12), primary_key=True)
    url: Mapped[str] = mapped_column(String(2048))
    visits: Mapped[int] = mapped_column(default=0)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
```

Run it:

```bash
docker compose up -d db
alembic upgrade head
uvicorn app.main:app --reload
```
````

## 7. Markdown that renders

| Feature | Syntax | Notes |
|---|---|---|
| Code block | ` ```python ` | Every fence names a language (`bash`, `text`, `yaml`, ...) |
| File name on a block | ` ```python title="app/main.py" ` | Use for every file the reader creates |
| Fence inside a fence | Four backticks outside | |
| Note | `> [!NOTE]` on its own line, then `> text` | Background, versions, pointers |
| Warning | `> [!WARNING]` | Common mistakes and their symptoms |
| Same-route link | `[[stop-id]]` | Text becomes the stop's title |
| Other-route link | `[[route-slug/stop-id]]` | |
| Image | `![Alt text](diagram.svg)` | File lives in the route's `assets/` folder |
| Table | GitHub-flavoured Markdown | Commands, options, requirements |

Raw HTML is shown as text, never rendered. Links may use `http:`, `https:`, `mailto:`,
relative paths or `#` anchors; any other scheme fails validation.

## 8. The outline to propose

Before writing, present this to the owner and wait for approval:

```text
Slug:          fastapi
Title:         FastAPI from zero to production
Number:        3
Summary:       Build, test and ship REST APIs ... Capstone: a URL shortener ...
Reader knows:  Basic Python syntax; has used a terminal.
Outcome:       You can design, test and deploy a FastAPI service backed by Postgres and Redis.
Prerequisites: python-basics (or none)

Part 1  Python essentials        goal: ...
  names-and-mutability       Names, mutability and truthiness
  f-strings                  Strings and f-strings
  ...
Part 2  ...
Capstone  URL shortener
  spec                       The spec
  step-1-in-memory           Step 1: in-memory        done_when: ...
  ...

Capstone coverage:
  Part 1 -> step 2 (validation relies on truthiness, unpacking)
  Part 3 -> steps 1-3
  ...
```

The coverage list shows that every part is used by the capstone.

## 9. Checklist

Before calling a route done:

- [ ] One topic, covered completely: every concept the outcome needs has a stop.
- [ ] Every stop has what-and-why, a complete runnable example, and how it works.
- [ ] Common mistakes are in `[!WARNING]` callouts with symptom and fix.
- [ ] Every command and API checked against official docs; versions pinned; `checked`
      set to the current month.
- [ ] No stop uses a term or tool before the stop that introduces it.
- [ ] Every capstone step lists tasks with `[[...]]` links, shows full code at the end of
      the step, and has an observable `done_when`.
- [ ] Every part is used by the capstone.
- [ ] `draft` removed (or `false`), then `npm run validate` prints `OK` and `npm test`
      passes.
- [ ] Read top to bottom in `npm run dev`: code, callouts, tables, images and links render.
