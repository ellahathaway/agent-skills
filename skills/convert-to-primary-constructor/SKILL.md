---
name: convert-to-primary-constructor
description: >-
  Convert DI-injected C# classes to primary constructors.
  Use only when explicitly invoked.
---

# Convert to primary constructor

For each class the user names or describes:

1. Move the DI constructor's parameters into a primary constructor on the class declaration.
2. Delete the constructor, the `private readonly` fields that only stored those parameters, and
   their `?? throw new ArgumentNullException(...)` guards. Trust the nullable annotations.
3. Replace every use of those fields (for example `_logger`) with the parameter (`logger`).
4. Keep a field only if it is reassigned or does more than store a parameter.
5. Build and fix any errors.
