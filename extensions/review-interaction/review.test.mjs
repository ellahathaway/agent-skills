import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runGraph, validateGraph } from "./graph.mjs";
import { Review } from "./review.mjs";
import { startServer } from "./server.mjs";

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

const node = (id) => ({ id, name: id, prompt: "", model: "", effort: "", x: 0, y: 0 });

// A repository with one source file, an extension folder with three review prompts, and a fake agent runtime.
async function fixture(t, {
    runAgent = async () => "Done.",
    models = [{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol", efforts: [] }],
    saved,
} = {}) {
    const root = await mkdtemp(join(tmpdir(), "review-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const extensionDir = join(root, "extension");
    await mkdir(join(extensionDir, "reviews"), { recursive: true });
    for (const name of ["design", "readability", "testing"]) {
        await writeFile(join(extensionDir, "reviews", `${name}.md`), `# ${name} review\n`);
    }
    await writeFile(join(root, "app.js"), ["one", "two", "three", "four", "five", "six", "seven"].join("\n"));

    const messages = [];
    const prompts = [];
    let review;
    const options = {
        root,
        extensionDir,
        sessionFile: join(root, "session", "review.json"),
        presetsFile: join(root, "home", "presets.json"),
        api: {
            startWorkflow: async () => {
                await review.runPass("run-1", async (prompt, agentOptions) => {
                    prompts.push({ prompt, ...agentOptions });
                    return runAgent(review, prompt, agentOptions);
                });
                return { status: "completed" };
            },
            cancelWorkflow: async () => {},
            notify: async (message) => { messages.push(message); },
            listModels: async () => models,
        },
    };
    if (saved) {
        await mkdir(join(root, "session"), { recursive: true });
        await writeFile(options.sessionFile, JSON.stringify(saved));
    }
    review = await Review.load(options);
    return { review, root, options, messages, prompts };
}

test("connected reviewers run in order and unconnected reviewers run at the same time", async () => {
    const graph = { nodes: [node("a"), node("b"), node("c")], edges: [{ from: "a", to: "c" }] };
    const started = [];
    const finishA = deferred();
    const run = runGraph(graph, async ({ id }) => {
        started.push(id);
        if (id === "a") await finishA.promise;
        return true;
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started.sort(), ["a", "b"]);
    finishA.resolve();
    await run;
    assert.deepEqual(started.sort(), ["a", "b", "c"]);
});

test("reviewers after a failed reviewer don't run", async () => {
    const graph = { nodes: [node("a"), node("b"), node("c")], edges: [{ from: "a", to: "c" }] };
    const started = [];
    await runGraph(graph, async ({ id }) => {
        started.push(id);
        return id !== "a";
    });
    assert.deepEqual(started.sort(), ["a", "b"]);
});

test("graphs with loops are rejected", () => {
    const loop = { nodes: [node("a"), node("b")], edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }] };
    assert.throws(() => validateGraph(loop), { code: "invalid_graph" });
    assert.throws(() => validateGraph({ nodes: [node("a")], edges: [{ from: "a", to: "a" }] }), { code: "invalid_graph" });
});

test("the default graph has one parallel reviewer per review prompt", async (t) => {
    const { review } = await fixture(t);
    assert.deepEqual(review.graph.nodes.map((node) => node.prompt), ["reviews/design.md", "reviews/readability.md", "reviews/testing.md"]);
    assert.deepEqual(review.graph.nodes.map((node) => node.model), ["gpt-6.1-sol", "gpt-6.1-sol", "gpt-6.1-sol"]);
    assert.deepEqual(review.graph.edges, []);
});

test("model choices include only available OpenAI model families", async (t) => {
    const ids = ["gpt-6.1-sol", "gpt-5-mini", "o3", "o4-mini", "codex-mini", "claude-sonnet-5.5", "opus-5.5", "gemini-3.8-flash", "grok-4.7", "mai-code-1.1-flash", "gpt-j"];
    const { review } = await fixture(t, { models: ids.map((id) => ({ id, name: id, efforts: [] })) });
    assert.deepEqual(review.snapshot().models.map((model) => model.id), ["gpt-6.1-sol", "gpt-5-mini", "o3", "o4-mini", "codex-mini"]);
});

test("older saved graphs with blank models explicitly run on gpt-6.1-sol", async (t) => {
    const { review, prompts, options } = await fixture(t, {
        saved: { graph: { nodes: [{ ...node("design"), prompt: "reviews/design.md" }], edges: [] } },
    });
    await review.start({ request: "Count", scope: "app.js" });
    await review.finished;
    assert.equal(prompts[0].model, "gpt-6.1-sol");

    const restored = await Review.load(options);
    assert.equal(restored.graph.nodes[0].model, "gpt-6.1-sol");
});

test("saved non-OpenAI selections prevent every reviewer from launching", async (t) => {
    for (const model of ["claude-sonnet-5.5", "opus-5.5", "gemini-3.8-flash", "grok-4.7", "mai-code-1.1-flash", "gpt-j"]) {
        await t.test(model, async (t) => {
            const { review, prompts } = await fixture(t, {
                models: [
                    { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", efforts: [] },
                    { id: model, name: model, efforts: [] },
                ],
                saved: {
                    graph: {
                        nodes: [
                            { ...node("design"), prompt: "reviews/design.md" },
                            { ...node("testing"), prompt: "reviews/testing.md", model },
                        ],
                        edges: [],
                    },
                },
            });
            await assert.rejects(review.start({ request: "Count", scope: "app.js" }), {
                code: "invalid_model",
                message: /Only OpenAI models are allowed/,
            });
            assert.deepEqual(prompts, []);
            assert.equal(review.snapshot().run.status, "idle");
        });
    }
});

test("an unavailable requested model does not fall back to any other model", async (t) => {
    const { review, prompts } = await fixture(t, {
        models: [
            { id: "gpt-5-mini", name: "GPT-5 Mini", efforts: [] },
            { id: "claude-sonnet-5.5", name: "Claude Sonnet 5.5", efforts: [] },
        ],
    });
    await assert.rejects(review.start({ request: "Count", scope: "app.js" }), {
        code: "model_unavailable",
        message: /No fallback model will be used/,
    });
    assert.deepEqual(prompts, []);
    assert.equal(review.snapshot().run.status, "idle");
});

test("a review pass sends each reviewer its definition, the request, and its tool instructions", async (t) => {
    const models = [{ id: "gpt-5-mini", name: "GPT-5 Mini", efforts: [] }, { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", efforts: ["low", "high"] }];
    const { review, prompts } = await fixture(t, { models });
    const [design, readability] = review.graph.nodes;
    await review.setGraph({
        nodes: [{ ...design, model: "gpt-6.1-sol", effort: "high" }, { ...readability, model: "gpt-5-mini", effort: "high" }],
        edges: [],
    });

    await review.start({ request: "Add a cache", scope: "All unstaged changes" });
    await review.finished;

    const designPrompt = prompts.find((call) => call.prompt.includes("# design review"));
    assert.match(designPrompt.prompt, /Add a cache/);
    assert.match(designPrompt.prompt, /All unstaged changes/);
    assert.match(designPrompt.prompt, /reviewer "design"/);
    assert.match(designPrompt.prompt, /review_add_comment/);
    assert.match(designPrompt.prompt, /Use gpt-6\.1-sol for this review and any delegated work/);
    assert.match(designPrompt.prompt, /Use only OpenAI models/);
    assert.match(designPrompt.prompt, /Do not use Anthropic models/);
    assert.equal(designPrompt.model, "gpt-6.1-sol");
    assert.equal(designPrompt.reasoningEffort, "high");

    const readabilityCall = prompts.find((call) => call.prompt.includes("# readability review"));
    assert.equal(readabilityCall.model, "gpt-5-mini");
    assert.equal(readabilityCall.reasoningEffort, undefined, "an effort the model doesn't support is dropped");
});

test("reviewer comments keep a snippet of the code and the implementer is told what's open", async (t) => {
    const { review, messages } = await fixture(t, {
        runAgent: async (review, prompt) => {
            if (prompt.includes("# design review")) {
                await review.addComment({ reviewer: "design", file: "app.js", line: 4, body: "Why four?" });
            }
            return "Done.";
        },
    });

    await review.start({ request: "Count", scope: "app.js" });
    await review.finished;

    const [comment] = review.snapshot().comments;
    assert.equal(comment.file, "app.js");
    assert.deepEqual(comment.snippet, { start: 2, lines: ["two", "three", "four", "five", "six"] });
    assert.equal(review.snapshot().run.nodes.design.status, "done");
    assert.match(messages[0], /1 review comment\(s\) are open/);
    assert.match(review.listComments(), /c1 \[open\] Design on app.js:4/);
});

test("only the reviewer that wrote a comment can resolve it, and resolved comments sort last", async (t) => {
    const { review } = await fixture(t);
    await review.start({ request: "Count", scope: "app.js" });
    await review.finished;
    await review.addComment({ reviewer: "design", file: "app.js", line: 1, body: "First" });
    await review.addComment({ reviewer: "testing", file: "app.js", line: 2, body: "Second" });

    await assert.rejects(review.resolveComment({ reviewer: "testing", id: "c1" }), { code: "not_your_comment" });
    await review.resolveComment({ reviewer: "design", id: "c1", note: "Fixed" });

    assert.deepEqual(review.snapshot().comments.map((comment) => [comment.id, comment.status]), [["c2", "open"], ["c1", "resolved"]]);
});

test("the next pass gives each reviewer its open comments and the implementer's replies", async (t) => {
    const { review, prompts } = await fixture(t);
    await review.start({ request: "Count", scope: "app.js" });
    await review.finished;
    await review.addComment({ reviewer: "design", file: "app.js", line: 1, body: "Rename this" });
    await review.reply({ id: "c1", body: "The name matches the spec." });

    await review.start({ request: "Count", scope: "app.js" });
    await review.finished;

    const lastPass = prompts.slice(-3);
    const promptFor = (name) => lastPass.find((call) => call.prompt.includes(`# ${name} review`)).prompt;
    assert.match(promptFor("design"), /Your open comments from earlier passes/);
    assert.match(promptFor("design"), /Rename this/);
    assert.match(promptFor("design"), /Implementer: The name matches the spec\./);
    assert.doesNotMatch(promptFor("testing"), /Your open comments/);
});

test("changes to the loaded preset show as modified until they are saved", async (t) => {
    const { review } = await fixture(t);
    assert.equal(review.snapshot().preset, "Default");
    assert.equal(review.snapshot().modified, false);

    await review.setGraph({ nodes: [node("solo")], edges: [] });
    assert.equal(review.snapshot().modified, true);

    await review.savePreset("Just one");
    assert.equal(review.snapshot().preset, "Just one");
    assert.equal(review.snapshot().modified, false);
});

test("presets are shared between sessions, and a saved Default replaces the included one", async (t) => {
    const { review, options } = await fixture(t);
    await review.setGraph({ nodes: [node("solo")], edges: [] });
    await review.savePreset("Just one");
    await review.setGraph({ nodes: [node("pair-1"), node("pair-2")], edges: [] });
    await review.savePreset("Default");

    const other = await Review.load({ ...options, sessionFile: join(options.root, "other", "review.json") });
    assert.deepEqual(other.snapshot().presets, ["Default", "Just one"]);
    assert.deepEqual(other.graph.nodes.map((node) => node.id), ["pair-1", "pair-2"]);

    await other.loadPreset("Just one");
    assert.deepEqual(other.graph.nodes.map((node) => node.id), ["solo"]);
});

test("prompt files can be absolute or relative to the extension's folder, and missing ones are reported", async (t) => {
    const { review, prompts } = await fixture(t);
    const shared = await mkdtemp(join(tmpdir(), "shared-reviews-"));
    t.after(() => rm(shared, { recursive: true, force: true }));
    await writeFile(join(shared, "security.md"), "# security review\n");

    const [design] = review.graph.nodes;
    await review.setGraph({
        nodes: [{ ...design }, { ...node("security"), prompt: join(shared, "security.md") }, { ...node("gone"), prompt: "reviews/gone.md" }],
        edges: [],
    });
    assert.deepEqual(review.snapshot().missingPrompts, ["gone"]);

    await review.start({ request: "Count", scope: "app.js" });
    await review.finished;
    assert.ok(prompts.some((call) => call.prompt.includes("# design review")));
    assert.ok(prompts.some((call) => call.prompt.includes("# security review")));
    assert.equal(review.snapshot().run.nodes.gone.status, "failed");
});

test("the canvas only accepts changes from its own page", async (t) => {
    const { review } = await fixture(t);
    const canvas = await startServer(review);
    t.after(() => canvas.close());
    const graph = JSON.stringify({ nodes: [node("solo")], edges: [] });

    const foreign = await fetch(`${canvas.url}graph`, { method: "PUT", body: graph, headers: { Origin: "https://example.com" } });
    assert.equal(foreign.status, 403);
    assert.equal(review.graph.nodes.length, 3);

    const own = await fetch(`${canvas.url}graph`, { method: "PUT", body: graph, headers: { Origin: new URL(canvas.url).origin } });
    assert.equal(own.status, 200);
    assert.deepEqual(review.graph.nodes.map((node) => node.id), ["solo"]);
});
