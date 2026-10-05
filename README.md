# agent-skills

A GitHub Copilot plugin with agent skills, custom agents, and an OpenAI-only
review canvas.

## Install

In Copilot CLI:

```powershell
copilot plugin marketplace add ellahathaway/agent-skills
copilot plugin install agent-skills@agent-skills
```

In the GitHub Copilot app, add `ellahathaway/agent-skills` under
**Settings > Plugins**, then install **agent-skills**.

Update the installed plugin with:

```powershell
copilot plugin update agent-skills@agent-skills
```

Reload extensions or start a new Copilot session after updates.

For an existing manual installation, remove this repo's separately registered
skills, the copied `comment-sicko.agent.md` and `overengineering-advisor.agent.md`
user profiles, and only the old `review-interaction` extension link. Back up
`artifacts\presets.json` before removing that link, then restore it to the
user-level preset path in the review canvas README.

## Layout

| Path | Contents |
|------|----------|
| `.plugin\plugin.json` | Plugin metadata and component paths |
| `.claude-plugin\marketplace.json` | Marketplace catalog, following the Aspire Skills layout |
| `skills\` | Skills and their references |
| `agents\` | Discoverable `.agent.md` profiles |
| `extensions\review-interaction\` | Review canvas, prompts, and tests |

## Development

Load this checkout without installing it:

```powershell
copilot --plugin-dir . --model gpt-6.1-sol
```

Run the packaging and review tests:

```powershell
node --test tests\plugin.test.mjs extensions\review-interaction\review.test.mjs
```

## Attribution

The following were lifted from https://github.com/backnotprop/pstack (MIT license):

- skills/blast-radius
- skills/bro
- skills/technical-writing
- skills/unslop
- agents/comment-sicko.agent.md
