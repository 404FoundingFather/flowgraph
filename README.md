# FlowGraph

Machine-verifiable maintenance contracts for codebases. Capture what breaks when code changes.

## What is FlowGraph?

FlowGraph is a lightweight contract system that answers one question: **"If I change X, what else breaks?"**

It captures the invisible maintenance relationships in your codebase — the ones where changing a database table silently breaks a repository method, or adding an enum value requires updating three switch statements in different files. These are the bugs that compilers don't catch and code review misses.

FlowGraph is designed for AI coding agents and human developers alike. It's not documentation, not a dependency graph, and not a type system. It's a maintenance contract.

### What goes in a FlowGraph:

- **co_change edges** — "if you change X, you must also update Y" (highest value)
- **validates edges** — runtime schema validation boundaries (Zod, Joi, etc.)
- **Invariants** — cross-cutting rules that span multiple files
- **Complex flows** — multi-file execution paths with non-trivial branching

### What does NOT go in a FlowGraph:

- Function call trees (read the code)
- Request/response shapes (that's documentation)
- Anything the type checker already enforces
- Simple linear flows with no branching

## Quick Start

```bash
# Verify your flowgraph against source code
npx flowgraph verify

# See what breaks if you change a specific node
npx flowgraph verify --impact table:users

# Create a starter flowgraph for your project
npx flowgraph init
```

## Example

Here's a minimal flowgraph for a todo API ([full example](./example/)):

```json
{
  "$flowgraph": "2.1",
  "meta": { "name": "todo-api", "root": "src/" },
  "nodes": {
    "type:TaskStatus": {
      "kind": "type",
      "loc": "types.ts:5",
      "values": ["pending", "in_progress", "done", "cancelled"]
    },
    "table:tasks": {
      "kind": "table",
      "loc": "../schema.sql:1"
    },
    "method:TaskRepository.create": {
      "kind": "method",
      "loc": "repository.ts:11"
    }
  },
  "edges": [
    {
      "from": "table:tasks",
      "to": "method:TaskRepository.create",
      "rel": "co_change",
      "note": "column changes require INSERT query update"
    }
  ],
  "flows": {},
  "invariants": []
}
```

This single `co_change` edge says: if you add a column to the `tasks` table, you must also update `TaskRepository.create` — because it has a raw INSERT query that lists columns explicitly. The verifier confirms both sides of this contract exist in your source code.

## CLI Commands

### `flowgraph verify [file]`

Runs four verification phases against your source code:

1. **Structural** — every node's `loc` points to a real file and the expected artifact exists (type definition, method signature, CREATE TABLE, route handler, etc.)
2. **Relational** — edges are valid (validates edges check for schema.parse() calls, co_change edges check both nodes exist)
3. **Sequential** — flow steps reference existing nodes and branch targets are reachable
4. **Invariant** — scoped nodes and files exist (custom invariant logic requires a project-specific checker)

Output: `PASS`, `FAIL`, or `WARN` for each check.

If no file is specified, auto-discovers `*.flowgraph.json` in the current directory.

### `flowgraph verify --impact <node:id>`

Shows everything affected by changing a node:
- Outgoing/incoming edges (with `co_change` edges highlighted)
- Flows containing the node
- Invariants scoping the node

### `flowgraph init`

Creates a starter `<project-name>.flowgraph.json` in the current directory.

## Specification

See [spec.md](./spec.md) for the full FlowGraph specification, including:
- All node kinds and their fields
- Edge types and when to use each
- Flow syntax and branching
- Invariant structure
- Extensibility with custom node kinds

## Integrating with AI Agents

FlowGraph is designed to be read by AI coding agents (Claude, GPT, Copilot, etc.). Add this to your agent's system prompt or project instructions:

```
Before modifying code, run: npx flowgraph verify --impact <node:id>
After modifying code, run: npx flowgraph verify
If verification fails, update the flowgraph to match your changes.
```

The agent gets a clear answer to "what else do I need to change?" without reading the entire codebase.

## Getting Started from Scratch

1. **Start small.** Run `npx flowgraph init` and replace the example with 5-10 `co_change` edges from your project. Focus on database table -> repository method pairs and enum -> switch statement pairs.

2. **Add invariants.** Write down 2-3 cross-cutting rules that a new contributor would violate without being told.

3. **Add validates edges** where runtime validation (Zod, Joi, etc.) marks a trust boundary.

4. **Only add flows** for complex multi-file paths with 3+ branching cases. Most projects have 2-5 of these.

See the [Getting Started section of the spec](./spec.md#getting-started) for detailed guidance.

## Philosophy

FlowGraph follows a "less is more" approach:

- Every element must prevent a real bug when code changes
- If it would drift silently without causing bugs, it doesn't belong
- Nodes exist because they're referenced by edges, flows, or invariants — not to document the codebase
- The maintenance cost of each element must be justified by the bugs it prevents

## License

MIT
