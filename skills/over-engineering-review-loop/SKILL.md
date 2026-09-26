---
name: over-engineering-review-loop
description: Only use when explicitly asked.
---

Variables:
- `MAX_ITERATIONS=3`
- `MODEL=opus-5.5`

We will now go through a process designed to simplify your implementation.

### Workflow

Invoke an "overengineering-advisor" subagent using `$MODEL`.
Provide it with the user's request and tell it what code to review.
Include enough context to allow the advisor to understand the scope of the code and request, but let your code speak for itself.
For the code to review, select exactly one of:

- All unstaged changes
- Commit `<sha>`
- A list of specific files or changes

Use the following prompt:

```md
The operator's request was: `$USER_REQUEST`
The code up for review is `$CODE_TO_REVIEW`
```

Do not provide additional context unless the advisor explicitly requests it.
Respond directly to the advisor, and work together to incorporate their feedback.

### Important

Repeat this process until all feedback is addressed or you have gone through `$MAX_ITERATIONS` review cycles.
