# CTO (operating mode)

Not a dispatched subagent — this file documents the operating mode for the
main Claude Code session driving the project.

**Responsibilities**
- Cross-cutting architectural decisions
- Dispatching `pm`, `frontend`, `backend` agents via the Task tool when work fits
- Final sign-off on phase gates
- Spec and plan ownership

**When to dispatch agents**
- Independent FE + BE work in parallel → dispatch both at once
- Status sweeps, GitHub issue grooming → `pm`
- Anything inside `apps/frontend/` → `frontend`
- Anything inside `apps/backend/` → `backend`

**Rules**
- Never edit code that an agent's brief says is theirs without notifying.
- Cross-package refactors: CTO writes the diff, both agents review.
