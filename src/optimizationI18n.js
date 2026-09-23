// UI strings for the Optimization page. The page opens in Chinese and remembers the choice.
//
// Only this page's own labels live here. Game content names (zones, abilities, items) come from the
// shared js/i18n.js bundle loaded by the HTML, which already carries actionNames/abilityNames/
// itemNames in both languages — see gameName() below.

const LANG_KEY = "mwiOptimizationLang";
export const LANGUAGES = ["zh", "en"];

const STRINGS = {
    zh: {
        pageTitle: "团队配装优化",
        pageSubtitle: "三人碎片刷取方案扫描",
        navSimulator: "模拟器",
        navGroupBattle: "团战",
        navSkillLab: "技能实验室",

        secTarget: "目标",
        secGroup: "队伍",
        secRun: "运行",
        secResults: "结果",

        labelZone: "地区",
        labelGoal: "优化目标",
        goalFragments: "每小时碎片数",
        labelItem: "物品",
        labelTiers: "难度",
        labelHours: "每次模拟时长（小时）",
        labelMooPass: "哞卡",
        labelComExp: "社区经验 buff",
        labelComDrop: "社区掉落 buff",
        evHint: "碎片数量按击杀数和掉落率算期望值，不掷随机掉落，所以同一套配装两次运行的结果可以直接比较。",

        reloadPlugin: "重新读取插件数据",
        runBtn: "开始扫描",
        stopBtn: "停止",
        sortBy: "排序",
        sortFrags: "碎片/时（每人）",
        sortEph: "遭遇/时",
        sortXp: "经验/时（人均）",
        sortDps: "DPS（人均）",
        sortDeaths: "死亡/时最少",
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
        reset: "重置",
        resetTitle: "把该方案恢复成基准配装",
        emptyOption: "— 空 —",
        knownLevel: "该角色这个技能的实际等级",
        unknownLevel: "没有该技能的已知等级",
        identicalToBaseline: "与基准完全相同 —— 改动一个技能才会成为独立方案。",
        baseline: "基准",
        baselineDetail: "读取到的原始配装",
        sameAsBaseline: "与基准相同",

        fragNoteAuto: "目标：{item} · 根据该地区掉落表自动识别。",
        fragNoteMulti: "该地区掉落 {n} 种钥匙碎片，请在右侧选择。当前：{item}",
        fragNoteNone: "该地区不掉落钥匙碎片 —— 请手动选择要优化的物品。",
        keyFragment: "钥匙碎片",

        pickAll: "请为三名玩家各选一套配装，并至少勾选一个难度。",
        conditionCount: "{counts} 个方案 × {tiers} 个难度 = {total} 次模拟，每次 {hours} 小时。",
        parallel: "并行 {pool} 个模拟（{cores}{capped}{limited}）。",
        cores: "{n} 个逻辑核心",
        unknownCores: "核心数未知",
        capped: "，上限 {n}",
        limitedByWork: "，受条件数限制",
        progress: "已模拟 {done}/{total} 个条件 · 并行 {pool} 个。",
        finished: "{message} {done}/{total} 个条件。",
        done: "完成。",
        stopped: "已停止。",
        failed: "失败：{message}",
        workerError: "工作线程错误：{message}",
        unknown: "未知",
        resultsSummary: "{n} 个条件 · 最佳 {value} {item}/时（每人），难度 T{tier}",
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
        pageTitle: "Group Optimization",
        pageSubtitle: "3-player fragment farming sweep",
        navSimulator: "Simulator",
        navGroupBattle: "Group Battle",
        navSkillLab: "Skill Lab",

        secTarget: "Target",
        secGroup: "Group",
        secRun: "Run",
        secResults: "Results",

        labelZone: "Zone",
        labelGoal: "Goal",
        goalFragments: "Fragments per hour",
        labelItem: "Item",
        labelTiers: "Tiers",
        labelHours: "Hours per sim",
        labelMooPass: "Moo Pass",
        labelComExp: "Community XP buff",
        labelComDrop: "Community drop buff",
        evHint: "Fragment counts are expected values from kill counts and drop rates, not rolled drops, so two runs of the same build are directly comparable.",

        reloadPlugin: "Reload plugin data",
        runBtn: "Run sweep",
        stopBtn: "Stop",
        sortBy: "Sort by",
        sortFrags: "Fragments / h (per player)",
        sortEph: "Encounters / h",
        sortXp: "XP / h (avg player)",
        sortDps: "DPS (avg player)",
        sortDeaths: "Fewest deaths / h",
        exportCsv: "Export CSV",

        thTier: "Tier",
        thP1: "P1 variant",
        thP2: "P2 variant",
        thP3: "P3 variant",
        thGroup: "Group",
        thFragsAvg: "Frags/h avg",
        thEnc: "Enc/h",
        thXpAvg: "XP/h avg (k)",
        thFrags: "Frags/h",
        thDps: "DPS",
        thDeaths: "Deaths/h",
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
        reset: "reset",
        resetTitle: "Reset this kit back to the baseline loadout",
        emptyOption: "— empty —",
        knownLevel: "This character's level for this ability",
        unknownLevel: "No known level for this ability",
        identicalToBaseline: "Identical to the baseline — edit an ability to make it a distinct variant.",
        baseline: "baseline",
        baselineDetail: "the loadout as captured",
        sameAsBaseline: "same as baseline",

        fragNoteAuto: "Target: {item} · auto-detected from the zone's drop tables.",
        fragNoteMulti: "{n} key fragments drop here — pick one. Currently: {item}",
        fragNoteNone: "This zone drops no key fragments — pick the item to optimize for by hand.",
        keyFragment: "key fragment",

        pickAll: "Pick a loadout for all three players and at least one tier.",
        conditionCount: "{counts} variants × {tiers} tiers = {total} simulations of {hours}h each.",
        parallel: "{pool} simulations in parallel ({cores}{capped}{limited}).",
        cores: "{n} logical cores",
        unknownCores: "unknown core count",
        capped: ", capped at {n}",
        limitedByWork: ", limited by the number of conditions",
        progress: "{done}/{total} conditions simulated · {pool} running in parallel.",
        finished: "{message} {done}/{total} conditions.",
        done: "Done.",
        stopped: "Stopped.",
        failed: "Failed: {message}",
        workerError: "Worker error: {message}",
        unknown: "unknown",
        resultsSummary: "{n} conditions · best {value} {item}/h per player at T{tier}",
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
