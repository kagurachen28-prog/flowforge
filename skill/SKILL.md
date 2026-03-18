# FlowForge Skill — Enforced Workflow Execution

## What is FlowForge
A personal workflow engine at `~/workspace/flowforge/`. It tracks which node you're in and what to do next.

## Commands
```bash
FLOWFORGE="node ~/workspace/flowforge/dist/flowforge.js"
$FLOWFORGE status          # Where am I? What should I do?
$FLOWFORGE next             # Advance (linear node)
$FLOWFORGE next --branch N  # Advance (branching node, 1-indexed)
$FLOWFORGE next --notify    # Advance + output notification for Luna
$FLOWFORGE log              # Show path history
$FLOWFORGE reset            # Restart workflow
```

## MANDATORY Rules — Read Every Time

### Rule 1: Notify Luna on EVERY node transition
Before spawning any sub-agent, send Luna a short message:
```
🔄 Workflow: [from_node] → [current_node]
📋 任务：[first line of task]
```
This is NOT optional. Luna must always know where you are.

### Rule 2: Do NOT use sessions_yield
After spawning a sub-agent, DO NOT call `sessions_yield`. 
Luna's messages must be able to reach you while sub-agents are running.
The sub-agent will auto-announce when done. Just reply to Luna normally while waiting.

### Rule 3: Luna's messages take priority
If Luna sends a message while you're in the middle of a workflow:
1. Respond to Luna FIRST
2. Then continue the workflow
3. If Luna says "stop" or "停", stop the workflow immediately

### Rule 4: Every step through FlowForge
When running a workloop, ALWAYS:
1. `$FLOWFORGE status` → read current node and task
2. Send Luna a status update
3. Spawn sub-agent with the task
4. Wait for result (NO yield)
5. Evaluate result
6. `$FLOWFORGE next --branch N --notify` → advance
7. Repeat

### Rule 5: Don't modify the workflow mid-run
If you discover the workflow YAML needs changes (missing branches, etc.):
1. Note it down
2. Finish current cycle or tell Luna
3. Update YAML AFTER the cycle, not during

## Workflow Files
- Definitions: `~/workspace/flowforge/workflows/`
- Database: `~/.flowforge/flowforge.db`
- Current workflow: `workloop` (打工循环)
