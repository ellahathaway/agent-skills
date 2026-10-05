# Review canvas

`.github\extensions\review-interaction` runs a graph of review agents and
collects their feedback on a canvas.

## Install

Run `.\install.ps1` from the repository root to install the review canvas
for your user. Keep this checkout at the same path, and reload extensions
or start a new Copilot session after updates.

## Flow

1. The implementer calls `review_start` with the user's request and the code
   to review.
2. Each reviewer on the canvas runs as a subagent. Reviewers with no
   connection between them run at the same time. A connection from A to B
   runs B after A succeeds.
3. Reviewers record findings with `review_add_comment`. Each comment keeps a
   snippet of the code as the reviewer saw it.
4. When the pass ends, the extension messages the implementer. The
   implementer reads `review_list_comments`, fixes the code or answers with
   `review_reply`, then calls `review_start` again.
5. On the next pass, each reviewer gets its own open comments and their
   replies. Only the reviewer that wrote a comment can resolve it, with
   `review_resolve_comment`.

The canvas shows the graph with live progress on each reviewer, and every
comment: open comments first, resolved comments last. **Run review** repeats
the last request.

Preset controls sit below the graph on the left, with **Run review** on the
right. The **+** button in the graph's bottom-right corner adds a reviewer.

## Reviewers

A reviewer is a prompt file, a model, and a reasoning effort. Hover over a
reviewer and click its pencil to edit it. The reviewer's prompt is the prompt
file, the review request, and instructions for the review tools.

Prompt file paths can be absolute, or relative to this extension's folder.
The included review prompts are in `reviews\`. Pasted paths from Windows
"Copy as path" work as is. Reviewers read their prompt file at the start of
every pass, so edits to it apply to the next pass.

Reviewers run in a workflow, because workflow agents are the only subagents
that accept a reasoning effort. Subagents can't call canvas actions, so the
review tools are extension tools.

## Presets

A preset is a saved graph. New sessions start from the **Default** preset,
which has one parallel reviewer per `.md` file in this extension's `reviews\`
folder. Saving over **Default** replaces it for every session.

The preset list shows the loaded preset. A bold name with `*` means the graph
has changes that aren't saved. **Save** writes them to the loaded preset, and
**Save as...** writes them to a new one. Switching presets with unsaved
changes asks whether to save them first.

## Storage

- This session's graph, loaded preset, last request, and comments:
  `<session workspace>\files\review.json`.
- Presets, shared by every session:
  `$COPILOT_HOME\extensions\review-interaction\artifacts\presets.json`.

## Tests

From the repository root: `node --test .github\extensions\review-interaction\*.test.mjs`.
