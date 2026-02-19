# FlowGraph Specification v2.1

A contract system optimized for AI agent verification and code modification.

## Core Idea

FlowGraph captures **maintenance contracts** — the relationships where changing one thing silently breaks another. It is NOT a comprehensive map of the codebase, and it is NOT documentation. Every element must justify its maintenance cost.

**Principles:**

1. **High-value only** — if the source code already says it (type signatures, call sites, method names), don't repeat it. Capture contracts that are invisible in any single file.
2. **Maintenance-aware** — every element must prevent a real bug when code changes. If it drifts silently without causing bugs, it shouldn't be in the graph.
3. **Query-oriented** — structured for "what breaks if I change X?" and "what must I also update?" questions.
4. **Context-efficient** — minimize tokens. Nodes need only `kind` + `loc` unless they carry high-value metadata (schemas, enum values, foreign keys).

## File Format

```json
{
  "$flowgraph": "2.1",
  "meta": { "name": "...", "root": "src/" },
  "nodes": { ... },
  "edges": [ ... ],
  "flows": { ... },
  "invariants": [ ... ]
}
```

`meta.root` is the base path for all `loc` references. Set it to your source root (e.g., `"src/"`, `"app/"`, `"lib/"`, or `""` for repo root).

## Nodes

Each node has a namespaced ID: `kind:Identifier`. Most nodes need only `kind` + `loc` — additional fields are listed below but should only be added when they carry information not visible in the source file.

### Common Fields (all nodes)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `kind` | string | yes | One of the built-in kinds (`type`, `method`, `table`, `endpoint`, `event`) or a custom kind (see [Extensibility](#extensibility)). |
| `loc` | string | yes | File path relative to `meta.root`, optionally `:line` |

### Node Kind: `type`

Lean reference to a type, interface, struct, or schema definition.

| Field | Type | Description |
|-------|------|-------------|
| `schema` | string | Runtime validation schema name (e.g., Zod, Joi, Pydantic). **High-value** — tells the agent a validation boundary exists. Include when a `validates` edge references this type. |
| `values` | array | For enums only. Enum values define state machines and drive switch/match statements. |

### Node Kind: `method`

A reference to a method or function. In practice, **most method nodes need only `kind` + `loc`**. A method node exists in the graph because it's referenced by a co_change edge, validates edge, invariant scope, or flow step — not to document its behavior.

| Field | Type | Description |
|-------|------|-------------|
| `pre` | array | Preconditions not enforced by the type system. **Rarely needed** — only for critical system boundaries. |
| `post` | array | Postconditions beyond the return type. **Rarely needed** — usually restates what the method name says. |
| `side_effects` | array | Non-graph effects: `fs:`, `shell:`, `git:`, `http:`, `ext:`. Only include when truly non-obvious. |
| `errors` | object | Error contract: `{ condition: consequence }`. **Rarely needed.** |

### Node Kind: `table`

Reference to a persistent data store. Tables are high-value nodes because they're almost always co_change sources.

| Field | Type | Description |
|-------|------|-------------|
| `fk` | array | Foreign key references. Captures cross-entity relationships. |
| `indexes` | array | Index definitions. |
| `triggers` | array | Trigger definitions. |

### Node Kind: `endpoint`

Most endpoint nodes need only `kind` + `loc`. Request/response shapes are documentation, not contracts — put them in docs if needed.

| Field | Type | Description |
|-------|------|-------------|
| `request` | object | `{ body?, query?, params? }` shape descriptions. **Optional** — only if the shape isn't obvious from the handler code. |
| `response` | object | Status code to response shape. **Optional.** |

### Node Kind: `event`

Minimal: just `kind` and `loc`. Include only when referenced by a flow step.

| Field | Type | Description |
|-------|------|-------------|
| `payload` | array | Parameter types. Only include if non-obvious. |

## Edges

Edges capture relationships where changes propagate silently. **co_change and validates are the primary edge types.** Other edge types exist for completeness but should be used sparingly.

### Primary edges (include these):

| Relation | When to include | Example |
|----------|----------------|---------|
| `co_change` | **Changing the `from` node requires also changing the `to` node.** This is the highest-value edge. Every table should have co_change edges to its repository methods. Every enum/config type should have co_change edges to code that branches on its values. | table:orders -> method:OrderRepo.create |
| `validates` | Method performs runtime schema validation on a type. Marks a trust boundary between unvalidated and validated data. | method:OrderService.create -> type:Order |

### Secondary edges (include sparingly):

| Relation | When to include | Example |
|----------|----------------|---------|
| `calls` | Cross-file calls through deep indirection (constructor injection, plugin systems) where the call is truly non-obvious. **Most calls are visible by reading the caller — don't add edges for those.** | |
| `writes` | **Usually redundant with co_change.** Only include if the write relationship isn't captured by a co_change edge and is non-obvious. | |
| `reads` | Same as writes — usually redundant. | |
| `emits` | Method emits an event. Only include if the wiring is in a different file and non-obvious. | |
| `listens` | Something subscribes to an event. Same criteria as emits. | |

### What to OMIT:

- `calls` edges where the call is visible by reading the method at `loc`
- `writes`/`reads` edges when a co_change edge already captures the table->method relationship
- `emits`/`listens` edges when the event wiring is in the same file or obvious from the emitter
- Any edge that would be caught by the compiler or type checker if broken

### Edge Format

```json
{ "from": "node:id", "to": "node:id", "rel": "relation", "note": "optional context" }
```

The `note` field explains the relationship when non-obvious (e.g., "column changes require INSERT query update").

## Flows

Flows document complex execution paths that cross multiple files and have non-trivial branching. **Most projects have 2-5 of these.** If a flow is a straight sequence of calls visible in one method, it doesn't need a flow definition.

```json
{
  "flow-name": {
    "trigger": "what initiates this",
    "steps": [
      { "node": "method:X", "then": "next" },
      { "node": "event:Y", "then": { "condition_a": "next", "condition_b": "method:Z", "condition_c": "FAIL" } }
    ]
  }
}
```

### `then` values:
- `"next"` — proceed to next step
- `"DONE"` / `"FAIL"` — terminal states
- `"node:id"` — jump (loop or skip)
- `{ condition: target, ... }` — conditional branch

### When to add a flow:

- The execution path crosses 3+ files
- There are 3+ branching cases (not just success/failure)
- The path includes loops, retries, or async handoffs
- A developer reading one file can't see the full picture

### When NOT to add a flow:

- Linear sequence: endpoint -> service -> repo -> done
- Simple success/failure branching visible in one method
- The edges and source code are sufficient to understand the path

## Invariants

Rules that span multiple components. These are the highest-value elements alongside co_change edges — they capture constraints an agent would violate without knowing about them.

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique ID (e.g. `INV-001`) |
| `rule` | string | What must hold |
| `scope` | array | Node IDs this applies to. Required — unscoped invariants are too vague to verify. |
| `enforce` | string | How it's enforced. Required — tells the agent where to look. |

## Extensibility

The five built-in node kinds (`type`, `method`, `table`, `endpoint`, `event`) cover most projects. If your project has domain concepts that don't fit, define custom node kinds:

| Custom Kind | Use Case | Example |
|-------------|----------|---------|
| `queue` | Message queues, job queues, task brokers | `queue:order-processing` |
| `service` | External service dependencies | `service:stripe-payments` |
| `config` | Configuration groups that affect behavior | `config:feature-flags` |
| `job` | Background jobs, cron tasks | `job:nightly-cleanup` |
| `migration` | Database migrations | `migration:003_add_indexes` |

Custom kinds use the same common fields (`kind`, `loc`) and participate in edges, flows, and invariants like any built-in kind.

## Impact Analysis

The primary use case for an AI agent is: **"I need to change X. What else is affected?"**

A verification script should support an `--impact node:id` flag that traverses the graph:

1. Find the node being changed.
2. Follow all `co_change` edges (both directions) — these are required co-modifications.
3. Check which flows include the node — the flow may need updating.
4. Check which invariants scope the node — the invariant may be violated.

## Verification Procedure

### Structural
For each node, confirm the artifact exists at `loc` with expected shape.

### Relational
For each edge, confirm the relationship exists in source. Pay special attention to `co_change` edges — these are maintenance contracts. `validates` edges should confirm the schema parse call exists.

### Sequential
For each flow, trace the path and confirm all step nodes exist and branch targets are reachable.

### Invariant
For each invariant, examine scoped code and confirm the rule holds.

### Output
- **PASS** — verified
- **FAIL** — does not match source
- **WARN** — partially matches or requires semantic judgment

## Getting Started

FlowGraph is designed for incremental adoption. Start with the elements that deliver the most value.

### Step 1: Start with co_change edges

These deliver the most immediate value. Identify the pairs where changing one thing silently breaks another:
- Database schema -> repository/DAO methods that use raw queries
- Enum/union types -> switch/match statements that branch on values
- Config schemas -> code that reads config values by key
- Interface types -> implementation classes

Even 5-10 `co_change` edges with their connected nodes make a useful flowgraph.

### Step 2: Add invariants

Write down the cross-cutting rules that a new contributor (or AI agent) would violate without being told:
- "All user input must be validated before persistence"
- "Every database write must be wrapped in a transaction"
- "Feature flags must be checked before calling experimental endpoints"

Include `scope` and `enforce` — vague invariants are useless.

### Step 3: Add validates edges for runtime boundaries

Identify where unvalidated data becomes validated (Zod parse, JSON schema validation, etc.). These mark trust boundaries that must not be removed.

### Step 4: Add flows for complex paths

Only model execution paths that cross multiple files and have non-trivial branching (3+ cases). Most projects have 2-5 of these.

### What NOT to do

- Don't add method nodes with pre/post/errors unless the contract is truly non-obvious and high-value.
- Don't add calls/writes/reads/emits edges for relationships visible by reading the source.
- Don't add endpoint request/response shapes — those are documentation, not contracts.
- Don't add flows for straight-line code — edges are sufficient.
- Don't add nodes that aren't referenced by any edge, invariant, or flow.
