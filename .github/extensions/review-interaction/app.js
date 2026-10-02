const start = document.querySelector("#start");
const status = document.querySelector("#status");
const error = document.querySelector("#error");
let submitting = false;

function showError(message) {
    error.textContent = message;
    error.hidden = false;
}

function render(state) {
    const working = ["starting", "reviewing"].includes(state.status);
    start.disabled = submitting || state.busy;
    start.textContent = state.status === "done" ? "Review again" : "Start review";
    status.textContent = {
        idle: "Ready to review",
        starting: "Starting reviewer...",
        reviewing: "Reviewing README.md...",
        done: "Review finished",
        error: "Review stopped with an error",
    }[state.status];
    document.querySelector("#spinner").hidden = !working;
    document.querySelector("#checkmark").hidden = state.status !== "done";
    document.querySelector("#review-status").setAttribute("aria-busy", String(working));
    document.querySelector("#result").hidden = !state.summary;
    document.querySelector("#summary").textContent = state.summary ?? "";
    const handoff = document.querySelector("#handoff");
    handoff.textContent = {
        pending: "Sending result to the main agent...",
        sent: "Result sent to the main agent.",
        failed: "Result could not be sent to the main agent.",
    }[state.notificationStatus] ?? "";
    handoff.hidden = !handoff.textContent;
    const problems = [state.error, state.deliveryError, ...(state.warnings ?? [])].filter(Boolean);
    error.hidden = !problems.length;
    if (problems.length) showError(problems.join("\n"));
}

async function request(route, options) {
    const response = await fetch(route, options);
    const value = await response.json();
    if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
    return value;
}

async function refresh() {
    try {
        render(await request("state"));
    } catch (failure) {
        start.disabled = true;
        showError(`Canvas connection failed: ${failure.message}`);
    }
}

start.addEventListener("click", async () => {
    submitting = true;
    render({ status: "starting", busy: true });
    try {
        render(await request("review", { method: "POST" }));
    } catch (failure) {
        showError(`Could not start review: ${failure.message}`);
    } finally {
        submitting = false;
        await refresh();
    }
});

async function poll() {
    await refresh();
    setTimeout(poll, 1000);
}

poll();
