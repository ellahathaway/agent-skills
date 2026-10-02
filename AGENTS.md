# Skill authoring

## Layout

In general, keep `SKILL.md` files under 50 lines.
If extra information is necessary (references, scripts), put them in sub-folders:

```
skill-name/
  SKILL.md
  references/
    some-reference.md
  scripts/
    do-the-thing.ps1
```

## Frontmatter

Treat the frontmatter `description` as the skill's trigger.
The description should have two short sentences:

1. What the skill does.
2. Exactly when to use it.

Agents will decide whether to load the skill from the description alone.
Therefore, the skill body should not contain qualifiers about when to use the skill.

## Content

Use simplified technical english for agent instructions.
Start skills small with the minimum amount of content.
Only add content over time as necessary to improve agent performance on specific tasks.
