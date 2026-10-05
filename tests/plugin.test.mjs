import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

test("the marketplace resolves to the root plugin with matching identity and version", async () => {
    const [plugin, marketplace] = await Promise.all([
        readJson(join(root, ".plugin", "plugin.json")),
        readJson(join(root, ".claude-plugin", "marketplace.json")),
    ]);
    assert.equal(marketplace.plugins.length, 1);
    const [entry] = marketplace.plugins;
    assert.equal(resolve(root, entry.source), root);
    assert.equal(entry.name, plugin.name);
    assert.equal(entry.version, plugin.version);
    assert.equal(entry.description, plugin.description);
});

test("the plugin packages discoverable skills, both agent profiles, and the review extension", async () => {
    const plugin = await readJson(join(root, ".plugin", "plugin.json"));
    const skillsDirectory = resolve(root, plugin.skills);
    const skills = (await readdir(skillsDirectory, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    assert.ok(skills.length > 0);
    await Promise.all(skills.map((skill) => access(join(skillsDirectory, skill.name, "SKILL.md"))));

    const agentsDirectory = resolve(root, plugin.agents);
    await Promise.all([
        access(join(agentsDirectory, "comment-sicko.agent.md")),
        access(join(agentsDirectory, "overengineering-advisor.agent.md")),
        access(resolve(root, plugin.extensions, "review-interaction", "extension.mjs")),
    ]);
});
