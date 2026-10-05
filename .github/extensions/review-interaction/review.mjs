import { statSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { runGraph, validateGraph } from "./graph.mjs";

const SNIPPET_CONTEXT_LINES = 2;
const SNIPPET_MAX_LINES = 20;
const DEFAULT_PRESET = "Default";

function failure(code, message) {
    return Object.assign(new Error(message), { code });
}

function isFile(path) {
    try {
        return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
    } catch {
        return false;
    }
}

async function readJson(path, fallback) {
    try {
        return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
        if (error.code === "ENOENT") return fallback;
        throw error;
    }
}

async function writeJson(path, value) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(value, null, 2));
}

async function listPrompts(extensionDir) {
    try {
        const files = await readdir(join(extensionDir, "reviews"));
        return files.filter((file) => file.endsWith(".md")).sort().map((file) => `reviews/${file}`);
    } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
    }
}

// One reviewer per prompt file. No connections, so they all run in parallel.
function defaultGraph(prompts) {
    const nodes = prompts.map((prompt, index) => {
        const id = basename(prompt, ".md");
        const name = id[0].toUpperCase() + id.slice(1);
        return { id, name, prompt, model: "", effort: "", x: 32, y: 32 + index * 96 };
    });
    return { nodes, edges: [] };
}

function displayPath(root, path) {
    const inRoot = relative(root, path);
    const outside = inRoot.startsWith("..") || isAbsolute(inRoot);
    return (outside ? path : inRoot).split(sep).join("/");
}

function formatComment(comment) {
    const range = comment.endLine > comment.line ? `${comment.line}-${comment.endLine}` : `${comment.line}`;
    const snippet = comment.snippet.lines.map((text, index) => {
        const number = comment.snippet.start + index;
        const marker = number >= comment.line && number <= comment.endLine ? ">" : " ";
        return `  ${marker} ${number} | ${text}`;
    });
    const replies = comment.replies.map((reply) => `  ${reply.author}: ${reply.body}`);
    const resolution = comment.status === "resolved" ? [`  Resolved: ${comment.resolution ?? "(no note)"}`] : [];

    return [
        `${comment.id} [${comment.status}] ${comment.reviewerName} on ${comment.file}:${range}`,
        ...snippet,
        `  ${comment.body}`,
        ...replies,
        ...resolution,
    ].join("\n");
}

// Review state for one session: the reviewer graph, the comments that
// reviewers leave, and the progress of the current review pass.
export class Review {
    listeners = new Set();
    saving = Promise.resolve();
    run = { status: "idle", nodes: {} };

    // root: the repository. Commented files are relative to it.
    // extensionDir: this extension's folder. Relative prompt file paths start here.
    // sessionFile: this session's graph, preset, last request, and comments. Optional.
    // presetsFile: graphs saved by name, shared by every session.
    // api: { startWorkflow(), cancelWorkflow(runId), notify(message), listModels() }
    static async load({ root, extensionDir, sessionFile, presetsFile, api }) {
        const review = new Review();
        Object.assign(review, { root, extensionDir, sessionFile, presetsFile, api });
        await review.refresh();

        const saved = sessionFile ? await readJson(sessionFile, {}) : {};
        if (saved.graph) {
            review.graph = validateGraph(saved.graph);
            review.preset = saved.preset;
        } else {
            review.usePreset(DEFAULT_PRESET);
        }
        review.request = saved.request;
        review.comments = saved.comments ?? [];
        review.pass = saved.pass ?? 0;

        review.models = await api.listModels();
        return review;
    }

    snapshot() {
        return structuredClone({
            extensionDir: this.extensionDir,
            graph: this.graph,
            preset: this.preset,
            modified: this.isModified(),
            request: this.request,
            run: this.run,
            comments: this.sortedComments(),
            presets: this.presets.map((preset) => preset.name),
            models: this.models,
            prompts: this.prompts,
            missingPrompts: this.graph.nodes.filter((node) => !isFile(this.promptPath(node))).map((node) => node.id),
        });
    }

    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    changed() {
        for (const listener of this.listeners) listener();
    }

    // Saves one at a time, so two quick changes can't interleave in the file.
    save() {
        this.changed();
        if (!this.sessionFile) return;

        const saved = structuredClone({
            graph: this.graph,
            preset: this.preset,
            request: this.request,
            comments: this.comments,
            pass: this.pass,
        });
        this.saving = this.saving.catch(() => {}).then(() => writeJson(this.sessionFile, saved));
        return this.saving;
    }

    async setGraph(graph) {
        this.graph = validateGraph(graph);
        await this.save();
    }

    // Other sessions can save presets, and the user can add prompt files,
    // so read both again before showing them.
    async refresh() {
        this.prompts = await listPrompts(this.extensionDir);

        const saved = (await readJson(this.presetsFile, []))
            .map((preset) => ({ name: preset.name, graph: validateGraph(preset.graph) }));

        // A saved preset named "Default" replaces the included one.
        const included = { name: DEFAULT_PRESET, graph: defaultGraph(this.prompts) };
        const replaced = saved.some((preset) => preset.name === included.name);
        this.presets = replaced ? saved : [included, ...saved];
        this.presets.sort((a, b) => a.name.localeCompare(b.name));
        this.changed();
    }

    // True when the graph has changes that aren't saved to its preset.
    isModified() {
        const preset = this.presets.find((preset) => preset.name === this.preset);
        return !preset || JSON.stringify(preset.graph) !== JSON.stringify(this.graph);
    }

    // Save and "Save as" both land here. Save passes the current preset's name.
    async savePreset(name) {
        name = name?.trim();
        if (!name) throw failure("invalid_preset", "Give the preset a name.");

        const saved = (await readJson(this.presetsFile, [])).filter((preset) => preset.name !== name);
        saved.push({ name, graph: this.graph });
        await writeJson(this.presetsFile, saved);

        this.preset = name;
        await this.refresh();
        await this.save();
    }

    usePreset(name) {
        const preset = this.presets.find((preset) => preset.name === name);
        if (!preset) throw failure("preset_not_found", `There is no preset named "${name}".`);
        this.graph = structuredClone(preset.graph);
        this.preset = name;
    }

    async loadPreset(name) {
        this.usePreset(name);
        await this.save();
    }

    async start({ request, scope }) {
        if (this.run.status === "running") throw failure("review_busy", "A review is already running.");
        if (!request?.trim() || !scope?.trim()) {
            throw failure("invalid_request", "Say what the user asked for and which code to review.");
        }
        if (!this.graph.nodes.length) throw failure("no_reviewers", "Add a reviewer on the review canvas first.");

        this.request = { request: request.trim(), scope: scope.trim() };
        this.pass++;
        this.passGraph = structuredClone(this.graph);
        const waiting = this.graph.nodes.map((node) => [node.id, { status: "waiting" }]);
        this.run = { status: "running", pass: this.pass, nodes: Object.fromEntries(waiting) };
        await this.save();

        this.finished = this.api.startWorkflow().then(
            (result) => this.finish(workflowError(result)),
            (error) => this.finish(error.message),
        );
    }

    async restart() {
        if (!this.request) throw failure("no_request", "Ask the agent to start the first review.");
        await this.start(this.request);
    }

    async stop() {
        if (this.run.status !== "running") return;
        if (!this.run.runId) throw failure("review_starting", "The review is still starting. Try again in a moment.");
        await this.api.cancelWorkflow(this.run.runId);
    }

    // The review workflow calls this. runAgent(prompt, options) resolves to the
    // reviewer's final reply, or to null when the reviewer failed.
    async runPass(runId, runAgent) {
        if (this.run.status !== "running") throw failure("not_started", "Start reviews with the review_start tool.");
        this.run.runId = runId;

        await runGraph(this.passGraph, async (node) => {
            this.setNodeStatus(node.id, { status: "running" });
            try {
                const prompt = await this.reviewerPrompt(node);
                const result = await runAgent(prompt, {
                    label: `${node.id} pass ${this.run.pass}`,
                    model: node.model || undefined,
                    reasoningEffort: this.supportedEffort(node),
                });
                if (result === null) throw new Error("The reviewer stopped without finishing.");

                this.setNodeStatus(node.id, { status: "done" });
                return true;
            } catch (error) {
                this.setNodeStatus(node.id, { status: "failed", error: error.message });
                return false;
            }
        });
    }

    setNodeStatus(id, status) {
        this.run.nodes[id] = status;
        this.changed();
    }

    // A reviewer fails without an error message when its model doesn't
    // support the requested effort, so only pass an effort the model lists.
    supportedEffort(node) {
        const model = this.models.find((model) => model.id === node.model);
        return model?.efforts.includes(node.effort) ? node.effort : undefined;
    }

    async finish(error) {
        for (const node of Object.values(this.run.nodes)) {
            if (node.status === "waiting") node.status = "skipped";
        }
        this.run.status = error ? "failed" : "done";
        this.run.error = error;
        this.changed();

        try {
            await this.api.notify(this.passSummary());
        } catch (notifyError) {
            this.run.error = [error, `Could not message the agent: ${notifyError.message}`].filter(Boolean).join("\n");
            this.changed();
        }
    }

    passSummary() {
        const open = this.comments.filter((comment) => comment.status === "open").length;
        const failed = this.passGraph.nodes
            .filter((node) => this.run.nodes[node.id].status === "failed")
            .map((node) => node.name);

        const lines = [`Review pass ${this.run.pass} finished.`];
        if (this.run.error) lines.push(`The review stopped early: ${this.run.error}`);
        if (failed.length) lines.push(`These reviewers failed: ${failed.join(", ")}. The review canvas shows why.`);
        if (open) {
            lines.push(
                `${open} review comment(s) are open. Call review_list_comments to read them.`,
                "Fix each one, or answer it with review_reply if you disagree.",
                "Then call review_start again so the reviewers can check your work and resolve their comments.",
            );
        } else {
            lines.push("No review comments are open.");
        }
        return lines.join("\n");
    }

    // An absolute path is used as is. A relative path starts at the extension's folder.
    promptPath(node) {
        return resolve(this.extensionDir, node.prompt);
    }

    async reviewerPrompt(node) {
        let definition;
        try {
            definition = await readFile(this.promptPath(node), "utf8");
        } catch {
            throw new Error(`Could not read the prompt file "${node.prompt}".`);
        }

        const id = JSON.stringify(node.id);
        const lines = [
            definition.trim(),
            "",
            "## Review request",
            "",
            `The user's request: ${this.request.request}`,
            `The code to review: ${this.request.scope}`,
            "",
            "## Recording feedback",
            "",
            `You are reviewer ${id}. Record your feedback with these tools, not in your final reply:`,
            "",
            `- review_add_comment: record one finding. Pass reviewer ${id}, the file path relative to ${this.root}, the line (and endLine for a range), and the comment.`,
            `- review_resolve_comment: pass reviewer ${id} and the comment ID when one of your comments is addressed.`,
            `- review_reply: pass reviewer ${id} to answer the implementer on a comment that stays open.`,
            "- review_list_comments: read every comment, including other reviewers' comments.",
            "",
            "Do not edit files. When you finish, reply with one line that summarizes your review.",
        ];

        const open = this.comments.filter((comment) => comment.reviewer === node.id && comment.status === "open");
        if (open.length) {
            lines.push(
                "",
                "## Your open comments from earlier passes",
                "",
                ...open.map(formatComment),
                "",
                "Check each one. Resolve it if the code or the implementer's reply addresses it.",
                "Otherwise keep it open, and reply if the implementer disagreed. Don't add a duplicate of an open comment.",
            );
        }
        return lines.join("\n");
    }

    reviewerFor(id) {
        const node = this.passGraph?.nodes.find((node) => node.id === id);
        if (!node) throw failure("unknown_reviewer", `${JSON.stringify(id)} isn't a reviewer in the current review pass.`);
        return node;
    }

    findComment(id) {
        const comment = this.comments.find((comment) => comment.id === id);
        if (!comment) throw failure("comment_not_found", `There is no comment ${JSON.stringify(id)}.`);
        return comment;
    }

    async addComment({ reviewer, file, line, endLine = line, body }) {
        const node = this.reviewerFor(reviewer);
        if (!body?.trim()) throw failure("invalid_comment", "The comment is empty.");

        const path = resolve(this.root, file);
        let lines;
        try {
            lines = (await readFile(path, "utf8")).split(/\r?\n/);
        } catch {
            throw failure("file_not_found", `Could not read "${file}". Use a path relative to ${this.root}.`);
        }

        const validRange = Number.isInteger(line) && Number.isInteger(endLine) && line >= 1 && endLine >= line;
        if (!validRange || line > lines.length) {
            throw failure("invalid_line", `"${file}" has ${lines.length} lines. Use 1 <= line <= endLine.`);
        }
        endLine = Math.min(endLine, lines.length);

        // Keep a copy of the code as the reviewer saw it, because the implementer will change the file.
        const start = Math.max(1, line - SNIPPET_CONTEXT_LINES);
        const lastShown = Math.min(endLine, line + SNIPPET_MAX_LINES - 1);
        const end = Math.min(lines.length, lastShown + SNIPPET_CONTEXT_LINES);

        const comment = {
            id: `c${this.comments.length + 1}`,
            reviewer: node.id,
            reviewerName: node.name,
            file: displayPath(this.root, path),
            line,
            endLine,
            snippet: { start, lines: lines.slice(start - 1, end) },
            body: body.trim(),
            status: "open",
            replies: [],
            createdAt: new Date().toISOString(),
        };
        this.comments.push(comment);
        await this.save();
        return comment;
    }

    async resolveComment({ reviewer, id, note }) {
        const node = this.reviewerFor(reviewer);
        const comment = this.findComment(id);
        if (comment.reviewer !== node.id) {
            throw failure("not_your_comment", `${id} belongs to ${comment.reviewerName}. Only that reviewer can resolve it.`);
        }

        comment.status = "resolved";
        comment.resolution = note?.trim() || undefined;
        comment.resolvedAt = new Date().toISOString();
        await this.save();
        return comment;
    }

    // Reviewers pass their ID. The implementer leaves it out.
    async reply({ id, body, reviewer }) {
        const author = reviewer ? this.reviewerFor(reviewer).name : "Implementer";
        const comment = this.findComment(id);
        if (!body?.trim()) throw failure("invalid_reply", "The reply is empty.");

        comment.replies.push({ author, body: body.trim(), createdAt: new Date().toISOString() });
        await this.save();
        return comment;
    }

    sortedComments() {
        const open = this.comments.filter((comment) => comment.status === "open");
        const resolved = this.comments.filter((comment) => comment.status === "resolved");
        return [...open, ...resolved];
    }

    listComments() {
        const comments = this.sortedComments();
        if (!comments.length) return "There are no review comments.";
        return comments.map(formatComment).join("\n\n");
    }
}

function workflowError(result) {
    if (result.status === "completed") return undefined;
    return result.error ?? result.reason ?? `The review ended as "${result.status}".`;
}
