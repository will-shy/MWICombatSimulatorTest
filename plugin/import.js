// ==UserScript==
// @name         [战斗模拟器]配装导入
// @version      1.8.0
// @description  配装导入模拟器
// @author       AstroV GPT DiamondMoo willshy
// @match        https://www.milkywayidle.com/*
// @match        https://www.milkywayidlecn.com/*
// @match        https://test.milkywayidle.com/*
// @match        https://test.milkywayidlecn.com/*
// @match        https://shykai.github.io/MWICombatSimulatorTest/*
// @match        *.github.io/MWICombatSimulator*
// @icon         https://www.milkywayidle.com/favicon.svg
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @license      MIT
// @namespace    http://tampermonkey.net/
// @downloadURL https://update.greasyfork.org/scripts/556755/%5B%E6%88%98%E6%96%97%E6%A8%A1%E6%8B%9F%E5%99%A8%5D%E9%85%8D%E8%A3%85%E5%AF%BC%E5%85%A5.user.js
// @updateURL https://update.greasyfork.org/scripts/556755/%5B%E6%88%98%E6%96%97%E6%A8%A1%E6%8B%9F%E5%99%A8%5D%E9%85%8D%E8%A3%85%E5%AF%BC%E5%85%A5.meta.js
// ==/UserScript==

const STORAGE_KEY = "mwi_combat_loadouts_v1";
const IMPORT_REQUEST_KEY = "mwi_import_request";
const UI_POS_GAME = "mwi_ui_pos_game_v1";
const UI_POS_SIM = "mwi_ui_pos_sim_v1";
const UI_POS_LAST_GAME = "mwi_ui_last_pos_game_v1";
const UI_POS_LAST_SIM = "mwi_ui_last_pos_sim_v1";
const UI_POS_PANEL_GAME = "mwi_panel_pos_game_v2";
const KEY_LAST_ACTIVE_CHAR = "mwi_last_active_char";
const KEY_FIRST_OPEN = "mwi_first_open";
const KEY_SIM_PANEL_OPEN = "mwi_sim_panel_open";
const KEY_SETTINGS = "mwi_settings_v1";
// 模拟器站点上的页面读不到油猴存储，所以在模拟器域名下把整份角色数据镜像到
// localStorage，给 optimization.html 之类的页面用。必须和 src/optimization.js 里的
// PLUGIN_MIRROR_KEY 保持一致。
const PAGE_MIRROR_KEY = "mwiPluginCharacters";
// 同一份数据也挂到页面 DOM 上。油猴的 localStorage 不一定和页面同源可见，但面板本身
// 就画在页面 DOM 里，所以这条通道一定通。页面优先读它。
const PAGE_MIRROR_NODE_ID = "mwi-plugin-data";
const PAGE_MIRROR_EVENT = "mwi-plugin-data";
const TAB_INSTANCE_ID = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
const HOST = location.hostname;
// 本地 webpack dev server 也算模拟器页面，否则点配装会走"复制到剪贴板"分支，
// 而不是直接填进模拟器的导入框。脚本头里不再匹配 localhost，本地调试时请在
// 油猴里自行加一条用户匹配规则。
const IS_LOCAL_SIM = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(HOST);
const IS_SIM = HOST.includes(".github.io") || IS_LOCAL_SIM;
const IS_MILKY = HOST.includes("milkywayidle");
const IS_TEST = HOST.includes("test.milkywayidle");
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
let currentScale = 1.0;
let panelPositionLock = { horizontal: "right", vertical: "bottom" };

function safeJSONParse(s, f = null) { try { return JSON.parse(s); } catch { return f } }
function nowTs() { return Date.now(); }

// 提示条。放在模块作用域：importLoadoutToSimulator、buildSettingsModal 等都在
// createFloatingUI 的闭包之外，之前调用会直接抛 ReferenceError。元素按需创建，
// 样式挂在 #mwi-toast 上，面板还没初始化时也能提示。
let toastTimer = null;
function showToast(msg) {
  let toast = document.getElementById("mwi-toast");
  if (!toast) {
    if (!document.body) return;
    toast = document.createElement("div");
    toast.id = "mwi-toast";
    document.body.appendChild(toast);
  }
  toast.innerText = msg;
  toast.style.opacity = "1";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.style.opacity = "0", 1500);
}

const DEFAULT_SETTINGS = {
  READ_ONLY_IRONCOW: false,
  BLOCK_TEST_SERVERS: true,
  ENABLE_AUTO_READ_ON_ENTER: true,
  SIM_SCALE: 1.0,
  MWI_SCALE: 1.0,
  SIM_THEME: "follow",
  GAME_THEME: "dark",
  LOADOUT_BLOCK_WORDS: [],
  LANGUAGE: "en",
  SIM_AUTO_LOAD_BINDINGS: true
};

// 界面文案。默认英文，设置面板里可切到中文。{name} 这种占位符由 t() 替换。
const I18N = {
  en: {
    floatingBtn: "Loadout",
    floatingBtnTitle: "Loadout import (drag to move)",
    panelTitle: "Loadout Import",
    closePanel: "Close",
    notSelected: "(none selected)",
    notRead: "(not read yet)",
    lastSynced: "Last synced: {time}",
    slot: "Slot",
    character: "Character",
    refresh: "Refresh",
    refreshing: "Reading...",
    refreshOk: "Refreshed",
    refreshFail: "Refresh failed",
    charDetail: "Character details",
    charDetailCount: "Character details · Shrines {shrines} · Abilities {abilities}",
    pickCharacter: "Select a character",
    noCharData: "No data for this character",
    shrines: "Guild shrines",
    abilityLevels: "Ability levels",
    noShrineData: "No shrine data. Refresh on the game page.",
    noAbilityData: "No ability data. Refresh on the game page.",
    loadouts: "Loadouts",
    noCharacters: "No characters read yet",
    noLoadouts: "This character has no loadouts",
    allBlocked: "All loadouts are hidden by the block words",
    confirmDelete: "Delete character {name} from local storage?",
    unknownChar: "Unknown character",
    unknownLoadout: "Unknown loadout",
    copiedLoadout: "Copied [{char}] - [{loadout}]",
    copied: "Loadout data copied",
    copyFail: "Copy failed, please copy manually",
    importFail: "Import failed",
    importedToSlot: "Imported loadout to slot {slot}",
    settings: "Settings",
    settingsTitle: "Loadout Import Settings",
    setLanguage: "Language",
    setReadOnlyIroncow: "Hide standard characters",
    setBlockTest: "Hide test server characters",
    setAutoRead: "Read character on entering the game",
    setAutoLoadBindings: "Load bound slots when opening the panel",
    slotBoundTo: "Slot {slot}: {char} - {loadout}",
    slotNotBound: "Slot {slot}: not bound (import a loadout to bind it)",
    slotBindingMissing: "Slot {slot}: bound loadout no longer exists",
    unbind: "Unbind",
    unbindAll: "Clear all",
    bindingsCleared: "All slot bindings cleared",
    loadedBound: "Loaded {n} bound slot(s)",
    setBlockWords: "Loadout name block words",
    blockWordsPlaceholder: "One block word per line, e.g.:\nGathering\nBoss",
    saveBlockWords: "Save",
    setSimScale: "Simulator scale",
    setMwiScale: "MWI scale",
    scaleSaved: "Scale saved: {scale}×",
    setSimTheme: "Simulator theme",
    setGameTheme: "MWI page theme",
    themeFollow: "Follow",
    themeDark: "Dark",
    themeLight: "Light",
    shrine_force: "Shrine of Force",
    shrine_tempo: "Shrine of Tempo",
    shrine_spirit: "Shrine of Spirit",
    shrine_scholar: "Shrine of Scholar"
  },
  zh: {
    floatingBtn: "配装",
    floatingBtnTitle: "配装导入（可拖动）",
    panelTitle: "配装导入",
    closePanel: "关闭配装导入",
    notSelected: "（未选择）",
    notRead: "（未读取）",
    lastSynced: "最后同步：{time}",
    slot: "序号",
    character: "角色",
    refresh: "刷新",
    refreshing: "读取中...",
    refreshOk: "刷新成功",
    refreshFail: "刷新失败",
    charDetail: "角色详情",
    charDetailCount: "角色详情 · 神龛 {shrines} · 技能 {abilities}",
    pickCharacter: "请选择角色",
    noCharData: "该角色暂无数据",
    shrines: "公会神龛",
    abilityLevels: "技能等级",
    noShrineData: "未读取到神龛数据，请在游戏页刷新",
    noAbilityData: "未读取到技能数据，请在游戏页刷新",
    loadouts: "配装",
    noCharacters: "暂无已读取角色",
    noLoadouts: "该角色暂无配装",
    allBlocked: "没有符合当前屏蔽规则的配装",
    confirmDelete: "确定从本地删除角色 {name} 吗？",
    unknownChar: "未知角色",
    unknownLoadout: "未知配装",
    copiedLoadout: "已复制【{char}】-【{loadout}】",
    copied: "已复制配装数据",
    copyFail: "复制失败，请手动复制",
    importFail: "导入失败",
    importedToSlot: "已导入配装到序号{slot}",
    settings: "设置",
    settingsTitle: "配装导入 设置",
    setLanguage: "语言",
    setReadOnlyIroncow: "屏蔽标准角色",
    setBlockTest: "屏蔽测试服角色",
    setAutoRead: "进入游戏时读取角色配置",
    setAutoLoadBindings: "打开面板时自动载入各序号绑定的配装",
    slotBoundTo: "序号{slot}：{char} - {loadout}",
    slotNotBound: "序号{slot}：未绑定（导入一套配装即绑定）",
    slotBindingMissing: "序号{slot}：绑定的配装已不存在",
    unbind: "解除绑定",
    unbindAll: "全部清除",
    bindingsCleared: "已清除所有序号绑定",
    loadedBound: "已载入 {n} 个绑定序号",
    setBlockWords: "配装名称屏蔽词",
    blockWordsPlaceholder: "每行一个屏蔽词，例如：\n采集\nBoss",
    saveBlockWords: "保存屏蔽词",
    setSimScale: "战斗模拟器缩放倍率",
    setMwiScale: "MWI缩放倍率",
    scaleSaved: "缩放倍率已保存: {scale}×",
    setSimTheme: "战斗模拟器主题",
    setGameTheme: "MWI页面主题",
    themeFollow: "跟随",
    themeDark: "黑暗",
    themeLight: "明亮",
    shrine_force: "力量神龛",
    shrine_tempo: "节奏神龛",
    shrine_spirit: "精神神龛",
    shrine_scholar: "学者神龛"
  }
};

// 设置还没读到时（脚本刚启动）按默认英文走。
function currentLang() {
  const lang = window.__mwi_settings_cache?.LANGUAGE;
  return I18N[lang] ? lang : DEFAULT_SETTINGS.LANGUAGE;
}

function t(key, vars) {
  const s = I18N[currentLang()][key] ?? I18N.en[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
}

// 切语言：静态文案就地换，面板里的动态内容（角色、配装、详情）整体重画。
function applyLanguage() {
  applyStaticTexts();
  window.__mwi_panel?.refresh?.();
}

// 静态文案挂 data-mwi-i18n（文本）、data-mwi-i18n-title（title）、
// data-mwi-i18n-placeholder，切语言时统一刷新；动态内容由各自的 render 重画。
function applyStaticTexts(scope = document) {
  if (!scope) return;
  scope.querySelectorAll("[data-mwi-i18n]").forEach(el => { el.innerText = t(el.dataset.mwiI18n); });
  scope.querySelectorAll("[data-mwi-i18n-title]").forEach(el => { el.title = t(el.dataset.mwiI18nTitle); });
  scope.querySelectorAll("[data-mwi-i18n-placeholder]").forEach(el => { el.placeholder = t(el.dataset.mwiI18nPlaceholder); });
}

GM_addStyle(`
.mwi-ui { box-sizing: border-box; font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto; user-select: none !important; }
#mwi-floating-btn, #mwi-panel, #mwi-panel * { -webkit-user-select:none !important; -moz-user-select:none !important; user-select:none !important; }
#mwi-floating-btn{position:fixed;left:12px;top:25%;z-index:2147483647;min-width:44px;height:33px;padding:0 10px;white-space:nowrap;touch-action:none;border-radius:8px;display:flex;align-items:center;justify-content:center;cursor:grab;transition:box-shadow .18s,transform .12s;font-weight:700}
#mwi-floating-btn.round{border-radius:50%}
#mwi-panel{position:fixed;left:60px;top:24%;width:360px;max-height:560px;overflow:auto;z-index:2147483646;border-radius:12px;padding:12px;display:none;flex-direction:column;gap:8px;box-shadow:0 18px 38px rgba(0,0,0,0.25);border:1px solid var(--mwi-panel-border);font-size:14px}
#mwi-panel-drag-handle{cursor:grab;touch-action:none}
.mwi-row{display:flex;flex-wrap:wrap;gap:8px}
.mwi-title { font-size: 16px !important; }
.mwi-section-label { font-size: 12px !important; }
.mwi-btn-text { font-size: 14px !important; }
.mwi-small-muted{font-size:12px !important;color:var(--mwi-muted,#888)}
.mwi-slot-btn{width:32px;height:32px;border-radius:8px;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:all .12s;border:1px solid var(--mwi-btn-border);font-size:14px !important;}
.mwi-item-btn{height:32px;min-width:110px;border-radius:8px;padding:0 8px;display:flex;align-items:center;justify-content:center;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:all .12s;border:1px solid var(--mwi-btn-border);font-size:14px !important;}
.mwi-delete-btn{margin-left:6px;color:var(--mwi-danger,#ff6b6b);cursor:pointer;font-weight:700;font-size:14px !important;}
.mwi-active{box-shadow:0 6px 12px rgba(0,0,0,0.12);}
.mwi-item-btn:hover, .mwi-slot-btn:hover { transform:translateY(-2px); box-shadow:0 6px 12px rgba(0,0,0,0.08); }
.mwi-item-btn.selected{border-color:var(--mwi-accent,#69a8ff); background:var(--mwi-selected-bg,#e0efff); color:var(--mwi-selected-color,#111);}
.mwi-slot-btn.selected{border-color:var(--mwi-accent,#69a8ff); background:var(--mwi-selected-bg,#e0efff); color:var(--mwi-selected-color,#111);}
.mwi-slot-btn.mwi-bound{position:relative}
.mwi-slot-btn.mwi-bound::after{content:"";position:absolute;right:3px;top:3px;width:6px;height:6px;border-radius:50%;background:var(--mwi-accent,#69a8ff)}
#mwi-slot-binding{display:flex;align-items:center;gap:8px;font-size:12px !important;min-height:18px}
#mwi-slot-binding-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#mwi-slot-unbind,#mwi-slot-unbind-all{cursor:pointer;color:var(--mwi-danger,#ff6b6b);white-space:nowrap}
#mwi-char-detail{border:1px solid var(--mwi-btn-border);border-radius:8px;padding:6px 8px}
#mwi-char-detail>summary{cursor:pointer;list-style:none;font-size:12px !important;color:var(--mwi-muted,#888)}
#mwi-char-detail>summary::-webkit-details-marker{display:none}
#mwi-char-detail>summary::before{content:"▸ "}
#mwi-char-detail[open]>summary::before{content:"▾ "}
.mwi-detail-group{margin-top:8px}
.mwi-detail-grid{display:grid;grid-template-columns:1fr auto;gap:2px 10px;font-size:12px;margin-top:4px}
.mwi-detail-grid>div{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mwi-detail-lv{text-align:right;font-variant-numeric:tabular-nums;color:var(--mwi-muted,#888)}
#mwi-toast{position:fixed;left:50%;transform:translateX(-50%);bottom:12%;padding:8px 12px;border-radius:8px;background:rgba(0,0,0,0.75);color:#fff;opacity:0;transition:opacity .25s;font-size:13px;pointer-events:none;z-index:2147483648}
:root.mwi-theme-light {
  --mwi-bg: #ffffff;
  --mwi-fg:#111;
  --mwi-muted:#666;
  --mwi-selected-bg:#fff4d2;
  --mwi-selected-color:#111;
  --mwi-accent:#ffca7a;
  --mwi-danger:#c0392b;
  --mwi-panel-border:rgba(0,0,0,0.06);
  --mwi-floating-bg: linear-gradient(180deg,#f5f5f7,#e8eaed);
  --mwi-floating-border: rgba(0,0,0,0.08);
  --mwi-btn-border: rgba(0,0,0,0.1);
}
:root.mwi-theme-light #mwi-panel, :root.mwi-theme-light #mwi-settings-modal { background:var(--mwi-bg); color:var(--mwi-fg); border-color: var(--mwi-panel-border); }
:root.mwi-theme-light #mwi-floating-btn { background: var(--mwi-floating-bg); color:var(--mwi-fg); border:1px solid var(--mwi-floating-border); }
:root.mwi-theme-dark {
  --mwi-bg:#212121;
  --mwi-fg:#e8f0e8;
  --mwi-muted:#9aa79a;
  --mwi-selected-bg:#274a3a;
  --mwi-selected-color:#e6f6e8;
  --mwi-accent:#3f7f5f;
  --mwi-danger:#ff6b6b;
  --mwi-panel-border:rgba(255,255,255,0.1);
  --mwi-floating-bg: linear-gradient(180deg,#333333,#212121);
  --mwi-floating-border: rgba(255,255,255,0.1);
  --mwi-btn-border: rgba(255,255,255,0.15);
}
:root.mwi-theme-dark #mwi-panel, :root.mwi-theme-dark #mwi-settings-modal { background:var(--mwi-bg); color:var(--mwi-fg); border-color: var(--mwi-panel-border); }
:root.mwi-theme-dark #mwi-floating-btn { background: var(--mwi-floating-bg); color:var(--mwi-fg); border:1px solid var(--mwi-floating-border); }
:root.mwi-sim-scale #mwi-panel{transform-origin:top left}
:root.mwi-sim-scale #mwi-floating-btn{transform-origin:top left}
#mwi-settings-modal{position:fixed;left:12px;top:12px;transform-origin:top left;max-height:calc(100vh - 24px);overflow:auto;z-index:2147483650;width:520px;max-width:95%;background:#fff;border-radius:12px;padding:16px;box-shadow:0 22px 54px rgba(0,0,0,0.6);display:none;color:#111;transition:transform .2s ease;}
#mwi-settings-modal.dark{background:var(--mwi-bg);color:var(--mwi-fg);border:1px solid var(--mwi-panel-border);}
#mwi-settings-modal h3{margin:0 0 8px 0;font-size:16px !important;}
#mwi-settings-list{display:flex;flex-direction:column;gap:8px}
.mwi-settings-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px;border-radius:8px}
.mwi-settings-row label{flex:1;font-size:14px !important;}
.mwi-settings-controls{min-width:220px;display:flex;gap:8px;align-items:center}
#s_mwi_settings_close{position:absolute;right:8px;top:8px;cursor:pointer;font-size:14px !important;z-index:2147483651;}
#s_mwi_settings_btn{position:absolute;right:8px;bottom:8px;width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;border:1px solid var(--mwi-btn-border);background:rgba(255,255,255,0.06);color:inherit}
#mwi-refresh-btn {
  background: var(--mwi-bg) !important;
  color: var(--mwi-fg) !important;
  border: 1px solid var(--mwi-btn-border) !important;
  min-width: 70px !important;
  height: 26px !important;
  border-radius: 8px !important;
  transition: all .12s !important;
  font-size: 14px !important;
}
#mwi-refresh-btn:hover {
  transform: translateY(-2px) !important;
  box-shadow: 0 6px 12px rgba(0,0,0,0.08) !important;
}
#mwi-refresh-btn:disabled {
  opacity: 0.7 !important;
  cursor: not-allowed !important;
  transform: none !important;
  box-shadow: none !important;
}
#mwi-panel-close{min-width:30px!important;width:30px!important;height:26px!important;padding:0!important}
#mwi-block-words{width:100%;min-height:72px;resize:vertical;box-sizing:border-box}
`);

async function getSettings() {
  const raw = await GM_getValue(KEY_SETTINGS, null);
  if (!raw) { await GM_setValue(KEY_SETTINGS, JSON.stringify(DEFAULT_SETTINGS)); return Object.assign({}, DEFAULT_SETTINGS); }
  const parsed = safeJSONParse(raw, {});
  return Object.assign({}, DEFAULT_SETTINGS, parsed);
}

async function saveSettings(obj) {
  await GM_setValue(KEY_SETTINGS, JSON.stringify(obj));
  await GM_setValue(KEY_SETTINGS + "_ts", Date.now());
}

async function saveAllData(o) { await GM_setValue(STORAGE_KEY, JSON.stringify(o)); }
async function loadAllData() { return safeJSONParse(await GM_getValue(STORAGE_KEY, "{}"), {}); }

// 只在模拟器页面写；游戏页面写了也没人读。整份覆盖，删掉的角色不会残留。
// 两条通道都写：DOM 节点（一定可见）和 localStorage（方便刷新后立即拿到）。
async function mirrorStoreToPage() {
  if (!IS_SIM) return;
  let payload;
  try {
    const all = await loadAllData();
    payload = JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), characters: all });
  } catch (e) {
    console.error("Mirror to page failed:", e);
    return;
  }

  try {
    localStorage.setItem(PAGE_MIRROR_KEY, payload);
  } catch (e) {
    // 存储被禁用或隔离时不影响 DOM 通道。
  }

  try {
    const host = document.body || document.documentElement;
    if (!host) return;
    let node = document.getElementById(PAGE_MIRROR_NODE_ID);
    if (!node) {
      node = document.createElement("script");
      // application/json 不会被执行，只是个数据容器。
      node.type = "application/json";
      node.id = PAGE_MIRROR_NODE_ID;
      host.appendChild(node);
    }
    node.textContent = payload;
    window.dispatchEvent(new CustomEvent(PAGE_MIRROR_EVENT));
  } catch (e) {
    console.error("Mirror node write failed:", e);
  }
}

function readGameStateFromPage() {
  try {
    const el = document.querySelector('[class^="GamePage"]');
    if (!el) return null;
    const fiberKey = Reflect.ownKeys(el).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
    const fiber = el?.[fiberKey];
    if (!fiber) return null;
    const stateNode = fiber.return?.stateNode || fiber?.return?.stateNode;
    if (!stateNode) return null;
    return stateNode.state || stateNode.props?.state || stateNode;
  } catch { return null }
}

function parseEquipmentFromWearableMap(map) {
  const out = [];
  if (!map) return out;
  for (const loc of Reflect.ownKeys(map)) {
    const raw = map[loc];
    if (!raw) continue;
    const parts = String(raw).split("::");
    let itemHrid = parts.find(p => typeof p === "string" && p.startsWith("/items/")) || "";
    let enh = 0;
    const last = parts[parts.length - 1];
    if (/^\d+$/.test(last)) enh = Number(last);
    out.push({ itemLocationHrid: loc, itemHrid: itemHrid, enhancementLevel: enh });
  }
  return out;
}

function parseFoodAndDrinks(loadout) {
  const foods = (loadout.foodItemHrids || []).filter(Boolean);
  const drinks = (loadout.drinkItemHrids || []).filter(Boolean);
  const f = []; const d = [];
  for (let i = 0; i < 3; i++) { f.push({ itemHrid: foods[i] || "" }); d.push({ itemHrid: drinks[i] || "" }); }
  return { food: { "/action_types/combat": f }, drinks: { "/action_types/combat": d } };
}

function parseAbilitiesFromMap(abilityMap, abilityLevelMap) {
  const plain = {};
  try { if (abilityLevelMap?.get) for (const [k, v] of abilityLevelMap.entries()) plain[k] = v; else Object.assign(plain, abilityLevelMap || {}); } catch { }
  const keys = Reflect.ownKeys(abilityMap || {}).sort((a, b) => Number(a) - Number(b));
  const out = [];
  for (const k of keys) {
    const hrid = abilityMap[k] || ""; let level = "1";
    if (hrid && plain[hrid] && Number.isFinite(Number(plain[hrid].level))) level = String(plain[hrid].level);
    out.push({ abilityHrid: hrid, level });
  }
  while (out.length < 5) out.push({ abilityHrid: "", level: "1" });
  return out.slice(0, 5);
}

// 从 key 或者技能对象里取 abilityHrid，兼容 "<id>::/abilities/x" 这种带前缀的 key。
function abilityHridFrom(key, ability) {
  if (ability && typeof ability.abilityHrid === "string") return ability.abilityHrid;
  if (typeof key !== "string") return "";
  return key.split("::").find(p => p.startsWith("/abilities/")) || "";
}

// 角色已学的全部技能等级，不只是当前配装装备的 5 个。
// 这样在模拟器里可以拿一套配装当基准，把技能换成别的（按真实等级）再看效果。
function parseAllAbilityLevels(abilityLevelMap) {
  const out = {};
  if (!abilityLevelMap) return out;
  const entries = typeof abilityLevelMap.entries === "function" ? Array.from(abilityLevelMap.entries()) : Reflect.ownKeys(abilityLevelMap).map(k => [k, abilityLevelMap[k]]);
  for (const [key, ability] of entries) {
    const hrid = abilityHridFrom(key, ability);
    const level = Number(ability?.level);
    if (hrid && level > 0) out[hrid] = level;
  }
  return out;
}

function parseCombatLevels(skillMap) {
  const get = hrid => { try { if (!skillMap) return 1; if (skillMap.get) return Number(skillMap.get(hrid)?.level || 1); if (skillMap[hrid]) return Number(skillMap[hrid].level || 1); } catch { } return 1; };
  return {
    attackLevel: get("/skills/attack"),
    magicLevel: get("/skills/magic"),
    meleeLevel: get("/skills/melee"),
    rangedLevel: get("/skills/ranged"),
    defenseLevel: get("/skills/defense"),
    staminaLevel: get("/skills/stamina"),
    intelligenceLevel: get("/skills/intelligence")
  };
}

function parseHouseRooms(dict) { const out = {}; if (!dict) return out; for (const k of Reflect.ownKeys(dict)) out[k] = dict[k].level || 0; return out; }


function parseAchievement(dict) {
  const result = {};
  for (const [key, achievement] of dict) {
    // 使用 achievementHrid 作为键，isCompleted 作为值
    result[achievement.achievementHrid] = achievement.isCompleted;
  }
  return result;
}


function convertStateToLoadoutJson(state, characterID, loadout) {
  const equipment = parseEquipmentFromWearableMap(loadout.wearableMap || {});
  const { food, drinks } = parseFoodAndDrinks(loadout);
  const abilities = parseAbilitiesFromMap(loadout.abilityMap || {}, state.characterAbilityMap || {});
  const triggerMap = Object.assign({}, loadout.abilityCombatTriggersMap || {}, loadout.consumableCombatTriggersMap || {});
  const zone = state.zone || loadout.zone || "/actions/combat/fly";
  const simulationTime = String(loadout.simulationTime || state.simulationTime || 24);
  const houseRooms = parseHouseRooms(state.characterHouseRoomDict || {});
  const combatLevels = parseCombatLevels(state.characterSkillMap || {});
  const charMeta = state.character || {};
  const achievements = parseAchievement(state.characterAchievementMap || {});
  const guildShrine = parseCharacterGuildBuffDict(state.characterGuildBuffDict);
  const abilityLevels = parseAllAbilityLevels(state.characterAbilityMap);

  return {
    player: { ...combatLevels, equipment },
    food,
    drinks,
    abilities,
    triggerMap,
    zone,
    simulationTime,
    achievements,
    houseRooms,
    guildShrine,
    ...(Object.keys(abilityLevels).length > 0 ? { abilityLevels } : {}),
    characterName: charMeta.name || `Player ${characterID.slice(-1)}`
  };
}

// 战斗神龛：力量 / 节奏 / 精神 / 学者。采集、生产那些技能神龛模拟器用不上，直接丢掉。
// 游戏里的 key 可能是 /guild_buffs/<name> 也可能带 _combat 后缀，两种都认；白名单之外
// 的一律不输出。这四个固定输出：没建的龛就是 0 级，和"整个字段缺失"（模拟器改用自己
// 的缓存）区分开。将来游戏加了新的战斗神龛，这里和模拟器的 shrineDetailMap 都要补。
const COMBAT_SHRINES = ["force", "tempo", "spirit", "scholar"];

function parseCharacterGuildBuffDict(dict) {
  const out = {};
  for (const name of COMBAT_SHRINES) out[name] = 0;
  if (!dict) return out;
  const entries = typeof dict.entries === "function" ? Array.from(dict.entries()) : Reflect.ownKeys(dict).map(k => [k, dict[k]]);
  for (const [key, buff] of entries) {
    if (typeof key !== "string") continue;
    const m = /^\/guild_buffs\/(.+?)(?:_combat)?$/.exec(key);
    if (!m || !COMBAT_SHRINES.includes(m[1])) continue;
    out[m[1]] = Number(buff?.level) || 0;
  }
  return out;
}

// 神龛和技能书都是角色级别的数据，旧版本存下来的配装里没有这两项。导出时在游戏
// 页面从当前状态补一次；补不到就让字段缺失，模拟器会用它自己缓存的值。
function readCharacterExtrasFromPage() {
  const state = readGameStateFromPage();
  if (!state) return null;
  const abilityLevels = parseAllAbilityLevels(state.characterAbilityMap);
  return {
    guildShrine: state.characterGuildBuffDict ? parseCharacterGuildBuffDict(state.characterGuildBuffDict) : null,
    abilityLevels: Object.keys(abilityLevels).length > 0 ? abilityLevels : null
  };
}

const shrineLabel = key => COMBAT_SHRINES.includes(key) ? t("shrine_" + key) : key;

// 技能中文名。和仓库 js/i18n.js 里的 zh.abilityNames 一致，直接内嵌：面板在游戏页和
// 模拟器页都能显示中文，不依赖游戏内部数据，也不用联网。
const ABILITY_NAMES_CN = {
  "/abilities/poke": "破胆之刺",
  "/abilities/impale": "透骨之刺",
  "/abilities/puncture": "破甲之刺",
  "/abilities/penetrating_strike": "贯心之刺",
  "/abilities/scratch": "爪影斩",
  "/abilities/cleave": "分裂斩",
  "/abilities/maim": "血刃斩",
  "/abilities/crippling_slash": "致残斩",
  "/abilities/smack": "重碾",
  "/abilities/sweep": "重扫",
  "/abilities/stunning_blow": "重锤",
  "/abilities/fracturing_impact": "碎裂冲击",
  "/abilities/shield_bash": "盾击",
  "/abilities/quick_shot": "快速射击",
  "/abilities/aqua_arrow": "流水箭",
  "/abilities/flame_arrow": "烈焰箭",
  "/abilities/rain_of_arrows": "箭雨",
  "/abilities/silencing_shot": "沉默之箭",
  "/abilities/steady_shot": "稳定射击",
  "/abilities/pestilent_shot": "疫病射击",
  "/abilities/penetrating_shot": "贯穿射击",
  "/abilities/water_strike": "流水冲击",
  "/abilities/ice_spear": "冰枪术",
  "/abilities/frost_surge": "冰霜爆裂",
  "/abilities/mana_spring": "法力喷泉",
  "/abilities/entangle": "缠绕",
  "/abilities/toxic_pollen": "剧毒粉尘",
  "/abilities/natures_veil": "自然菌幕",
  "/abilities/life_drain": "生命吸取",
  "/abilities/fireball": "火球",
  "/abilities/flame_blast": "熔岩爆裂",
  "/abilities/firestorm": "火焰风暴",
  "/abilities/smoke_burst": "烟爆灭影",
  "/abilities/minor_heal": "初级自愈术",
  "/abilities/heal": "自愈术",
  "/abilities/quick_aid": "快速治疗术",
  "/abilities/rejuvenate": "群体治疗术",
  "/abilities/taunt": "嘲讽",
  "/abilities/provoke": "挑衅",
  "/abilities/toughness": "坚韧",
  "/abilities/elusiveness": "闪避",
  "/abilities/precision": "精确",
  "/abilities/berserk": "狂暴",
  "/abilities/frenzy": "狂速",
  "/abilities/elemental_affinity": "元素增幅",
  "/abilities/spike_shell": "尖刺防护",
  "/abilities/retribution": "惩戒",
  "/abilities/vampirism": "吸血",
  "/abilities/revive": "复活",
  "/abilities/insanity": "疯狂",
  "/abilities/invincible": "无敌",
  "/abilities/speed_aura": "速度光环",
  "/abilities/guardian_aura": "守护光环",
  "/abilities/fierce_aura": "物理光环",
  "/abilities/critical_aura": "暴击光环",
  "/abilities/mystic_aura": "元素光环",
  "/abilities/promote": "晋升",
};

// 没收录的 hrid（比如新出的技能）退回可读的英文名，完整 hrid 在 title 里备查。
function prettyAbilityName(hrid) {
  if (currentLang() === "zh" && ABILITY_NAMES_CN[hrid]) return ABILITY_NAMES_CN[hrid];
  return String(hrid).replace("/abilities/", "").split("_")
    .map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(" ");
}

// 老版本存下来的角色数据没有角色级别的字段，退回到任意一套配装里找。
function characterExtras(char) {
  let guildShrine = char?.guildShrine || null;
  let abilityLevels = char?.abilityLevels || null;
  for (const lo of Object.values(char?.loadouts || {})) {
    if (guildShrine && abilityLevels) break;
    if (!guildShrine && lo?.data?.guildShrine) guildShrine = lo.data.guildShrine;
    if (!abilityLevels && lo?.data?.abilityLevels) abilityLevels = lo.data.abilityLevels;
  }
  return { guildShrine, abilityLevels };
}

function mergeTriggerMaps(existingMap, newMap) {
  if (!existingMap) return { ...newMap };
  if (!newMap) return { ...existingMap };

  const merged = { ...existingMap };
  Reflect.ownKeys(newMap).forEach(key => {
    merged[key] = newMap[key];
  });
  return merged;
}

function extractHighestItemInfo(itemMap) {
  const resultMap = new Map(); // 物品路径 -> {enhancementLevel, originalKey, itemData}

  for (const [key, itemData] of itemMap) {
    const parts = key.split('::');
    const itemPath = parts[2]; // 如 /items/swiftness_coffee

    // 从物品数据中获取 enhancementLevel，而不是从键的序号
    const enhancementLevel = itemData.enhancementLevel || 0;

    const existing = resultMap.get(itemPath);

    if (!existing || enhancementLevel > existing.enhancementLevel) {
      resultMap.set(itemPath, {
        enhancementLevel,
        originalKey: key,
        itemData
      });
    }
  }

  return resultMap;
}

function updateEquipmentWithHighestLevel(equipmentArray, highestItemMap) {
  return equipmentArray.map(equipment => {
    const itemInfo = highestItemMap.get(equipment.itemHrid);

    if (itemInfo) {
      // 如果找到匹配的物品，更新 enhancementLevel
      return {
        ...equipment,
        enhancementLevel: itemInfo.enhancementLevel
      };
    }
    // 如果没有匹配，保持原样
    return equipment;
  });
}

async function readAndSaveCurrentPageConfig() {
  const settings = await getSettings();
  if (IS_TEST && settings.BLOCK_TEST_SERVERS) return null;
  const state = readGameStateFromPage();
  console.log("Read game state:", state);
  if (!state || !state.character) return null;
  const c = state.character;
  if (settings.READ_ONLY_IRONCOW && c.gameMode !== "ironcow") return null;
  const all = await loadAllData();
  const charId = String(c.id);
  const store = all[charId] || { characterMeta: {}, loadouts: {}, triggerMap: {}, lastSavedAt: null };
  store.characterMeta = { id: c.id, name: c.name, gameMode: c.gameMode, createdAt: c.createdAt };
  // 每次读取都以游戏当前配装为准，避免已删除的配装残留在本地缓存中。
  store.loadouts = {};
  store.triggerMap = {};
  const loadouts = state.characterLoadoutDict || {};
  const highestItemMap = extractHighestItemInfo(state.characterItemMap || new Map());

  // console.log("Extracted highest item info:", highestItemMap);
  let pageTriggerMap = {};
  for (const lid of Reflect.ownKeys(loadouts)) {
    const l = loadouts[lid]; if (!l) continue;
    if (l.actionTypeHrid !== "/action_types/combat") continue;
    const parsed = convertStateToLoadoutJson(state, charId, l);
    // console.log("Parsed loadout:", parsed);
    parsed.player.equipment = updateEquipmentWithHighestLevel(parsed.player.equipment, highestItemMap);
    store.loadouts[l.id] = { id: l.id, name: l.name, data: parsed };
    pageTriggerMap = mergeTriggerMaps(pageTriggerMap, parsed.triggerMap);
  }

  store.triggerMap = pageTriggerMap;
  // 神龛和技能书是角色级别的，存一份在角色上，面板预览直接读这里。
  store.guildShrine = parseCharacterGuildBuffDict(state.characterGuildBuffDict);
  const allAbilityLevels = parseAllAbilityLevels(state.characterAbilityMap);
  if (Object.keys(allAbilityLevels).length > 0) store.abilityLevels = allAbilityLevels;
  store.lastSavedAt = new Date().toISOString();
  all[charId] = store;
  await saveAllData(all);
  await GM_setValue(KEY_LAST_ACTIVE_CHAR, charId);
  return store;
}

function convertLoadoutToImportFormat(loadoutData, characterTriggerMap) {
  const mergedTriggers = mergeTriggerMaps(characterTriggerMap, loadoutData.triggerMap);
  const out = {
    ...loadoutData,
    triggerMap: mergedTriggers
  };
  if (!out.guildShrine || !out.abilityLevels) {
    const live = readCharacterExtrasFromPage() || {};
    if (!out.guildShrine && live.guildShrine) out.guildShrine = live.guildShrine;
    if (!out.abilityLevels && live.abilityLevels) out.abilityLevels = live.abilityLevels;
  }
  return out;
}

GM_addValueChangeListener(STORAGE_KEY, () => { mirrorStoreToPage(); });

GM_addValueChangeListener(IMPORT_REQUEST_KEY, (_, __, newVal) => {
  if (!newVal) return;
  try {
    const req = safeJSONParse(newVal, null);
    if (!req || !req.payload) return;
    if (req.targetTabId && req.targetTabId !== TAB_INSTANCE_ID) return;
    const payload = req.payload;
    const slot = req.slot || 1;
    const input = document.querySelector(`#inputSetGroupCombatplayer${slot}`);
    if (input) {
      input.value = payload;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      setTimeout(() => $("#buttonImportSet")?.click(), 150);
    } else {
      const all = $("#inputSetGroupCombatAll");
      if (all) {
        all.value = payload;
        all.dispatchEvent(new Event("input", { bubbles: true }));
        all.dispatchEvent(new Event("change", { bubbles: true }));
        setTimeout(() => $("#buttonImportSet")?.click(), 150);
      }
    }
    if (payload && slot >= 1 && slot <= 5) {
      const charData = safeJSONParse(payload, {});
      const charName = charData.characterName || `Player ${slot}`;
      const tabLink = $(`#player${slot}-tab`);
      if (tabLink) tabLink.innerText = charName;
    }
  } catch (e) { console.error("Import listener error:", e) }
});

async function importLoadoutToSimulator(data, slotNum, characterTriggerMap) {
  try {
    const importData = convertLoadoutToImportFormat(data, characterTriggerMap);
    const payload = JSON.stringify(importData || {});
    await GM_setValue(IMPORT_REQUEST_KEY, JSON.stringify({ slot: slotNum, payload, ts: nowTs(), targetTabId: TAB_INSTANCE_ID }));
    if (IS_SIM) {
      const input = document.querySelector(`#inputSetGroupCombatplayer${slotNum}`);
      if (input) {
        input.value = payload;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        setTimeout(() => $("#buttonImportSet")?.click(), 150);
      } else {
        const allInput = $("#inputSetGroupCombatAll");
        if (allInput) {
          allInput.value = payload;
          allInput.dispatchEvent(new Event("input", { bubbles: true }));
          allInput.dispatchEvent(new Event("change", { bubbles: true }));
          setTimeout(() => $("#buttonImportSet")?.click(), 150);
        }
      }
      if (data?.characterName && slotNum >= 1 && slotNum <= 5) {
        const tabLink = $(`#player${slotNum}-tab`);
        if (tabLink) tabLink.innerText = data.characterName;
      }
    } else {
      try {
        await navigator.clipboard.writeText(payload);
        showToast(t("copied"));
      } catch {
        showToast(t("copyFail"));
      }
    }
  } catch (e) {
    console.error("Import error:", e);
    showToast(t("importFail"));
  }
}

// 模拟器页：每个序号记住上次导入的是哪个角色的哪套配装，存在模拟器域名的
// localStorage 里（只有模拟器页用得到）。打开面板时按绑定把各序号一次性载入。
const SLOT_BINDINGS_KEY = "mwiPluginSlotBindings";

function loadSlotBindings() {
  try { return safeJSONParse(localStorage.getItem(SLOT_BINDINGS_KEY), {}) || {}; } catch { return {}; }
}

function setSlotBinding(slot, binding) {
  const bindings = loadSlotBindings();
  if (binding) bindings[slot] = binding;
  else delete bindings[slot];
  try { localStorage.setItem(SLOT_BINDINGS_KEY, JSON.stringify(bindings)); } catch { }
}

// 按 id 找；游戏里重建过的配装 id 会变，退回按同名找。
function resolveSlotBinding(all, binding) {
  const char = binding && all[binding.charId];
  if (!char?.loadouts) return null;
  const los = Object.values(char.loadouts);
  const lo = char.loadouts[binding.loadoutId] || los.find(l => l.name && l.name === binding.loadoutName);
  return lo ? { char, lo } : null;
}

function setInputValue(input, value) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

// 把所有能解析的绑定填进各自序号的导入框，然后只点一次导入：模拟器的组队导入会
// 一次读完 5 个框。没绑定（或绑定已失效）的序号把框清空，模拟器对空框什么都不做，
// 这样框里残留的旧内容不会被顺带导入。"全部玩家"框优先级更高，也得先清空。
// 返回载入的序号数。
async function loadBoundSlotsIntoSimulator() {
  if (!IS_SIM) return 0;
  const bindings = loadSlotBindings();
  const all = await loadAllData();
  let loaded = 0;
  for (let slot = 1; slot <= 5; slot++) {
    const hit = resolveSlotBinding(all, bindings[slot]);
    const input = document.querySelector(`#inputSetGroupCombatplayer${slot}`);
    if (!input) continue;
    if (!hit) { setInputValue(input, ""); continue; }
    const importData = convertLoadoutToImportFormat(hit.lo.data, hit.char.triggerMap || {});
    setInputValue(input, JSON.stringify(importData || {}));
    const tabLink = $(`#player${slot}-tab`);
    if (tabLink && hit.lo.data?.characterName) tabLink.innerText = hit.lo.data.characterName;
    loaded++;
  }
  if (!loaded) return 0;
  const allInput = $("#inputSetGroupCombatAll");
  if (allInput) setInputValue(allInput, "");
  // 导入按钮按导入弹窗里当前激活的页签分流，单人页签会去读单人框。
  const groupTab = $("#group-combat-tab");
  if (groupTab && !groupTab.classList.contains("active")) groupTab.click();
  setTimeout(() => $("#buttonImportSet")?.click(), 150);
  return loaded;
}

function waitForGameReady(timeoutMs = 8000, interval = 300) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = async () => {
      const st = readGameStateFromPage();
      if (st && st.character && (st.characterLoadoutDict || st.characterLoadoutDict === undefined)) { resolve(st); return; }
      if (Date.now() - start > timeoutMs) { resolve(null); return; }
      setTimeout(tick, interval);
    };
    tick();
  });
}

function constrainBtnToScreen(btn) {
  const btnRect = btn.getBoundingClientRect();
  const btnWidth = btnRect.width || 44;
  const btnHeight = btnRect.height || 33;
  const minOffset = 8;
  let newLeft = parseFloat(btn.style.left) || 0;
  let newTop = parseFloat(btn.style.top) || 0;
  newLeft = Math.max(minOffset, Math.min(newLeft, window.innerWidth - btnWidth - minOffset));
  newTop = Math.max(minOffset, Math.min(newTop, window.innerHeight - btnHeight - minOffset));
  btn.style.left = `${newLeft}px`;
  btn.style.top = `${newTop}px`;
}

function positionPanelNearButton(btn, panel) {
  if (IS_MILKY) {
    if (!panel.dataset.mwiPositioned) {
      const panelW = 360 * currentScale;
      const panelH = Math.min(560 * currentScale, window.innerHeight - 16);
      panel.style.left = `${Math.round((window.innerWidth - panelW) / 2)}px`;
      panel.style.top = `${Math.round((window.innerHeight - panelH) / 2)}px`;
      panel.dataset.mwiPositioned = "true";
    }
    return;
  }
  const btnRect = btn.getBoundingClientRect();
  panel.style.display = panel.style.display === "flex" ? "flex" : "none";
  const panelW = 360 * currentScale;
  const panelH = 360 * currentScale;
  const minOffset = 8;
  let left, top;
  const rightSpace = window.innerWidth - btnRect.right;
  const leftSpace = btnRect.left;

  if (panelPositionLock.horizontal === "right") {
    if (rightSpace >= panelW + minOffset) {
      left = btnRect.right + minOffset;
    } else {
      panelPositionLock.horizontal = "left";
      left = Math.max(minOffset, btnRect.left - panelW - minOffset);
    }
  } else {
    if (leftSpace >= panelW + minOffset) {
      left = Math.max(minOffset, btnRect.left - panelW - minOffset);
    } else {
      panelPositionLock.horizontal = "right";
      left = btnRect.right + minOffset;
    }
  }

  const btnCenterY = btnRect.top + btnRect.height / 2;
  const bottomSpace = window.innerHeight - btnRect.bottom;
  const topSpace = btnRect.top;

  if (panelPositionLock.vertical === "bottom") {
    if (bottomSpace >= panelH + minOffset) {
      top = btnRect.top;
    } else {
      panelPositionLock.vertical = "top";
      top = btnRect.bottom - panelH;
    }
  } else {
    if (topSpace >= panelH + minOffset) {
      top = btnRect.bottom - panelH;
    } else {
      panelPositionLock.vertical = "bottom";
      top = btnRect.top;
    }
  }

  left = Math.max(minOffset, Math.min(left, window.innerWidth - panelW - minOffset));
  top = Math.max(minOffset, Math.min(top, window.innerHeight - panelH - minOffset));
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
}

async function createFloatingUI() {
  if ($("#mwi-floating-btn")) return;
  const settings = await getSettings();
  window.__mwi_settings_cache = Object.assign({}, DEFAULT_SETTINGS, settings);
  const btn = document.createElement("div");
  btn.id = "mwi-floating-btn";
  btn.className = "mwi-ui";
  btn.dataset.mwiI18n = "floatingBtn";
  btn.dataset.mwiI18nTitle = "floatingBtnTitle";
  document.body.appendChild(btn);
  const panel = document.createElement("div");
  panel.id = "mwi-panel";
  panel.className = "mwi-ui";
  panel.innerHTML = `
    <div id="mwi-panel-drag-handle" style="display:flex;justify-content:space-between;align-items:center">
      <div style="display:flex;align-items:center;gap:8px">
        <h4 class="mwi-title" style="margin:0;" data-mwi-i18n="panelTitle"></h4>
        <div id="mwi-role-last-saved" class="mwi-section-label mwi-small-muted"></div>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <button id="mwi-panel-close" class="mwi-item-btn mwi-btn-text" data-mwi-i18n-title="closePanel">✕</button>
      </div>
    </div>
    <div id="mwi-select-label"><div class="mwi-section-label mwi-small-muted" data-mwi-i18n="slot"></div></div>
    <div class="mwi-row" id="mwi-slot-row"></div>
    <div id="mwi-slot-binding" class="mwi-small-muted">
      <span id="mwi-slot-binding-text"></span>
      <span id="mwi-slot-unbind" data-mwi-i18n="unbind"></span>
      <span id="mwi-slot-unbind-all" data-mwi-i18n="unbindAll"></span>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
      <div class="mwi-section-label mwi-small-muted" data-mwi-i18n="character"></div>
      <button id="mwi-refresh-btn" class="mwi-item-btn mwi-btn-text" style="min-width:70px;height:26px;padding:0 8px"></button>
    </div>
    <div class="mwi-row" id="mwi-char-row"></div>
    <div><div class="mwi-section-label mwi-small-muted" data-mwi-i18n="loadouts"></div></div>
    <div class="mwi-row" id="mwi-load-row"></div>
    <details id="mwi-char-detail">
      <summary id="mwi-char-detail-summary"></summary>
      <div id="mwi-char-detail-body"></div>
    </details>
  `;
  document.body.appendChild(panel);

  // 游戏页和模拟器页都用同一个可拖动的悬浮按钮作为入口。
  const settingsModal = buildSettingsModal();
  document.body.appendChild(settingsModal.modal);
  applyStaticTexts();
  const root = document.documentElement;
  const currentSite = IS_SIM ? "sim" : "game";
  const UI_POS_LAST_CURRENT = IS_SIM ? UI_POS_LAST_SIM : UI_POS_LAST_GAME;
  currentScale = IS_SIM ? window.__mwi_settings_cache.SIM_SCALE : window.__mwi_settings_cache.MWI_SCALE;

  function applyGameTheme(theme) {
    root.classList.remove("mwi-theme-dark", "mwi-theme-light");
    if (theme === "dark") root.classList.add("mwi-theme-dark");
    else if (theme === "light") root.classList.add("mwi-theme-light");
  }

  function applySimTheme(theme) {
    root.classList.remove("mwi-theme-dark", "mwi-theme-light");
    if (theme === "dark") root.classList.add("mwi-theme-dark");
    else if (theme === "light") root.classList.add("mwi-theme-light");
    else {
      const chk = $("#darkModeToggle");
      if (chk) root.classList.add(chk.checked ? "mwi-theme-dark" : "mwi-theme-light");
    }
  }

  function applyScalesAndTheme() {
    const s = window.__mwi_settings_cache;
    currentScale = IS_SIM ? s.SIM_SCALE : s.MWI_SCALE;
    if (IS_MILKY) {
      panel.style.transform = `scale(${currentScale})`;
      panel.style.transformOrigin = "top left";
      btn.style.transform = `scale(${currentScale})`;
      btn.style.transformOrigin = "top left";
      const modal = $("#mwi-settings-modal");
      if (modal) modal.style.transform = `scale(${currentScale})`;
      applyGameTheme(s.GAME_THEME);
    } else {
      root.classList.add("mwi-sim-scale");
      panel.style.transform = `scale(${currentScale})`;
      panel.style.transformOrigin = "top left";
      btn.style.transform = `scale(${currentScale})`;
      btn.style.transformOrigin = "top left";
      const modal = $("#mwi-settings-modal");
      if (modal) modal.style.transform = `scale(${currentScale})`;
      applySimTheme(s.SIM_THEME);
    }
    panel.style.fontSize = "14px";
    const modal = $("#mwi-settings-modal");
    if (modal) {
      modal.classList.toggle("dark", IS_SIM ? s.SIM_THEME === "dark" : s.GAME_THEME === "dark");
    }
    positionPanelNearButton(btn, panel);
  }

  applyScalesAndTheme();

  if (IS_SIM) {
    const chk = $("#darkModeToggle");
    if (chk) root.classList.remove("mwi-theme-dark", "mwi-theme-light"), root.classList.add(chk.checked ? "mwi-theme-dark" : "mwi-theme-light");
    const obs = new MutationObserver(() => {
      if (window.__mwi_settings_cache.SIM_THEME === "follow") {
        const c = $("#darkModeToggle");
        if (c) {
          root.classList.remove("mwi-theme-dark", "mwi-theme-light");
          root.classList.add(c.checked ? "mwi-theme-dark" : "mwi-theme-light");
        }
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  const uiKey = IS_SIM ? UI_POS_SIM : UI_POS_GAME;

  async function loadAndApplySavedBtnPos() {
    if (IS_MILKY) {
      const pos = safeJSONParse(await GM_getValue(UI_POS_PANEL_GAME, null), null);
      const panelW = 360 * currentScale;
      const panelH = Math.min(560 * currentScale, window.innerHeight - 16);
      const isOnScreen = pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)
        && pos.left >= 8 && pos.top >= 8
        && pos.left <= window.innerWidth - panelW - 8
        && pos.top <= window.innerHeight - panelH - 8;
      if (isOnScreen) {
        panel.style.left = `${pos.left}px`;
        panel.style.top = `${pos.top}px`;
      } else {
        panel.style.left = `${Math.round((window.innerWidth - panelW) / 2)}px`;
        panel.style.top = `${Math.round((window.innerHeight - panelH) / 2)}px`;
        await GM_setValue(UI_POS_PANEL_GAME, JSON.stringify({ left: parseFloat(panel.style.left), top: parseFloat(panel.style.top) }));
      }
      panel.dataset.mwiPositioned = "true";
      // 游戏页的面板位置独立保存，悬浮按钮的位置照常往下读。
    }
    const pos = safeJSONParse(await GM_getValue(uiKey, null), null);
    const last = safeJSONParse(await GM_getValue(UI_POS_LAST_CURRENT, null), null);
    if (last && last.ts && (!pos || last.ts >= (pos.ts || 0))) {
      btn.style.left = last.left;
      btn.style.top = last.top;
      await GM_setValue(uiKey, JSON.stringify(last));
    } else if (pos && pos.left && pos.top) {
      btn.style.left = pos.left;
      btn.style.top = pos.top;
    } else {
      btn.style.left = "12px";
      btn.style.top = "25%";
    }
    constrainBtnToScreen(btn);
    positionPanelNearButton(btn, panel);
  }

  await loadAndApplySavedBtnPos();

  if (IS_MILKY) {
    const dragHandle = $("#mwi-panel-drag-handle");
    let panelDragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;

    dragHandle.addEventListener("pointerdown", event => {
      if (event.button !== 0 || event.target.closest("button")) return;
      panelDragging = true;
      startX = event.clientX; startY = event.clientY;
      startLeft = parseFloat(panel.style.left) || 0;
      startTop = parseFloat(panel.style.top) || 0;
      dragHandle.setPointerCapture?.(event.pointerId);
      panel.style.transition = "none";
    });
    document.addEventListener("pointermove", event => {
      if (!panelDragging) return;
      panel.style.left = `${startLeft + event.clientX - startX}px`;
      panel.style.top = `${startTop + event.clientY - startY}px`;
    });
    document.addEventListener("pointerup", async event => {
      if (!panelDragging) return;
      panelDragging = false;
      dragHandle.releasePointerCapture?.(event.pointerId);
      panel.style.transition = "";
      const rect = panel.getBoundingClientRect();
      const isOnScreen = rect.left >= 8 && rect.top >= 8 && rect.right <= window.innerWidth - 8 && rect.bottom <= window.innerHeight - 8;
      if (!isOnScreen) {
        delete panel.dataset.mwiPositioned;
        positionPanelNearButton(btn, panel);
      }
      await GM_setValue(UI_POS_PANEL_GAME, JSON.stringify({ left: parseFloat(panel.style.left), top: parseFloat(panel.style.top) }));
    });
  }

  let dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0, moved = false;
  const DRAG_THRESHOLD = 6;

  btn.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    dragging = true; moved = false;
    startX = e.clientX; startY = e.clientY;
    startLeft = btn.offsetLeft; startTop = btn.offsetTop;
    btn.setPointerCapture && btn.setPointerCapture(e.pointerId);
    btn.style.transition = "none";
  });

  document.addEventListener("pointermove", e => {
    if (!dragging) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (!moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) moved = true;
    let newLeft = startLeft + dx;
    let newTop = startTop + dy;
    btn.style.left = `${newLeft}px`;
    btn.style.top = `${newTop}px`;
    constrainBtnToScreen(btn);
    positionPanelNearButton(btn, panel);
  });

  document.addEventListener("pointerup", async e => {
    if (!dragging) return;
    dragging = false;
    btn.style.transition = "all .18s ease";
    btn.releasePointerCapture && btn.releasePointerCapture(e.pointerId);
    constrainBtnToScreen(btn);
    const payload = { left: btn.style.left, top: btn.style.top, ts: nowTs() };
    await GM_setValue(uiKey, JSON.stringify(payload));
    await GM_setValue(UI_POS_LAST_CURRENT, JSON.stringify(payload));
  });

  GM_addValueChangeListener(UI_POS_LAST_CURRENT, async (_, __, newVal) => {
    try {
      const p = safeJSONParse(newVal, null);
      if (!p) return;
      btn.style.left = p.left;
      btn.style.top = p.top;
      constrainBtnToScreen(btn);
      await GM_setValue(uiKey, JSON.stringify(p));
      positionPanelNearButton(btn, panel);
    } catch { }
  });

  const slotRow = $("#mwi-slot-row"), selectLabel = $("#mwi-select-label"), charRow = $("#mwi-char-row"), loadRow = $("#mwi-load-row");
  const roleLastSavedEl = $("#mwi-role-last-saved"), refreshBtn = $("#mwi-refresh-btn"), panelCloseBtn = $("#mwi-panel-close");
  const charDetailSummary = $("#mwi-char-detail-summary");
  const charDetailBody = $("#mwi-char-detail-body");
  const slotBindingRow = $("#mwi-slot-binding"), slotBindingTextEl = $("#mwi-slot-binding-text"), slotUnbindBtn = $("#mwi-slot-unbind"), slotUnbindAllBtn = $("#mwi-slot-unbind-all");
  let selectedSlot = 1;
  let selectedCharacterId = null;

  slotUnbindBtn?.addEventListener("click", () => {
    setSlotBinding(selectedSlot, null);
    renderSlots();
  });

  slotUnbindAllBtn?.addEventListener("click", () => {
    try { localStorage.removeItem(SLOT_BINDINGS_KEY); } catch { }
    renderSlots();
    showToast(t("bindingsCleared"));
  });

  panelCloseBtn.addEventListener("click", async () => {
    panel.style.display = "none";
    if (IS_SIM) await GM_setValue(KEY_SIM_PANEL_OPEN, "closed");
  });

  // 各个 render 都是异步的，切语言、改设置时会被好几个监听器同时触发。每次调用拿一个
  // 序号，await 回来后只有最新的那次才动 DOM；清空也放在 await 之后，否则几次调用
  // 会各自往同一个容器里追加一遍。
  const renderSeq = {};
  function beginRender(name) {
    const id = (renderSeq[name] = (renderSeq[name] || 0) + 1);
    return () => renderSeq[name] === id;
  }

  function slotBindingText(all, slot, binding) {
    if (!binding) return t("slotNotBound", { slot });
    const hit = resolveSlotBinding(all, binding);
    if (!hit) return t("slotBindingMissing", { slot });
    return t("slotBoundTo", { slot, char: hit.char.characterMeta?.name || binding.charName || "#" + binding.charId, loadout: hit.lo.name || binding.loadoutName || "#" + hit.lo.id });
  }

  async function renderSlots() {
    if (!slotRow) return;
    const isCurrent = beginRender("slots");
    const bindings = IS_SIM ? loadSlotBindings() : {};
    const all = IS_SIM ? await loadAllData() : {};
    if (!isCurrent()) return;
    slotRow.innerHTML = "";
    for (let i = 1; i <= 5; i++) {
      const b = document.createElement("div");
      b.className = "mwi-slot-btn mwi-ui mwi-btn-text";
      b.innerText = String(i);
      if (i === selectedSlot) b.classList.add("selected");
      if (bindings[i]) {
        b.classList.add("mwi-bound");
        b.title = slotBindingText(all, i, bindings[i]);
      }
      b.onclick = async () => {
        selectedSlot = i;
        $$(".mwi-slot-btn").forEach(x => x.classList.remove("selected"));
        b.classList.add("selected");
        renderSlotBinding();
        // 序号有绑定就跳到绑定的角色，配装列表里会高亮绑定的那套。
        const binding = IS_SIM ? loadSlotBindings()[i] : null;
        const hit = binding && resolveSlotBinding(await loadAllData(), binding);
        if (hit && selectedSlot === i && selectedCharacterId !== String(binding.charId)) {
          selectedCharacterId = String(binding.charId);
          await renderCharacters();
        }
        renderLoadouts();
      };
      slotRow.appendChild(b);
    }
    renderSlotBinding();
  }

  async function renderSlotBinding() {
    if (!slotBindingRow) return;
    if (!IS_SIM) { slotBindingRow.style.display = "none"; return; }
    const isCurrent = beginRender("slotBinding");
    const bindings = loadSlotBindings();
    const binding = bindings[selectedSlot];
    const all = await loadAllData();
    if (!isCurrent()) return;
    slotBindingTextEl.innerText = slotBindingText(all, selectedSlot, binding);
    slotBindingTextEl.title = slotBindingTextEl.innerText;
    slotUnbindBtn.style.display = binding ? "" : "none";
    slotUnbindAllBtn.style.display = Object.keys(bindings).length ? "" : "none";
  }

  async function updateRoleLastSavedDisplay() {
    const all = await loadAllData();
    if (!selectedCharacterId || !all[selectedCharacterId]) {
      roleLastSavedEl.innerText = t("notSelected");
      return;
    }
    const ts = all[selectedCharacterId].lastSavedAt;
    roleLastSavedEl.innerText = ts ? t("lastSynced", { time: new Date(ts).toLocaleString() }) : t("notRead");
  }

  function detailGroup(title, rows, emptyText) {
    const group = document.createElement("div");
    group.className = "mwi-detail-group";
    const label = document.createElement("div");
    label.className = "mwi-section-label mwi-small-muted";
    label.innerText = title;
    group.appendChild(label);

    if (!rows.length) {
      const empty = document.createElement("div");
      empty.className = "mwi-small-muted";
      empty.innerText = emptyText;
      group.appendChild(empty);
      return group;
    }

    const grid = document.createElement("div");
    grid.className = "mwi-detail-grid";
    for (const [name, level, hint] of rows) {
      const nameEl = document.createElement("div");
      nameEl.innerText = name;
      if (hint) nameEl.title = hint;
      const levelEl = document.createElement("div");
      levelEl.className = "mwi-detail-lv";
      levelEl.innerText = "Lv " + level;
      grid.appendChild(nameEl);
      grid.appendChild(levelEl);
    }
    group.appendChild(grid);
    return group;
  }

  // 选中角色后的只读预览：神龛等级 + 已学的全部技能等级。默认折叠，
  // 展开状态不随重渲染变化，所以切角色时内容会就地更新。
  async function renderCharacterDetails() {
    const isCurrent = beginRender("charDetails");
    if (!selectedCharacterId) {
      charDetailBody.innerHTML = "";
      charDetailSummary.innerText = t("charDetail");
      charDetailBody.innerHTML = `<div class="mwi-section-label mwi-small-muted">${t("pickCharacter")}</div>`;
      return;
    }

    const all = await loadAllData();
    if (!isCurrent()) return;
    charDetailBody.innerHTML = "";
    const char = all[selectedCharacterId];
    if (!char) {
      charDetailSummary.innerText = t("charDetail");
      charDetailBody.innerHTML = `<div class="mwi-section-label mwi-small-muted">${t("noCharData")}</div>`;
      return;
    }

    const { guildShrine, abilityLevels } = characterExtras(char);

    const shrineKeys = COMBAT_SHRINES
      .concat(Object.keys(guildShrine || {}).filter(k => !COMBAT_SHRINES.includes(k)))
      .filter(k => guildShrine && k in guildShrine);
    const shrineRows = shrineKeys.map(k => [shrineLabel(k), Number(guildShrine[k]) || 0, "/shrines/" + k]);

    const abilityRows = Object.entries(abilityLevels || {})
      .map(([hrid, level]) => [prettyAbilityName(hrid), Number(level) || 0, hrid])
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

    charDetailSummary.innerText = t("charDetailCount", { shrines: shrineRows.length, abilities: abilityRows.length });
    charDetailBody.appendChild(detailGroup(t("shrines"), shrineRows, t("noShrineData")));
    charDetailBody.appendChild(detailGroup(t("abilityLevels"), abilityRows, t("noAbilityData")));
  }

  async function renderCharacters() {
    const isCurrent = beginRender("characters");
    const all = await loadAllData();
    if (!isCurrent()) return;
    mirrorStoreToPage();
    const ids = Reflect.ownKeys(all);
    if (ids.length === 0) {
      charRow.innerHTML = `<div class="mwi-section-label mwi-small-muted">${t("noCharacters")}</div>`;
      roleLastSavedEl.innerText = t("notSelected");
      renderCharacterDetails();
      return;
    }
    if (!selectedCharacterId || !all[selectedCharacterId]) {
      if (IS_MILKY) {
        const st = readGameStateFromPage();
        if (st && st.character) selectedCharacterId = String(st.character.id);
        else selectedCharacterId = ids[0];
      } else {
        const last = await GM_getValue(KEY_LAST_ACTIVE_CHAR, null);
        if (!isCurrent()) return;
        if (last && all[last]) selectedCharacterId = last;
        else selectedCharacterId = ids[0];
      }
    }
    charRow.innerHTML = "";
    for (const id of ids) {
      const meta = all[id].characterMeta || {};
      const name = meta.name || ("#" + id);
      const wrap = document.createElement("div");
      wrap.style.display = "flex"; wrap.style.alignItems = "center"; wrap.style.gap = "6px";
      const b = document.createElement("div");
      b.className = "mwi-item-btn mwi-ui mwi-btn-text";
      if (id === selectedCharacterId) b.classList.add("selected");
      b.innerHTML = `<div style="font-weight:600">${name}</div>`;
      b.onclick = () => {
        selectedCharacterId = id;
        $$(".mwi-item-btn").forEach(x => {
          if (x.parentElement?.querySelector(".mwi-delete-btn")) x.classList.remove("selected");
        });
        b.classList.add("selected");
        renderLoadouts();
        renderCharacterDetails();
        updateRoleLastSavedDisplay();
      };
      const del = document.createElement("div");
      del.className = "mwi-delete-btn mwi-btn-text";
      del.innerText = "✕";
      del.onclick = async e => {
        e.stopPropagation();
        if (confirm(t("confirmDelete", { name }))) {
          const all2 = await loadAllData();
          delete all2[id];
          await saveAllData(all2);
          if (id === selectedCharacterId) selectedCharacterId = null;
          renderCharacters();
          renderLoadouts();
          updateRoleLastSavedDisplay();
        }
      };
      wrap.appendChild(b); wrap.appendChild(del); charRow.appendChild(wrap);
    }
    renderCharacterDetails();
    updateRoleLastSavedDisplay();
  }

  async function renderLoadouts() {
    const isCurrent = beginRender("loadouts");
    if (!selectedCharacterId) {
      loadRow.innerHTML = `<div class="mwi-section-label mwi-small-muted">${t("pickCharacter")}</div>`;
      return;
    }
    const all = await loadAllData();
    const settings = await getSettings();
    if (!isCurrent()) return;
    loadRow.innerHTML = "";
    const char = all[selectedCharacterId];
    if (!char || !char.loadouts || Reflect.ownKeys(char.loadouts).length === 0) {
      loadRow.innerHTML = `<div class="mwi-section-label mwi-small-muted">${t("noLoadouts")}</div>`;
      return;
    }
    const characterTriggerMap = char.triggerMap || {};
    const slotBinding = IS_SIM ? loadSlotBindings()[selectedSlot] : null;
    const boundLoadout = slotBinding && String(slotBinding.charId) === String(selectedCharacterId)
      ? resolveSlotBinding(all, slotBinding)?.lo : null;
    const blockedWords = (settings.LOADOUT_BLOCK_WORDS || []).map(word => String(word).trim()).filter(Boolean);
    const visibleLoadouts = Object.values(char.loadouts).filter(lo =>
      !blockedWords.some(word => String(lo.name || "").includes(word))
    );
    if (visibleLoadouts.length === 0) {
      loadRow.innerHTML = `<div class="mwi-section-label mwi-small-muted">${t("allBlocked")}</div>`;
      return;
    }
    for (const lo of visibleLoadouts) {
      const b = document.createElement("div");
      b.className = "mwi-item-btn mwi-ui mwi-btn-text";
      b.innerText = lo.name || ("#" + lo.id);
      if (lo === boundLoadout) b.classList.add("selected");
      b.onclick = async () => {
        if (!selectedCharacterId || !selectedSlot) return;
        const charData = all[selectedCharacterId];
        const loadoutData = lo.data;
        if (IS_MILKY) {
          try {
            const mergedData = convertLoadoutToImportFormat(loadoutData, characterTriggerMap);
            const payload = JSON.stringify(mergedData || {});
            await navigator.clipboard.writeText(payload);
            showToast(t("copiedLoadout", { char: charData.characterMeta.name || t("unknownChar"), loadout: lo.name || t("unknownLoadout") }));
          } catch {
            showToast(t("copyFail"));
          }
        } else {
          await importLoadoutToSimulator(loadoutData, selectedSlot, characterTriggerMap);
          setSlotBinding(selectedSlot, { charId: selectedCharacterId, loadoutId: lo.id, charName: charData.characterMeta?.name || "", loadoutName: lo.name || "" });
          renderSlots();
          renderLoadouts();
          showToast(t("importedToSlot", { slot: selectedSlot }));
          return;
        }
        b.classList.add("selected");
        setTimeout(() => b.classList.remove("selected"), 700);
      };
      loadRow.appendChild(b);
    }
  }

  refreshBtn.dataset.mwiI18n = "refresh";
  refreshBtn.addEventListener("click", async () => {
    refreshBtn.innerText = t("refreshing");
    refreshBtn.disabled = true;
    try {
      const currentSelectedCharId = selectedCharacterId;
      await readAndSaveCurrentPageConfig();
      await renderCharacters();
      await renderLoadouts();
      if (currentSelectedCharId) {
        const all = await loadAllData();
        if (all[currentSelectedCharId]) {
          selectedCharacterId = currentSelectedCharId;
          $$(".mwi-item-btn").forEach(x => {
            if (x.parentElement?.querySelector(".mwi-delete-btn")) x.classList.remove("selected");
          });
          const charBtns = $$(".mwi-item-btn");
          charBtns.forEach(btn => {
            const charNameEl = btn.querySelector("div");
            if (!charNameEl) return;
            const charName = charNameEl.innerText;
            const targetChar = all[currentSelectedCharId]?.characterMeta?.name;
            if (charName === targetChar) btn.classList.add("selected");
          });
        }
      }
      $$(".mwi-slot-btn").forEach(x => x.classList.remove("selected"));
      $(`.mwi-slot-btn:nth-child(${selectedSlot})`).classList.add("selected");
      showToast(t("refreshOk"));
    } catch (e) {
      console.error("Refresh error:", e);
      showToast(t("refreshFail"));
    }
    refreshBtn.disabled = false;
    refreshBtn.innerText = t("refresh");
  });

  function refreshPanelUI() {
    renderSlots();
    renderCharacters();
    renderLoadouts();
  }

  if (IS_MILKY) {
    if (selectLabel) selectLabel.style.display = "none";
    if (slotRow) slotRow.style.display = "none";
  }

  if (IS_SIM) {
    if (refreshBtn) refreshBtn.style.display = "none";
    root.classList.add("mwi-sim-scale");
  }

  const firstOpen = await GM_getValue(KEY_FIRST_OPEN, null);
  const simPanelState = await GM_getValue(KEY_SIM_PANEL_OPEN, "closed");

  if (!firstOpen && IS_SIM) {
    panel.style.display = "flex";
    await GM_setValue(KEY_FIRST_OPEN, true);
  }
  else {
    if (IS_SIM) panel.style.display = simPanelState === "open" ? "flex" : "none";
    else panel.style.display = "none";
  }

  if (panel.style.display === "flex") {
    setTimeout(() => {
      renderCharacters();
      renderLoadouts();
      updateRoleLastSavedDisplay();
      positionPanelNearButton(btn, panel);
    }, 20);
  }

  setTimeout(() => {
    refreshPanelUI();
    positionPanelNearButton(btn, panel);
  }, 200);

  btn.addEventListener("click", async e => {
    if (moved) { moved = false; return; }
    if (panel.style.display === "flex") {
      panel.style.display = "none";
      if (IS_SIM) await GM_setValue(KEY_SIM_PANEL_OPEN, "closed");
    }
    else {
      panel.style.display = "flex";
      if (IS_MILKY) {
        const st = readGameStateFromPage();
        if (st && st.character) selectedCharacterId = String(st.character.id);
        // 每次打开都按游戏当前状态重新读一遍，面板里的配装不会是旧的。
        try { await readAndSaveCurrentPageConfig(); } catch (err) { console.error("Auto refresh error:", err); }
      }
      else {
        const last = await GM_getValue(KEY_LAST_ACTIVE_CHAR, null);
        if (last) {
          const all = await loadAllData();
          if (all[last]) selectedCharacterId = last;
        }
      }
      refreshPanelUI();
      positionPanelNearButton(btn, panel);
      if (IS_SIM) {
        await GM_setValue(KEY_SIM_PANEL_OPEN, "open");
        if (window.__mwi_settings_cache.SIM_AUTO_LOAD_BINDINGS) {
          const loaded = await loadBoundSlotsIntoSimulator();
          if (loaded) showToast(t("loadedBound", { n: loaded }));
        }
      }
    }
  });

  const settingsBtn = document.createElement("div");
  settingsBtn.id = "s_mwi_settings_btn";
  settingsBtn.className = "mwi-ui";
  settingsBtn.dataset.mwiI18nTitle = "settings";
  settingsBtn.innerText = "⚙️";
  panel.appendChild(settingsBtn);
  let settingsModalOpen = false;

  settingsBtn.addEventListener("click", async () => {
    const modal = $("#mwi-settings-modal");
    if (settingsModalOpen) {
      modal.style.display = "none";
      settingsModalOpen = false;
    } else {
      await syncSettingsToModal();
      modal.classList.toggle("dark", IS_SIM ? window.__mwi_settings_cache.SIM_THEME === "dark" : window.__mwi_settings_cache.GAME_THEME === "dark");
      modal.style.display = "block";
      settingsModalOpen = true;
    }
  });

  const closeBtn = document.createElement("div");
  closeBtn.id = "s_mwi_settings_close";
  closeBtn.innerText = "✕";
  closeBtn.style.position = "absolute";
  closeBtn.style.right = "8px";
  closeBtn.style.top = "8px";
  closeBtn.style.cursor = "pointer";
  closeBtn.style.fontSize = "14px";
  closeBtn.style.zIndex = "2147483651";
  closeBtn.addEventListener("click", () => {
    const modal = $("#mwi-settings-modal");
    modal.style.display = "none";
    settingsModalOpen = false;
  });
  settingsModal.modal.appendChild(closeBtn);

  GM_addValueChangeListener(KEY_SETTINGS, async (name, oldVal, newVal) => {
    try {
      const s = safeJSONParse(newVal, null);
      if (!s) return;
      window.__mwi_settings_cache = Object.assign({}, DEFAULT_SETTINGS, s);
      applyScalesAndTheme();
      applyLanguage();
      await syncSettingsToModal();
    } catch (e) { console.error("Settings sync error:", e) }
  });

  GM_addValueChangeListener(KEY_SETTINGS + "_ts", async () => {
    try {
      const fresh = await getSettings();
      window.__mwi_settings_cache = Object.assign({}, DEFAULT_SETTINGS, fresh);
      applyScalesAndTheme();
      applyLanguage();
      await syncSettingsToModal();
    } catch (e) { console.error("Settings ts sync error:", e) }
  });

  window.__mwi_panel = { refresh: refreshPanelUI, setSelectedSlot: (n) => { selectedSlot = n; refreshPanelUI(); } };
}

function buildSettingsModal() {
  const modal = document.createElement("div");
  modal.id = "mwi-settings-modal";
  modal.className = "mwi-ui";
  modal.innerHTML = `
    <h3 class="mwi-title" data-mwi-i18n="settingsTitle"></h3>
    <div id="mwi-settings-list"></div>
  `;
  const list = modal.querySelector("#mwi-settings-list");
  const settingsControls = {
    chkReadOnly: null,
    chkBlockTest: null,
    chkAutoRead: null,
    chkAutoLoadBindings: null,
    simScaleInput: null,
    simScaleLabel: null,
    mwiScaleInput: null,
    mwiScaleLabel: null,
    simThemeSelect: null,
    gameThemeSelect: null,
    blockWordsInput: null,
    languageSelect: null
  };

  (async () => {
    const s = await getSettings();
    window.__mwi_settings_cache = Object.assign({}, DEFAULT_SETTINGS, s);

    function row(labelKey, controlEl) {
      const r = document.createElement("div");
      r.className = "mwi-settings-row";
      const lab = document.createElement("label");
      lab.dataset.mwiI18n = labelKey;
      const wrap = document.createElement("div");
      wrap.className = "mwi-settings-controls";
      wrap.appendChild(controlEl);
      r.appendChild(lab);
      r.appendChild(wrap);
      return r;
    }

    const languageSelect = document.createElement("select");
    languageSelect.className = "mwi-btn-text";
    [["en", "English"], ["zh", "中文"]].forEach(([v, label]) => {
      const o = document.createElement("option");
      o.value = v;
      o.innerText = label;
      languageSelect.appendChild(o);
    });
    languageSelect.value = I18N[s.LANGUAGE] ? s.LANGUAGE : DEFAULT_SETTINGS.LANGUAGE;
    languageSelect.onchange = async () => {
      window.__mwi_settings_cache.LANGUAGE = languageSelect.value;
      applyLanguage();
      await saveSettings(window.__mwi_settings_cache);
    };
    settingsControls.languageSelect = languageSelect;
    list.appendChild(row("setLanguage", languageSelect));

    const chkReadOnly = document.createElement("input");
    chkReadOnly.type = "checkbox";
    chkReadOnly.checked = s.READ_ONLY_IRONCOW;
    chkReadOnly.onchange = async () => {
      window.__mwi_settings_cache.READ_ONLY_IRONCOW = chkReadOnly.checked;
      await saveSettings(window.__mwi_settings_cache);
    };
    settingsControls.chkReadOnly = chkReadOnly;
    list.appendChild(row("setReadOnlyIroncow", chkReadOnly));

    const chkBlockTest = document.createElement("input");
    chkBlockTest.type = "checkbox";
    chkBlockTest.checked = !!s.BLOCK_TEST_SERVERS;
    chkBlockTest.onchange = async () => {
      window.__mwi_settings_cache.BLOCK_TEST_SERVERS = chkBlockTest.checked;
      await saveSettings(window.__mwi_settings_cache);
    };
    settingsControls.chkBlockTest = chkBlockTest;
    list.appendChild(row("setBlockTest", chkBlockTest));

    const chkAutoRead = document.createElement("input");
    chkAutoRead.type = "checkbox";
    chkAutoRead.checked = !!s.ENABLE_AUTO_READ_ON_ENTER;
    chkAutoRead.onchange = async () => {
      window.__mwi_settings_cache.ENABLE_AUTO_READ_ON_ENTER = chkAutoRead.checked;
      await saveSettings(window.__mwi_settings_cache);
    };
    settingsControls.chkAutoRead = chkAutoRead;
    list.appendChild(row("setAutoRead", chkAutoRead));

    if (IS_SIM) {
      const chkAutoLoadBindings = document.createElement("input");
      chkAutoLoadBindings.type = "checkbox";
      chkAutoLoadBindings.checked = !!s.SIM_AUTO_LOAD_BINDINGS;
      chkAutoLoadBindings.onchange = async () => {
        window.__mwi_settings_cache.SIM_AUTO_LOAD_BINDINGS = chkAutoLoadBindings.checked;
        await saveSettings(window.__mwi_settings_cache);
      };
      settingsControls.chkAutoLoadBindings = chkAutoLoadBindings;
      list.appendChild(row("setAutoLoadBindings", chkAutoLoadBindings));
    }

    const blockWordsWrap = document.createElement("div");
    const blockWordsInput = document.createElement("textarea");
    blockWordsInput.id = "mwi-block-words";
    blockWordsInput.dataset.mwiI18nPlaceholder = "blockWordsPlaceholder";
    blockWordsInput.value = (s.LOADOUT_BLOCK_WORDS || []).join("\n");
    const saveBlockWords = document.createElement("button");
    saveBlockWords.type = "button";
    saveBlockWords.className = "mwi-item-btn mwi-btn-text";
    saveBlockWords.style.cssText = "min-width:70px;height:28px;margin-top:6px";
    saveBlockWords.dataset.mwiI18n = "saveBlockWords";
    saveBlockWords.onclick = async () => {
      const words = blockWordsInput.value.split(/\r?\n|,/).map(word => word.trim()).filter(Boolean);
      window.__mwi_settings_cache.LOADOUT_BLOCK_WORDS = [...new Set(words)];
      blockWordsInput.value = window.__mwi_settings_cache.LOADOUT_BLOCK_WORDS.join("\n");
      await saveSettings(window.__mwi_settings_cache);
      window.__mwi_panel?.refresh?.();
    };
    blockWordsWrap.append(blockWordsInput, saveBlockWords);
    settingsControls.blockWordsInput = blockWordsInput;
    list.appendChild(row("setBlockWords", blockWordsWrap));

    if (IS_SIM) {
      const simScaleInput = document.createElement("input");
      simScaleInput.type = "range";
      simScaleInput.min = "0.5";
      simScaleInput.max = "2";
      simScaleInput.step = "0.1";
      simScaleInput.value = s.SIM_SCALE || 1.0;
      const simScaleLabel = document.createElement("div");
      simScaleLabel.innerText = simScaleInput.value + "×";
      simScaleLabel.className = "mwi-btn-text";

      simScaleInput.oninput = async () => {
        const newScale = Number(simScaleInput.value);
        simScaleLabel.innerText = newScale + "×";

        window.__mwi_settings_cache.SIM_SCALE = newScale;
        document.querySelector("#mwi-panel")?.style.setProperty("transform", `scale(${newScale})`);
        document.querySelector("#mwi-floating-btn")?.style.setProperty("transform", `scale(${newScale})`);
        const modal = $("#mwi-settings-modal");
        modal?.style.setProperty("transform", `scale(${newScale})`);

        currentScale = newScale;
        const btn = document.querySelector("#mwi-floating-btn");
        const panel = document.querySelector("#mwi-panel");
        if (btn && panel) positionPanelNearButton(btn, panel);

        await saveSettings(window.__mwi_settings_cache);
        showToast(t("scaleSaved", { scale: newScale }));
      };

      settingsControls.simScaleInput = simScaleInput;
      settingsControls.simScaleLabel = simScaleLabel;
      const simWrap = document.createElement("div");
      simWrap.appendChild(simScaleInput);
      simWrap.appendChild(simScaleLabel);
      list.appendChild(row("setSimScale", simWrap));
    } else {
      const mwiScaleInput = document.createElement("input");
      mwiScaleInput.type = "range";
      mwiScaleInput.min = "0.5";
      mwiScaleInput.max = "2";
      mwiScaleInput.step = "0.1";
      mwiScaleInput.value = s.MWI_SCALE || 1.0;
      const mwiScaleLabel = document.createElement("div");
      mwiScaleLabel.innerText = mwiScaleInput.value + "×";
      mwiScaleLabel.className = "mwi-btn-text";

      mwiScaleInput.oninput = async () => {
        const newScale = Number(mwiScaleInput.value);
        mwiScaleLabel.innerText = newScale + "×";

        window.__mwi_settings_cache.MWI_SCALE = newScale;
        document.querySelector("#mwi-panel")?.style.setProperty("transform", `scale(${newScale})`);
        document.querySelector("#mwi-floating-btn")?.style.setProperty("transform", `scale(${newScale})`);
        const modal = $("#mwi-settings-modal");
        modal?.style.setProperty("transform", `scale(${newScale})`);

        currentScale = newScale;
        const btn = document.querySelector("#mwi-floating-btn");
        const panel = document.querySelector("#mwi-panel");
        if (btn && panel) positionPanelNearButton(btn, panel);

        await saveSettings(window.__mwi_settings_cache);
        showToast(t("scaleSaved", { scale: newScale }));
      };

      settingsControls.mwiScaleInput = mwiScaleInput;
      settingsControls.mwiScaleLabel = mwiScaleLabel;
      const mwiWrap = document.createElement("div");
      mwiWrap.appendChild(mwiScaleInput);
      mwiWrap.appendChild(mwiScaleLabel);
      list.appendChild(row("setMwiScale", mwiWrap));
    }

    if (IS_SIM) {
      const simThemeSelect = document.createElement("select");
      simThemeSelect.className = "mwi-btn-text";
      [["follow", "themeFollow"], ["dark", "themeDark"], ["light", "themeLight"]].forEach(([v, key]) => {
        const o = document.createElement("option");
        o.value = v;
        o.dataset.mwiI18n = key;
        simThemeSelect.appendChild(o);
      });
      simThemeSelect.value = s.SIM_THEME || "follow";
      simThemeSelect.onchange = async () => {
        window.__mwi_settings_cache.SIM_THEME = simThemeSelect.value;
        if (simThemeSelect.value === "dark") document.documentElement.classList.add("mwi-theme-dark"), document.documentElement.classList.remove("mwi-theme-light");
        else if (simThemeSelect.value === "light") document.documentElement.classList.add("mwi-theme-light"), document.documentElement.classList.remove("mwi-theme-dark");
        else {
          const chk = $("#darkModeToggle");
          if (chk) document.documentElement.classList.remove("mwi-theme-dark", "mwi-theme-light"), document.documentElement.classList.add(chk.checked ? "mwi-theme-dark" : "mwi-theme-light");
        }
        await saveSettings(window.__mwi_settings_cache);
      };
      settingsControls.simThemeSelect = simThemeSelect;
      list.appendChild(row("setSimTheme", simThemeSelect));
    } else {
      const gameThemeSelect = document.createElement("select");
      gameThemeSelect.className = "mwi-btn-text";
      [["dark", "themeDark"], ["light", "themeLight"]].forEach(([v, key]) => {
        const o = document.createElement("option");
        o.value = v;
        o.dataset.mwiI18n = key;
        gameThemeSelect.appendChild(o);
      });
      gameThemeSelect.value = s.GAME_THEME || "dark";
      gameThemeSelect.onchange = async () => {
        window.__mwi_settings_cache.GAME_THEME = gameThemeSelect.value;
        if (gameThemeSelect.value === "dark") document.documentElement.classList.add("mwi-theme-dark"), document.documentElement.classList.remove("mwi-theme-light");
        else document.documentElement.classList.add("mwi-theme-light"), document.documentElement.classList.remove("mwi-theme-dark");
        await saveSettings(window.__mwi_settings_cache);
      };
      settingsControls.gameThemeSelect = gameThemeSelect;
      list.appendChild(row("setGameTheme", gameThemeSelect));
    }
    applyStaticTexts(modal);
  })();

  window.syncSettingsToModal = async function () {
    try {
      const freshSettings = await getSettings();
      window.__mwi_settings_cache = Object.assign({}, DEFAULT_SETTINGS, freshSettings);

      if (settingsControls.chkReadOnly) settingsControls.chkReadOnly.checked = freshSettings.READ_ONLY_IRONCOW;
      if (settingsControls.chkBlockTest) settingsControls.chkBlockTest.checked = !!freshSettings.BLOCK_TEST_SERVERS;
      if (settingsControls.chkAutoRead) settingsControls.chkAutoRead.checked = !!freshSettings.ENABLE_AUTO_READ_ON_ENTER;
      if (settingsControls.chkAutoLoadBindings) settingsControls.chkAutoLoadBindings.checked = !!freshSettings.SIM_AUTO_LOAD_BINDINGS;

      if (IS_SIM && settingsControls.simScaleInput) {
        const savedScale = freshSettings.SIM_SCALE || 1.0;
        settingsControls.simScaleInput.value = savedScale;
        if (settingsControls.simScaleLabel) settingsControls.simScaleLabel.innerText = savedScale + "×";
        currentScale = savedScale;
      }

      if (IS_MILKY && settingsControls.mwiScaleInput) {
        const savedScale = freshSettings.MWI_SCALE || 1.0;
        settingsControls.mwiScaleInput.value = savedScale;
        if (settingsControls.mwiScaleLabel) settingsControls.mwiScaleLabel.innerText = savedScale + "×";
        currentScale = savedScale;
      }

      if (IS_SIM && settingsControls.simThemeSelect) settingsControls.simThemeSelect.value = freshSettings.SIM_THEME || "follow";
      if (IS_MILKY && settingsControls.gameThemeSelect) settingsControls.gameThemeSelect.value = freshSettings.GAME_THEME || "dark";
      if (settingsControls.languageSelect) settingsControls.languageSelect.value = I18N[freshSettings.LANGUAGE] ? freshSettings.LANGUAGE : DEFAULT_SETTINGS.LANGUAGE;
      if (settingsControls.blockWordsInput) settingsControls.blockWordsInput.value = (freshSettings.LOADOUT_BLOCK_WORDS || []).join("\n");

      const btn = document.querySelector("#mwi-floating-btn");
      const panel = document.querySelector("#mwi-panel");
      if (btn && panel) positionPanelNearButton(btn, panel);
    } catch (e) { console.error("Sync settings to modal error:", e) }
  };

  return { modal };
}

async function main() {
  try {
    // 先镜像再建面板：模拟器上的页面（比如 optimization.html）一加载就会读这个键，
    // 等面板首次渲染（约 800ms 后）再写就太晚了。
    await mirrorStoreToPage();
    const s = await getSettings();
    window.__mwi_settings_cache = Object.assign({}, DEFAULT_SETTINGS, s);
    await createFloatingUI();

    currentScale = IS_SIM ? s.SIM_SCALE : s.MWI_SCALE;

    if (IS_MILKY && window.__mwi_settings_cache.ENABLE_AUTO_READ_ON_ENTER) {
      const flag = await GM_getValue("mwi_auto_read_once", null);
      if (!flag) {
        await GM_setValue("mwi_auto_read_once", true);
        const st = await waitForGameReady(9000, 300);
        if (st) {
          await readAndSaveCurrentPageConfig();
          window.__mwi_panel?.refresh?.();
        }
      }
    }

    if (IS_SIM) {
      const panel = document.querySelector("#mwi-panel");
      if (panel) panel.style.transform = `scale(${currentScale})`;
      const modal = $("#mwi-settings-modal");
      if (modal) modal.style.transform = `scale(${currentScale})`;
      if (window.__mwi_settings_cache.SIM_THEME === "follow") {
        const chk = $("#darkModeToggle");
        if (chk) {
          document.documentElement.classList.remove("mwi-theme-dark", "mwi-theme-light");
          document.documentElement.classList.add(chk.checked ? "mwi-theme-dark" : "mwi-theme-light");
        }
      } else if (window.__mwi_settings_cache.SIM_THEME === "dark") {
        document.documentElement.classList.remove("mwi-theme-light");
        document.documentElement.classList.add("mwi-theme-dark");
      } else {
        document.documentElement.classList.remove("mwi-theme-dark");
        document.documentElement.classList.add("mwi-theme-light");
      }
    } else {
      const panel = document.querySelector("#mwi-panel");
      if (panel) panel.style.transform = `scale(${currentScale})`;
      const modal = $("#mwi-settings-modal");
      if (modal) modal.style.transform = `scale(${currentScale})`;
      if (window.__mwi_settings_cache.GAME_THEME === "dark") {
        document.documentElement.classList.remove("mwi-theme-light");
        document.documentElement.classList.add("mwi-theme-dark");
      } else {
        document.documentElement.classList.remove("mwi-theme-dark");
        document.documentElement.classList.add("mwi-theme-light");
      }
    }

    GM_addValueChangeListener(KEY_SETTINGS + "_ts", async () => {
      try {
        const fresh = await getSettings();
        window.__mwi_settings_cache = Object.assign({}, DEFAULT_SETTINGS, fresh);
        currentScale = IS_SIM ? fresh.SIM_SCALE : fresh.MWI_SCALE;

        const modal = $("#mwi-settings-modal");
        if (modal) {
          modal.classList.toggle("dark", IS_SIM ? window.__mwi_settings_cache.SIM_THEME === "dark" : window.__mwi_settings_cache.GAME_THEME === "dark");
          modal.style.transform = `scale(${currentScale})`;
        }

        const panel = $("#mwi-panel"), btn = $("#mwi-floating-btn");
        if (panel && btn) {
          if (IS_MILKY) {
            panel.style.transform = `scale(${currentScale})`;
            btn.style.transform = `scale(${currentScale})`;
            if (window.__mwi_settings_cache.GAME_THEME === "dark") {
              document.documentElement.classList.remove("mwi-theme-light");
              document.documentElement.classList.add("mwi-theme-dark");
            } else {
              document.documentElement.classList.remove("mwi-theme-dark");
              document.documentElement.classList.add("mwi-theme-light");
            }
          } else {
            panel.style.transform = `scale(${currentScale})`;
            btn.style.transform = `scale(${currentScale})`;
            if (window.__mwi_settings_cache.SIM_THEME === "dark") {
              document.documentElement.classList.remove("mwi-theme-light");
              document.documentElement.classList.add("mwi-theme-dark");
            } else if (window.__mwi_settings_cache.SIM_THEME === "light") {
              document.documentElement.classList.remove("mwi-theme-dark");
              document.documentElement.classList.add("mwi-theme-light");
            } else {
              const chk = $("#darkModeToggle");
              if (chk) {
                document.documentElement.classList.remove("mwi-theme-dark", "mwi-theme-light");
                document.documentElement.classList.add(chk.checked ? "mwi-theme-dark" : "mwi-theme-light");
              }
            }
          }
        }

        const btnEl = document.querySelector("#mwi-floating-btn");
        const panelEl = document.querySelector("#mwi-panel");
        if (btnEl && panelEl) positionPanelNearButton(btnEl, panelEl);
      } catch (e) { console.error("Settings ts sync main error:", e) }
    });

    try {
      if (IS_MILKY) {
        const st = await waitForGameReady(9000, 300);
        if (st) {
          await readAndSaveCurrentPageConfig();
          window.__mwi_panel?.refresh?.();
        }
      } else {
        const st = readGameStateFromPage();
        if (st && st.character) {
          await readAndSaveCurrentPageConfig();
          window.__mwi_panel?.refresh?.();
        }
      }
    } catch (e) { console.error("Initial load error:", e) }

    setTimeout(() => {
      window.__mwi_panel?.refresh?.();
      const btn = document.querySelector("#mwi-floating-btn");
      const panel = document.querySelector("#mwi-panel");
      if (btn && panel) positionPanelNearButton(btn, panel);
    }, 800);
  } catch (e) { console.error("Main init error:", e) }
}

main();