# Review interaction canvas

`.github\extensions\review-interaction` is a proof-of-concept Copilot canvas.
Reload extensions, then open the `review-interaction` canvas. Click **Start
review** to launch a real `code-review` subagent directly through
`session.rpc.tasks.startAgent`. The extension collects the task's result into
the panel using `session.rpc.tasks.list`. A spinner shows the reviewer working;
a checkmark shows a successful result. Start/stop entries are persisted with
`session.log` at info level.

Starting a review does not send the main agent a message. Once the review
stops, the extension queues a normal main-agent message containing the result
or failure. It does not use experimental notification injection. The runtime
may also emit its own native task-completion notification.

The reviewer reads the repository's root `README.md` without changing files.
It uses your normal subagent settings and AI credits. Only one request runs at
a time. Direct launch and result-collection failures are displayed in the
canvas, without falling back to the main agent. Closing the canvas does not
cancel a review. Log and completion-message delivery failures are shown
separately from the review result. If task monitoring fails, the canvas
reports that the reviewer may still be running rather than claiming it
finished. State is shared across this session's panels and resets on extension
reload.

Run the dependency-free checks from the repository root with:
`node --test .github\extensions\review-interaction\*.test.mjs`.
