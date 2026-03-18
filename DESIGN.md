# FlowForge — Workflow Engine for AI Agents

## Architecture

FlowForge is NOT a sub-agent. FlowForge is a CLI tool + workflow definition that the **main agent (me) uses to control its own execution flow**.

### How it works:

1. **cron** triggers my main session every 30 minutes
2. I run `flowforge status` → it tells me what node I'm in and what task to do
3. I **spawn a sub-agent** to execute that task (isolated token tracking)
4. Sub-agent completes, reports result back to me
5. I evaluate the result, decide which branch to take
6. I run `flowforge next --branch N` → FlowForge moves me to next node
7. Repeat until cron session ends or workflow loops back

### The key insight:

- **FlowForge = the workflow state machine** (what to do, in what order)
- **Sub-agents = the workers** (do the actual task)
- **Main session (me) = the coordinator** (reads workflow, spawns workers, evaluates results, advances state)

I am both the executor AND the manager, but FlowForge constrains my management decisions to the predefined workflow.

### Cron session flow:

```
cron kicks me →
  flowforge status → current node = "followup"
  spawn sub-agent: "用 gogetajob sync 检查所有 PR，处理 review 反馈"
  sub-agent reports: "PR #279 有新 review，已处理并 push"
  I evaluate: 有处理过 review → branch 1: handle_review? 不对，已经处理完了
  flowforge next --branch 2 → find_work
  spawn sub-agent: "用 gogetajob scan + feed 找新活"
  sub-agent reports: "找到 ClawX issue #XX"
  flowforge next --branch 1 → study
  spawn sub-agent: "研究 ClawX 代码和这个 issue"
  ...continue until cron timeout...
```

## Workflow YAML

Nodes have:
- `task`: natural language description (becomes sub-agent's task prompt)
- `next`: linear progression
- `branches`: conditional branching based on result

## CLI

- `flowforge define <yaml>` — register workflow
- `flowforge start <workflow>` — start instance
- `flowforge status` — current node + task + branches
- `flowforge next [--branch N]` — advance
- `flowforge log` — history
- `flowforge reset` — restart

## Why this works

1. FlowForge persists state in SQLite → survives session restarts
2. Each cron session reads state, continues from where last session left off
3. Sub-agents do isolated work with tracked tokens
4. The workflow YAML is the source of truth for what I should be doing
5. I can't "forget" to check reviews because the workflow starts with followup
