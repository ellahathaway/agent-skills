import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

function renderer() {
    const elements = new Map();
    for (const id of ["start", "status", "error", "spinner", "checkmark", "review-status", "result", "summary", "handoff"]) {
        elements.set(`#${id}`, {
            hidden: false, disabled: false, textContent: "", attributes: {},
            addEventListener() {},
            setAttribute(name, value) { this.attributes[name] = value; },
        });
    }
    const context = {
        document: { querySelector: (selector) => elements.get(selector) },
        fetch: () => new Promise(() => {}),
        setTimeout() {},
    };
    runInNewContext(readFileSync(new URL("app.js", import.meta.url), "utf8"), context);
    return { render: context.render, get: (id) => elements.get(`#${id}`) };
}

test("starting and running show a spinner, not a completion checkmark", () => {
    const { render, get } = renderer();
    for (const status of ["starting", "reviewing"]) {
        render({ status, busy: true, warnings: [] });
        assert.equal(get("spinner").hidden, false);
        assert.equal(get("checkmark").hidden, true);
        assert.equal(get("review-status").attributes["aria-busy"], "true");
        assert.equal(get("start").disabled, true);
        assert.equal(get("handoff").hidden, true);
    }
});

test("finished reviews show a checkmark and escaped text even while the main-agent handoff is pending", () => {
    const { render, get } = renderer();
    render({
        status: "done", busy: true, notificationStatus: "pending",
        summary: "<script>Reviewer output as text</script>", warnings: [],
    });
    assert.equal(get("spinner").hidden, true);
    assert.equal(get("checkmark").hidden, false);
    assert.equal(get("review-status").attributes["aria-busy"], "false");
    assert.equal(get("summary").textContent, "<script>Reviewer output as text</script>");
    assert.equal(get("result").hidden, false);
    assert.equal(get("start").disabled, true);
    render({ status: "done", busy: false, notificationStatus: "sent", summary: "Result" });
    assert.equal(get("start").disabled, false);
    assert.equal(get("start").textContent, "Review again");
    assert.equal(get("handoff").textContent, "Result sent to the main agent.");
});

test("failures are visible and cannot look like successful reviews", () => {
    const { render, get } = renderer();
    render({ status: "error", busy: false, error: "Review failed", warnings: [] });
    assert.equal(get("spinner").hidden, true);
    assert.equal(get("checkmark").hidden, true);
    assert.equal(get("error").textContent, "Review failed");
    assert.equal(get("error").hidden, false);
    render({
        status: "done", busy: false, summary: "Result", notificationStatus: "failed",
        deliveryError: "Message failed", warnings: ["Log failed"],
    });
    assert.equal(get("checkmark").hidden, false);
    assert.match(get("error").textContent, /Message failed\nLog failed/);
    render({ status: "idle", busy: false });
    assert.equal(get("error").hidden, true);
    assert.equal(get("result").hidden, true);
    assert.equal(get("checkmark").hidden, true);
});

test("the page contains only the review control and respects hidden indicators and reduced motion", () => {
    const html = readFileSync(new URL("index.html", import.meta.url), "utf8");
    const css = readFileSync(new URL("style.css", import.meta.url), "utf8");
    assert.doesNotMatch(html, /<(form|textarea|select|pre|details)\b/);
    assert.equal((html.match(/<button\b/g) ?? []).length, 1);
    assert.match(html, /id="checkmark"/);
    assert.match(css, /\[hidden\]\s*\{\s*display:\s*none/);
    assert.match(css, /prefers-reduced-motion:\s*reduce/);
});
