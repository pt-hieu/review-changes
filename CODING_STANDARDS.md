# Coding standards

## Source text

- No code comments. Names and structure carry the meaning.
- Identifiers are spelled out in full. No abbreviations, no single-letter parameters.
- A hook keeps the engine's signature `($, e, next)`: `$` is the engine interface, `e` the event, `next` the rest of the chain. Every other name is spelled out.

## Grouping

Statements inside a function are grouped by goal: the lines that together achieve one thing sit next to each other, and a blank line separates one group from the next. Each branch of a conditional is its own group.

## Domain state

A piece of domain knowledge lives in one structure that encodes it: a state machine for a lifecycle, a lookup table keyed on the variant for per-variant values, a discriminated union for variants that hold different data. Code reads the structure instead of branching on the same condition in several places. In this repo, `STATUS_LETTERS` in `tui/src/review/analysis.ts`, keyed on `ReviewFileStatus`, is one.

- A new variant is a new entry in the structure. A change that adds one more branch to an if/else chain that already exists is the sign the structure is missing.
- State that two booleans would have to keep in sync is one value: `status: Status.Loading` rather than `isLoading` beside `isLoaded`.
- A module is organized around the domain knowledge it owns. A pipeline split into steps (load, validate, transform, save) repeats the same domain rules in each step.
- Logic that lives in one place and has two or three cases stays a plain conditional. A structure earns its place by deleting branches, duplicated rules, or invalid states.

## Boundaries

Data from outside the program, from `process.env` reads, command-line arguments, the session file and the analyzer's answer, `git` and `gh` output, and the engine's hook environment, is parsed into the repo's own types where it enters. Code past that point trusts those types and checks nothing again.

- A parse function turns raw input into a typed value or an error, and business logic receives the typed value.
- Business logic is pure functions with no framework imports. The framework layer parses input, calls them, and writes the output.
- The public surface of a module exposes the repo's domain types. Transport, storage, and wire types stay inside the module that talks to them.

## Types admit only valid states

A type admits the states the program can be in, and the compiler rejects the rest.

- Variants that hold different data are a discriminated union keyed on an enum member. `{ completed: boolean; completedAt?: Date }` admits a completed task with no date, and `{ status: TaskStatus.Open } | { status: TaskStatus.Done; completedAt: Date }` admits valid tasks alone. A comment explaining which combinations of fields are valid marks a type that is a union.
- A `switch` over a union handles every member and ends in a `default` that assigns the value to `never`, so adding a member fails compilation at every `switch` that misses it.
- Two values that share a primitive and differ in meaning, such as a `UserId` and an `OrderId`, are branded types, each created by one function that validates it.
- `as`, a non-null `!`, and `any` each assert a fact the compiler cannot prove. The fact is proven where the data enters (see Boundaries), and the assertion goes.
- A runtime check or a "should never happen" throw marks a type that is wider than the data. The type narrows at that spot and no further: a type tracks what each caller must handle, and a function that has an answer for every input keeps the plain type.

## Enums, not string unions

A closed set of string values is a TypeScript enum with string values, declared in the `types.ts` of the module that owns the set. Members are PascalCase. Values are the strings the wire format or storage already uses.

The enum is the source of truth. Do not declare the set as a union type. Lookup tables key on the enum members, and every consumer, including tests, passes the enum member rather than its string value.

A value set declared in the plugin's state contract, `plugins/review-changes/types/index.d.ts`, stays a union there, because a declaration file holds no runtime values.

Boolean variants are not string sets and stay booleans. A type alias that only re-exports a third-party type is not a string set and stays an alias in `types.ts`.

## Tests

A test file sits in a `__test__` folder beside the file it tests and is named after it: `tui/src/review/git.ts` is tested by `tui/src/review/__test__/git.test.ts`.

A test verifies the behavior of its target, never how the target achieves it. A test that restates the implementation is tautological: it can only pass. A test that fails on a behavior-preserving refactor is a change detector. Both are worse than no test.

- Assert on what a caller can observe: the value returned for the inputs a caller passes, or the state change the caller relies on. Asserting that an internal function was called pins the implementation.
- Do not pin values no caller can observe, such as the shape of internal state or the format of an internal lookup key. Assert the property the caller relies on instead.
- Every utility function with behavior of its own is tested, whether it lives in the plugin's `hooks/` or in the app's `tui/src/`.
- Do not test a declarative artifact against itself. A reader sees exactly what it accepts, so a test that restates its clauses documents nothing a reader lacks and catches no defect, because there is no logic to get wrong. Test the code that consumes it, where the behavior is emergent.
- Write the expected value out by hand. An expectation computed with the code under test copies its bug and still passes.
- Run the real collaborators. Mock only what cannot run for real: network, clock, randomness.
- When output is unstable, such as generated ids or timestamps, assert the property that must hold rather than the exact string.
- If a behavior-preserving refactor forces a test edit, rewrite that test against the behavior or delete it. Do not patch the expectation.
