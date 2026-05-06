import { parseWorkflow, type Workflow, type WorkflowNode, type Branch } from "./workflow.js";
import { execSync } from "child_process";
import * as db from "./db.js";

export interface FlowAction {
  type: 'spawn' | 'prompt' | 'complete';
  instanceId: number;
  workflowName: string;
  node: string;
  task: string;
  branches?: Branch[];
  previousResult?: string;
}

function loadWorkflow(name: string): Workflow {
  const row = db.getWorkflow(name);
  if (!row) throw new Error(`Workflow '${name}' not found. Use 'flowforge list' to see available workflows.`);
  return parseWorkflow(row.yaml_content);
}

function resolveInstance(workflowName?: string, instanceId?: number) {
  if (instanceId !== undefined) {
    const inst = db.getInstance(instanceId);
    if (!inst) throw new Error(`Instance #${instanceId} not found.`);
    if (inst.status !== 'active') throw new Error(`Instance #${instanceId} is ${inst.status}.`);
    return inst;
  }
  return db.getActiveInstance(workflowName);
}

function requireActiveInstance(workflowName?: string, instanceId?: number) {
  const inst = resolveInstance(workflowName, instanceId);
  if (!inst) {
    if (instanceId !== undefined) {
      throw new Error(`Instance #${instanceId} not found or not active.`);
    }
    throw new Error("No active instance. Use 'flowforge start <workflow>' first.");
  }
  return inst;
}

export function define(yamlContent: string, source: 'auto' | 'manual' = 'auto') {
  const wf = parseWorkflow(yamlContent);
  db.upsertWorkflow(wf.name, yamlContent, source);
  return wf.name;
}

export function start(workflowName: string) {
  const wf = loadWorkflow(workflowName);
  const existing = db.getActiveInstance(workflowName);
  let previousId: number | null = null;
  if (existing) {
    // Auto-close stale active instance instead of throwing
    db.closeHistory(existing.id, existing.current_node, null);
    db.setInstanceStatus(existing.id, "done");
    previousId = existing.id;
  }
  const id = db.createInstance(workflowName, wf.start);
  db.addHistory(id, wf.start);
  return { id, node: wf.start, previouslyClosed: previousId };
}

export function status(workflowName?: string, instanceId?: number) {
  const inst = requireActiveInstance(workflowName, instanceId);
  const wf = loadWorkflow(inst.workflow_name);
  const node = wf.nodes[inst.current_node];
  if (!node) throw new Error(`Node '${inst.current_node}' not found in workflow`);

  return {
    instanceId: inst.id,
    workflowName: inst.workflow_name,
    workflowDescription: wf.description,
    currentNode: inst.current_node,
    task: node.task,
    branches: node.branches || null,
    hasNext: !!node.next,
    nextNode: node.next || null,
    terminal: !!node.terminal,
    guard: node.guard || null,
  };
}

export function next(branch?: number, workflowName?: string, instanceId?: number) {
  const inst = requireActiveInstance(workflowName, instanceId);
  const wf = loadWorkflow(inst.workflow_name);
  const node = wf.nodes[inst.current_node];
  if (!node) throw new Error(`Node '${inst.current_node}' not found`);

  // Check guard before allowing progression
  if (node.guard) {
    try {
      const result = execSync(node.guard, { encoding: "utf-8", timeout: 60_000 });
      // Guard passed — log output as a note
      console.error(`\n[guard] ${node.guard}\n[guard output]\n${result.trim()}\n`);
    } catch (e: any) {
      const code = e.status ?? "unknown";
      const output = e.stdout ? `\n${e.stdout.trim()}` : "";
      throw new Error(
        `Guard failed for node '${inst.current_node}': exit ${code}${output}\n` +
        `Command: ${node.guard}\n` +
        `Refusing to advance. Fix the guard condition before proceeding.`
      );
    }
  }

  let nextNode: string;
  let branchTaken: string | null = null;

  if (node.branches) {
    if (branch === undefined) {
      const lines = node.branches.map((b, i) => `  ${i + 1}. ${b.condition} → ${b.next}`);
      throw new Error(
        `This node has branches. Use --branch <N>:\n${lines.join("\n")}`
      );
    }
    if (branch < 1 || branch > node.branches.length) {
      const lines = node.branches.map((b, i) => `  ${i + 1}. ${b.condition} → ${b.next}`);
      throw new Error(
        `Invalid branch ${branch}. Valid options (1-${node.branches.length}):\n${lines.join("\n")}\n\nExample: flowforge next --branch 1`
      );
    }
    const chosen = node.branches[branch - 1];
    nextNode = chosen.next;
    branchTaken = chosen.condition;
  } else if (node.next) {
    nextNode = node.next;
  } else if (node.terminal) {
    // Terminal node — close history and mark instance as done
    db.closeHistory(inst.id, inst.current_node, null);
    db.setInstanceStatus(inst.id, "done");
    return {
      from: inst.current_node,
      to: "(end)",
      branchTaken: null,
      task: "",
      branches: null,
      hasNext: false,
      terminal: true,
    };
  } else {
    throw new Error("Node has no next, branches, or terminal — this should not happen");
  }

  // Check plateau: how many times has nextNode been visited?
  let plateauWarning: string | undefined;
  const visits = db.getNodeVisitCount(inst.id, nextNode);
  const limit = wf.nodes[nextNode]?.max_visits ?? 5;
  if (visits >= limit) {
    plateauWarning = `Node ${nextNode} visited ${visits} times (limit: ${limit}). Consider breaking the loop or adjusting strategy.`;
  }

  // Close current history entry, move to next node, open new history entry
  db.closeHistory(inst.id, inst.current_node, branchTaken);
  db.updateInstanceNode(inst.id, nextNode);
  db.addHistory(inst.id, nextNode);

  const nextNodeDef = wf.nodes[nextNode];
  return {
    from: inst.current_node,
    to: nextNode,
    branchTaken,
    task: nextNodeDef.task,
    branches: nextNodeDef.branches || null,
    hasNext: !!nextNodeDef.next,
    plateauWarning,
  };
}

export function log(workflowName?: string, instanceId?: number) {
  const inst = requireActiveInstance(workflowName, instanceId);
  return {
    workflowName: inst.workflow_name,
    instanceId: inst.id,
    entries: db.getHistory(inst.id),
  };
}

export function list() {
  return db.listWorkflows();
}

export function active(workflowName?: string) {
  return db.listActiveInstances(workflowName);
}

export function kill(instanceId: number) {
  const inst = db.getInstance(instanceId);
  if (!inst) throw new Error(`Instance #${instanceId} not found.`);
  if (inst.status !== 'active') throw new Error(`Instance #${instanceId} is already ${inst.status}.`);
  db.closeHistory(inst.id, inst.current_node, null);
  db.setInstanceStatus(inst.id, "cancelled");
  return { id: inst.id, workflowName: inst.workflow_name, node: inst.current_node };
}

export function reset(workflowName?: string, instanceId?: number) {
  const inst = requireActiveInstance(workflowName, instanceId);
  const wf = loadWorkflow(inst.workflow_name);

  // Mark old instance as done
  db.closeHistory(inst.id, inst.current_node, null);
  db.setInstanceStatus(inst.id, "done");

  // Start fresh
  const id = db.createInstance(inst.workflow_name, wf.start);
  db.addHistory(id, wf.start);
  return { id, node: wf.start };
}

export function deleteWorkflow(name: string) {
  // Prevent deleting workflows that have active instances
  const activeInstances = db.listActiveInstances(name);
  if (activeInstances.length > 0) {
    throw new Error(`Cannot delete workflow '${name}': ${activeInstances.length} active instance(s) still running. Kill them first with 'flowforge kill <instance-id>' or wait for them to complete.`);
  }
  db.deleteWorkflow(name);
}

export function getAction(workflowName?: string, previousResult?: string, instanceId?: number): FlowAction {
  const inst = requireActiveInstance(workflowName, instanceId);
  const wf = loadWorkflow(inst.workflow_name);
  const node = wf.nodes[inst.current_node];
  if (!node) throw new Error(`Node '${inst.current_node}' not found`);

  let task = node.task;
  if (previousResult) {
    task = `${task}\n\nPrevious result:\n${previousResult}`;
  }

  if (node.terminal) {
    return {
      type: 'complete',
      instanceId: inst.id,
      workflowName: inst.workflow_name,
      node: inst.current_node,
      task,
      previousResult,
    };
  }

  if (node.executor === 'subagent') {
    return {
      type: 'spawn',
      instanceId: inst.id,
      workflowName: inst.workflow_name,
      node: inst.current_node,
      task,
      branches: node.branches,
      previousResult,
    };
  }

  return {
    type: 'prompt',
    instanceId: inst.id,
    workflowName: inst.workflow_name,
    node: inst.current_node,
    task,
    branches: node.branches,
    previousResult,
  };
}

export function advanceWithResult(result: string, workflowName?: string, instanceId?: number): FlowAction {
  // Parse result to extract branch choice (looks for 'Branch: N' or 'branch N' pattern)
  let branch: number | undefined;
  const branchMatch = result.match(/\bbranch:?\s*(\d+)\b/i);
  if (branchMatch) {
    branch = parseInt(branchMatch[1], 10);
  }

  // Advance to next node
  const nextResult = next(branch, workflowName, instanceId);

  if (nextResult.terminal) {
    const inst = resolveInstance(workflowName, instanceId);
    if (!inst) throw new Error("No active instance found");
    return {
      type: 'complete',
      instanceId: inst.id,
      workflowName: inst.workflow_name,
      node: "(end)",
      task: "",
    };
  }

  // Get the next action
  return getAction(workflowName, result, instanceId);
}
