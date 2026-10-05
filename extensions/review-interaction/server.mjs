import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

const MAX_BODY_BYTES = 1_000_000;

const assets = new Map(await Promise.all([
    ["", "index.html", "text/html; charset=utf-8"],
    ["app.js", "app.js", "text/javascript; charset=utf-8"],
    ["style.css", "style.css", "text/css; charset=utf-8"],
].map(async ([route, file, type]) => [route, { type, body: await readFile(new URL(file, import.meta.url)) }])));

const actions = {
    "PUT graph": (review, body) => review.setGraph(body),
    "POST run": (review) => review.restart(),
    "POST stop": (review) => review.stop(),
    "POST presets": (review, body) => review.savePreset(body.name),
    "POST presets/load": (review, body) => review.loadPreset(body.name),
};

const errorStatus = { review_busy: 409, preset_not_found: 404 };

function json(res, status, value) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(value));
}

async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) throw Object.assign(new Error("The request is too large."), { code: "too_large" });
        chunks.push(chunk);
    }
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

// Server-sent events: the canvas gets the full state now and after every change.
function streamState(review, req, res) {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = () => res.write(`data: ${JSON.stringify(review.snapshot())}\n\n`);
    send();
    const unsubscribe = review.subscribe(send);
    req.on("close", unsubscribe);
}

export async function startServer(review) {
    // A random path, plus host and origin checks, keep other local pages from driving the canvas.
    const base = `/${randomUUID()}/`;
    let origin;

    const server = createServer(async (req, res) => {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        if (req.headers.host !== new URL(origin).host) return json(res, 403, { error: "Unexpected host." });

        const path = new URL(req.url, origin).pathname;
        if (!path.startsWith(base)) return json(res, 404, { error: "Not found." });
        const route = path.slice(base.length);

        if (req.method === "GET" && assets.has(route)) {
            const asset = assets.get(route);
            res.writeHead(200, { "Content-Type": asset.type });
            return res.end(asset.body);
        }
        if (req.method === "GET" && route === "events") return streamState(review, req, res);

        const action = actions[`${req.method} ${route}`];
        if (!action) return json(res, 404, { error: "Not found." });
        if (req.headers.origin !== origin) return json(res, 403, { error: "Changes must come from this canvas." });

        try {
            await action(review, await readBody(req));
            json(res, 200, {});
        } catch (error) {
            json(res, errorStatus[error.code] ?? (error.code ? 400 : 500), { error: error.message });
        }
    });

    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    origin = `http://127.0.0.1:${server.address().port}`;

    return {
        url: `${origin}${base}`,
        close: () => new Promise((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
            server.closeAllConnections();
        }),
    };
}
