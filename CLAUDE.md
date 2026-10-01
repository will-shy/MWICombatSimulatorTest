# CLAUDE.md

## Long-term memory: feature docs

Rules and logic learned while working on a feature go into that feature's doc in `docs/`, so they
outlive the session. Read the doc before starting work on the feature, and update it when the work
establishes or changes a rule.

| Area | Doc |
| --- | --- |
| Skill Lab (`skill-lab.html`) | `docs/skill_lab.md` (create it on first use) |
| Group battle (`group-battle.html`, `src/groupBattle.js`, group-battle sim code) | `docs/group_battle.md` |
| Local sim harness (`scripts/sim-sweep.mjs`, headless runs on the wasm kernel) | `docs/harness.md` |
