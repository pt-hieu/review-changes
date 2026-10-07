# Coding standards

## Source text

- No code comments. Names and structure carry the meaning.
- Identifiers are spelled out in full. No abbreviations, no single-letter parameters.
- A hook keeps the engine's signature `($, e, next)`: `$` is the engine interface, `e` the event, `next` the rest of the chain. Every other name is spelled out.

## Grouping

Statements inside a function are grouped by goal: the lines that together achieve one thing sit next to each other, and a blank line separates one group from the next. Each branch of a conditional is its own group.

## Enums, not string unions

A closed set of string values is a TypeScript enum with string values, declared in the `types.ts` of the module that owns the set. Members are PascalCase. Values are the strings the wire format or storage already uses.

The enum is the source of truth. Do not declare the set as a union type. Lookup tables key on the enum members, and every consumer, including tests, passes the enum member rather than its string value.

A value set declared in the plugin's state contract, `plugins/review-changes/types/index.d.ts`, stays a union there, because a declaration file holds no runtime values.

Boolean variants are not string sets and stay booleans. A type alias that only re-exports a third-party type is not a string set and stays an alias in `types.ts`.

## Tests

A test file sits in a `__test__` folder beside the file it tests and is named after it: `plugins/review-changes/hooks/git.ts` is tested by `plugins/review-changes/hooks/__test__/git.test.ts`.

A test verifies the behavior of its target, never how the target achieves it. A test that restates the implementation is tautological: it can only pass. A test that fails on a behavior-preserving refactor is a change detector. Both are worse than no test.

- Assert on what a caller can observe: the value returned for the inputs a caller passes, or the state change the caller relies on. Asserting that an internal function was called pins the implementation.
- Do not pin values no caller can observe, such as the shape of internal state or the format of an internal lookup key. Assert the property the caller relies on instead.
- Every utility function with behavior of its own is tested, whether it lives in the plugin's `hooks/` or in the viewer's `viewer/src/`.
- Do not test a declarative artifact against itself. A reader sees exactly what it accepts, so a test that restates its clauses documents nothing a reader lacks and catches no defect, because there is no logic to get wrong. Test the code that consumes it, where the behavior is emergent.
- Write the expected value out by hand. An expectation computed with the code under test copies its bug and still passes.
- Run the real collaborators. Mock only what cannot run for real: network, clock, randomness.
- When output is unstable, such as generated ids or timestamps, assert the property that must hold rather than the exact string.
- If a behavior-preserving refactor forces a test edit, rewrite that test against the behavior or delete it. Do not patch the expectation.
