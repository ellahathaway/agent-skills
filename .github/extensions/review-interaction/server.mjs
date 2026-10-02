import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

const assets = new Map(await Promise.all([
    ["", "index.html", "text/html; charset=utf-8"],
    ["app.js", "app.js", "text/javascript; charset=utf-8"],
    ["style.css", "style.css", "text/css; charset=utf-8"],
].map(async ([route, file, type]) => [route, { type, body: await readFile(new URL(file, import.meta.url)) }])));

function json(res, status, value) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(value));
}

export async function startServer(review, instanceId) {
    const base = `/${randomUUID()}/`;
    let origin;
    const server = createServer(async (req, res) => {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        if (req.headers.host !== new URL(origin).host) {
            json(res, 403, { error: "Unexpected host." });
            return;
        }

        const path = new URL(req.url, origin).pathname;
        if (!path.startsWith(base)) {
            json(res, 404, { error: "Not found." });
            return;
        }
        const route = path.slice(base.length);
        if (req.method === "GET" && assets.has(route)) {
            const asset = assets.get(route);
            res.writeHead(200, { "Content-Type": asset.type });
            res.end(asset.body);
        } else if (req.method === "GET" && route === "state") {
            json(res, 200, review.snapshot());
        } else if (req.method === "POST" && route === "review") {
            if (req.headers.origin !== origin) {
                json(res, 403, { error: "Actions must come from this canvas." });
                return;
            }
            try {
                json(res, 202, await review.start(instanceId));
            } catch (error) {
                json(res, error.code === "review_busy" ? 409 : 500, { error: error.message });
            }
        } else {
            json(res, 404, { error: "Not found." });
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
            server.close((error) => error ? reject(error) : resolve());
            server.closeAllConnections();
        }),
    };
}
