// Registers this page's own UI strings into the shared i18next instance that
// js/i18n.js sets up (loaded as a plain <script> in group-battle.html, same as
// the main app). Reuses the main app's existing itemNames/abilityNames/
// skillNames/combatStyleNames/damageTypeNames translations for equipment,
// abilities, and skills instead of duplicating them - only page-specific UI
// strings (labels, buttons, hints) live here, under the "groupBattle" namespace.

const en = {
    pageTitle: "MWI Group Battle Simulator",
    backToStandard: "← Back to standard simulator",
    tabBattle: "Battle",
    tabPresets: "Monster Presets",

    importPlayersTitle: "Import Players",
    importPlayersHint: "Paste player data exported from the main simulator (Import/Export → Solo export). Accepts a single export, a JSON array of exports, newline-separated exports, or a group export. Import as many as you like (10–50+). Note: food & drinks are ignored in group battles — levels, equipment, and abilities are used.",
    importTextPlaceholder: 'Paste one export, or a JSON array: [ {"player":{...},"food":{...},...}, {...} ]',
    importReplace: "Import (replace)",
    importAppend: "Import (append)",
    clearAll: "Clear all",
    noPlayersImported: "No players imported yet.",
    player: "Player",
    equipment: "Equipment",
    abilities: "Abilities",
    noCombatEquipment: "No combat equipment.",
    noAbilities: "No abilities.",

    buildEnemyGroupTitle: "Build Enemy Group",
    buildEnemyGroupHint: "Pick a monster and (for Trial Monsters) its level, then add it to the group. Max 20 enemies. Build custom presets in the <b>Monster Presets</b> tab.",
    add: "Add",
    clearAllEnemies: "Clear all enemies",
    noEnemiesAdded: "No enemies added yet.",
    monster: "Monster",
    style: "Style",

    battleSettingsTitle: "Battle Settings",
    timeCap: "Time cap (seconds)",
    timeCapHint: "Battle ends when one side is wiped, or when this cap is reached.",
    runBattle: "▶ Run Battle",
    simulating: "Simulating...",

    battleResultTitle: "Battle Result",
    combatLogTitle: "Combat Log",
    entries: "entries",
    show: "Show",
    logAllEvents: "All events",
    logAttacksOnly: "Attacks only",
    logHealsOnly: "Heals only",
    logDeathsOnly: "Deaths only",
    logConsumablesOnly: "Consumables only",
    searchPlaceholder: "Search (name, ability...)",

    trialMonstersTitle: "Trial Monsters",
    trialMonstersHint: "Built-in monsters that scale with level (T1 = L100 up to L300, step 10). Pick one and a level to preview its full status, then add it to the battle enemy group.",
    statusPreviewTitle: "Status Preview",
    level: "Level",
    addToEnemyGroup: "Add to Enemy Group →",
    perEncounter: "per encounter",

    importStatBlockTitle: "Import from in-game stat block (custom, non-scaling)",
    importStatBlockHint: 'For monsters NOT in the Trial Monsters list. Paste a stat block (label: value per line). Recognized labels: Combat Style, Damage Type, Attack Interval, Cast Speed, Ability Haste, Ranged/Magic/Stab/Slash/Smash Accuracy & Damage, Max Hitpoints, Max Manapoints, Stab/Slash/Smash/Ranged/Magic Evasion, Armor, Water/Nature/Fire Resistance, Tenacity, Threat. Suffixes K/M and % are understood. "Defensive Damage" is a display-only value and is ignored. These presets are fixed at the stats you enter (no level scaling).',
    presetName: "Preset name",
    presetNamePlaceholder: "e.g. Custom Boss",
    parseAndFill: "Parse & fill editor →",

    savedCustomPresetsTitle: "Saved Custom Presets",
    savedCustomPresetsHint: "Presets are saved in your browser. Select one to edit, or add it to the battle enemy list.",
    noPresetsYet: "No presets yet. Build one below or paste a stat block.",
    edit: "Edit",
    couldNotSavePresets: "Could not save presets: {{msg}}",

    presetEditorTitle: "Preset Editor",
    name: "Name",
    combatStyle: "Combat Style",
    damageType: "Damage Type",
    attackInterval: "Attack Interval",
    attackIntervalS: "Attack Interval (s)",
    castSpeed: "Cast Speed",
    castSpeedPct: "Cast Speed (%)",
    abilityHaste: "Ability Haste",
    accuracy: "Accuracy",
    accuracyActiveStyle: "Accuracy (active style)",
    maxDamage: "Max Damage",
    maxDamageActiveStyle: "Max Damage (active style)",
    evasion: "Evasion",
    maxHitpoints: "Max Hitpoints",
    maxManapoints: "Max Manapoints",
    stabEvasion: "Stab Evasion",
    slashEvasion: "Slash Evasion",
    smashEvasion: "Smash Evasion",
    rangedEvasion: "Ranged Evasion",
    magicEvasion: "Magic Evasion",
    armor: "Armor",
    waterResistance: "Water Resistance",
    natureResistance: "Nature Resistance",
    fireResistance: "Fire Resistance",
    tenacity: "Tenacity",
    threat: "Threat",
    savePreset: "Save preset",
    clearEditor: "Clear editor",

    selectMonsterFirst: "Select a monster first.",
    maxEnemiesError: "Maximum 20 enemies in a group.",
    unknownTrialMonster: "Unknown Trial Monster.",
    unknownCustomPreset: "Unknown custom preset.",
    importAtLeastOnePlayer: "Import at least one player.",
    addAtLeastOneEnemy: "Add at least one enemy.",
    noPlayerDataFound: "No player data found in the import.",
    couldNotParseImport: "Could not parse import: {{msg}}",
    importedWithErrors: "Imported with {{count}} error(s):\n{{errors}}",
    newPreset: "New preset.",
    savedPreset: 'Saved "{{name}}".',
    editingPreset: 'Editing "{{name}}" — Save to update.',
    parsedReview: "Parsed — review below and click Save preset.",
    simulationErrorPrefix: "Simulation error: ",
    noLogEntriesMatch: "No log entries match.",
    moreEntriesHidden: "... {{count}} more entries hidden (refine filter/search)",
    players: "Players",
    enemies: "Enemies",
    hp: "HP",
    mp: "MP",
    deaths: "Deaths",
    damageDone: "Damage Done",
    damageTaken: "Damage Taken",
    source: "Source",
    totalDmg: "Total Dmg",
    hits: "Hits",
    dps: "DPS",
    outcomeVictory: "VICTORY (players win)",
    outcomeDefeat: "DEFEAT (players wiped)",
    outcomeTimeout: "TIMEOUT (hit time cap)",
    outcomeEnded: "ENDED",
    battleDuration: "Battle duration:",
    custom: "custom",

    died: "died",
    misses: "misses",
    heals: "heals",
    consumes: "consumes",
    hitsForDamage: "{{src}} hits {{tgt}} for {{dmg}} {{ability}}",
    casts: "casts",
    castsOn: "{{src}} casts {{ability}} on {{tgt}}",
    enragesText: "{{src}} <b>enrages</b> (stack {{stack}}: +{{pct}}% damage, +{{pct}}% accuracy)",
    gainsMana: "gains",

    damageTaken: "Damage Taken",

    rulesBannerTitle: "Group Battle Rules:",
    rulesBannerNoFoodDrink: "No food or drink consumables are used — all players get a flat <b>+3 percentage points</b> added to HP regen and MP regen instead (e.g. 1% → 4%).",
    rulesBannerMonsterHp: "Monster max HP is increased by <b>+1% per player</b> in the group.",
    rulesBannerEnrage: "Monster <b>enrages after 10 minutes</b> in combat, then gains +10% damage and +10% accuracy for every additional 10 minutes alive (stacking up to +100%/+100% at 100 minutes).",

    testImportTitle: "Test Import",
    testImportHint: "Load built-in test rosters by role. Food &amp; drinks are always stripped.",
    testRanger: "Ranger",
    testHealer: "Healer",
    testTank: "Tank",
    testSmash: "Smash",
    importTestGroup: "Import Test Group (replace)",

    preview: "Preview",
    previewTitlePrefix: "Preview —",
    close: "x",

    logManaGainsOnly: "Mana gains only",
    logBuffCastsOnly: "Buff casts only",
    logEnrageOnly: "Enrage only",

    manaCost: "Mana Cost",
    cooldown: "Cooldown",
    castTime: "Cast Time",
    triggersWhen: "Triggers when:",
    noTriggerCondition: "No trigger condition (casts whenever off cooldown &amp; affordable)",
};

const zh = {
    pageTitle: "MWI 团队战斗模拟器",
    backToStandard: "← 返回标准模拟器",
    tabBattle: "战斗",
    tabPresets: "怪物预设",

    importPlayersTitle: "导入玩家",
    // Import instructions stay English-only: the pasted format itself is
    // English/JSON, so translating the instructions could mislead users
    // about what to actually paste.
    importPlayersHint: "Paste player data exported from the main simulator (Import/Export → Solo export). Accepts a single export, a JSON array of exports, newline-separated exports, or a group export. Import as many as you like (10–50+). Note: food & drinks are ignored in group battles — levels, equipment, and abilities are used.",
    // Kept English-only: shows the literal JSON syntax to paste.
    importTextPlaceholder: 'Paste one export, or a JSON array: [ {"player":{...},"food":{...},...}, {...} ]',
    importReplace: "导入（替换）",
    importAppend: "导入（追加）",
    clearAll: "全部清除",
    noPlayersImported: "尚未导入玩家。",
    player: "玩家",
    equipment: "装备",
    abilities: "技能",
    noCombatEquipment: "无战斗装备。",
    noAbilities: "无技能。",

    buildEnemyGroupTitle: "构建敌方队伍",
    buildEnemyGroupHint: "选择一个怪物，并为试炼怪物选择等级，然后添加到队伍中。最多 20 只。可在<b>怪物预设</b>标签页中创建自定义预设。",
    add: "添加",
    clearAllEnemies: "清除所有敌人",
    noEnemiesAdded: "尚未添加敌人。",
    monster: "怪物",
    style: "风格",

    battleSettingsTitle: "战斗设置",
    timeCap: "时间上限（秒）",
    timeCapHint: "当一方全灭，或达到此时间上限时，战斗结束。",
    runBattle: "▶ 开始战斗",
    simulating: "模拟中...",

    battleResultTitle: "战斗结果",
    combatLogTitle: "战斗日志",
    entries: "条记录",
    show: "显示",
    logAllEvents: "全部事件",
    logAttacksOnly: "仅攻击",
    logHealsOnly: "仅治疗",
    logDeathsOnly: "仅死亡",
    logConsumablesOnly: "仅消耗品",
    searchPlaceholder: "搜索（名称、技能...）",

    trialMonstersTitle: "试炼怪物",
    trialMonstersHint: "内置的怪物会随等级缩放（T1 = L100，最高 L300，每级间隔 10）。选择一个怪物和等级以预览其完整状态，然后添加到战斗敌方队伍。",
    statusPreviewTitle: "状态预览",
    level: "等级",
    addToEnemyGroup: "添加到敌方队伍 →",
    perEncounter: "每场遭遇",

    importStatBlockTitle: "从游戏内数值面板导入（自定义，不缩放）",
    // Kept English-only: recognized labels (Combat Style, Ranged Accuracy, ...)
    // must be pasted in English, so translating the instructions would mislead.
    importStatBlockHint: 'For monsters NOT in the Trial Monsters list. Paste a stat block (label: value per line). Recognized labels: Combat Style, Damage Type, Attack Interval, Cast Speed, Ability Haste, Ranged/Magic/Stab/Slash/Smash Accuracy & Damage, Max Hitpoints, Max Manapoints, Stab/Slash/Smash/Ranged/Magic Evasion, Armor, Water/Nature/Fire Resistance, Tenacity, Threat. Suffixes K/M and % are understood. "Defensive Damage" is a display-only value and is ignored. These presets are fixed at the stats you enter (no level scaling).',
    presetName: "预设名称",
    presetNamePlaceholder: "例如：自定义Boss",
    parseAndFill: "解析并填入编辑器 →",

    savedCustomPresetsTitle: "已保存的自定义预设",
    savedCustomPresetsHint: "预设保存在你的浏览器中。选择一个进行编辑，或将其添加到战斗敌方列表。",
    noPresetsYet: "尚无预设。请在下方创建，或粘贴数值面板。",
    edit: "编辑",
    couldNotSavePresets: "无法保存预设：{{msg}}",

    presetEditorTitle: "预设编辑器",
    name: "名称",
    combatStyle: "战斗风格",
    damageType: "伤害类型",
    attackInterval: "攻击间隔",
    attackIntervalS: "攻击间隔（秒）",
    castSpeed: "施法速度",
    castSpeedPct: "施法速度（%）",
    abilityHaste: "技能急速",
    accuracy: "命中",
    accuracyActiveStyle: "命中（当前风格）",
    maxDamage: "最大伤害",
    maxDamageActiveStyle: "最大伤害（当前风格）",
    evasion: "闪避",
    maxHitpoints: "最大生命值",
    maxManapoints: "最大魔力值",
    stabEvasion: "穿刺闪避",
    slashEvasion: "挥砍闪避",
    smashEvasion: "打击闪避",
    rangedEvasion: "远程闪避",
    magicEvasion: "魔法闪避",
    armor: "护甲",
    waterResistance: "水抗性",
    natureResistance: "自然抗性",
    fireResistance: "火抗性",
    tenacity: "坚韧",
    threat: "威胁值",
    savePreset: "保存预设",
    clearEditor: "清空编辑器",

    selectMonsterFirst: "请先选择一个怪物。",
    maxEnemiesError: "队伍中最多 20 名敌人。",
    unknownTrialMonster: "未知的试炼怪物。",
    unknownCustomPreset: "未知的自定义预设。",
    importAtLeastOnePlayer: "请至少导入一名玩家。",
    addAtLeastOneEnemy: "请至少添加一名敌人。",
    noPlayerDataFound: "导入内容中未找到玩家数据。",
    couldNotParseImport: "无法解析导入内容：{{msg}}",
    importedWithErrors: "导入完成，但有 {{count}} 个错误：\n{{errors}}",
    newPreset: "新预设。",
    savedPreset: '已保存 "{{name}}"。',
    editingPreset: '正在编辑 "{{name}}" — 点击保存以更新。',
    parsedReview: "已解析 — 请在下方检查，然后点击保存预设。",
    simulationErrorPrefix: "模拟出错：",
    noLogEntriesMatch: "没有符合条件的日志记录。",
    moreEntriesHidden: "...还有 {{count}} 条记录被隐藏（请调整筛选/搜索条件）",
    players: "玩家",
    enemies: "敌人",
    hp: "生命值",
    mp: "魔力值",
    deaths: "死亡次数",
    damageDone: "造成的伤害",
    source: "来源",
    totalDmg: "总伤害",
    hits: "命中次数",
    dps: "每秒伤害",
    outcomeVictory: "胜利（玩家获胜）",
    outcomeDefeat: "失败（玩家全灭）",
    outcomeTimeout: "超时（达到时间上限）",
    outcomeEnded: "已结束",
    battleDuration: "战斗时长：",
    custom: "自定义",

    died: "死亡",
    misses: "未命中",
    heals: "治疗了",
    consumes: "使用了",
    hitsForDamage: "{{src}} 命中 {{tgt}}，造成 {{dmg}} 点伤害 {{ability}}",
    casts: "施放了",
    castsOn: "{{src}} 对 {{tgt}} 施放了 {{ability}}",
    enragesText: "{{src}} <b>进入狂暴</b>（第 {{stack}} 层：伤害 +{{pct}}%，命中 +{{pct}}%）",
    gainsMana: "恢复了",

    damageTaken: "承受的伤害",

    rulesBannerTitle: "团队战斗规则：",
    rulesBannerNoFoodDrink: "团队战斗中不使用任何食物或饮品——所有玩家改为获得固定 <b>+3 个百分点</b> 的生命回复和魔力回复加成（例如 1% → 4%）。",
    rulesBannerMonsterHp: "怪物最大生命值会根据队伍人数增加 <b>每人 +1%</b>。",
    rulesBannerEnrage: "怪物在战斗 <b>10 分钟后进入狂暴</b>，此后每多存活 10 分钟再获得 +10% 伤害与 +10% 命中（最多叠加至 100 分钟时的 +100%/+100%）。",

    testImportTitle: "测试导入",
    testImportHint: "按职业加载内置的测试队伍。食物和饮品将始终被清空。",
    testRanger: "游侠",
    testHealer: "治疗",
    testTank: "坦克",
    testSmash: "重击",
    importTestGroup: "导入测试队伍（替换）",

    preview: "预览",
    previewTitlePrefix: "预览 —",
    close: "关闭",

    logManaGainsOnly: "仅魔力恢复",
    logBuffCastsOnly: "仅增益施放",
    logEnrageOnly: "仅狂暴",

    manaCost: "魔力消耗",
    cooldown: "冷却时间",
    castTime: "施法时间",
    triggersWhen: "触发条件：",
    noTriggerCondition: "无触发条件（冷却完毕且魔力充足时即可施放）",
};

// i18next is loaded globally by js/i18n.js (same as the main app) and is
// configured with ns: ['translation', 'common'] only - a brand new namespace
// added via addResourceBundle is NOT reliably resolved by t(), so our strings
// live nested under "common:groupBattle.<key>" in the already-known "common"
// namespace instead (same namespace main.js uses for its own UI strings).
//
// js/i18n.js's own i18next.init() call (with an HTTP backend that fetches
// locales/{{lng}}/common.json) completes AFTER our module runs, and finishing
// init() replaces the "common" bundle - so registering our keys before that
// resolves gets silently discarded. We must add our bundle only once i18next
// reports "initialized", not merely once the global exists.
function registerBundle() {
    i18next.addResourceBundle("en", "common", { groupBattle: en }, true, true);
    i18next.addResourceBundle("zh", "common", { groupBattle: zh }, true, true);
}

function applyStaticTranslations() {
    document.querySelectorAll("[data-i18n]").forEach((el) => {
        let key = el.getAttribute("data-i18n");
        if (el.hasAttribute("data-i18n-html")) {
            el.innerHTML = i18next.t(key);
        } else {
            el.textContent = i18next.t(key);
        }
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
        el.placeholder = i18next.t(el.getAttribute("data-i18n-placeholder"));
    });
    document.title = i18next.t("common:groupBattle.pageTitle");
}

// Dynamic content (player cards, enemy table, trial preview, battle log, ...)
// is built as HTML strings at render time and won't pick up a language change
// on its own. Callers register a re-render callback here; it fires after
// every languageChanged (and after the initial bundle registration).
const dynamicRenderCallbacks = [];
function onLanguageChange(cb) {
    dynamicRenderCallbacks.push(cb);
}
function rerenderDynamic() {
    dynamicRenderCallbacks.forEach((cb) => {
        try { cb(); } catch (e) { /* a panel not yet populated - ignore */ }
    });
}

function bindLifecycle() {
    i18next.on("initialized", () => {
        registerBundle();
        applyStaticTranslations();
        rerenderDynamic();
    });
    i18next.on("languageChanged", () => {
        registerBundle();
        applyStaticTranslations();
        rerenderDynamic();
        // js/i18n.js's own switcher sets document.title to the main app's title
        // in a .then() after changeLanguage(), which runs after our listener
        // fires. Re-assert ours on the next tick so it wins.
        setTimeout(applyStaticTranslations, 0);
    });
    // If i18next finished initializing before this listener was attached
    // (e.g. on a fast reload where the language was already cached), catch up.
    if (i18next.isInitialized) {
        registerBundle();
        applyStaticTranslations();
    }
}

if (typeof i18next !== "undefined") {
    bindLifecycle();
} else {
    window.addEventListener("DOMContentLoaded", () => {
        // js/i18n.js defines the global; wait a tick for it to load/init.
        const wait = setInterval(() => {
            if (typeof i18next !== "undefined") {
                clearInterval(wait);
                bindLifecycle();
            }
        }, 20);
    });
}

// Translate a groupBattle UI key from JS (for dynamically-built strings:
// table headers, error messages, outcome labels, etc). Falls back to the raw
// English string if i18next hasn't finished loading yet.
function t(key, vars) {
    if (typeof i18next !== "undefined" && i18next.isInitialized) {
        return i18next.t("common:groupBattle." + key, vars);
    }
    let str = en[key] ?? key;
    if (vars) {
        for (const [k, v] of Object.entries(vars)) {
            str = str.replace("{{" + k + "}}", v);
        }
    }
    return str;
}

export { en, zh, t, onLanguageChange };
