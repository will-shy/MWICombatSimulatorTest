// Worker for the Skill Lab page. Thin wrapper: the simulation lives in
// combatsimulator/skillLab.js so it can also be driven from node or a test.
// Runs the requested number of seeds one after another, reporting progress so a
// long multi-seed sweep doesn't look frozen.
import { runSkillLab, aggregateRuns, setCustomBuilds } from "./combatsimulator/skillLab.js";

onmessage = async function (event) {
    if (event.data.type !== "run_skill_lab") {
        return;
    }

    const config = event.data.config;
    // Builds the page read out of localStorage aren't bundled, so they arrive with
    // the config; register them before anything resolves a squad's build id.
    setCustomBuilds(config.customBuilds);
    const runCount = Math.max(1, Math.min(10, Math.floor(Number(config.runs) || 1)));

    try {
        const runs = [];
        for (let i = 0; i < runCount; i++) {
            // Fixed seed ladder: the same config always produces the same numbers,
            // and two kits are compared on identical rolls.
            const result = await runSkillLab({ ...config, seed: 1000 + (i + 1) * 7919 });
            runs.push(result);
            this.postMessage({
                type: "skill_lab_progress",
                done: i + 1,
                total: runCount,
                seconds: result.seconds,
                outcome: result.outcome,
            });
        }
        this.postMessage({ type: "skill_lab_result", result: aggregateRuns(runs), runsRaw: runs });
    } catch (e) {
        this.postMessage({ type: "skill_lab_error", error: e && e.message ? e.message : String(e) });
    }
};
