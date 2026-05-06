import { Command } from "commander";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, resolve } from "path";
import * as engine from "./engine.js";

// Auto-load workflows from workflows/ directory
function autoLoadWorkflows() {
  const workflowDirs = [
    join(process.cwd(), "workflows"),
    join(process.env.HOME || "~", ".openclaw", "workspace", "flowforge", "workflows")
  ];

  for (const dir of workflowDirs) {
    if (!existsSync(dir)) continue;

    try {
      const files = readdirSync(dir);
      const yamlFiles = files.filter(f => f.endsWith(".yaml") || f.endsWith(".yml"));

      for (const file of yamlFiles) {
        try {
          const content = readFileSync(join(dir, file), "utf-8");
          engine.define(content, "auto");
        } catch (e) {
          // Silently skip invalid workflow files
        }
      }
    } catch (e) {
      // Directory not accessible, skip
    }
  }
}

// Auto-load workflows on CLI startup
autoLoadWorkflows();

const program = new Command();
program
  .name("flowforge")
  .description("Personal workflow engine")
  .version(process.env.npm_package_version ?? "1.2.3");

// Shared instance flag
const withInstance = (cmd: ReturnType<typeof Command.prototype.command>) =>
  cmd.option("--instance <id>", "Target a specific instance by ID")
    .option("-w, --workflow <name>", "Target a workflow by name");

program
  .command("define <yaml>")
  .description("Register or update a workflow from a YAML file (manual source — protected from auto-overwrite)")
  .action((yamlPath) => {
    try {
      const content = readFileSync(yamlPath, "utf-8");
      const name = engine.define(content, "manual");
      console.log(`Workflow '${name}' defined (manual — protected from auto-overwrite).`);
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
  });

program
  .command("delete <workflow>")
  .description("Delete a registered workflow and its history")
  .action((workflow) => {
    try {
      engine.deleteWorkflow(workflow);
      console.log(`Workflow '${workflow}' deleted.`);
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
  });

withInstance(program.command("start <workflow>"))
  .description("Start a new instance of a workflow (name or path to .yaml file)")
  .action((workflow, opts) => {
    try {
      // If it looks like a file path, load it first
      if (workflow.endsWith(".yaml") || workflow.endsWith(".yml")) {
        const absPath = resolve(workflow);
        if (existsSync(absPath)) {
          const content = readFileSync(absPath, "utf-8");
          engine.define(content, "manual");
          // Extract workflow name from the loaded file
          const match = content.match(/^name:\s*(.+)$/m);
          if (match) workflow = match[1].trim();
        }
      }
      const { id, node } = engine.start(workflow);
      if (opts.instance) {
        console.log(`Started new instance #${id} at node '${node}'.`);
      } else {
        console.log(`Started instance #${id} at node '${node}'.`);
      }
      printStatus(opts);
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
  });

withInstance(program.command("status"))
  .description("Show current node, task, and available branches")
  .action((opts) => {
    try {
      printStatus(opts);
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
  });

withInstance(program.command("next"))
  .description("Complete current node and move to next")
  .option("-b, --branch <N>", "Branch number (1-indexed) for branching nodes", parseInt)
  .option("--notify", "Output a notification message for the user (e.g. Luna)")
  .action((opts) => {
    try {
      const instId = opts.instance ? parseInt(String(opts.instance)) : undefined;
      const result = engine.next(opts.branch, opts.workflow, instId);
      if (result.plateauWarning) {
        console.log(`\n⚠️ ${result.plateauWarning}`);
      }
      if (result.terminal) {
        console.log(`\n✅ ${result.from} → (end) — Workflow complete!\n`);
      } else {
        console.log(`\n${result.from} → ${result.to}${result.branchTaken ? ` (${result.branchTaken})` : ""}\n`);
        printStatus(opts);
      }
      if (opts.notify) {
        if (result.terminal) {
          console.log("---NOTIFY---");
          console.log(`✅ Workflow 完成：${result.from} → 结束`);
        } else {
          const s = engine.status(opts.workflow, instId);
          console.log("---NOTIFY---");
          console.log(`🔄 Workflow 进度：${result.from} → ${s.currentNode}`);
          console.log(`📋 当前任务：${s.task.trim().split("\n")[0]}`);
          if (s.branches) {
            console.log(`⑂ ${s.branches.length} 个分支待决策`);
          }
        }
      }
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
  });

withInstance(program.command("log"))
  .description("Show history of nodes visited")
  .action((opts) => {
    try {
      const instId = opts.instance ? parseInt(String(opts.instance)) : undefined;
      const { workflowName, instanceId, entries } = engine.log(opts.workflow, instId);
      console.log(`\nWorkflow: ${workflowName} (instance #${instanceId})\n`);
      for (const e of entries) {
        const branch = e.branch_taken ? ` [${e.branch_taken}]` : "";
        const exit = e.exited_at ? ` → exited ${e.exited_at}` : " (current)";
        console.log(`  ${e.entered_at}  ${e.node_name}${branch}${exit}`);
      }
      console.log();
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
  });

program
  .command("list")
  .description("List all defined workflows")
  .action(() => {
    const workflows = engine.list();
    if (workflows.length === 0) {
      console.log("No workflows defined.");
      return;
    }
    for (const w of workflows) {
      const source = w.source === 'manual' ? ' [manual]' : '';
      console.log(`  ${w.name}${source}  (updated ${w.updated_at})`);
    }
  });

program
  .command("active")
  .description("List active instances")
  .option("-w, --workflow <name>", "Filter by workflow name")
  .action((opts) => {
    const instances = engine.active(opts.workflow);
    if (instances.length === 0) {
      console.log("No active instances.");
      return;
    }
    for (const inst of instances) {
      console.log(`  #${inst.id}  ${inst.workflow_name}  at '${inst.current_node}'  (started ${inst.created_at})`);
    }
  });

program
  .command("kill <instance>")
  .description("Kill a running workflow instance (marks as cancelled)")
  .action((instanceIdStr) => {
    try {
      const instanceId = parseInt(instanceIdStr);
      if (isNaN(instanceId)) throw new Error("Instance ID must be a number.");
      const { id, workflowName, node } = engine.kill(instanceId);
      console.log(`Instance #${id} (${workflowName} at '${node}') cancelled.`);
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
  });

withInstance(program.command("reset"))
  .description("Reset current instance back to start node")
  .action((opts) => {
    try {
      const instId = opts.instance ? parseInt(String(opts.instance)) : undefined;
      const { id, node } = engine.reset(opts.workflow, instId);
      console.log(`Reset. New instance #${id} at node '${node}'.`);
      printStatus(opts);
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
  });

program
  .command("run <workflow>")
  .description("Start workflow and output next action as JSON")
  .option("--instance <id>", "Target a specific instance by ID")
  .action((workflow, opts) => {
    try {
      const instId = opts.instance ? parseInt(String(opts.instance)) : undefined;
      // Resume existing instance, or start a new one if none active
      const existing = engine.active(workflow).find(i => i.workflow_name === workflow);
      if (!existing) {
        engine.start(workflow);
      }

      const action = engine.getAction(workflow, undefined, instId);
      console.log(JSON.stringify({ action }, null, 2));
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
  });

program
  .command("advance")
  .description("Advance workflow with result and output next action as JSON")
  .option("--instance <id>", "Target a specific instance by ID")
  .option("-w, --workflow <name>", "Target a workflow by name")
  .option("--result <text>", "Result text from previous step")
  .action((opts) => {
    try {
      const instId = opts.instance ? parseInt(String(opts.instance)) : undefined;
      let result = opts.result;

      // If no --result flag, read from stdin
      if (!result) {
        const fs = require("fs");
        result = fs.readFileSync(0, "utf-8").trim();
      }

      const action = engine.advanceWithResult(result, opts.workflow, instId);
      console.log(JSON.stringify({ action }, null, 2));
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
  });


function printStatus(opts?: any) {
  const instId = opts?.instance ? parseInt(String(opts.instance)) : undefined;
  const s = engine.status(opts?.workflow, instId);
  console.log(`\n📍 Instance #${s.instanceId} | ${s.workflowName} | Node: ${s.currentNode}`);
  console.log(`📋 Task: ${s.task}`);
  if (s.guard) {
    console.log(`\n🛡️  Guard: ${s.guard}`);
  }
  if (s.terminal) {
    console.log(`\n🏁 This is a terminal node. Use: flowforge next`);
  } else if (s.branches) {
    console.log(`\nBranches:`);
    for (let i = 0; i < s.branches.length; i++) {
      console.log(`  ${i + 1}. ${s.branches[i].condition} → ${s.branches[i].next}`);
    }
    console.log(`\nUse: flowforge next --branch <N>`);
  } else if (s.nextNode) {
    console.log(`\nNext: ${s.nextNode}`);
    console.log(`\nUse: flowforge next`);
  }
  console.log();
}

program.parse();
