// UI strings for the Optimization page. The page opens in Chinese and remembers the choice.
//
// Only this page's own labels live here. Game content names (zones, abilities, items) come from the
// shared js/i18n.js bundle loaded by the HTML, which already carries actionNames/abilityNames/
// itemNames in both languages — see gameName() below.

const LANG_KEY = "mwiOptimizationLang";
export const LANGUAGES = ["zh", "en"];

const STRINGS = {
    zh: {
        // ---- Trigger Optimization page (trigger-optimization.html)
        trTitle: "触发器优化",
        trNavOptimization: "配装优化",
        trNavSimulator: "模拟器",
        trSecAbilities: "技能",
        trAbilitiesHint: "每个技能显示其当前触发器，默认已载入。修改触发器并勾选 <b>模拟</b>，即可搜索触发器里的数值，找出每小时遭遇数（EPH）最高的设置。未勾选的技能保持不变。",
        trSecPlan: "方案预览",
        trSecResults: "结果",
        trPlanEmpty: "暂无可模拟的内容。勾选技能的 <b>模拟</b>，并确保触发器里有可搜索的数值，或已修改触发器。",
        trHours: "每次模拟时长（小时）",
        trRun: "开始触发器优化",
        trStop: "停止",
        trConfirmHours: "确认模拟时长（小时）",
        trConfirmHoursTitle: "找到更好的触发器后，用这个时长再模拟一次基准和推荐设置来确认。",
        trPlanConfirm: "确认：找到更好的触发器后，基准和推荐设置各用 {hours} 小时再模拟 1 次（共 2 次），确认提升是否真实。",
        trConfirmTitle: "确认（{hours} 小时）",
        trConfirmRecommended: "推荐触发器",
        trConfirmOk: "已确认：{hours} 小时的模拟里，推荐设置比基准高 {pct}%。",
        trConfirmFail: "未确认：{hours} 小时的模拟里，推荐设置没有超过基准（{pct}%），建议保留当前触发器。",
        trPoolSize: "同时模拟数",
        trPoolSizeTitle: "同时运行的模拟数量。默认并最多为本浏览器可用的最大值。",
        trPoolMax: "最大 {max}",
        trParallel: "并行模拟",
        trParallelTitle: "所有勾选的技能同时各自对比基准搜索，最后再合并验证一次。关闭后按顺序逐个技能调优，每个技能在前面已采用的设置上继续。",
        trResultsEmpty: "运行后在此查看结果。",
        trNoContext: "没有载入队伍。请在配装优化结果表中点击某一行的“触发器”按钮打开本页。",
        trCurrent: "当前：",
        trNoCondition: "无条件：冷却好就释放",
        trSim: "模拟",
        trAddTrigger: "+ 触发器",
        trReset: "恢复当前",
        trResetTitle: "恢复为当前触发器",
        trClear: "清空",
        trStartValue: "起始值；勾选“模拟”时会在其附近搜索",
        trPlayerFallback: "玩家{n}",
        trPlanSummary: "共 <b>{min}–{max}</b> 次模拟，每次 {hours} 小时（含基准）。",
        trPlanOrderPar: "所有技能同时搜索，各自对比基准；最后把各自最优合并再模拟一次。",
        trPlanOrderSeq: "按下列顺序逐个技能调优，每个技能从前面已找到的最优设置继续。",
        trPlanBaseline: "基准：队伍保持现状，用于对比。",
        trPlanSims: "{min}–{max} 次模拟",
        trPlanNoNumber: "没有可搜索的数值，按当前设置模拟一次。",
        trPlanUnchanged: "触发器未修改且没有可搜索的数值，已跳过。",
        trPlanTry: "尝试 {values}；{refine}。",
        trPlanCombined: "合并：把各技能的最优设置一起模拟 1 次，只有比单个最优更好时才采用。",
        trPlanIncomplete: "触发器不完整，已跳过。",
        trKindcount: "单位数",
        trKindpercent: "百分比",
        trKindnumber: "数值",
        trRefineNone: "不细化",
        trRefinePercent: "再在最优值附近试 ±{steps}",
        trRefineNumber: "再在最优值附近试 ÷/× {factors}",
        trProgress: "{done} / 最多 {total} 次模拟",
        trDone: "完成：共 {done} 次模拟",
        trStopped: "已停止（结果为部分结果）",
        trStopping: "正在停止…",
        trRunFailed: "运行失败：{message}",
        trThSetup: "设置",
        trThEph: "EPH",
        trThVs: "对比基准",
        trThFrags: "碎片/时 均",
        trThDeaths: "死亡/时（合计）",
        trBaseline: "基准（当前触发器）",
        trBest: "当前最优",
        trCombined: "合并所有最优",
        trAdopted: "采用：",
        trNoBetter: "没有任何尝试超过当前设置：保留当前触发器。",
        trCombinedWorse: "第 {pass} 轮：合并后的结果（EPH {combined}）不如单个最优，所以只采用了单个最优。",
        trPass: "第 {n} 轮",
        trPassStop: "第 {pass} 轮只提升了 {gain} EPH（低于 {limit}），停止。",
        trPassMax: "已达到最多 {pass} 轮，停止。",
        trPlanPasses: "以上为第 1 轮。一个技能的触发器变化可能影响另一个技能的最优值，所以之后会在已采用的设置上围绕当前数值再搜索一轮又一轮，直到某一轮提升低于 {limit} EPH（最多 {max} 轮）。",
        trRecommended: "推荐的触发器",
        pageTitle: "团队配装优化",
        pageSubtitle: "三人碎片刷取方案扫描",
        navSimulator: "模拟器",
        navGroupBattle: "团战",
        navSkillLab: "技能实验室",

        secTarget: "模拟设置",
        secGroup: "队伍",
        secRun: "运行",
        secResults: "结果",

        labelZone: "地区",
        labelGoal: "优化目标",
        goalFragments: "每小时碎片数",
        goalXp: "每小时经验",
        goalCharms: "每小时护符",
        thCharmAvg: "护符/时 均",
        thCharm: "护符/时",
        charmTitle: "护符得分：基础护符 = 1，高级护符 = 8.1（所有类型的护符合计，期望值）",
        resultsSummaryXp: "{n} 个条件中的前 {shown} 名（{stage}）· 最佳 {value}k 经验/时（人均），难度 T{tier}",
        resultsSummaryCharms: "{n} 个条件中的前 {shown} 名（{stage}）· 最佳 {value} 护符分/时（人均），难度 T{tier}",
        labelFastHours: "快速模拟时长（小时）",
        labelFullHours: "完整模拟时长（小时）",
        fastHoursTitle: "先用这个时长模拟所有条件，筛出前几名",
        fullHoursTitle: "筛出的前几名再用这个时长模拟，结果更准确",
        labelMooPass: "哞卡",
        labelComExp: "社区经验 buff",
        labelComDrop: "社区掉落 buff",
        evHint: "碎片数量按击杀数和掉落率算期望值，不掷随机掉落，所以同一套配装两次运行的结果可以直接比较。",

        reloadPlugin: "重新读取插件数据",
        runBtn: "模拟单个地区",
        stopBtn: "停止",
        exportCsv: "导出 CSV",

        thTier: "难度",
        thP1: "P1 方案",
        thP2: "P2 方案",
        thP3: "P3 方案",
        thGroup: "团队",
        thFragsAvg: "碎片/时 均",
        thEnc: "遭遇/时",
        thXpAvg: "经验/时 均 (k)",
        thFrags: "碎片/时",
        thDps: "DPS",
        thDeaths: "死亡/时",
        thXp: "经验/时 (k)",
        thPlayer1: "玩家1",
        thPlayer2: "玩家2",
        thPlayer3: "玩家3",
        avgTitle: "三名玩家的平均值",

        pluginWaiting: "正在等待配装插件发布数据…",
        pluginMissing: "本页没有插件数据。请确认配装脚本已安装并在此网址生效，然后打开一次它的面板（加载时会发布数据）。",
        pluginParseFail: "插件数据解析失败：{message}",
        pluginEmpty: "插件已在本页发布数据，但还没有任何角色 —— 请在游戏页点一次“刷新”（发布于 {when}）。",
        pluginOk: "已从插件读取 {count} 个角色，发布于 {when}。",
        unknownTime: "未知时间",

        player: "玩家{n}",
        labelCharacter: "角色",
        labelBaseline: "基准配装",
        pick: "— 选择 —",
        noLoadout: "未选择配装",
        slotSpecial: "特殊",
        slot: "槽{n}",
        empty: "空",
        addKit: "+ 候选方案",
        variantsHint: "方案数：<strong>{n}</strong>（基准 + 每个候选）",
        kitName: "方案{n}",
        kitNameTitle: "显示在结果表中",
        noAbilities: "无技能",
        openTriggerOpt: "打开触发器优化",
        triggerBtn: "触发器",
        triggerOptStorageFailed: "无法保存队伍数据，浏览器存储已满。",
        reset: "重置",
        resetTitle: "把该方案恢复成基准配装",
        emptyOption: "— 空 —",
        knownLevel: "该角色这个技能的实际等级",
        unknownLevel: "没有该技能的已知等级",
        identicalToBaseline: "与基准完全相同 —— 改动一个技能才会成为独立方案。",
        baseline: "基准",
        baselineDetail: "读取到的原始配装",
        sameAsBaseline: "与基准相同",


        pickAll: "单个地区：请为三名玩家各选一套配装，并选择一个在地区设置里开启的地区。",
        secZones: "地区设置",
        zonesDefault: "全部 T4+T5",
        zonesClear: "全部关闭",
        zonesHint: "两种模拟都用这里的难度。“模拟全部地区”扫描所有开启的地区；关闭的地区（灰色）跳过，也不出现在单个地区的列表里，难度设置会保留。",
        runAllBtn: "模拟全部地区",
        thZone: "地区",
        pickAllZones: "全部地区：请先选好三名玩家，并在地区设置里至少勾选一个难度。",
        allZonesCount: "全部地区：{zones} 个地区共 {total} 次 {fast} 小时快速模拟，再对每个地区前 {top} 名做 {full} 小时完整模拟。",
        allZonesCountFull: "全部地区：{zones} 个地区共 {total} 次模拟，每次 {full} 小时。",
        resultsSummaryZones: "{zones} 个地区各取最佳（共 {n} 个条件，{stage}）",
        conditionCount: "{counts} 个方案 × {tiers} 个难度 = {total} 次 {fast} 小时快速模拟，再对前 {top} 名做 {full} 小时完整模拟。",
        conditionCountFull: "{counts} 个方案 × {tiers} 个难度 = {total} 次模拟，每次 {full} 小时（条件太少，跳过快速模拟）。",
        parallel: "并行 {pool} 个模拟（{cores}{capped}{limited}）。",
        cores: "{n} 个逻辑核心",
        unknownCores: "核心数未知",
        capped: "，上限 {n}",
        limitedByWork: "，受条件数限制",
        progressZone: "地区 {k}/{n}：{zone} · ",
        progressFast: "快速模拟（{hours} 小时）：{done}/{total} 个条件 · 并行 {pool} 个。",
        progressFull: "完整模拟（{hours} 小时）：{done}/{total} 个条件 · 并行 {pool} 个。",
        finished: "{message} 共 {done} 次模拟。",
        done: "完成。",
        stopped: "已停止。",
        failed: "失败：{message}",
        workerError: "工作线程错误：{message}",
        unknown: "未知",
        resultsSummary: "{n} 个条件中的前 {shown} 名（{stage}）· 最佳 {value} {item}/时（每人），难度 T{tier}",
        stageFast: "快速模拟 {hours} 小时，尚未完整模拟",
        stageFull: "{fast} 小时快速模拟的前 {top} 名再做 {hours} 小时完整模拟",
        stageFullOnly: "{hours} 小时完整模拟",
        preview: "预览",
        close: "关闭",
        candidateFrom: "配装来源",
        baselineLoadoutOption: "（基准配装）",
        gearFrom: "装备来自《{name}》",
        secLevels: "等级",
        secGear: "装备",
        secAbilities: "技能",
        secConsumables: "食物 / 饮料",
        secShrines: "神龛",
        secRooms: "房屋",
        secAchievements: "成就",
        secStats: "属性",
        statNote: "按等级和装备计算，不含神龛、区域增益和社区 buff。",
        achievementsDone: "已完成 {n} 项",
        combatLevel: "战斗等级",
        maxHp: "最大生命",
        maxMp: "最大魔法",
        attackInterval: "攻击间隔",
        accuracy: "命中",
        maxDamage: "最大伤害",
        none: "无",
        slotHead: "头部", slotBody: "身体", slotLegs: "腿部", slotFeet: "鞋子", slotHands: "手套",
        slotMainHand: "主手", slotTwoHand: "双手", slotOffHand: "副手", slotPouch: "袋子",
        slotNeck: "项链", slotEarrings: "耳环", slotRing: "戒指", slotBack: "背部", slotCharm: "护符",
    },
    en: {
        // ---- Trigger Optimization page (trigger-optimization.html)
        trTitle: "Trigger Optimization",
        trNavOptimization: "Optimization",
        trNavSimulator: "Simulator",
        trSecAbilities: "Abilities",
        trAbilitiesHint: "Each ability shows its current trigger, loaded by default. Edit the trigger and tick <b>sim</b> to search its numbers for the best encounters per hour (EPH). Abilities that are not ticked stay as they are.",
        trSecPlan: "Plan preview",
        trSecResults: "Results",
        trPlanEmpty: "Nothing to simulate yet. Tick <b>sim</b> on an ability whose trigger has a number to search, or edit its trigger.",
        trHours: "Hours per sim",
        trRun: "Run trigger optimization",
        trStop: "Stop",
        trConfirmHours: "Confirm hours",
        trConfirmHoursTitle: "After a better trigger is found, the baseline and the recommended triggers are simulated again for this long to confirm.",
        trPlanConfirm: "Confirmation: once a better trigger is found, the baseline and the recommended triggers are each simulated once more for {hours}h (2 sims) to confirm the gain is real.",
        trConfirmTitle: "Confirmation ({hours}h)",
        trConfirmRecommended: "Recommended triggers",
        trConfirmOk: "Confirmed: over {hours}h the recommended triggers are {pct}% above the baseline.",
        trConfirmFail: "Not confirmed: over {hours}h the recommended triggers did not beat the baseline ({pct}%); keep the current triggers.",
        trPoolSize: "Sims at once",
        trPoolSizeTitle: "How many simulations run at the same time. Defaults to, and is capped at, the most this browser can run.",
        trPoolMax: "max {max}",
        trParallel: "Parallel sims",
        trParallelTitle: "Every ticked ability is searched at the same time against the baseline, then the results are combined and verified once. Off: abilities are tuned one after another, each on top of the settings adopted before it.",
        trResultsEmpty: "Run the optimization to see results.",
        trNoContext: "No party loaded. Open this page with the Triggers button on a row of the Optimization results table.",
        trCurrent: "Current: ",
        trNoCondition: "no condition: casts whenever ready",
        trSim: "sim",
        trAddTrigger: "+ trigger",
        trReset: "reset to current",
        trResetTitle: "Restore the current trigger",
        trClear: "clear",
        trStartValue: "Starting value; searched around when sim is ticked",
        trPlayerFallback: "Player {n}",
        trPlanSummary: "<b>{min}–{max}</b> simulations of {hours}h each (baseline included).",
        trPlanOrderPar: "All abilities are searched at the same time, each against the baseline; then the best of each are simulated together once.",
        trPlanOrderSeq: "Abilities are tuned in this order, each starting from the best settings found before it.",
        trPlanBaseline: "Baseline: the party exactly as it is now, to compare against.",
        trPlanSims: "{min}–{max} sims",
        trPlanNoNumber: "No number to search: the trigger is simulated as set.",
        trPlanUnchanged: "Trigger unchanged and no number to search: skipped.",
        trPlanTry: "try {values}; {refine}.",
        trPlanCombined: "Combined: every ability's best settings simulated together once; adopted only if better than the best single one.",
        trPlanIncomplete: "the trigger is incomplete, so it is skipped.",
        trKindcount: "unit count",
        trKindpercent: "percentage",
        trKindnumber: "number",
        trRefineNone: "no refinement",
        trRefinePercent: "then ±{steps} around the best",
        trRefineNumber: "then ÷/× {factors} around the best",
        trProgress: "{done} / up to {total} sims",
        trDone: "Done: {done} sims",
        trStopped: "Stopped (results are partial)",
        trStopping: "Stopping…",
        trRunFailed: "Run failed: {message}",
        trThSetup: "Setup",
        trThEph: "EPH",
        trThVs: "vs baseline",
        trThFrags: "Frags/h avg",
        trThDeaths: "Deaths/h (all)",
        trBaseline: "Baseline (current triggers)",
        trBest: "Best so far",
        trCombined: "All best combined",
        trAdopted: "Adopted: ",
        trNoBetter: "No trial beat the current setup: keep the current trigger.",
        trCombinedWorse: "Pass {pass}: the combination (EPH {combined}) was worse than the best single ability, so only that one was adopted.",
        trPass: "pass {n}",
        trPassStop: "Pass {pass} gained only {gain} EPH (under {limit}): stopped.",
        trPassMax: "Reached the maximum of {pass} passes: stopped.",
        trPlanPasses: "The above is pass 1. One ability's trigger can change another's best value, so further passes search around the adopted values again, until a pass gains less than {limit} EPH (at most {max} passes).",
        trRecommended: "Recommended triggers",
        pageTitle: "Group Optimization",
        pageSubtitle: "3-player fragment farming sweep",
        navSimulator: "Simulator",
        navGroupBattle: "Group Battle",
        navSkillLab: "Skill Lab",

        secTarget: "Sim settings",
        secGroup: "Group",
        secRun: "Run",
        secResults: "Results",

        labelZone: "Zone",
        labelGoal: "Goal",
        goalFragments: "Fragments per hour",
        goalXp: "XP per hour",
        goalCharms: "Charms per hour",
        thCharmAvg: "Charms/h avg",
        thCharm: "Charms/h",
        charmTitle: "Charm score: a basic charm = 1, an advanced charm = 8.1 (every charm type together, expected value)",
        resultsSummaryXp: "Top {shown} of {n} conditions ({stage}) · best {value}k XP/h per player at T{tier}",
        resultsSummaryCharms: "Top {shown} of {n} conditions ({stage}) · best {value} charm score/h per player at T{tier}",
        labelFastHours: "Fast sim hours",
        labelFullHours: "Full sim hours",
        fastHoursTitle: "Every condition is simulated this long first to find the front-runners",
        fullHoursTitle: "The front-runners are simulated again this long for precise numbers",
        labelMooPass: "Moo Pass",
        labelComExp: "Community XP buff",
        labelComDrop: "Community drop buff",
        evHint: "Fragment counts are expected values from kill counts and drop rates, not rolled drops, so two runs of the same build are directly comparable.",

        reloadPlugin: "Reload plugin data",
        runBtn: "Sim single zone",
        stopBtn: "Stop",
        exportCsv: "Export CSV",

        thTier: "Tier",
        thP1: "P1 variant",
        thP2: "P2 variant",
        thP3: "P3 variant",
        thGroup: "Group",
        thFragsAvg: "Frags/h avg",
        thEnc: "EPH",
        thXpAvg: "XP/h avg (k)",
        thFrags: "Frags/h",
        thDps: "DPS",
        thDeaths: "DPH",
        thXp: "XP/h (k)",
        thPlayer1: "Player 1",
        thPlayer2: "Player 2",
        thPlayer3: "Player 3",
        avgTitle: "Average across the three players",

        pluginWaiting: "Waiting for the loadout plugin to publish its data…",
        pluginMissing: "No plugin data on this page. Check that the loadout userscript is installed and runs on this URL, then open its panel once (it publishes on load).",
        pluginParseFail: "Plugin data could not be parsed: {message}",
        pluginEmpty: "Plugin is publishing here but has no characters yet — hit 刷新 on the game page (mirrored {when}).",
        pluginOk: "{count} characters from the plugin, mirrored {when}.",
        unknownTime: "unknown time",

        player: "Player {n}",
        labelCharacter: "Character",
        labelBaseline: "Baseline loadout",
        pick: "— pick —",
        noLoadout: "No loadout selected.",
        slotSpecial: "special",
        slot: "slot {n}",
        empty: "empty",
        addKit: "+ candidate kit",
        variantsHint: "Variants: <strong>{n}</strong> (baseline + each kit)",
        kitName: "Kit {n}",
        kitNameTitle: "Shown in the results table",
        noAbilities: "no abilities",
        openTriggerOpt: "Open Trigger Optimization for this row",
        triggerBtn: "Triggers",
        triggerOptStorageFailed: "Could not save the party for the next page: browser storage is full.",
        reset: "reset",
        resetTitle: "Reset this kit back to the baseline loadout",
        emptyOption: "— empty —",
        knownLevel: "This character's level for this ability",
        unknownLevel: "No known level for this ability",
        identicalToBaseline: "Identical to the baseline — edit an ability to make it a distinct variant.",
        baseline: "baseline",
        baselineDetail: "the loadout as captured",
        sameAsBaseline: "same as baseline",


        pickAll: "Single zone: pick a loadout for all three players and a zone that is on in the zone settings.",
        secZones: "Zone settings",
        zonesDefault: "All T4+T5",
        zonesClear: "All off",
        zonesHint: "Both runs use the tiers set here. \"Sim all zones\" sweeps every zone that is on; zones switched off (greyed) are skipped, left out of the single-zone list, and keep their tiers.",
        runAllBtn: "Sim all zones",
        thZone: "Zone",
        pickAllZones: "All zones: pick all three players and tick at least one tier in the zone settings.",
        allZonesCount: "All zones: {zones} zones, {total} fast sims of {fast}h, then the top {top} of each zone at {full}h.",
        allZonesCountFull: "All zones: {zones} zones, {total} simulations of {full}h each.",
        resultsSummaryZones: "Best of each of {zones} zones ({n} conditions, {stage})",
        conditionCount: "{counts} variants × {tiers} tiers = {total} fast sims of {fast}h, then the top {top} at {full}h.",
        conditionCountFull: "{counts} variants × {tiers} tiers = {total} simulations of {full}h each (too few to need a fast sim).",
        parallel: "{pool} simulations in parallel ({cores}{capped}{limited}).",
        cores: "{n} logical cores",
        unknownCores: "unknown core count",
        capped: ", capped at {n}",
        limitedByWork: ", limited by the number of conditions",
        progressZone: "Zone {k}/{n}: {zone} · ",
        progressFast: "Fast sim ({hours}h): {done}/{total} conditions · {pool} running in parallel.",
        progressFull: "Full sim ({hours}h): {done}/{total} conditions · {pool} running in parallel.",
        finished: "{message} {done} simulations in all.",
        done: "Done.",
        stopped: "Stopped.",
        failed: "Failed: {message}",
        workerError: "Worker error: {message}",
        unknown: "unknown",
        resultsSummary: "Top {shown} of {n} conditions ({stage}) · best {value} {item}/h per player at T{tier}",
        stageFast: "{hours}h fast sim, full sim pending",
        stageFull: "{hours}h full sim of the top {top} from a {fast}h fast sim",
        stageFullOnly: "{hours}h full sim",
        preview: "Preview",
        close: "Close",
        candidateFrom: "Loadout",
        baselineLoadoutOption: "(baseline loadout)",
        gearFrom: "gear from \u201c{name}\u201d",
        secLevels: "Levels",
        secGear: "Equipment",
        secAbilities: "Abilities",
        secConsumables: "Food / Drinks",
        secShrines: "Shrines",
        secRooms: "House rooms",
        secAchievements: "Achievements",
        secStats: "Stats",
        statNote: "From levels and equipment only — shrines, zone buffs and community buffs are not included.",
        achievementsDone: "{n} completed",
        combatLevel: "Combat level",
        maxHp: "Max HP",
        maxMp: "Max MP",
        attackInterval: "Attack interval",
        accuracy: "Accuracy",
        maxDamage: "Max damage",
        none: "none",
        slotHead: "Head", slotBody: "Body", slotLegs: "Legs", slotFeet: "Feet", slotHands: "Hands",
        slotMainHand: "Main hand", slotTwoHand: "Two hand", slotOffHand: "Off hand", slotPouch: "Pouch",
        slotNeck: "Neck", slotEarrings: "Earrings", slotRing: "Ring", slotBack: "Back", slotCharm: "Charm",
    },
};

let current = "zh";

export function initLanguage() {
    try {
        const saved = localStorage.getItem(LANG_KEY);
        if (LANGUAGES.includes(saved)) {
            current = saved;
        }
    } catch (e) { /* default stands */ }
    syncSharedI18n();
    return current;
}

export function language() {
    return current;
}

export function setLanguage(next) {
    if (!LANGUAGES.includes(next)) {
        return current;
    }
    current = next;
    try {
        localStorage.setItem(LANG_KEY, current);
    } catch (e) { /* the page still works, it just will not remember */ }
    syncSharedI18n();
    return current;
}

// Keep the shared bundle on the same language, since game names are read through it. Before it has
// initialised there is nothing to switch — the initialised handler below syncs it then.
function syncSharedI18n() {
    const i18next = window.i18next;
    if (i18next?.isInitialized && i18next.language !== current) {
        i18next.changeLanguage(current);
    }
}

export function t(key, vars = {}) {
    const template = STRINGS[current][key] ?? STRINGS.en[key] ?? key;
    return template.replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match);
}

// Game content names come from the shared bundle when it has loaded, falling back to the English
// name baked into the game data. `ns` is one of actionNames / abilityNames / itemNames.
export function gameName(ns, hrid, fallback) {
    const i18next = window.i18next;
    if (i18next?.isInitialized) {
        const translated = i18next.t(`${ns}.${hrid}`, { defaultValue: "" });
        if (translated) {
            return translated;
        }
    }
    return fallback ?? hrid;
}

// Calls back whenever the shared bundle becomes able to answer differently: once it initialises,
// and again each time its language actually changes. changeLanguage() is asynchronous — it resolves
// only after the language is in place — so rendering off the initialised event alone would read
// game names in whatever language the bundle's own detector picked.
export function onSharedI18nReady(callback) {
    const i18next = window.i18next;
    if (!i18next) {
        return;
    }

    // Deferred by a tick: the bundle's own init callback rewrites document.title, and the order
    // between it and these listeners is not guaranteed.
    const later = () => setTimeout(callback, 0);

    i18next.on("languageChanged", later);
    if (i18next.isInitialized) {
        syncSharedI18n();
        later();
        return;
    }
    i18next.on("initialized", () => {
        syncSharedI18n();
        later();
    });
}
