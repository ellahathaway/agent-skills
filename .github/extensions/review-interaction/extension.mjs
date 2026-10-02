import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";
import { ReviewInteraction } from "./review.mjs";
import { startServer } from "./server.mjs";

const servers = new Map();
let session;

function currentSession() {
    if (!session) throw new Error("The extension is reconnecting. Try again in a moment.");
    return session;
}

const review = new ReviewInteraction({
    startAgent: (options) => currentSession().rpc.tasks.startAgent(options),
    list: () => currentSession().rpc.tasks.list(),
    log: (message, options) => currentSession().log(message, options),
    send: (options) => currentSession().send(options),
});

function handle(operation) {
    return async (ctx) => {
        try {
            return await operation(ctx);
        } catch (error) {
            throw new CanvasError(error.code ?? "review_interaction_failed", error.message);
        }
    };
}

session = await joinSession({
    canvases: [
        createCanvas({
            id: "review-interaction",
            displayName: "Review interaction",
            description: "Start a review subagent, show its progress and result, and message the main agent when it stops.",
            inputSchema: { type: "object", additionalProperties: false },
            actions: [
                {
                    name: "get_status",
                    description: "Read the review status, result, and completion-message delivery status.",
                    handler: () => review.snapshot(),
                },
                {
                    name: "start_review",
                    description: "Launch a review directly through the task RPC, just like the canvas button.",
                    handler: handle((ctx) => review.start(ctx.instanceId)),
                },
            ],
            open: async (ctx) => {
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = await startServer(review, ctx.instanceId);
                    servers.set(ctx.instanceId, entry);
                }
                return { title: "Review interaction", url: entry.url };
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
