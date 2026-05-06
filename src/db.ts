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
    source TEXT NOT NULL DEFAULT 'auto',
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

export function upsertWorkflow(name: string, yaml: string, source: 'auto' | 'manual' = 'auto') {
  // Only upsert if: new source is 'manual' (always overwrite), OR existing record is also 'auto'
  const existing = getWorkflow(name);
  if (existing && existing.source === 'manual' && source === 'auto') {
    // Manual registrations are protected from auto-overwrite
    return;
  }
  db.prepare(`
    INSERT INTO workflows (name, yaml_content, source) VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET yaml_content = ?, source = ?, updated_at = datetime('now')
  `).run(name, yaml, source, yaml, source);
}

export function deleteWorkflow(name: string) {
  db.prepare("DELETE FROM workflows WHERE name = ?").run(name);
}

export function getWorkflow(name: string) {
  return db.prepare("SELECT * FROM workflows WHERE name = ?").get(name) as
    | { id: number; name: string; yaml_content: string; source: string }
    | undefined;
}

export function getWorkflowById(id: number) {
  return db.prepare("SELECT * FROM workflows WHERE id = ?").get(id) as
    | { id: number; name: string; yaml_content: string; source: string }
    | undefined;
}

export function getInstance(id: number) {
  return db.prepare("SELECT * FROM instances WHERE id = ?").get(id) as InstanceRow | undefined;
}

export function listWorkflows() {
  return db.prepare("SELECT name, source, updated_at FROM workflows ORDER BY name").all() as {
    name: string;
    source: string;
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

export function listActiveInstances(workflowName?: string) {
  if (workflowName) {
    return db.prepare(
      "SELECT id, workflow_name, current_node, created_at, status FROM instances WHERE workflow_name = ? AND status = 'active' ORDER BY id"
    ).all(workflowName) as { id: number; workflow_name: string; current_node: string; created_at: string; status: string }[];
  }
  return db.prepare(
    "SELECT id, workflow_name, current_node, created_at, status FROM instances WHERE status = 'active' ORDER BY id"
  ).all() as { id: number; workflow_name: string; current_node: string; created_at: string; status: string }[];
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

export function getNodeVisitCount(instanceId: number, nodeName: string): number {
  const row = db.prepare(
    "SELECT COUNT(*) as cnt FROM history WHERE instance_id = ? AND node_name = ?"
  ).get(instanceId, nodeName) as { cnt: number };
  return row.cnt;
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

export type InstanceRow = {
  id: number;
  workflow_name: string;
  current_node: string;
  status: string;
  created_at: string;
  updated_at: string;
};
