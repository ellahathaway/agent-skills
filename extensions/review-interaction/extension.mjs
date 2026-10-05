import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, defineWorkflow, joinSession } from "@github/copilot-sdk/extension";
import { Review } from "./review.mjs";
import { startServer } from "./server.mjs";

// Reviewers run inside a workflow because only workflow agents accept a
// reasoning effort. Subagents can call extension tools but not canvas
// actions, so reviewers record comments with the tools below.
const reviewWorkflow = defineWorkflow({
    meta: {
        name: "review-interaction-pass",
        description: "Runs the reviewers configured on the review canvas. Use the review_start tool instead of running this directly.",
        phases: [{ title: "Review" }],
    },
    run: async (ctx) => {
        const review = await reviewReady;
        await review.runPass(ctx.runId, (prompt, options) => ctx.agent(prompt, options));
    },
});

function tool(name, description, properties, required, handler) {
    return {
        name,
        description,
        parameters: { type: "object", properties, required, additionalProperties: false },
        handler: async (args) => handler(await reviewReady, args),
    };
}

const reviewer = { type: "string", description: "Your reviewer ID, from your instructions." };
const commentId = { type: "string", description: "The comment ID, for example c3." };

const tools = [
    tool(
        "review_start",
        "Start a review pass. Each reviewer on the review canvas runs as a subagent and records comments there. "
            + "You get a message when the pass finishes. Open the review-interaction canvas so the user can follow along.",
        {
            request: { type: "string", description: "The user's request." },
            scope: { type: "string", description: "The code to review: for example all unstaged changes, a commit SHA, or a list of files." },
        },
        ["request", "scope"],
        async (review, args) => {
            await review.start(args);
            return "Review started. You will get a message when it finishes.";
        },
    ),
    tool(
        "review_list_comments",
        "List every review comment with its code snippet and replies. Open comments come first.",
        {},
        [],
        (review) => review.listComments(),
    ),
    tool(
        "review_reply",
        "Reply to a review comment. The implementer explains a fix or disagrees. Reviewers pass their reviewer ID.",
        {
            id: commentId,
            body: { type: "string", description: "The reply." },
            reviewer: { ...reviewer, description: "Reviewers only: your reviewer ID. The implementer leaves this out." },
        },
        ["id", "body"],
        async (review, args) => {
            await review.reply(args);
            return `Replied to ${args.id}.`;
        },
    ),
    tool(
        "review_add_comment",
        "Reviewers only: record one review finding on the review canvas.",
        {
            reviewer,
            file: { type: "string", description: "Path relative to the repository root." },
            line: { type: "integer", minimum: 1, description: "The line the finding is about." },
            endLine: { type: "integer", minimum: 1, description: "The last line, for a finding about a range of lines." },
            body: { type: "string", description: "The finding." },
        },
        ["reviewer", "file", "line", "body"],
        async (review, args) => `Added ${(await review.addComment(args)).id}.`,
    ),
    tool(
        "review_resolve_comment",
        "Reviewers only: mark one of your own comments resolved once it is addressed.",
        { reviewer, id: commentId, note: { type: "string", description: "How it was addressed." } },
        ["reviewer", "id"],
        async (review, args) => {
            await review.resolveComment(args);
            return `Resolved ${args.id}.`;
        },
    ),
];

const servers = new Map();

const sessionReady = joinSession({
    tools,
    workflows: [reviewWorkflow],
    canvases: [
        createCanvas({
            id: "review-interaction",
            displayName: "Review",
            description: "Configure review agents as a graph, watch them run, and read the comments they leave.",
            inputSchema: { type: "object", additionalProperties: false },
            open: async (ctx) => {
                const review = await reviewReady;
                await review.refresh();
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = await startServer(review);
                    servers.set(ctx.instanceId, entry);
                }
                return { title: "Review", url: entry.url };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (entry) {
                    servers.delete(ctx.instanceId);
                    await entry.close();
                }
            },
        }),
    ],
});

const copilotHome = process.env.COPILOT_HOME ?? join(homedir(), ".copilot");

const reviewReady = sessionReady.then((session) => Review.load({
    root: process.cwd(),
    extensionDir: dirname(fileURLToPath(import.meta.url)),
    sessionFile: session.workspacePath && join(session.workspacePath, "files", "review.json"),
    presetsFile: join(copilotHome, "extensions", "review-interaction", "artifacts", "presets.json"),
    api: {
        startWorkflow: () => session.workflow.run(reviewWorkflow, { notifyOnComplete: false }),
        cancelWorkflow: (runId) => session.workflow.cancel(runId),
        notify: (prompt) => session.send({ prompt, mode: "enqueue" }),
        listModels: async () => {
            try {
                const { list } = await session.rpc.model.list();
                return list.map((model) => ({
                    id: model.id,
                    name: model.name,
                    efforts: model.capabilities?.supports?.reasoning_effort ?? [],
                }));
            } catch (error) {
                await session.log(`The review canvas could not list models: ${error.message}`, { level: "warning" });
                return [];
            }
        },
    },
}));

await reviewReady;
