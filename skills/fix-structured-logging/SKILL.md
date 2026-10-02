---
name: fix-structured-logging
description: >-
  Fix ILogger structured logging usage in C# classes.
  Use only when explicitly invoked.
---

# Fix structured logging

For each class the user names or describes, fix its `ILogger` calls:

1. Use a constant message template with named placeholders (`"Digest '{Digest}'", digest`),
   never string interpolation, a variable template, or concatenation with non-literal values
   (CA2254).
2. Don't log empty strings for spacing.
3. Log one logical event with one call. Put multi-line content in a placeholder after `\n`
   in the template instead of splitting it across calls.
4. Compute expensive or multi-line values (for example JSON serialization) into a local before
   the log call.
5. Inline small helpers that only exist to wrap logging so each call site has its own constant
   template.
6. If a logger call is longer than 120 characters, put each argument on its own indented line.
   If the template is still longer than 120 characters, split it into indented `+` continuation
   lines, with any leading space on the new line. Put a blank line between a wrapped logger call
   and any statement that follows it:

   ```csharp
   logger.LogError(
       "Could not annotate digest '{Digest}' because its existing EOL date '{ExistingEolDate}'"
           + " does not match '{EolDate}'.",
       digest,
       existingEolDate,
       eolDate);

   failedDigests.Add(digest);
   ```

7. Match the log level to the event (for example `LogError` for failure summaries).
8. Build and run the class's tests.
