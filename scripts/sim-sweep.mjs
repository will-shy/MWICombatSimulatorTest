#!/usr/bin/env node
// Batch-run group battles on the wasm combat kernel and compare roster variants.
//
// The page is used once per arm, only to turn a guild trial export into the `start_battle` message
// its worker would receive. Every run then goes through the same wasm kernel directly in Node,
// across a pool of worker threads. Runs are seeded, so a sweep is reproducible with --seed.
//
//   node scripts/sim-sweep.mjs --arm "baseline=roster.json" --arm "variant=variant.json"
//
// See docs/harness.md for the methodology this is built around - in particular: always make the
// first arm a control, and give it enough runs for a difference to mean anything.

import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism, homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Trial Mode's tier ladder, as groupBattle.js defines it (TRIAL_MIN_LEVEL, TRIAL_LEVEL_STEP,
// TRIAL_MAX_LEVEL): T1 = L100, +10 per tier, up to L300.
const tierLevel = (tier) => 100 + 10 * (tier - 1);
const MAX_TIER = 21;

// ---------------------------------------------------------------------------- kernel

// Loads the kernel the way src/worker.js does: the same wasm build, fed the same data maps. The
// map list is read out of worker.js itself so the two cannot drift apart.
async function loadKernel() {
    const workerSrc = readFileSync(path.join(REPO, "src/worker.js"), "utf8");
    const data = {};
    for (const [, name, file] of workerSrc.matchAll(/import (\w+) from "\.\/combatsimulator\/data\/([\w.-]+)\.json"/g)) {
        data[name] = JSON.parse(readFileSync(path.join(REPO, "src/combatsimulator/data", file + ".json"), "utf8"));
    }
    // Imported from source rather than by path: this repo's package.json has no "type": "module",
    // so importing the .js file directly makes Node reparse it and print a warning in every thread.
    const glue = readFileSync(path.join(REPO, "src/wasm/mwi_wasm.js"), "utf8");
    const { initSync, CombatKernel } = await import("data:text/javascript;base64," + Buffer.from(glue).toString("base64"));
    initSync({ module: readFileSync(path.join(REPO, "src/wasm/mwi_wasm_bg.wasm")) });
    return new CombatKernel(JSON.stringify(data));
}

const battle = (kernel, job) => JSON.parse(kernel.battle(JSON.stringify(job)));

// Health of the lowest surviving enemy, as a fraction - the page's "boss HP left".
function bossHpFrac(res) {
    const enemies = res.enemyFinalState || [];
    if (!enemies.length) return 0;
    const frac = (e) => (e.maxHitpoints ? e.currentHitpoints / e.maxHitpoints : 0);
    const alive = enemies.filter((e) => e.currentHitpoints > 0);
    return Math.min(...(alive.length ? alive : enemies).map(frac));
}

function summarize(res) {
    let healed = 0;
    for (const e of res.battleLog || []) if (e.kind === "heal" && e.healSource !== "regen") healed += e.amount;
    const players = res.playerFinalState || [];
    return {
        outcome: res.battleOutcome,
        dur: (res.battleDurationNs || 0) / 1e9,
        bossPct: 100 * bossHpFrac(res),
        alive: players.filter((p) => p.currentHitpoints > 0).length,
        total: players.length,
        healed: Math.round(healed),
        oom: Object.values(res.playerOomCastCount || {}).reduce((a, n) => a + n, 0),
    };
}

// Each tier's seed is derived from the run's, so a ladder run is reproducible from one number.
const tierSeed = (seed, tier) => (Math.imul(seed ^ (tier * 0x9e3779b9), 0x85ebca6b) >>> 0) || 1;

// Trial Mode, as runTrialMode in groupBattle.js runs it: every enemy re-leveled to the tier, one
// shared time budget, advance on victory and stop on anything else. `job` is the tier-1 message.
function runLadder(kernel, job, seed) {
    let remaining = job.timeCapSeconds;
    const tiers = [];
    for (let tier = 1; tier <= MAX_TIER && remaining > 0; tier++) {
        const level = tierLevel(tier);
        const res = battle(kernel, {
            ...job,
            enemies: job.enemies.map((e) => ({ ...e, level })),
            timeCapSeconds: remaining,
            seed: tierSeed(seed, tier),
        });
        remaining -= (res.battleDurationNs ?? res.simulatedTime ?? 0) / 1e9;
        tiers.push({ tier, ...summarize(res) });
        if (res.battleOutcome !== "victory") break;
    }
    const last = tiers[tiers.length - 1];
    const cleared = tiers.filter((t) => t.outcome === "victory").length;
    return {
        ...last,
        cleared,
        lastTier: last.tier,
        // One number for the whole ladder: tiers cleared, plus how far into the next one it got.
        progress: cleared + (last.outcome === "victory" ? 0 : 1 - last.bossPct / 100),
        tiers,
    };
}


// ------------------------------------------------------------------------------ main

async function main() {
    const DEFAULTS = {
        url: "http://localhost:9000/group-battle.html",
        level: 170,          // L170 = T8; level = 100 + 10*(tier-1)
        runs: 40,
        cap: 900,            // seconds; single-tier time cap, or the shared budget in ladder mode
        ladder: false,
        buildings: '{"diningRoom":0,"library":2,"dojo":4,"armory":1,"gym":1,"archeryRange":1,"mysticalStudy":1}',
        seed: "",            // base seed; drawn at random when omitted
        seeds: "",           // explicit comma-separated run seeds, e.g. one run to replay from --json
        jobs: Math.max(1, availableParallelism() - 1),
        json: "",            // optional path to dump raw per-run results
        "save-jobs": "",     // optional directory to write each arm's start_battle message to
    };

    const opts = { ...DEFAULTS, arms: [] };
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--arm") opts.arms.push(argv[++i]);
        else if (a === "--ladder") opts.ladder = true;
        else if (a.startsWith("--") && a.slice(2) in DEFAULTS) opts[a.slice(2)] = argv[++i];
        else throw new Error(`unexpected argument: ${a}`);
    }
    opts.level = Number(opts.level);
    opts.runs = Number(opts.runs);
    opts.cap = Number(opts.cap);
    opts.jobs = Number(opts.jobs);
    opts.seed = opts.seed === "" ? (Math.random() * 2 ** 32) >>> 0 || 1 : Number(opts.seed) >>> 0;

    if (!opts.arms.length) {
        console.error(`usage: node scripts/sim-sweep.mjs --arm "name=file.json" [--arm ...]

  --arm name=path    an arm to run; repeat. The FIRST arm is the control everything is compared to.
                     The file is a guild trial export (built into a job by the page), or a job
                     saved by --save-jobs (run as saved, no browser needed).
  --level 170        monster level (L170 = T8). Ignored in ladder mode, which always starts at T1.
  --runs 40          runs per arm. Every arm uses the same seeds.
  --cap 900          single-tier time cap, or the shared budget in --ladder mode.
  --ladder           run the full escalating ladder instead of one tier.
  --buildings JSON   guild building levels.
  --seed N           base seed. Omit for a random one; the header prints it so a sweep can be re-run.
  --seeds a,b,...    run exactly these seeds instead (the per-run seeds --json records).
  --jobs ${String(DEFAULTS.jobs).padEnd(11)} worker threads.
  --json out.json    also dump raw per-run results (ladder runs include every tier).
  --save-jobs DIR    write each arm's start_battle message to DIR/<arm>.json.
  --url URL          defaults to ${DEFAULTS.url}

--level, --cap and --buildings shape the job the page builds; they do not touch a saved job.
Roster arms need the dev server:  npx webpack serve --mode development --no-open`);
        process.exit(1);
    }

    const arms = opts.arms.map((spec) => {
        const i = spec.indexOf("=");
        if (i < 0) throw new Error(`--arm needs name=path, got: ${spec}`);
        const file = path.resolve(spec.slice(i + 1));
        if (!existsSync(file)) throw new Error(`file not found: ${file}`);
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        const job = parsed?.type === "start_battle" ? parsed : null;
        return { name: spec.slice(0, i), file, job, saved: !!job };
    });

    const t0 = Date.now();
    if (arms.some((a) => !a.job)) await buildJobs(arms.filter((a) => !a.job), opts);
    const buildSecs = (Date.now() - t0) / 1000;

    if (opts["save-jobs"]) {
        mkdirSync(opts["save-jobs"], { recursive: true });
        for (const a of arms) writeFileSync(path.join(opts["save-jobs"], `${a.name}.json`), JSON.stringify(a.job));
        console.log(`jobs -> ${opts["save-jobs"]}/`);
    }

    // Every arm sees the same seed for run r, so arms can also be compared seed by seed.
    const seeds = opts.seeds ? String(opts.seeds).split(",").map((x) => Number(x) >>> 0) : [];
    let s = opts.seed;
    for (let r = 0; !opts.seeds && r < opts.runs; r++) {
        s = (s + 0x6d2b79f5) >>> 0;
        let z = Math.imul(s ^ (s >>> 15), 1 | s);
        z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z;
        seeds.push(((z ^ (z >>> 14)) >>> 0) || 1);
    }

    opts.runs = seeds.length;
    const seedNote = opts.seeds ? `seeds ${seeds.join(",")}` : `seed ${opts.seed}`;
    const mode = opts.ladder ? `ladder, ${arms[0].job.timeCapSeconds}s budget`
        : `L${arms[0].job.enemies[0]?.level}, ${arms[0].job.timeCapSeconds}s cap`;
    console.log(`${mode}, ${opts.runs} runs/arm, ${seedNote}, buildings ${JSON.stringify(arms[0].job.guildBuildingLevels)}`);
    if (arms.some((a) => JSON.stringify(a.job.guildBuildingLevels) !== JSON.stringify(arms[0].job.guildBuildingLevels))) {
        console.log("(buildings differ by arm; the line above is the control's)");
    }
    const saved = arms.filter((a) => a.saved);
    if (saved.length) console.log(`(saved jobs run as saved: ${saved.map((a) => a.name).join(", ")})`);
    console.log();

    const results = await runPool(arms, seeds, opts);
    const simSecs = (Date.now() - t0) / 1000 - buildSecs;
    report(results, opts);
    console.log(`${arms.length * opts.runs} runs in ${simSecs.toFixed(1)}s on ${Math.min(opts.jobs, arms.length * opts.runs)} threads` +
        (buildSecs > 1 ? ` (+${buildSecs.toFixed(1)}s building jobs in the page)` : ""));

    if (opts.json) {
        writeFileSync(opts.json, JSON.stringify(results.map(({ job, saved, ...r }) => r), null, 1));
        console.log(`raw results -> ${opts.json}`);
    }
}

// --------------------------------------------------------------------- building jobs

// Playwright is not a dependency of this repo; pick it up from wherever npx cached it.
function resolvePlaywright() {
    const require_ = createRequire(import.meta.url);
    try {
        return require_.resolve("playwright");
    } catch {}
    const cache = path.join(homedir(), ".npm", "_npx");
    if (existsSync(cache)) {
        for (const dir of readdirSync(cache)) {
            const p = path.join(cache, dir, "node_modules", "playwright", "index.mjs");
            if (existsSync(p)) return p;
        }
    }
    throw new Error("playwright not found. Run:  npx playwright --version");
}

// Prefer an installed Chrome over a downloaded chromium, which usually is not present.
const CHROME_CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
];

// Imports each roster into the page and clicks Run, but keeps the message the page posts to its
// worker instead of letting it through. That message is exactly what the kernel would receive.
async function buildJobs(arms, opts) {
    const { chromium } = await import(resolvePlaywright());
    const browser = await chromium.launch({
        executablePath: CHROME_CANDIDATES.find((p) => existsSync(p)),
        args: ["--no-sandbox"],
    });
    const page = await browser.newPage();
    page.on("pageerror", (e) => console.error("  [page error]", e.message));
    await page.addInitScript(() => {
        const post = Worker.prototype.postMessage;
        window.__sweepJobs = [];
        Worker.prototype.postMessage = function (msg, ...rest) {
            if (msg?.type === "start_battle") return void window.__sweepJobs.push(JSON.parse(JSON.stringify(msg)));
            return post.call(this, msg, ...rest);
        };
    });

    for (const arm of arms) {
        await page.goto(opts.url);
        // Seed the origin, then reload so the page reads the levels on startup.
        await page.evaluate((b) => localStorage.setItem("mwiGuildBuildingLevels", b), opts.buildings);
        await page.reload();
        await page.waitForSelector("#guildTrialDrop");
        await page.setInputFiles("#guildTrialFile", arm.file);
        await page.waitForSelector(".roster-row", { timeout: 60000 });
        // Derived summaries build a real Player per member; 50+ of them is not instant.
        await page.waitForTimeout(1800);

        if (opts.ladder) {
            await page.click('.subtab[data-modetab="trialMode"]');
            await page.fill("#trialTimeCap", String(opts.cap));
            await page.click("#runTrial");
        } else {
            await page.click('.subtab[data-modetab="singleBossMode"]');
            await page.selectOption("#enemyLevelSelect", String(opts.level));
            await page.fill("#timeCap", String(opts.cap));
            await page.click("#runBattle");
        }
        await page.waitForFunction(() => window.__sweepJobs.length > 0, null, { timeout: 60000 });
        arm.job = await page.evaluate(() => window.__sweepJobs[0]);
    }
    await browser.close();
}

// ------------------------------------------------------------------------------ pool

function runPool(arms, seeds, opts) {
    const tasks = [];
    arms.forEach((_, arm) => seeds.forEach((seed, run) => tasks.push({ id: tasks.length, arm, run, seed })));
    const outs = new Array(tasks.length);
    const nThreads = Math.max(1, Math.min(opts.jobs, tasks.length));

    return new Promise((resolve, reject) => {
        let next = 0, done = 0;
        const workers = [];
        const finish = (err) => {
            for (const w of workers) w.terminate();
            if (process.stderr.isTTY) process.stderr.write(" ".repeat(40) + "\r");
            err ? reject(err) : resolve(arms.map((a, i) => ({ ...a, runs: outs.slice(i * seeds.length, (i + 1) * seeds.length) })));
        };
        const feed = (w) => {
            if (next < tasks.length) w.postMessage(tasks[next++]);
        };
        for (let i = 0; i < nThreads; i++) {
            const w = new Worker(fileURLToPath(import.meta.url), {
                workerData: { jobs: arms.map((a) => a.job), ladder: opts.ladder },
            });
            workers.push(w);
            w.on("error", finish);
            w.on("message", (m) => {
                if (m.ready) return feed(w);
                if (m.error) return finish(new Error(`kernel error on ${arms[tasks[m.id].arm].name} seed ${tasks[m.id].seed}:\n${m.error}`));
                outs[m.id] = m.out;
                done++;
                // In-place progress only on a terminal; piped output must stay parseable.
                if (process.stderr.isTTY) process.stderr.write(`  ${done}/${tasks.length} runs\r`);
                if (done === tasks.length) finish();
                else feed(w);
            });
        }
    });
}

// ----------------------------------------------------------------------------- stats

// Mann-Whitney U for "a scores better than b", on scores where lower is better.
function mannWhitneyU(a, b) {
    let u = 0;
    for (const x of a) for (const y of b) u += x < y ? 1 : x === y ? 0.5 : 0;
    return u;
}

// One-sided p for the observed U: exact for small samples, normal approximation beyond that.
function pValue(n, m, u) {
    if (n * m > 400) {
        const z = (u - 0.5 - n * m / 2) / Math.sqrt(n * m * (n + m + 1) / 12);
        return 0.5 * erfc(z / Math.SQRT2);
    }
    return exactP(n, m, u);
}

// Abramowitz & Stegun 7.1.26; plenty for a p-value.
function erfc(x) {
    const t = 1 / (1 + 0.3275911 * Math.abs(x));
    const y = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x);
    return x >= 0 ? y : 2 - y;
}

// Exact one-sided p for the observed U, by counting rank orderings.
function exactP(n, m, u) {
    const memo = new Map();
    const count = (i, j, k) => {
        if (k < 0) return 0;
        if (i === 0 || j === 0) return k === 0 ? 1 : 0;
        const key = `${i},${j},${k}`;
        if (memo.has(key)) return memo.get(key);
        const v = count(i - 1, j, k - j) + count(i, j - 1, k);
        memo.set(key, v);
        return v;
    };
    let atLeast = 0, total = 0;
    for (let k = 0; k <= n * m; k++) {
        const c = count(n, m, k);
        total += c;
        if (k >= Math.ceil(u)) atLeast += c;
    }
    return atLeast / total;
}

const quantile = (sorted, q) => {
    const pos = (sorted.length - 1) * q, lo = Math.floor(pos);
    return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (pos - lo);
};
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

// --------------------------------------------------------------------------- report

function report(results, opts) {
    // Single tier: boss HP left, lower is better. Ladder: tiers cleared plus progress into the
    // next, higher is better - boss HP on its own compares runs that died on different tiers.
    const metric = opts.ladder ? (r) => r.progress : (r) => r.bossPct;
    const better = opts.ladder ? (x, y) => x > y : (x, y) => x < y;
    const sign = opts.ladder ? -1 : 1;
    const control = results[0].runs.map(metric);
    const n = opts.runs;
    const width = Math.max(...results.map((r) => r.name.length), 6);

    console.log(opts.ladder ? "score: tiers cleared + progress into the next (higher is better)"
        : "score: boss HP left, % (lower is better)");
    const killsHead = opts.ladder ? "" : "  kills";
    console.log(`${"arm".padEnd(width)}    min     q1    med     q3    max   mean${killsHead}  alive  seed w-l    U vs ${results[0].name}`);
    for (const r of results) {
        const xs = r.runs.map(metric);
        const sorted = [...xs].sort((a, b) => a - b);
        const kills = r.runs.filter((x) => x.bossPct === 0).length;
        const alive = r.runs.filter((x) => (x.alive ?? 0) > 0).length;
        let wl = "     -", u = "     -";
        if (r !== results[0]) {
            const w = xs.filter((x, i) => better(x, control[i])).length;
            const l = xs.filter((x, i) => better(control[i], x)).length;
            wl = `${w}-${l}`.padStart(6);
            const uu = mannWhitneyU(xs.map((x) => sign * x), control.map((x) => sign * x));
            u = `${String(uu).padStart(5)}/${n * n}  p=${pValue(n, n, uu).toFixed(3)}`;
        }
        const f = (x) => x.toFixed(opts.ladder ? 2 : 1).padStart(6);
        const killsCol = opts.ladder ? "" : `  ${String(kills).padStart(5)}`;
        console.log(`${r.name.padEnd(width)} ${[0, 0.25, 0.5, 0.75, 1].map((q) => f(quantile(sorted, q))).join(" ")} ${f(mean(xs))}` +
            `${killsCol}  ${String(alive).padStart(2)}/${n}  ${wl}  ${u}`);
    }

    console.log(`\nU is one-sided "arm beats control"; null = ${n * n / 2}, max = ${n * n}.`);
    console.log(`seed w-l: runs where the arm beat / lost to the control on the same seed.`);
}

// ---------------------------------------------------------------------- entry point

// The same file is the main script and every pool thread; a thread just runs jobs it is sent.
if (!isMainThread) {
    const kernel = await loadKernel();
    const { jobs, ladder } = workerData;
    parentPort.on("message", ({ id, arm, seed }) => {
        try {
            const job = jobs[arm];
            const out = ladder ? runLadder(kernel, job, seed) : summarize(battle(kernel, { ...job, seed }));
            parentPort.postMessage({ id, out: { seed, ...out } });
        } catch (e) {
            parentPort.postMessage({ id, error: String(e?.stack ?? e) });
        }
    });
    parentPort.postMessage({ ready: true });
} else {
    await main();
}
