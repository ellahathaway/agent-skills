import assert from "node:assert/strict";
import { test } from "node:test";
import { ReviewInteraction } from "./review.mjs";
import { startServer } from "./server.mjs";

function fixture(overrides = {}) {
    const calls = { logs: [], messages: [] };
    return new ReviewInteraction({
        calls,
        startAgent: async () => ({ agentId: "agent-1" }),
        list: async () => ({ tasks: [
            { type: "agent", id: "agent-1", status: "completed", result: "Reviewer result" },
        ] }),
        log: async (message, options) => { calls.logs.push({ message, options }); },
        send: async (options) => { calls.messages.push(options); return "message-1"; },
        ...overrides,
    }, { pollIntervalMs: 1 });
}

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

test("a click calls the direct task RPC and prevents duplicate launches", async () => {
    let sent;
    let launch;
    const review = fixture({
        startAgent: (options) => {
            sent = options;
            return new Promise((resolve) => { launch = resolve; });
        },
    });
    const pending = review.start("demo-panel");
    await assert.rejects(review.start("second-panel"), { code: "review_busy" });
    assert.equal(sent.agentType, "code-review");
    assert.match(sent.prompt, /Read only README.md/);
    assert.match(sent.name, /^canvas-review-/);
    assert.equal(Object.hasOwn(sent, "model"), false);
    launch({ agentId: "agent-1" });
    const started = await pending;
    assert.equal(started.agentId, "agent-1");
    assert.equal(started.instanceId, "demo-panel");
    await review.completion;
    assert.equal(review.snapshot().status, "done");
    assert.equal(review.snapshot().summary, "Reviewer result");
    assert.equal(review.snapshot().notificationStatus, "sent");
    assert.equal(review.snapshot().busy, false);
});

test("only a stopped reviewer sends a main-agent message, with persisted info start/stop logs", async () => {
    let polls = 0;
    const listed = deferred();
    const release = deferred();
    const review = fixture({
        list: async () => {
            polls++;
            if (polls === 1) {
                listed.resolve();
                await release.promise;
            }
            return { tasks: [
                { type: "agent", id: "other", status: "completed", result: "Unrelated" },
                { type: "agent", id: "agent-1", status: polls === 1 ? "running" : "completed", result: "Direct result" },
            ] };
        },
    });
    await review.start("demo-panel");
    await listed.promise;
    assert.equal(review.snapshot().status, "reviewing");
    assert.equal(review.api.calls.messages.length, 0);
    assert.equal(review.api.calls.logs.length, 1);
    assert.match(review.api.calls.logs[0].message, /Review started/);
    await assert.rejects(review.start("second-panel"), { code: "review_busy" });
    release.resolve();
    await review.completion;
    const completed = review.snapshot();
    assert.equal(completed.summary, "Direct result");
    assert.equal(review.api.calls.messages.length, 1);
    assert.match(review.api.calls.messages[0].prompt, /Review finished/);
    assert.match(review.api.calls.messages[0].prompt, /Direct result/);
    assert.equal(review.api.calls.messages[0].mode, "enqueue");
    assert.equal(review.api.calls.logs.length, 2);
    assert.match(review.api.calls.logs[1].message, /Review finished/);
    for (const log of review.api.calls.logs) {
        assert.deepEqual(log.options, { level: "info", ephemeral: false });
    }
    completed.warnings.push("Not shared");
    assert.equal(review.snapshot().warnings.length, 0);
    await review.start("second-panel");
    await review.completion;
    assert.equal(review.snapshot().status, "done");
});

test("an idle agent's latest response is collected directly", async () => {
    const review = fixture({
        list: async () => ({ tasks: [
            { type: "agent", id: "agent-1", status: "idle", latestResponse: "Idle reviewer result" },
        ] }),
    });
    await review.start("demo-panel");
    await review.completion;
    assert.equal(review.snapshot().status, "done");
    assert.equal(review.snapshot().summary, "Idle reviewer result");
    assert.equal(review.snapshot().taskStatus, "idle");
});

test("direct launch failures are surfaced, with no prompt fallback", async () => {
    for (const startAgent of [
        async () => { throw new Error("RPC denied"); },
        async () => ({}),
    ]) {
        const review = fixture({ startAgent });
        await assert.rejects(review.start("demo-panel"));
        await review.completion;
        assert.equal(review.snapshot().status, "error");
        assert.match(review.snapshot().error, /Direct review launch failed/);
        assert.equal(review.snapshot().summary, undefined);
        assert.equal(review.api.calls.messages.length, 1);
        assert.match(review.api.calls.messages[0].prompt, /Review stopped with an error/);
        assert.equal(review.api.calls.logs.length, 1);
    }
});

test("monitoring failures cannot claim review completion or notify the main agent", async () => {
    for (const list of [
        async () => { throw new Error("RPC unavailable"); },
        async () => ({ tasks: [] }),
        async () => ({ tasks: [{ type: "agent", id: "agent-1", status: "unknown" }] }),
    ]) {
        const review = fixture({ list });
        await review.start("demo-panel");
        await review.completion;
        assert.equal(review.snapshot().status, "error");
        assert.match(review.snapshot().error, /reviewer may still be running/);
        assert.equal(review.snapshot().summary, undefined);
        assert.equal(review.snapshot().notificationStatus, undefined);
        assert.equal(review.api.calls.messages.length, 0);
    }
});

test("stopped reviewers with failure, cancellation, or missing output notify the main agent once", async () => {
    for (const task of [
        { status: "failed", error: "Review denied" },
        { status: "cancelled" },
        { status: "completed" },
    ]) {
        const review = fixture({
            list: async () => ({ tasks: [{ type: "agent", id: "agent-1", ...task }] }),
        });
        await review.start("demo-panel");
        await review.completion;
        assert.equal(review.snapshot().status, "error");
        assert.equal(review.snapshot().notificationStatus, "sent");
        assert.equal(review.api.calls.messages.length, 1);
        assert.match(review.api.calls.messages[0].prompt, /Review stopped with an error/);
    }
});

test("the review is complete while its handoff is pending, but cannot be restarted yet", async () => {
    const sending = deferred();
    const release = deferred();
    const review = fixture({
        send: async () => { sending.resolve(); return release.promise; },
    });
    await review.start("demo-panel");
    await sending.promise;
    assert.equal(review.snapshot().status, "done");
    assert.equal(review.snapshot().notificationStatus, "pending");
    assert.equal(review.snapshot().summary, "Reviewer result");
    await assert.rejects(review.start("second-panel"), { code: "review_busy" });
    release.resolve("message-1");
    await review.completion;
    assert.equal(review.snapshot().busy, false);
    assert.equal(review.snapshot().notificationStatus, "sent");
});

test("log and handoff failures remain separate from a successful review result", async () => {
    const missingLogs = fixture({ log: async () => { throw new Error("Logging unavailable"); } });
    await missingLogs.start("demo-panel");
    await missingLogs.completion;
    assert.equal(missingLogs.snapshot().status, "done");
    assert.equal(missingLogs.snapshot().warnings.length, 2);
    assert.match(missingLogs.snapshot().warnings[0], /Logging unavailable/);
    assert.equal(missingLogs.snapshot().notificationStatus, "sent");
    for (const send of [
        async () => { throw new Error("Message unavailable"); },
        async () => "",
    ]) {
        const review = fixture({ send });
        await review.start("demo-panel");
        await review.completion;
        assert.equal(review.snapshot().status, "done");
        assert.equal(review.snapshot().summary, "Reviewer result");
        assert.equal(review.snapshot().notificationStatus, "failed");
        assert.match(review.snapshot().deliveryError, /Could not notify/);
        assert.equal(review.snapshot().busy, false);
    }
});

test("loopback button endpoint, assets, shared state and origin checks", async (t) => {
    let launches = 0;
    let release;
    const listed = deferred();
    const review = fixture({
        startAgent: async () => { launches++; return { agentId: "agent-1" }; },
        list: () => {
            listed.resolve();
            return new Promise((resolve) => { release = resolve; });
        },
    });
    const first = await startServer(review, "first-panel");
    const second = await startServer(review, "second-panel");
    t.after(async () => { await first.close(); await second.close(); });
    const origin = new URL(first.url).origin;
    const page = await fetch(first.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /id="start"/);
    for (const asset of ["app.js", "style.css"]) {
        assert.equal((await fetch(`${first.url}${asset}`)).status, 200);
    }
    assert.equal((await fetch(`${origin}/state`)).status, 404);
    assert.equal((await fetch(`${first.url}interaction`, { method: "POST" })).status, 404);
    assert.equal((await fetch(`${first.url}review`, { method: "POST" })).status, 403);
    assert.equal((await fetch(`${first.url}review`, {
        method: "POST", headers: { Origin: "https://example.com" },
    })).status, 403);
    const click = await fetch(`${first.url}review`, { method: "POST", headers: { Origin: origin } });
    assert.equal(click.status, 202);
    assert.equal((await click.json()).instanceId, "first-panel");
    assert.equal(launches, 1);
    await listed.promise;
    assert.equal((await fetch(`${first.url}review`, {
        method: "POST", headers: { Origin: origin },
    })).status, 409);
    const shared = await (await fetch(`${second.url}state`)).json();
    assert.equal(shared.requestId, review.snapshot().requestId);
    release({ tasks: [{ type: "agent", id: "agent-1", status: "completed", result: "Direct result" }] });
    await review.completion;
    const result = await (await fetch(`${first.url}state`)).json();
    assert.equal(result.summary, "Direct result");
});

test("HTTP launch failures return errors, not successful reviews", async (t) => {
    const review = fixture({
        startAgent: async () => { throw new Error("Direct execution blocked"); },
    });
    const panel = await startServer(review, "demo-panel");
    t.after(() => panel.close());
    const response = await fetch(`${panel.url}review`, {
        method: "POST", headers: { Origin: new URL(panel.url).origin },
    });
    assert.equal(response.status, 500);
    await review.completion;
    assert.equal((await response.json()).error, "Direct execution blocked");
    assert.equal(review.snapshot().status, "error");
});
