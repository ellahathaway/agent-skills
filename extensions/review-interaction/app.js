const GRID = 16;
const NODE_WIDTH = 11 * GRID;
const NODE_HEIGHT = 4 * GRID;
const SVG = "http://www.w3.org/2000/svg";

const STATUS_TEXT = { waiting: "Waiting", running: "Reviewing...", done: "Done", failed: "Failed", skipped: "Skipped" };
const RUN_TEXT = {
    idle: () => "",
    running: (run) => `Pass ${run.pass} is running...`,
    done: (run) => `Pass ${run.pass} finished.`,
    failed: (run) => `Pass ${run.pass} stopped early.`,
};

const $ = (selector) => document.querySelector(selector);
const ui = {
    status: $("#status"), run: $("#run"), stop: $("#stop"), request: $("#request"),
    runError: $("#run-error"), error: $("#error"),
    preset: $("#preset"), save: $("#save"), saveAs: $("#save-as"),
    graph: $("#graph"), edges: $("#edges"), edgeLayer: $("#edge-layer"), add: $("#add"), pencil: $("#pencil-icon"),
    inspector: $("#inspector"), nodeName: $("#node-name"), nodePrompt: $("#node-prompt"), promptFiles: $("#prompt-files"),
    promptMissing: $("#prompt-missing"), promptHint: $("#prompt-hint"),
    nodeModel: $("#node-model"), nodeEffort: $("#node-effort"), effortHint: $("#effort-hint"), remove: $("#remove"),
    comments: $("#comments"), commentCount: $("#comment-count"), noComments: $("#no-comments"),
    saveAsDialog: $("#save-as-dialog"), saveAsName: $("#save-as-name"),
    confirmDialog: $("#confirm-dialog"), confirmMessage: $("#confirm-message"), confirmButtons: $("#confirm-buttons"),
};
ui.graph.style.setProperty("--grid", `${GRID}px`);

let state;          // The latest snapshot from the extension.
let selectedId;     // The reviewer shown in the inspector.
let drag;           // A node move or a new connection in progress.
let presetOptions;  // The preset list as last drawn, so it is only rebuilt when it changes.

function el(tag, attributes = {}, ...children) {
    const element = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    element.append(...children);
    return element;
}

function svg(tag, attributes = {}, ...children) {
    const element = document.createElementNS(SVG, tag);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    element.append(...children);
    return element;
}

const nodeById = (id) => state.graph.nodes.find((node) => node.id === id);
const modelById = (id) => state.models.find((model) => model.id === id);

const snap = (value) => Math.max(0, Math.round(value / GRID) * GRID);
const at = (node) => ({ x: snap(node.x), y: snap(node.y) });
const outPort = (node) => ({ x: at(node).x + NODE_WIDTH, y: at(node).y + NODE_HEIGHT / 2 });
const inPort = (node) => ({ x: at(node).x, y: at(node).y + NODE_HEIGHT / 2 });

function showError(message) {
    ui.error.textContent = message;
    ui.error.hidden = !message;
}

// Resolves to true when the extension accepted the change.
async function act(method, route, body = {}) {
    showError("");
    try {
        const response = await fetch(route, {
            method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            const value = await response.json().catch(() => ({}));
            throw new Error(value.error ?? `HTTP ${response.status}`);
        }
        return true;
    } catch (error) {
        showError(error.message);
        return false;
    }
}

// Shows a graph change right away, then saves it. Undoes the change if the save fails.
async function changeGraph(change) {
    const previous = state.graph;
    const graph = structuredClone(previous);
    change(graph);
    state.graph = graph;
    render();

    if (!(await act("PUT", "graph", graph))) {
        state.graph = previous;
        render();
    }
}

function render() {
    if (!state) return;
    renderHeader();
    renderPresets();
    if (!drag) renderGraph();
    renderInspector();
    renderComments();
}

function renderHeader() {
    const { run, request } = state;
    ui.status.textContent = RUN_TEXT[run.status](run);
    ui.status.hidden = !ui.status.textContent;
    ui.run.disabled = run.status === "running" || !request;
    ui.run.title = request ? "Run the reviewers again with the last request." : "Ask the agent to start the first review.";
    ui.stop.hidden = run.status !== "running";
    ui.request.hidden = !request;
    ui.request.textContent = request ? `Request: ${request.request} · Code: ${request.scope}` : "";
    ui.request.title = ui.request.textContent;
    ui.runError.hidden = !run.error;
    ui.runError.textContent = run.error ?? "";
}

// --- Presets ---

function renderPresets() {
    const { presets, preset, modified } = state;
    const current = preset ?? "";
    const names = presets.includes(current) ? presets : [current, ...presets];
    const options = names.map((name) => {
        const label = name || "Untitled";
        return [name, name === current && modified ? `${label}*` : label];
    });

    const drawn = JSON.stringify(options);
    if (drawn !== presetOptions) {
        presetOptions = drawn;
        ui.preset.replaceChildren(...options.map(([value, label]) => el("option", { value }, label)));
    }
    ui.preset.value = current;
    ui.preset.classList.toggle("modified", modified);
    ui.save.disabled = !modified;
}

// Opens a dialog. Resolves to the value of the button that closed it, or "" for Escape.
function showDialog(dialog) {
    dialog.returnValue = "";
    dialog.showModal();
    return new Promise((resolve) => dialog.addEventListener("close", () => resolve(dialog.returnValue), { once: true }));
}

// choices: [value, label, class] for each button, in order.
function ask(message, choices) {
    ui.confirmMessage.textContent = message;
    ui.confirmButtons.replaceChildren(...choices.map(([value, label, style = ""]) => el("button", { value, class: style }, label)));
    return showDialog(ui.confirmDialog);
}

// Each function below resolves to true when the graph was saved.
function save() {
    if (state.presets.includes(state.preset)) return act("POST", "presets", { name: state.preset });
    return saveAs();
}

async function saveAs() {
    ui.saveAsName.value = state.preset ?? "";
    const closed = showDialog(ui.saveAsDialog);
    ui.saveAsName.select();
    if ((await closed) !== "save") return false;

    const name = ui.saveAsName.value.trim();
    if (name !== state.preset && state.presets.includes(name)) {
        const choice = await ask(`A preset named "${name}" already exists. Replace it?`, [
            ["replace", "Replace", "primary"],
            ["cancel", "Cancel"],
        ]);
        if (choice !== "replace") return false;
    }
    return act("POST", "presets", { name });
}

// Asks whether to save unsaved changes first. Resolves to false if the user cancels.
async function settleChanges() {
    if (!state.modified) return true;

    const choice = await ask(`Save changes to "${state.preset ?? "Untitled"}"?`, [
        ["save", "Save", "primary"],
        ["discard", "Don't save"],
        ["cancel", "Cancel"],
    ]);
    if (choice === "save") return save();
    return choice === "discard";
}

ui.save.addEventListener("click", save);
ui.saveAs.addEventListener("click", saveAs);

ui.preset.addEventListener("change", async () => {
    const name = ui.preset.value;
    ui.preset.value = state.preset ?? "";
    if (!(await settleChanges())) return;

    select(undefined);
    act("POST", "presets/load", { name });
});

// --- Graph ---

function curve(start, end) {
    const bend = Math.max(40, Math.abs(end.x - start.x) / 2);
    return `M ${start.x} ${start.y} C ${start.x + bend} ${start.y}, ${end.x - bend} ${end.y}, ${end.x} ${end.y}`;
}

function edgeElement(edge) {
    const d = curve(outPort(nodeById(edge.from)), inPort(nodeById(edge.to)));
    return svg("g", { class: "edge", "data-from": edge.from, "data-to": edge.to },
        svg("path", { d, class: "edge-line", "marker-end": "url(#arrow)" }),
        svg("path", { d, class: "edge-hit" }, svg("title", {}, "Click to remove this connection")),
    );
}

function indicator(status) {
    if (status === "running") return el("span", { class: "indicator" }, el("span", { class: "spinner" }));
    const symbol = { done: "✓", failed: "✕", skipped: "–" }[status] ?? "";
    return el("span", { class: `indicator ${status}` }, symbol);
}

function nodeElement(node) {
    const run = state.run.nodes[node.id];
    const open = state.comments.filter((comment) => comment.reviewer === node.id && comment.status === "open").length;
    const model = modelById(node.model)?.name ?? node.model;
    const progress = [run ? STATUS_TEXT[run.status] : "", open ? `${open} open` : ""].filter(Boolean).join(" · ");
    const warning = !run && state.missingPrompts.includes(node.id) ? "Prompt file not found" : "";
    const classes = ["node", run?.status, node.id === selectedId ? "selected" : ""].filter(Boolean).join(" ");

    const element = el("div", {
        class: classes,
        "data-id": node.id,
        tabindex: "0",
        "aria-label": [node.name, warning || progress].filter(Boolean).join(". "),
        title: run?.error ?? "",
    },
        el("div", { class: "node-name" }, node.name),
        el("div", { class: "node-meta" }, node.effort ? `${model} · ${node.effort}` : model),
    );
    if (warning) element.append(el("div", { class: "node-meta warning" }, warning));
    else if (progress) element.append(el("div", { class: "node-meta" }, ...(run ? [indicator(run.status)] : []), progress));
    element.append(
        el("button", { type: "button", class: "icon edit", title: "Edit reviewer", "aria-label": `Edit ${node.name}` },
            ui.pencil.content.cloneNode(true)),
        el("span", { class: "port in" }),
        el("span", { class: "port out", title: "Drag to another reviewer to run it after this one" }),
    );

    const { x, y } = at(node);
    Object.assign(element.style, { left: `${x}px`, top: `${y}px`, width: `${NODE_WIDTH}px`, height: `${NODE_HEIGHT}px` });
    return element;
}

function renderEdges() {
    ui.edgeLayer.replaceChildren(...state.graph.edges.map(edgeElement));
}

function renderGraph() {
    const corners = state.graph.nodes.map(at);
    ui.edges.setAttribute("width", Math.max(0, ...corners.map(({ x }) => x + NODE_WIDTH)) + 40);
    ui.edges.setAttribute("height", Math.max(0, ...corners.map(({ y }) => y + NODE_HEIGHT)) + 40);
    renderEdges();
    for (const element of ui.graph.querySelectorAll(".node")) element.remove();
    ui.graph.append(...state.graph.nodes.map(nodeElement));
}

// A new connection can't repeat an existing one or make a loop.
function canConnect(from, to) {
    const { edges } = state.graph;
    if (edges.some((edge) => edge.from === from && edge.to === to)) return false;

    // The connection makes a loop when `from` already runs after `to`.
    const runsAfterTo = new Set([to]);
    for (const id of runsAfterTo) {
        for (const edge of edges) if (edge.from === id) runsAfterTo.add(edge.to);
    }
    return !runsAfterTo.has(from);
}

function graphPoint(event) {
    const box = ui.graph.getBoundingClientRect();
    return { x: event.clientX - box.left + ui.graph.scrollLeft, y: event.clientY - box.top + ui.graph.scrollTop };
}

function moveConnection(event) {
    const over = document.elementFromPoint(event.clientX, event.clientY)?.closest(".node");
    const target = over?.dataset.id === drag.from.id ? undefined : over;
    if (target !== drag.target) {
        drag.target?.classList.remove("drop-target", "drop-invalid");
        drag.valid = Boolean(target) && canConnect(drag.from.id, target.dataset.id);
        target?.classList.add(drag.valid ? "drop-target" : "drop-invalid");
        drag.target = target;
    }

    // Over a reviewer that can accept it, the arrow snaps to that reviewer's input.
    const end = drag.valid ? inPort(nodeById(drag.target.dataset.id)) : graphPoint(event);
    drag.line.setAttribute("d", curve(outPort(drag.from), end));
    drag.line.setAttribute("marker-end", drag.valid ? "url(#arrow-ready)" : "url(#arrow)");
    drag.line.classList.toggle("ready", drag.valid);
}

function moveNode(event) {
    const point = graphPoint(event);

    // Small movements still count as a click.
    drag.moved ||= Math.hypot(point.x - drag.start.x, point.y - drag.start.y) > 4;
    if (!drag.moved) return;

    drag.node.x = snap(point.x - drag.offset.x);
    drag.node.y = snap(point.y - drag.offset.y);
    drag.element.classList.add("dragging");
    Object.assign(drag.element.style, { left: `${drag.node.x}px`, top: `${drag.node.y}px` });
    renderEdges();
}

ui.graph.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest(".edge, .edit")) return;
    const element = event.target.closest(".node");
    if (!element) {
        select(undefined);
        return;
    }

    const node = nodeById(element.dataset.id);
    if (event.target.classList.contains("out")) {
        drag = { kind: "connect", from: node, valid: false, line: svg("path", { class: "edge-line pending" }) };
        ui.edgeLayer.append(drag.line);
        ui.graph.classList.add("connecting");
        element.classList.add("connect-source");
    } else {
        const point = graphPoint(event);
        const { x, y } = at(node);
        drag = { kind: "move", node, element, start: point, offset: { x: point.x - x, y: point.y - y }, moved: false };
    }
    ui.graph.setPointerCapture(event.pointerId);
    event.preventDefault();
});

ui.graph.addEventListener("pointermove", (event) => {
    if (drag?.kind === "connect") moveConnection(event);
    if (drag?.kind === "move") moveNode(event);
});

ui.graph.addEventListener("pointerup", () => {
    const finished = drag;
    if (!finished) return;
    drag = undefined;
    ui.graph.classList.remove("connecting");

    if (finished.kind === "connect" && finished.valid) {
        const to = finished.target.dataset.id;
        changeGraph((graph) => graph.edges.push({ from: finished.from.id, to }));
    } else if (finished.kind === "move" && finished.moved) {
        const { id, x, y } = finished.node;
        changeGraph((graph) => Object.assign(graph.nodes.find((node) => node.id === id), { x, y }));
    } else if (finished.kind === "move") {
        select(finished.node.id);
    } else {
        render();
    }
});

ui.graph.addEventListener("pointercancel", () => {
    drag = undefined;
    ui.graph.classList.remove("connecting");
    render();
});

ui.graph.addEventListener("click", (event) => {
    const edit = event.target.closest(".edit");
    if (edit) {
        select(edit.closest(".node").dataset.id);
        ui.nodeName.focus();
        return;
    }

    const edge = event.target.closest(".edge");
    if (!edge) return;
    const { from, to } = edge.dataset;
    changeGraph((graph) => {
        graph.edges = graph.edges.filter((existing) => existing.from !== from || existing.to !== to);
    });
});

ui.graph.addEventListener("keydown", (event) => {
    if (event.target.classList.contains("node") && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        select(event.target.dataset.id);
    }
});

ui.add.addEventListener("click", () => {
    const { nodes } = state.graph;
    const ids = new Set(nodes.map((node) => node.id));
    let number = nodes.length + 1;
    while (ids.has(`reviewer-${number}`)) number++;

    const id = `reviewer-${number}`;
    const bottom = Math.max(0, ...nodes.map((node) => at(node).y + NODE_HEIGHT));
    const reviewer = { id, name: `Reviewer ${number}`, prompt: state.prompts[0] ?? "", model: state.defaultModel, effort: "", x: 2 * GRID, y: bottom + 2 * GRID };
    selectedId = id;
    changeGraph((graph) => graph.nodes.push(reviewer));
    ui.graph.querySelector(`.node[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
});

// --- Inspector ---

function select(id) {
    // Blurring saves a field that is still being edited, before the inspector switches reviewers.
    if (ui.inspector.contains(document.activeElement)) document.activeElement.blur();
    selectedId = id;
    render();
}

function updateNode(id, values) {
    changeGraph((graph) => Object.assign(graph.nodes.find((node) => node.id === id), values));
}

// Leaves a field alone while the user is typing in it.
function setValue(input, value) {
    if (document.activeElement !== input) input.value = value;
}

function setOptions(select, options, value) {
    if (document.activeElement === select) return;
    if (value && !options.some(([id]) => id === value)) options.push([value, value]);
    select.replaceChildren(...options.map(([id, label]) => el("option", { value: id }, label)));
    select.value = value;
}

function renderInspector() {
    const node = selectedId && nodeById(selectedId);
    ui.inspector.hidden = !node;
    if (!node) return;

    setValue(ui.nodeName, node.name);

    setValue(ui.nodePrompt, node.prompt);
    ui.nodePrompt.title = node.prompt;
    ui.promptFiles.replaceChildren(...state.prompts.map((prompt) => el("option", { value: prompt })));
    ui.promptMissing.hidden = !state.missingPrompts.includes(node.id);
    ui.promptHint.textContent = `Use an absolute path, or a path relative to the extension's folder (${state.extensionDir}).`;

    const models = state.models.map((model) => [model.id, model.name]);
    setOptions(ui.nodeModel, models, node.model);
    const modelOption = [...ui.nodeModel.options].find((option) => option.value === node.model);
    if (!modelById(node.model) && modelOption) {
        modelOption.disabled = true;
        modelOption.textContent = `${node.model} (unavailable)`;
    }

    const efforts = modelById(node.model)?.efforts ?? [];
    setOptions(ui.nodeEffort, [["", "Default effort"], ...efforts.map((effort) => [effort, effort])], node.effort);
    ui.nodeEffort.disabled = !efforts.length;
    ui.effortHint.hidden = efforts.length > 0;
    ui.effortHint.textContent = node.model ? "This model has no effort setting." : "Pick a model to set its effort.";
}

ui.nodeName.addEventListener("change", () => updateNode(selectedId, { name: ui.nodeName.value }));
ui.nodeEffort.addEventListener("change", () => updateNode(selectedId, { effort: ui.nodeEffort.value }));
ui.nodeModel.addEventListener("change", () => {
    const efforts = modelById(ui.nodeModel.value)?.efforts ?? [];
    const effort = efforts.includes(ui.nodeEffort.value) ? ui.nodeEffort.value : "";
    updateNode(selectedId, { model: ui.nodeModel.value, effort });
});

// Windows "Copy as path" wraps the path in quotes.
ui.nodePrompt.addEventListener("change", () => {
    const prompt = ui.nodePrompt.value.trim().replace(/^"(.*)"$/, "$1");
    updateNode(selectedId, { prompt });
});

ui.remove.addEventListener("click", () => {
    const id = selectedId;
    selectedId = undefined;
    changeGraph((graph) => {
        graph.nodes = graph.nodes.filter((node) => node.id !== id);
        graph.edges = graph.edges.filter((edge) => edge.from !== id && edge.to !== id);
    });
});

// --- Comments ---

function snippetElement(comment) {
    const lines = comment.snippet.lines.map((text, index) => {
        const number = comment.snippet.start + index;
        const target = number >= comment.line && number <= comment.endLine;
        return el("span", { class: target ? "line target" : "line" }, el("span", { class: "number" }, String(number)), text);
    });
    return el("pre", { class: "snippet" }, ...lines);
}

function commentElement(comment) {
    const range = comment.endLine > comment.line ? `${comment.line}-${comment.endLine}` : `${comment.line}`;
    const replies = comment.replies.map((reply) => el("p", { class: "reply" }, el("strong", {}, `${reply.author}: `), reply.body));
    const resolution = comment.status === "resolved"
        ? [el("p", { class: "resolution muted" }, `Resolved by ${comment.reviewerName}${comment.resolution ? `: ${comment.resolution}` : "."}`)]
        : [];

    return el("li", { class: `comment ${comment.status}` },
        el("div", { class: "comment-head" },
            el("span", { class: "reviewer" }, comment.reviewerName),
            el("code", {}, `${comment.file}:${range}`),
            el("span", { class: "state muted" }, `${comment.id} · ${comment.status === "open" ? "Open" : "Resolved"}`),
        ),
        snippetElement(comment),
        el("p", { class: "body" }, comment.body),
        ...replies,
        ...resolution,
    );
}

function renderComments() {
    const { comments } = state;
    const open = comments.filter((comment) => comment.status === "open").length;
    ui.commentCount.textContent = comments.length ? `${open} open · ${comments.length - open} resolved` : "";
    ui.noComments.hidden = comments.length > 0;
    ui.comments.replaceChildren(...comments.map(commentElement));
}

// --- Run ---

ui.run.addEventListener("click", () => act("POST", "run"));
ui.stop.addEventListener("click", () => act("POST", "stop"));

const events = new EventSource("events");
events.addEventListener("message", (event) => {
    state = JSON.parse(event.data);
    render();
});
events.addEventListener("error", () => {
    ui.status.textContent = "Reconnecting to the extension...";
    ui.status.hidden = false;
});
