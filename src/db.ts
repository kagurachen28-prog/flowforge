import Database from "better-sqlite3";
import { homedir } from "os";
import { join } from "path";
import { mkdirSync } from "fs";

const DIR = join(homedir(), ".flowforge");
mkdirSync(DIR, { recursive: true });

const db = new Database(join(DIR, "flowforge.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS workflows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    yaml_content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS instances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_name TEXT NOT NULL,
    current_node TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (workflow_name) REFERENCES workflows(name)
  );
  CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_id INTEGER NOT NULL,
    node_name TEXT NOT NULL,
    branch_taken TEXT,
    entered_at TEXT DEFAULT (datetime('now')),
    exited_at TEXT,
    FOREIGN KEY (instance_id) REFERENCES instances(id)
  );
`);

// --- Workflow queries ---

export function upsertWorkflow(name: string, yaml: string) {
  db.prepare(`
    INSERT INTO workflows (name, yaml_content) VALUES (?, ?)
    ON CONFLICT(name) DO UPDATE SET yaml_content = ?, updated_at = datetime('now')
  `).run(name, yaml, yaml);
}

export function getWorkflow(name: string) {
  return db.prepare("SELECT * FROM workflows WHERE name = ?").get(name) as
    | { id: number; name: string; yaml_content: string }
    | undefined;
}

export function listWorkflows() {
  return db.prepare("SELECT name, updated_at FROM workflows ORDER BY name").all() as {
    name: string;
    updated_at: string;
  }[];
}

// --- Instance queries ---

export function createInstance(workflowName: string, startNode: string) {
  const res = db.prepare(
    "INSERT INTO instances (workflow_name, current_node, status) VALUES (?, ?, 'active')"
  ).run(workflowName, startNode);
  return res.lastInsertRowid as number;
}

export function getActiveInstance(workflowName?: string) {
  if (workflowName) {
    return db.prepare(
      "SELECT * FROM instances WHERE workflow_name = ? AND status = 'active' ORDER BY id DESC LIMIT 1"
    ).get(workflowName) as InstanceRow | undefined;
  }
  return db.prepare(
    "SELECT * FROM instances WHERE status = 'active' ORDER BY id DESC LIMIT 1"
  ).get() as InstanceRow | undefined;
}

export function listActiveInstances() {
  return db.prepare(
    "SELECT id, workflow_name, current_node, created_at FROM instances WHERE status = 'active' ORDER BY id"
  ).all() as { id: number; workflow_name: string; current_node: string; created_at: string }[];
}

export function updateInstanceNode(id: number, node: string) {
  db.prepare(
    "UPDATE instances SET current_node = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(node, id);
}

export function setInstanceStatus(id: number, status: string) {
  db.prepare(
    "UPDATE instances SET status = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(status, id);
}

// --- History queries ---

export function addHistory(instanceId: number, nodeName: string) {
  db.prepare(
    "INSERT INTO history (instance_id, node_name) VALUES (?, ?)"
  ).run(instanceId, nodeName);
}

export function closeHistory(instanceId: number, nodeName: string, branchTaken: string | null) {
  db.prepare(
    "UPDATE history SET exited_at = datetime('now'), branch_taken = ? WHERE instance_id = ? AND node_name = ? AND exited_at IS NULL"
  ).run(branchTaken, instanceId, nodeName);
}

export function getHistory(instanceId: number) {
  return db.prepare(
    "SELECT node_name, branch_taken, entered_at, exited_at FROM history WHERE instance_id = ? ORDER BY id"
  ).all(instanceId) as {
    node_name: string;
    branch_taken: string | null;
    entered_at: string;
    exited_at: string | null;
  }[];
}

// --- Stats queries ---

export function getWorkflowStats() {
  return db.prepare(`
    SELECT
      i.workflow_name,
      COUNT(*) AS total_runs,
      ROUND(100.0 * SUM(CASE WHEN i.status = 'done' THEN 1 ELSE 0 END) / COUNT(*), 1) AS completion_rate,
      ROUND(AVG(
        CASE WHEN i.status = 'done'
          THEN (julianday(i.updated_at) - julianday(i.created_at)) * 24 * 60
          ELSE NULL
        END
      ), 1) AS avg_duration_min
    FROM instances i
    GROUP BY i.workflow_name
    ORDER BY total_runs DESC
  `).all() as {
    workflow_name: string;
    total_runs: number;
    completion_rate: number;
    avg_duration_min: number | null;
  }[];
}

export function getTopBranches(workflowName?: string) {
  const sql = `
    SELECT h.node_name, h.branch_taken, COUNT(*) AS times_chosen
    FROM history h
    JOIN instances i ON h.instance_id = i.id
    WHERE h.branch_taken IS NOT NULL
    ${workflowName ? "AND i.workflow_name = ?" : ""}
    GROUP BY h.node_name, h.branch_taken
    ORDER BY times_chosen DESC
    LIMIT 10
  `;
  const stmt = db.prepare(sql);
  return (workflowName ? stmt.all(workflowName) : stmt.all()) as {
    node_name: string;
    branch_taken: string;
    times_chosen: number;
  }[];
}

export function getNodeStats(workflowName: string) {
  return db.prepare(`
    SELECT
      h.node_name,
      COUNT(*) AS visit_count,
      ROUND(AVG(
        CASE WHEN h.exited_at IS NOT NULL
          THEN (julianday(h.exited_at) - julianday(h.entered_at)) * 24 * 60
          ELSE NULL
        END
      ), 1) AS avg_duration_min
    FROM history h
    JOIN instances i ON h.instance_id = i.id
    WHERE i.workflow_name = ?
    GROUP BY h.node_name
    ORDER BY visit_count DESC
  `).all(workflowName) as {
    node_name: string;
    visit_count: number;
    avg_duration_min: number | null;
  }[];
}

export function getGuideposts() {
  const lowCompletion = db.prepare(`
    SELECT
      workflow_name,
      COUNT(*) AS total_runs,
      ROUND(100.0 * SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) / COUNT(*), 1) AS completion_rate
    FROM instances
    GROUP BY workflow_name
    HAVING completion_rate < 50 AND total_runs >= 3
    ORDER BY completion_rate ASC
  `).all() as { workflow_name: string; total_runs: number; completion_rate: number }[];

  const slowNodes = db.prepare(`
    SELECT
      i.workflow_name, h.node_name,
      ROUND(AVG((julianday(h.exited_at) - julianday(h.entered_at)) * 24 * 60), 1) AS avg_duration_min,
      COUNT(*) AS visit_count
    FROM history h
    JOIN instances i ON h.instance_id = i.id
    WHERE h.exited_at IS NOT NULL
    GROUP BY i.workflow_name, h.node_name
    HAVING avg_duration_min > 10
    ORDER BY avg_duration_min DESC
  `).all() as { workflow_name: string; node_name: string; avg_duration_min: number; visit_count: number }[];

  const abandonedNodes = db.prepare(`
    SELECT
      i.workflow_name, h.node_name,
      COUNT(*) AS stall_count
    FROM history h
    JOIN instances i ON h.instance_id = i.id
    WHERE h.exited_at IS NULL AND i.status != 'active'
    GROUP BY i.workflow_name, h.node_name
    ORDER BY stall_count DESC
    LIMIT 10
  `).all() as { workflow_name: string; node_name: string; stall_count: number }[];

  return { lowCompletion, slowNodes, abandonedNodes };
}

export type InstanceRow = {
  id: number;
  workflow_name: string;
  current_node: string;
  status: string;
  created_at: string;
  updated_at: string;
};
