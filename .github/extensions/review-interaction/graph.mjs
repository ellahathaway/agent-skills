function invalid(message) {
    return Object.assign(new Error(message), { code: "invalid_graph" });
}

const text = (value) => (typeof value === "string" ? value.trim() : "");
const position = (value) => (Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0);

// Returns a clean copy of the graph. Throws when the graph can't run.
export function validateGraph(graph) {
    if (!Array.isArray(graph?.nodes) || !Array.isArray(graph?.edges)) {
        throw invalid("A graph needs a list of nodes and a list of edges.");
    }

    const nodes = graph.nodes.map((node) => ({
        id: text(node.id),
        name: text(node.name) || text(node.id),
        prompt: text(node.prompt),
        model: text(node.model),
        effort: text(node.effort),
        x: position(node.x),
        y: position(node.y),
    }));
    const ids = new Set(nodes.map((node) => node.id));
    if (ids.has("") || ids.size !== nodes.length) throw invalid("Every reviewer needs a unique ID.");

    const edges = graph.edges.map((edge) => ({ from: text(edge.from), to: text(edge.to) }));
    const pairs = new Set();
    for (const { from, to } of edges) {
        if (!ids.has(from) || !ids.has(to)) throw invalid("A connection points to a reviewer that doesn't exist.");
        if (pairs.has(`${from}\n${to}`)) throw invalid("Those reviewers are already connected.");
        pairs.add(`${from}\n${to}`);
    }
    if (hasCycle(nodes, edges)) throw invalid("That connection would create a loop.");

    return { nodes, edges };
}

// Kahn's algorithm: repeatedly remove nodes that nothing points to.
// Any node left over is part of a cycle.
function hasCycle(nodes, edges) {
    const incoming = new Map(nodes.map((node) => [node.id, 0]));
    for (const { to } of edges) incoming.set(to, incoming.get(to) + 1);

    const free = nodes.filter((node) => incoming.get(node.id) === 0).map((node) => node.id);
    let removed = 0;
    while (free.length) {
        const id = free.pop();
        removed++;
        for (const { from, to } of edges) {
            if (from !== id) continue;
            incoming.set(to, incoming.get(to) - 1);
            if (incoming.get(to) === 0) free.push(to);
        }
    }
    return removed !== nodes.length;
}

// Runs each node once every node with an edge into it has succeeded.
// Nodes that don't depend on each other run at the same time.
// runNode(node) resolves to true on success. Nodes after a failure never run.
export async function runGraph(graph, runNode) {
    const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
    const results = new Map();

    function run(node) {
        if (!results.has(node.id)) results.set(node.id, runAfterDependencies(node));
        return results.get(node.id);
    }

    async function runAfterDependencies(node) {
        const dependencies = graph.edges
            .filter((edge) => edge.to === node.id)
            .map((edge) => nodesById.get(edge.from));

        const succeeded = await Promise.all(dependencies.map(run));
        if (!succeeded.every(Boolean)) return false;

        return runNode(node);
    }

    await Promise.all(graph.nodes.map(run));
}
