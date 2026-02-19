#!/usr/bin/env node
/**
 * FlowGraph CLI — verify maintenance contracts against source code.
 *
 * Usage:
 *   flowgraph verify [path/to/file.flowgraph.json]
 *   flowgraph verify --impact <node:id> [path/to/file.flowgraph.json]
 *   flowgraph render [path/to/file.flowgraph.json]
 *   flowgraph init
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";

// ─── State ───────────────────────────────────────────────────────────────────

const results = [];

function record(status, category, id, message) {
  results.push({ status, id, category, message });
}

// ─── CLI Parsing ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

if (!command || command === "--help" || command === "-h") {
  printUsage();
  process.exit(0);
}

if (command === "init") {
  runInit();
  process.exit(0);
}

if (command === "verify") {
  const verifyArgs = args.slice(1);
  const impactIdx = verifyArgs.indexOf("--impact");
  const impactNode = impactIdx !== -1 ? verifyArgs[impactIdx + 1] : null;

  // Find flowgraph file: explicit arg, or auto-discover *.flowgraph.json
  const explicitFile = verifyArgs.find(
    (a) => !a.startsWith("--") && (impactIdx === -1 || verifyArgs.indexOf(a) !== impactIdx + 1)
  );
  const flowgraphPath = resolveFlowgraphPath(explicitFile);

  if (!flowgraphPath) {
    console.error("No flowgraph file found. Pass a path or run `flowgraph init` to create one.");
    process.exit(1);
  }

  const projectRoot = dirname(flowgraphPath);
  const flowgraph = JSON.parse(readFileSync(flowgraphPath, "utf-8"));

  if (impactNode) {
    runImpactAnalysis(impactNode, flowgraph, projectRoot);
  } else {
    runVerification(flowgraph, projectRoot, flowgraphPath);
  }
} else if (command === "render") {
  const explicitFile = args[1];
  const flowgraphPath = resolveFlowgraphPath(explicitFile);

  if (!flowgraphPath) {
    console.error("No flowgraph file found. Pass a path or run `flowgraph-ai init` to create one.");
    process.exit(1);
  }

  const flowgraph = JSON.parse(readFileSync(flowgraphPath, "utf-8"));
  runRender(flowgraph, flowgraphPath);
} else {
  console.error(`Unknown command: ${command}`);
  printUsage();
  process.exit(1);
}

// ─── Commands ────────────────────────────────────────────────────────────────

function printUsage() {
  console.log(`
FlowGraph — machine-verifiable maintenance contracts

Usage:
  flowgraph-ai verify [file.flowgraph.json]          Verify contracts against source
  flowgraph-ai verify --impact <node:id> [file]       Show impact of changing a node
  flowgraph-ai render [file.flowgraph.json]           Render as Mermaid diagrams (markdown)
  flowgraph-ai init                                    Create a starter flowgraph

Options:
  --help, -h    Show this help message

If no file is specified, discovers *.flowgraph.json in the current directory.
`);
}

function resolveFlowgraphPath(explicit) {
  if (explicit) {
    const p = resolve(process.cwd(), explicit);
    if (existsSync(p)) return p;
    console.error(`File not found: ${explicit}`);
    process.exit(1);
  }

  // Auto-discover
  const cwd = process.cwd();
  const entries = readdirSyncSafe(cwd);
  const matches = entries.filter((e) => e.endsWith(".flowgraph.json"));

  if (matches.length === 1) return resolve(cwd, matches[0]);
  if (matches.length > 1) {
    console.error("Multiple flowgraph files found. Specify one:");
    for (const m of matches) console.error(`  ${m}`);
    process.exit(1);
  }
  return null;
}

function readdirSyncSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function runInit() {
  const name = basename(process.cwd());
  const template = {
    $flowgraph: "2.1",
    meta: { name, root: "src/" },
    nodes: {
      "type:ExampleConfig": {
        kind: "type",
        loc: "config.ts:1",
      },
      "method:loadConfig": {
        kind: "method",
        loc: "config.ts:10",
      },
    },
    edges: [
      {
        from: "type:ExampleConfig",
        to: "method:loadConfig",
        rel: "co_change",
        note: "adding a config field requires updating the loader",
      },
    ],
    flows: {},
    invariants: [],
  };

  const filename = `${name}.flowgraph.json`;
  if (existsSync(filename)) {
    console.error(`${filename} already exists.`);
    process.exit(1);
  }

  writeFileSync(filename, JSON.stringify(template, null, 2) + "\n");
  console.log(`Created ${filename} — edit it to match your project.`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resolveLoc(loc, root, projectRoot) {
  const parts = loc.split(":");
  const linePart =
    parts.length > 1 && /^\d+$/.test(parts[parts.length - 1])
      ? parts.pop()
      : undefined;
  const pathPart = parts.join(":");
  const filePath = resolve(projectRoot, root, pathPart);
  return { filePath, line: linePart ? parseInt(linePart, 10) : undefined };
}

function readSource(filePath) {
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function getRegion(source, lineNum, radius = 15) {
  const lines = source.split("\n");
  const start = Math.max(0, lineNum - 1 - radius);
  const end = Math.min(lines.length, lineNum - 1 + radius);
  return lines.slice(start, end).join("\n");
}

function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function has(source, pattern) {
  if (typeof pattern === "string") return source.includes(pattern);
  return pattern.test(source);
}

// ─── Node Verification ──────────────────────────────────────────────────────

function verifyTypeNode(id, node, root, projectRoot) {
  const { filePath, line } = resolveLoc(node.loc, root, projectRoot);
  const source = readSource(filePath);

  if (!source) {
    record("FAIL", "structural", id, `File not found: ${node.loc}`);
    return;
  }

  const typeName = id.replace("type:", "");
  const patterns = [
    new RegExp(`(interface|type|enum|class|struct)\\s+${esc(typeName)}\\b`),
    new RegExp(`(const|export const|let|var)\\s+${esc(typeName)}Schema\\s*=`),
    new RegExp(`(const|export const|let|var)\\s+${esc(typeName)}\\s*=`),
    new RegExp(`(def|class)\\s+${esc(typeName)}[:\\(\\b]`), // Python
  ];

  if (!patterns.some((p) => has(source, p))) {
    record("FAIL", "structural", id, `Type '${typeName}' not found in ${node.loc}`);
    return;
  }

  if (line) {
    const region = getRegion(source, line, 5);
    if (patterns.some((p) => has(region, p))) {
      record("PASS", "structural", id, `Found at ${node.loc}`);
    } else {
      record("WARN", "structural", id, `Found in file but not near line ${line}`);
    }
  } else {
    record("PASS", "structural", id, `Found in ${node.loc}`);
  }

  if (node.schema && !has(source, node.schema)) {
    record("FAIL", "structural", id, `Schema '${node.schema}' not found`);
  }

  if (Array.isArray(node.values)) {
    for (const val of node.values) {
      if (!has(source, val)) {
        record("FAIL", "structural", id, `Enum value '${val}' not found`);
      }
    }
  }
}

function verifyMethodNode(id, node, root, projectRoot) {
  const { filePath, line } = resolveLoc(node.loc, root, projectRoot);
  const source = readSource(filePath);

  if (!source) {
    record("FAIL", "structural", id, `File not found: ${node.loc}`);
    return;
  }

  const fullName = id.replace("method:", "");
  const methodName = fullName.split(".").pop();

  const patterns = [
    new RegExp(`(async\\s+)?${esc(methodName)}\\s*\\(`),
    new RegExp(`(private|public|protected)\\s+(async\\s+)?${esc(methodName)}\\s*\\(`),
    new RegExp(`def\\s+${esc(methodName)}\\s*\\(`), // Python
    new RegExp(`func\\s+${esc(methodName)}\\s*\\(`), // Go
    new RegExp(`fn\\s+${esc(methodName)}\\s*[<(]`), // Rust
  ];

  if (!patterns.some((p) => has(source, p))) {
    record("FAIL", "structural", id, `Method '${methodName}' not found in ${node.loc}`);
    return;
  }

  if (line) {
    const region = getRegion(source, line, 5);
    if (patterns.some((p) => has(region, p))) {
      record("PASS", "structural", id, `Found at ${node.loc}`);
    } else {
      record("WARN", "structural", id, `Method found but not near line ${line}`);
    }
  } else {
    record("PASS", "structural", id, `Found in ${node.loc}`);
  }
}

function verifyTableNode(id, node, root, projectRoot) {
  const { filePath } = resolveLoc(node.loc, root, projectRoot);
  const source = readSource(filePath);

  if (!source) {
    record("FAIL", "structural", id, `File not found: ${node.loc}`);
    return;
  }

  const tableName = id.replace("table:", "");
  if (
    !has(
      source,
      new RegExp(
        `CREATE TABLE\\s+(IF NOT EXISTS\\s+)?${esc(tableName)}\\b`,
        "i"
      )
    )
  ) {
    record("FAIL", "structural", id, `CREATE TABLE '${tableName}' not found`);
    return;
  }

  record("PASS", "structural", id, `Table found`);

  if (Array.isArray(node.fk)) {
    for (const fk of node.fk) {
      const match = fk.match(/-> (\w+)/);
      if (match && !has(source, match[1])) {
        record("WARN", "structural", id, `FK to '${match[1]}' not in DDL`);
      }
    }
  }
}

function verifyEndpointNode(id, node, root, projectRoot) {
  const { filePath, line } = resolveLoc(node.loc, root, projectRoot);
  const source = readSource(filePath);

  if (!source) {
    record("FAIL", "structural", id, `File not found: ${node.loc}`);
    return;
  }

  const endpointStr = id.replace("endpoint:", "");
  const spaceIdx = endpointStr.indexOf(" ");
  if (spaceIdx === -1) {
    // No HTTP method prefix — just check the string appears
    if (has(source, endpointStr)) {
      record("PASS", "structural", id, `Endpoint reference found`);
    } else {
      record("FAIL", "structural", id, `Endpoint '${endpointStr}' not found`);
    }
    return;
  }

  const httpMethod = endpointStr.substring(0, spaceIdx).toLowerCase();
  const path = endpointStr.substring(spaceIdx + 1);

  const routePatterns = [
    new RegExp(`\\.${esc(httpMethod)}\\s*\\(\\s*['"\`]${esc(path)}['"\`]`),
    new RegExp(`${esc(httpMethod)}.*${esc(path)}`),
  ];

  if (routePatterns.some((p) => has(source, p))) {
    if (line) {
      const region = getRegion(source, line, 10);
      if (routePatterns.some((p) => has(region, p))) {
        record("PASS", "structural", id, `Route found at ${node.loc}`);
      } else {
        record("WARN", "structural", id, `Route in file but not near line ${line}`);
      }
    } else {
      record("PASS", "structural", id, `Route found in ${node.loc}`);
    }
  } else {
    record("FAIL", "structural", id, `Route '${httpMethod} ${path}' not found`);
  }
}

function verifyEventNode(id, node, root, projectRoot) {
  const { filePath } = resolveLoc(node.loc, root, projectRoot);
  const source = readSource(filePath);

  if (!source) {
    record("FAIL", "structural", id, `File not found: ${node.loc}`);
    return;
  }

  const eventName = id.replace("event:", "");

  if (
    has(source, new RegExp(`['"\`]${esc(eventName)}['"\`]`)) ||
    has(source, eventName)
  ) {
    record("PASS", "structural", id, `Event '${eventName}' found`);
  } else {
    record("FAIL", "structural", id, `Event '${eventName}' not found`);
  }
}

// ─── Edge Verification ──────────────────────────────────────────────────────

function verifyEdge(edge, nodes, root, projectRoot) {
  const edgeId = `${edge.from} -[${edge.rel}]-> ${edge.to}`;
  const fromNode = nodes[edge.from];
  const toNode = nodes[edge.to];

  if (!fromNode) {
    record("FAIL", "relational", edgeId, `Source node missing`);
    return;
  }
  if (!toNode) {
    record("FAIL", "relational", edgeId, `Target node missing`);
    return;
  }

  const { filePath } = resolveLoc(fromNode.loc, root, projectRoot);
  const source = readSource(filePath);
  if (!source) {
    record("FAIL", "relational", edgeId, `Source file not found`);
    return;
  }

  switch (edge.rel) {
    case "co_change": {
      // Co-change edges are maintenance contracts — both nodes existing is the check
      record(
        "PASS",
        "relational",
        edgeId,
        `Co-change contract${edge.note ? ": " + edge.note : ""}`
      );
      break;
    }
    case "validates": {
      const schemaName = toNode?.schema;
      if (schemaName) {
        // Check for common validation patterns
        const validationPatterns = [
          new RegExp(`${esc(schemaName)}\\.(parse|safeParse|validate)\\s*\\(`),
          new RegExp(`${esc(schemaName)}\\.check\\s*\\(`),
        ];
        if (validationPatterns.some((p) => has(source, p))) {
          record("PASS", "relational", edgeId, `${schemaName} validation found`);
        } else {
          record("FAIL", "relational", edgeId, `No ${schemaName} validation call`);
        }
      } else {
        record("WARN", "relational", edgeId, "No schema declared on target");
      }
      break;
    }
    case "calls": {
      const methodName = edge.to.replace("method:", "").split(".").pop();
      if (has(source, new RegExp(`${esc(methodName)}\\s*\\(`))) {
        record("PASS", "relational", edgeId, "Call site found");
      } else {
        record("FAIL", "relational", edgeId, `No call to '${methodName}'`);
      }
      break;
    }
    case "writes":
    case "reads": {
      const tableName = edge.to.replace("table:", "");
      const dbPatterns = [
        new RegExp(
          `(INSERT INTO|UPDATE|DELETE FROM|SELECT.*FROM)\\s+${esc(tableName)}`,
          "i"
        ),
        new RegExp(`['"\`].*${esc(tableName)}.*['"\`]`),
      ];
      if (dbPatterns.some((p) => has(source, p))) {
        record("PASS", "relational", edgeId, `DB op on '${tableName}' found`);
      } else {
        record("WARN", "relational", edgeId, "No direct DB op (may be indirect)");
      }
      break;
    }
    case "emits": {
      const eventName = edge.to.replace("event:", "");
      if (has(source, new RegExp(`['"\`]${esc(eventName)}['"\`]`))) {
        record("PASS", "relational", edgeId, `Event '${eventName}' referenced`);
      } else {
        record("FAIL", "relational", edgeId, `No reference to '${eventName}'`);
      }
      break;
    }
    case "listens": {
      const eventName = edge.to.replace("event:", "");
      if (has(source, new RegExp(`['"\`]${esc(eventName)}['"\`]`))) {
        record("PASS", "relational", edgeId, `Listener for '${eventName}' found`);
      } else {
        record("WARN", "relational", edgeId, `No listener for '${eventName}'`);
      }
      break;
    }
    default:
      record("PASS", "relational", edgeId, `Relation '${edge.rel}' accepted`);
  }
}

// ─── Flow Verification ──────────────────────────────────────────────────────

function verifyFlows(flows, nodes) {
  for (const [name, flow] of Object.entries(flows)) {
    let allExist = true;
    const missing = [];

    for (const step of flow.steps) {
      if (!nodes[step.node]) {
        allExist = false;
        missing.push(step.node);
      }

      if (typeof step.then === "object" && step.then !== null) {
        for (const target of Object.values(step.then)) {
          if (
            target !== "next" &&
            target !== "DONE" &&
            target !== "FAIL" &&
            !nodes[target]
          ) {
            allExist = false;
            missing.push(target);
          }
        }
      }
    }

    if (allExist) {
      record("PASS", "flow", name, `All ${flow.steps.length} step nodes exist`);
    } else {
      record("FAIL", "flow", name, `Missing nodes: ${missing.join(", ")}`);
    }

    let allReachable = true;
    for (const step of flow.steps) {
      if (typeof step.then === "object" && step.then !== null) {
        for (const [cond, target] of Object.entries(step.then)) {
          if (target !== "next" && target !== "DONE" && target !== "FAIL") {
            const inSteps = flow.steps.some((s) => s.node === target);
            if (!inSteps) {
              record(
                "WARN",
                "flow",
                name,
                `'${cond}' -> '${target}' not in step list`
              );
              allReachable = false;
            }
          }
        }
      }
    }

    if (allReachable) {
      record("PASS", "flow", name, "All branch targets reachable");
    }
  }
}

// ─── Invariant Verification ─────────────────────────────────────────────────

function verifyInvariants(invariants, nodes, root, projectRoot) {
  for (const inv of invariants) {
    // Check all scoped nodes exist
    const missingNodes = (inv.scope || []).filter((s) => !nodes[s]);
    if (missingNodes.length > 0) {
      record(
        "FAIL",
        "invariant",
        inv.id,
        `Scoped nodes missing: ${missingNodes.join(", ")}`
      );
      continue;
    }

    // Check all scoped files are readable
    const scopeNodes = (inv.scope || []).map((s) => nodes[s]).filter(Boolean);
    let allFilesExist = true;
    for (const n of scopeNodes) {
      const { filePath } = resolveLoc(n.loc, root, projectRoot);
      if (!readSource(filePath)) {
        allFilesExist = false;
        break;
      }
    }

    if (!allFilesExist) {
      record("FAIL", "invariant", inv.id, `Some scoped files not found`);
      continue;
    }

    const enforceNote = inv.enforce ? ` [enforce: ${inv.enforce}]` : "";
    record(
      "WARN",
      "invariant",
      inv.id,
      `${inv.rule} — requires manual/custom verification${enforceNote}`
    );
  }
}

// ─── Impact Analysis ────────────────────────────────────────────────────────

function runImpactAnalysis(nodeId, flowgraph, projectRoot) {
  const edges = flowgraph.edges.filter((e) => !e._comment);
  const node = flowgraph.nodes[nodeId];

  console.log(`\n\x1b[36m${"=".repeat(64)}\x1b[0m`);
  console.log(`\x1b[36m  Impact Analysis: \x1b[1m${nodeId}\x1b[0m`);
  if (node) {
    console.log(`\x1b[36m  Kind: ${node.kind}  Loc: ${node.loc}\x1b[0m`);
  } else {
    console.log(`\x1b[31m  Node not found in flowgraph!\x1b[0m`);
    console.log(`\x1b[36m${"=".repeat(64)}\x1b[0m\n`);
    console.log("Available nodes:");
    for (const id of Object.keys(flowgraph.nodes).sort()) {
      console.log(`  ${id}`);
    }
    process.exit(1);
  }
  console.log(`\x1b[36m${"=".repeat(64)}\x1b[0m`);

  // Outgoing
  const outgoing = edges.filter((e) => e.from === nodeId);
  console.log(
    `\n\x1b[1m-> Outgoing edges\x1b[0m (${outgoing.length} — things this node affects):\n`
  );
  if (outgoing.length === 0) {
    console.log("  (none)");
  } else {
    for (const e of outgoing) {
      const marker =
        e.rel === "co_change" ? "\x1b[31m! MUST CO-CHANGE\x1b[0m " : "";
      console.log(`  ${marker}\x1b[33m-[${e.rel}]->\x1b[0m ${e.to}`);
      if (e.note) console.log(`           ${e.note}`);
    }
  }

  // Incoming
  const incoming = edges.filter((e) => e.to === nodeId);
  console.log(
    `\n\x1b[1m<- Incoming edges\x1b[0m (${incoming.length} — things that depend on this node):\n`
  );
  if (incoming.length === 0) {
    console.log("  (none)");
  } else {
    for (const e of incoming) {
      const marker =
        e.rel === "co_change" ? "\x1b[31m! MUST CO-CHANGE\x1b[0m " : "";
      console.log(`  ${marker}${e.from} \x1b[33m-[${e.rel}]->\x1b[0m`);
      if (e.note) console.log(`           ${e.note}`);
    }
  }

  // Co-change summary
  const cochangeOut = outgoing.filter((e) => e.rel === "co_change");
  const cochangeIn = incoming.filter((e) => e.rel === "co_change");
  if (cochangeOut.length + cochangeIn.length > 0) {
    console.log(`\n\x1b[1;31m! Required co-changes:\x1b[0m\n`);
    for (const e of cochangeOut) {
      console.log(
        `  -> You change \x1b[1m${nodeId}\x1b[0m, you MUST also update \x1b[1m${e.to}\x1b[0m`
      );
      if (e.note) console.log(`     Reason: ${e.note}`);
    }
    for (const e of cochangeIn) {
      console.log(
        `  <- If \x1b[1m${e.from}\x1b[0m changes, this node (\x1b[1m${nodeId}\x1b[0m) must also be updated`
      );
      if (e.note) console.log(`     Reason: ${e.note}`);
    }
  }

  // Flows
  const containingFlows = [];
  for (const [name, flow] of Object.entries(flowgraph.flows || {})) {
    const inFlow = flow.steps.some((s) => s.node === nodeId);
    const branchTarget = flow.steps.some((s) => {
      if (typeof s.then === "object" && s.then !== null) {
        return Object.values(s.then).includes(nodeId);
      }
      return false;
    });
    if (inFlow || branchTarget)
      containingFlows.push({ name, flow, inFlow, branchTarget });
  }
  console.log(`\n\x1b[1mFlows\x1b[0m (${containingFlows.length}):\n`);
  if (containingFlows.length === 0) {
    console.log("  (none)");
  } else {
    for (const { name, flow, inFlow, branchTarget } of containingFlows) {
      const roles = [inFlow && "step", branchTarget && "branch target"]
        .filter(Boolean)
        .join(", ");
      console.log(
        `  \x1b[36m${name}\x1b[0m (${roles}) — trigger: ${flow.trigger}`
      );
    }
  }

  // Invariants
  const scopedInvariants = (flowgraph.invariants || []).filter((inv) =>
    (inv.scope || []).includes(nodeId)
  );
  console.log(`\n\x1b[1mInvariants\x1b[0m (${scopedInvariants.length}):\n`);
  if (scopedInvariants.length === 0) {
    console.log("  (none)");
  } else {
    for (const inv of scopedInvariants) {
      console.log(`  \x1b[33m${inv.id}\x1b[0m: ${inv.rule}`);
      if (inv.enforce) console.log(`         Enforce: ${inv.enforce}`);
    }
  }

  console.log("");
}

// ─── Full Verification ──────────────────────────────────────────────────────

function runVerification(flowgraph, projectRoot, flowgraphPath) {
  const root = flowgraph.meta.root || "";

  console.log(`\n${"=".repeat(64)}`);
  console.log(`  FlowGraph Verification: ${flowgraph.meta.name || basename(flowgraphPath)}`);
  console.log(`  Spec version: ${flowgraph.$flowgraph || "unknown"}`);
  console.log(`${"=".repeat(64)}\n`);

  // 1. Structural — verify each node exists at loc
  const nodeVerifiers = {
    type: verifyTypeNode,
    method: verifyMethodNode,
    table: verifyTableNode,
    endpoint: verifyEndpointNode,
    event: verifyEventNode,
  };

  for (const [id, node] of Object.entries(flowgraph.nodes)) {
    const verifier = nodeVerifiers[node.kind];
    if (verifier) {
      verifier(id, node, root, projectRoot);
    } else {
      // Custom kind — just check file exists
      const { filePath } = resolveLoc(node.loc, root, projectRoot);
      if (readSource(filePath)) {
        record("PASS", "structural", id, `File exists at ${node.loc}`);
      } else {
        record("FAIL", "structural", id, `File not found: ${node.loc}`);
      }
    }
  }

  // 2. Relational — verify edges
  for (const edge of flowgraph.edges) {
    if (edge._comment) continue;
    verifyEdge(edge, flowgraph.nodes, root, projectRoot);
  }

  // 3. Sequential — verify flows
  if (flowgraph.flows) {
    verifyFlows(flowgraph.flows, flowgraph.nodes);
  }

  // 4. Invariant
  if (flowgraph.invariants) {
    verifyInvariants(flowgraph.invariants, flowgraph.nodes, root, projectRoot);
  }

  // Print grouped results
  const categories = ["structural", "relational", "flow", "invariant"];
  for (const cat of categories) {
    const catResults = results.filter((r) => r.category === cat);
    if (catResults.length === 0) continue;

    const p = catResults.filter((r) => r.status === "PASS").length;
    const f = catResults.filter((r) => r.status === "FAIL").length;
    const w = catResults.filter((r) => r.status === "WARN").length;

    console.log(
      `\n## ${cat.charAt(0).toUpperCase() + cat.slice(1)} (${p} pass, ${f} fail, ${w} warn)\n`
    );
    for (const r of catResults) {
      const icon =
        r.status === "PASS" ? "+" : r.status === "FAIL" ? "x" : "?";
      const color =
        r.status === "PASS"
          ? "\x1b[32m"
          : r.status === "FAIL"
            ? "\x1b[31m"
            : "\x1b[33m";
      console.log(`  ${color}[${r.status}]\x1b[0m ${icon} ${r.id}`);
      if (r.message) console.log(`         ${r.message}`);
    }
  }

  // Summary
  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const warn = results.filter((r) => r.status === "WARN").length;

  console.log(`\n${"=".repeat(64)}`);
  console.log(
    `  Summary: \x1b[32m${pass} PASS\x1b[0m  \x1b[31m${fail} FAIL\x1b[0m  \x1b[33m${warn} WARN\x1b[0m  (${results.length} total)`
  );
  console.log(`${"=".repeat(64)}\n`);

  if (fail > 0) process.exit(1);
}

// ─── Mermaid Rendering ──────────────────────────────────────────────────────

function sanitizeMermaidId(id) {
  return id.replace(/[:./ \-]/g, "_");
}

function shortLabel(id) {
  return id.replace(/^[^:]+:/, "");
}

function renderDependencyGraph(fg) {
  const lines = ["graph LR"];

  // Group nodes by kind
  const groups = {};
  for (const [id, node] of Object.entries(fg.nodes)) {
    const kind = node.kind;
    if (!groups[kind]) groups[kind] = [];
    groups[kind].push(id);
  }

  const kindLabels = {
    type: "Types",
    table: "Tables",
    method: "Methods",
    endpoint: "Endpoints",
    event: "Events",
  };

  // Subgraphs
  for (const [kind, ids] of Object.entries(groups)) {
    lines.push(`  subgraph ${kindLabels[kind] || kind}`);
    for (const id of ids) {
      lines.push(`    ${sanitizeMermaidId(id)}["${shortLabel(id)}"]`);
    }
    lines.push("  end");
  }

  // Styles
  lines.push("");
  lines.push("  classDef type fill:#dae8fc,stroke:#6c8ebf,color:#333");
  lines.push("  classDef table fill:#d5e8d4,stroke:#82b366,color:#333");
  lines.push("  classDef method fill:#ffe6cc,stroke:#d6b656,color:#333");
  lines.push("  classDef endpoint fill:#e1d5e7,stroke:#9673a6,color:#333");
  lines.push("  classDef event fill:#fff2cc,stroke:#d6b656,color:#333");

  for (const [kind, ids] of Object.entries(groups)) {
    for (const id of ids) {
      lines.push(`  class ${sanitizeMermaidId(id)} ${kind}`);
    }
  }

  // Edges
  lines.push("");
  for (const edge of fg.edges) {
    if (edge._comment) continue;
    const from = sanitizeMermaidId(edge.from);
    const to = sanitizeMermaidId(edge.to);
    if (edge.rel === "co_change") {
      lines.push(`  ${from} -.->|co_change| ${to}`);
    } else {
      lines.push(`  ${from} -->|${edge.rel}| ${to}`);
    }
  }

  return lines.join("\n");
}

function renderFlow(name, flow, allSteps) {
  const lines = ["flowchart TD"];

  lines.push("  classDef decision fill:#fff2cc,stroke:#d6b656,color:#333");
  lines.push("  classDef terminal fill:#f8cecc,stroke:#b85450,color:#333");
  lines.push("  classDef success fill:#d5e8d4,stroke:#82b366,color:#333");
  lines.push("");

  const steps = flow.steps;
  const stepNodes = new Set(steps.map((s) => s.node));

  // Collect external node references
  const externalRefs = new Set();
  for (const step of steps) {
    if (typeof step.then === "object") {
      for (const target of Object.values(step.then)) {
        if (target !== "DONE" && target !== "FAIL" && target !== "next" && !stepNodes.has(target)) {
          externalRefs.add(target);
        }
      }
    }
  }

  // Trigger
  lines.push(`  trigger(["${flow.trigger}"])`);

  // Declare step nodes
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const label = shortLabel(step.node);
    const sid = `s${i}`;

    if (typeof step.then === "object") {
      lines.push(`  ${sid}{"${label}"}`);
      lines.push(`  class ${sid} decision`);
    } else {
      lines.push(`  ${sid}["${label}"]`);
    }
  }

  // External reference nodes
  for (const ref of externalRefs) {
    const sid = sanitizeMermaidId(ref);
    lines.push(`  ${sid}["${shortLabel(ref)}"]:::external`);
  }
  if (externalRefs.size > 0) {
    lines.push("  classDef external fill:#f5f5f5,stroke:#999,stroke-dasharray:5 5,color:#666");
  }

  // Terminals
  lines.push("  done([DONE])");
  lines.push("  class done success");
  lines.push("  fail([FAIL])");
  lines.push("  class fail terminal");
  lines.push("");

  // Trigger -> first step
  lines.push("  trigger --> s0");

  // Step edges
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const sid = `s${i}`;

    if (step.then === "next") {
      const next = i + 1 < steps.length ? `s${i + 1}` : "done";
      lines.push(`  ${sid} --> ${next}`);
    } else if (typeof step.then === "object") {
      for (const [label, target] of Object.entries(step.then)) {
        let targetSid;
        if (target === "DONE") {
          targetSid = "done";
        } else if (target === "FAIL") {
          targetSid = "fail";
        } else if (target === "next") {
          targetSid = i + 1 < steps.length ? `s${i + 1}` : "done";
        } else {
          const idx = steps.findIndex((s) => s.node === target);
          targetSid = idx >= 0 ? `s${idx}` : sanitizeMermaidId(target);
        }
        lines.push(`  ${sid} -->|${label}| ${targetSid}`);
      }
    }
  }

  return lines.join("\n");
}

function runRender(flowgraph, flowgraphPath) {
  const out = [];
  out.push(`# ${flowgraph.meta.name} FlowGraph`, "");
  if (flowgraph.meta.description) {
    out.push(`> ${flowgraph.meta.description}`, "");
  }

  out.push("## Dependency Graph", "");
  out.push("```mermaid");
  out.push(renderDependencyGraph(flowgraph));
  out.push("```", "");

  if (flowgraph.flows && Object.keys(flowgraph.flows).length > 0) {
    for (const [name, flow] of Object.entries(flowgraph.flows)) {
      out.push(`## Flow: ${name}`, "");
      out.push(`> ${flow.trigger}`, "");
      out.push("```mermaid");
      out.push(renderFlow(name, flow));
      out.push("```", "");
    }
  }

  if (flowgraph.invariants && flowgraph.invariants.length > 0) {
    out.push("## Invariants", "");
    out.push("| ID | Rule | Enforcement |");
    out.push("|---|---|---|");
    for (const inv of flowgraph.invariants) {
      const rule = inv.rule.replace(/\|/g, "\\|");
      const enforce = (inv.enforce || "").replace(/\|/g, "\\|");
      out.push(`| ${inv.id} | ${rule} | ${enforce} |`);
    }
    out.push("");
  }

  const outputPath = flowgraphPath.replace(/\.json$/, ".md");
  writeFileSync(outputPath, out.join("\n"));
  console.log(`Rendered: ${outputPath}`);
}
