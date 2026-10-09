# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Read this procedure before implementing a ticket or operating on issues. Use the `gh` CLI for all operations; infer the repository from the clone's existing remote, as `gh` does when run inside it.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body-file <file>`. Write multiline bodies to a temporary file with literal text and actual newlines.
- **Read an issue**: `gh issue view <number> --json title,body,labels,comments,state`. Use `--jq` to filter the JSON output when needed.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body-file <file>`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Use the label strings in [triage-labels.md](triage-labels.md) when assigning triage roles.

## Link every commit to the ticket it satisfies

A commit that satisfies a ticket carries `Closes #<n>` as a trailer; one that advances a ticket it does not finish carries `Refs #<n>`. Put trailers at the end of the message body, one issue per line. Name the completed child tickets as well as the parent when a branch implements a parent whole. This preserves the ticket decomposition and enables closure when the work is merged into the default branch.

Historical reason: fifteen commits between #12 and #26 carried trailers, while the #27 and #29 branches omitted them. All seven of #29's child tickets remained open after the work was merged, and later investigation found the work already implemented. Closing a parent manually does not close its children.

## Before implementing a ticket, check whether `main` already satisfies it

Read the ticket's acceptance criteria and compare them with `main` before writing code. If the work is already satisfied, identify the implementation and verification evidence rather than rebuilding it. An open ticket alone does not establish unfinished work.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs. Resolve a bare `#42` with `gh pr view 42`, falling back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Apply this section when `/wayfinder` coordinates work. The **map** is a single issue with **child** issues as tickets; ordinary issue work uses the conventions above.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: use GitHub's native issue dependencies as the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, not the issue number or `node_id`). GitHub reports open blockers in `issue_dependencies_summary.blocked_by`. Where dependencies are unavailable, add `Blocked by: #<n>, #<n>` at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children (`gh issue list --state open`, scoped to the map's sub-issues / task list), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: assign the ticket with `gh issue edit <n> --add-assignee @me` as the session's first write.
- **Resolve**: publish the answer with `gh issue comment <n> --body-file <file>`, close the completed ticket with `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.
