import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

function failure(code, message) {
    return Object.assign(new Error(message), { code });
}

export class ReviewInteraction {
    constructor(api, { pollIntervalMs = 1000 } = {}) {
        this.api = api;
        this.pollIntervalMs = pollIntervalMs;
        this.state = { status: "idle", busy: false, warnings: [] };
    }

    snapshot() {
        return structuredClone(this.state);
    }

    async writeLog(message) {
        try {
            await this.api.log(message, { level: "info", ephemeral: false });
        } catch (error) {
            this.state.warnings.push(`Could not write the review log: ${error.message}`);
        }
    }

    async start(instanceId) {
        if (this.state.busy) throw failure("review_busy", "A review is already in progress.");
        const requestId = randomUUID();
        this.state = { requestId, instanceId, status: "starting", busy: true, warnings: [] };
        let agentId;
        try {
            ({ agentId } = await this.api.startAgent({
                agentType: "code-review",
                name: `canvas-review-${requestId}`,
                description: "Canvas review",
                prompt: [
                    "Read only README.md in the current worktree.",
                    "Review it for clarity and report at most one observation in three sentences or fewer, then stop.",
                    "Do not examine other files or branch diffs, edit files, launch other agents,",
                    "or ask the main agent to do any work.",
                ].join("\n"),
            }));
            if (!agentId) throw failure("review_launch_invalid", "The task RPC did not return an agent ID.");
        } catch (error) {
            this.state.status = "error";
            this.state.error = `Direct review launch failed: ${error.message}`;
            this.completion = this.reportStop();
            throw error;
        }
        this.state.agentId = agentId;
        this.state.startedAt = new Date().toISOString();
        this.state.status = "reviewing";
        this.completion = this.collect(agentId);
        return this.snapshot();
    }

    async collect(agentId) {
        await this.writeLog(`Review started. Agent: ${agentId}.`);
        let task;
        try {
            while (true) {
                const { tasks } = await this.api.list();
                task = tasks.find((entry) => entry.type === "agent" && entry.id === agentId);
                if (!task) throw new Error("The launched review task is no longer tracked by the runtime.");
                if (["completed", "idle", "failed", "cancelled"].includes(task.status)) break;
                if (task.status !== "running") throw new Error(`Unexpected review task status: ${task.status}`);
                await delay(this.pollIntervalMs);
            }
        } catch (error) {
            this.state.status = "error";
            this.state.error = `Review monitoring failed: ${error.message} The reviewer may still be running.`;
            await this.writeLog(`Review monitoring failed. Agent: ${agentId}. ${error.message}`);
            this.state.busy = false;
            return;
        }

        this.state.taskStatus = task.status;
        const summary = task.result?.trim() || task.latestResponse?.trim();
        if (task.status === "failed" || task.status === "cancelled") {
            this.state.status = "error";
            this.state.error = task.error ?? `The review task was ${task.status}.`;
        } else if (!summary) {
            this.state.status = "error";
            this.state.error = "The review task stopped without returning a result.";
        } else {
            this.state.status = "done";
            this.state.summary = summary;
        }
        await this.reportStop();
    }

    async reportStop() {
        this.state.completedAt = new Date().toISOString();
        this.state.notificationStatus = "pending";
        const outcome = this.state.status === "done" ? "Review finished" : "Review stopped with an error";
        await this.writeLog(`${outcome}. Request: ${this.state.requestId}. ${this.state.error ?? ""}`.trim());
        try {
            const messageId = await this.api.send({
                prompt: [
                    `${outcome}.`,
                    `Canvas: ${this.state.instanceId}. Request: ${this.state.requestId}.`,
                    this.state.summary ? `Reviewer result:\n${this.state.summary}` : `Error: ${this.state.error}`,
                    "The extension has already collected this result.",
                    "Briefly acknowledge it. Do not read or restart the reviewer, or edit files for this demo.",
                ].join("\n"),
                mode: "enqueue",
            });
            if (!messageId) throw new Error("The session did not return a completion-message ID.");
            this.state.notificationStatus = "sent";
            this.state.notificationMessageId = messageId;
        } catch (error) {
            this.state.notificationStatus = "failed";
            this.state.deliveryError = `Could not notify the main agent: ${error.message}`;
        } finally {
            this.state.busy = false;
        }
    }
}
