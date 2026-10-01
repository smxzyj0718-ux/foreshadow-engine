/**
 * 伏笔引擎 · SillyTavern 集成层
 *
 * 职责：把 core.js（纯逻辑）接到酒馆的运行时上
 *   · 读对话 / 世界书
 *   · 调独立 API 做规划（mock / 自定义端点 / 连接配置档 三种）
 *   · 分层注入（setExtensionPrompt，含实体名的层 scan=true）
 *   · 持久化 + 切档重推导
 *   · 落拍感应（叙事模型回报 → 接地校验 → 只高亮不自动推进）
 *
 * 设计依据：设计书 4.7.1 / 5.2.1 / 5.4.1 / 6 / 附录 C / 附录 D-8
 * 挂载点：window.FSPIntegration
 */
(function () {
    'use strict';

    var C = window.FSPCore;
    if (!C) {
        console.error('[伏笔引擎] core.js 未加载，集成层中止');
        return;
    }

    var MODULE_NAME = 'foreshadowEngine';
    var WI_PREFIX = '[FSP]';            // 镜像条目的 comment 前缀，供 Collector 过滤（设计书 4.7.1）

    /**
     * 落拍报告的正则。
     * ⚠️ 必须【每次现造】：带 g 标志的正则对象会在 exec 之间保留 lastIndex，
     * 一旦同一个对象被复用于 replace/exec 混合场景，lastIndex 会被外部改写，
     * 遇到零长匹配时 lastIndex 不前进 → 死循环（这条踩过一次，记在这）。
     */
    function makePulseRe() {
        return /<!--\s*FSP\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([\s\S]*?)-->/g;
    }

    // ─────────────────────────────────────────────────────────
    // 默认配置
    // ─────────────────────────────────────────────────────────

    var DEFAULT_SETTINGS = Object.freeze({
        enabled: false,
        scope: 'per_chat',                 // per_chat | per_character | per_world

        // 规划器
        plannerMode: 'mock',               // mock | direct | direct_via_backend | profile
        direct: {
            url: 'https://api.openai.com/v1',
            apiKey: '',
            model: 'gpt-4o-mini',
            temperature: 0.2,
            maxTokens: 4000,
            timeoutMs: 90000,
            jsonSchema: true
        },
        profileId: '',
        maxPatches: 12,

        // 注入
        injectIndex: true,
        indexDepth: 0,
        injectSchedule: true,
        scheduleDepth: 4,
        injectContract: true,
        contractDepth: 4,
        injectPulse: true,
        maxSchedule: 3,
        minGap: 20,

        // 合并
        mergeStrategy: 'balanced',         // auto | balanced | strict
        shiftThreshold: 80,
        duplicateThreshold: 0.75,
        minEvidenceLength: 8,

        // 采集
        recentFloors: 20,
        worldInfoLimit: 15,
        dormantWorldInfoLimit: 8,

        // 世界书镜像（默认关，有硬约束见 5.4.1）
        mirrorToWorldbook: false,

        // 界面
        showFloatingButton: true,
        buttonPos: { right: 18, bottom: 120 },
        debug: false
    });

    // ─────────────────────────────────────────────────────────
    // 状态（内存，不持久化）
    // ─────────────────────────────────────────────────────────

    var ctx = null;
    var settings = null;
    var ledger = null;                      // 当前作用域的台账
    var lastResult = null;                  // 上一次合并结果
    var undoSnapshot = null;                // 撤销用快照
    var staging = null;                     // 待用户裁决的 patches
    var worldInfoLog = [];                  // WORLD_INFO_ACTIVATED 的环形缓冲
    var planning = false;
    var lastInjections = { index: '', schedule: '', contract: '', pulse: '' };

    // ─────────────────────────────────────────────────────────
    // 基础
    // ─────────────────────────────────────────────────────────

    function getCtx() {
        if (ctx) return ctx;
        try {
            if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) ctx = SillyTavern.getContext();
        } catch (e) { /* 还没就绪 */ }
        return ctx;
    }

    function log() {
        if (!settings || !settings.debug) return;
        var args = ['[伏笔引擎]'].concat(Array.prototype.slice.call(arguments));
        console.log.apply(console, args);
    }

    function warn() {
        var args = ['[伏笔引擎]'].concat(Array.prototype.slice.call(arguments));
        console.warn.apply(console, args);
    }

    function toast(msg, type) {
        try {
            if (typeof toastr !== 'undefined') {
                var fn = toastr[type] || toastr.info;
                fn.call(toastr, msg, '伏笔引擎');
                return;
            }
        } catch (e) { /* ignore */ }
        log('toast:', type, msg);
    }

    function getExtensionSettings() {
        var c = getCtx();
        if (c && c.extensionSettings) return c.extensionSettings;
        return null;
    }

    function loadSettings() {
        var store = getExtensionSettings();
        if (!store) { settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)); return settings; }
        if (!store[MODULE_NAME]) store[MODULE_NAME] = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
        var s = store[MODULE_NAME];
        // 补默认键（版本升级）
        for (var k in DEFAULT_SETTINGS) {
            if (!Object.prototype.hasOwnProperty.call(s, k)) {
                s[k] = JSON.parse(JSON.stringify(DEFAULT_SETTINGS[k]));
            }
        }
        if (!s.direct) s.direct = JSON.parse(JSON.stringify(DEFAULT_SETTINGS.direct));
        for (var dk in DEFAULT_SETTINGS.direct) {
            if (!Object.prototype.hasOwnProperty.call(s.direct, dk)) s.direct[dk] = DEFAULT_SETTINGS.direct[dk];
        }
        if (!s.buttonPos) s.buttonPos = { right: 18, bottom: 120 };
        settings = s;
        return settings;
    }

    function saveSettings() {
        var c = getCtx();
        try {
            if (c && typeof c.saveSettingsDebounced === 'function') c.saveSettingsDebounced();
        } catch (e) { warn('保存设置失败', e); }
    }

    // ─────────────────────────────────────────────────────────
    // 台账作用域与持久化
    // ─────────────────────────────────────────────────────────

    function currentChatKey() {
        var c = getCtx();
        if (!c) return 'default';
        var chatId = c.chatId || c.getCurrentChatId && c.getCurrentChatId() || 'nochat';
        if (settings.scope === 'per_chat') return 'chat::' + chatId;

        var charName = c.name2 || 'nochar';
        if (settings.scope === 'per_character') return 'char::' + charName;

        // per_world：用当前角色绑定的主世界书
        var wi = primaryWorldName();
        return 'world::' + (wi || charName);
    }

    function ledgerStore() {
        var store = getExtensionSettings();
        if (!store) return null;
        if (!store[MODULE_NAME]) store[MODULE_NAME] = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
        var s = store[MODULE_NAME];
        if (!s.ledgers || typeof s.ledgers !== 'object') s.ledgers = {};
        return s.ledgers;
    }

    function loadLedger() {
        var key = currentChatKey();
        var ledgers = ledgerStore();
        if (!ledgers) { ledger = C.createLedger(key); return ledger; }

        if (!ledgers[key] || typeof ledgers[key] !== 'object' || !Array.isArray(ledgers[key].active)) {
            ledgers[key] = C.createLedger(key);
        } else if (!Array.isArray(ledgers[key].archive) || !Array.isArray(ledgers[key].planningRuns) || !ledgers[key].counters) {
            // 结构修复
            var base = C.createLedger(key);
            ledgers[key] = Object.assign(base, ledgers[key]);
        }
        ledger = ledgers[key];
        log('载入台账', key, '活跃', ledger.active.length, '归档', ledger.archive.length);
        return ledger;
    }

    function persistLedger() {
        var c = getCtx();
        try {
            if (c && typeof c.saveSettingsDebounced === 'function') c.saveSettingsDebounced();
        } catch (e) { warn('持久化台账失败', e); }
    }

    function primaryWorldName() {
        var c = getCtx();
        try {
            var chars = c.characters || [];
            var ch = chars[c.characterId];
            if (ch && ch.data && ch.data.extensions && ch.data.extensions.world) return ch.data.extensions.world;
        } catch (e) { /* ignore */ }
        return null;
    }

    function associatedWorldNames() {
        var c = getCtx();
        var out = [];
        try {
            var chars = c.characters || [];
            var ch = chars[c.characterId];
            if (ch && ch.data && ch.data.extensions && ch.data.extensions.world) out.push(ch.data.extensions.world);
        } catch (e) { /* ignore */ }

        // charLore 附加书
        try {
            var mod = getWorldInfoModuleCached();
            var charLore = mod && mod.world_info && mod.world_info.charLore;
            if (Array.isArray(charLore)) {
                for (var i = 0; i < charLore.length; i++) {
                    var rec = charLore[i];
                    if (rec && Array.isArray(rec.extraBooks)) {
                        for (var j = 0; j < rec.extraBooks.length; j++) {
                            if (rec.extraBooks[j] && out.indexOf(rec.extraBooks[j]) === -1) out.push(rec.extraBooks[j]);
                        }
                    }
                }
            }
        } catch (e) { /* ignore */ }

        // 自定义「剧情指导」书
        var charName = c && c.name2;
        if (charName) out.push(charName + '-剧情指导');
        return out;
    }

    // ─────────────────────────────────────────────────────────
    // 楼层与对话采集
    // ─────────────────────────────────────────────────────────

    function currentFloor() {
        var c = getCtx();
        if (!c || !Array.isArray(c.chat)) return 0;
        return c.chat.length;
    }

    function lastAssistantText() {
        var c = getCtx();
        if (!c || !Array.isArray(c.chat)) return '';
        for (var i = c.chat.length - 1; i >= 0; i--) {
            var m = c.chat[i];
            if (m && !m.is_user && !m.is_system) return String(m.mes || '');
        }
        return '';
    }

    function replyTextMap(fromFloor, toFloor) {
        var c = getCtx();
        var map = {};
        if (!c || !Array.isArray(c.chat)) return map;
        for (var i = Math.max(0, fromFloor - 1); i < Math.min(c.chat.length, toFloor); i++) {
            var m = c.chat[i];
            if (m && !m.is_user) map[i + 1] = String(m.mes || '');
        }
        return map;
    }

    function collectRecentChat(fromFloor, toFloor) {
        var c = getCtx();
        if (!c || !Array.isArray(c.chat)) return '';
        var lines = [];
        for (var i = Math.max(0, fromFloor - 1); i < Math.min(c.chat.length, toFloor); i++) {
            var m = c.chat[i];
            if (!m) continue;
            var who = m.is_user ? (c.name1 || 'User') : (m.is_system ? 'System' : (m.name || c.name2 || 'Char'));
            var text = String(m.mes || '');
            if (text.length > 2000) text = text.slice(0, 2000) + '…';
            lines.push('[' + (i + 1) + '] ' + who + '：' + text);
        }
        return lines.join('\n');
    }

    // ─────────────────────────────────────────────────────────
    // 世界书读取（含 4.7.1 的自我污染过滤）
    // ─────────────────────────────────────────────────────────

    var wiModule = null;
    var wiModuleChecked = false;

    function getWorldInfoModuleCached() {
        if (wiModuleChecked) return wiModule;
        wiModuleChecked = true;
        try {
            var c = getCtx();
            if (c && typeof c.loadWorldInfo === 'function') {
                wiModule = { loadWorldInfo: c.loadWorldInfo, world_info: null, getSortedEntries: c.getSortedEntries || null };
            }
        } catch (e) { wiModule = null; }
        return wiModule;
    }

    /** 把已激活的条目记进环形缓冲，供「从未被触发过」统计用 */
    function rememberActivated(payload) {
        try {
            var list = Array.isArray(payload) ? payload : (payload && payload.entries) || [];
            for (var i = 0; i < list.length; i++) {
                var e = list[i];
                if (!e) continue;
                var uid = (e.world || '') + '::' + (e.uid !== undefined ? e.uid : e.comment || '');
                if (worldInfoLog.indexOf(uid) === -1) worldInfoLog.push(uid);
            }
            if (worldInfoLog.length > 5000) worldInfoLog = worldInfoLog.slice(-3000);
        } catch (e) { /* ignore */ }
    }

    /**
     * 采集世界书条目。
     * 🔴 关键：过滤掉本插件自己写入的镜像条目（comment 以 [FSP] 开头），
     *    否则规划器会读到它自己上一轮的输出，形成自我强化循环。见设计书 4.7.1。
     */
    function collectWorldInfoEntries(limit) {
        var out = [];
        try {
            var c = getCtx();
            var names = associatedWorldNames();

            // 优先用 getSortedEntries（扁平数组，自带 world 字段）
            var sorted = null;
            try { if (c && typeof c.getSortedEntries === 'function') sorted = c.getSortedEntries(); } catch (e) { sorted = null; }

            if (Array.isArray(sorted)) {
                for (var i = 0; i < sorted.length; i++) {
                    var e = sorted[i];
                    if (!e || !e.world || e.disable || !e.content) continue;
                    if (isOwnEntry(e)) continue;
                    out.push(e);
                }
            } else {
                // 退路：逐个书 loadWorldInfo
                for (var n = 0; n < names.length; n++) {
                    var data = null;
                    try { data = c && c.loadWorldInfo ? c.loadWorldInfo(names[n]) : null; } catch (e2) { data = null; }
                    if (!data || !data.entries) continue;
                    for (var uid in data.entries) {
                        if (!Object.prototype.hasOwnProperty.call(data.entries, uid)) continue;
                        var ent = data.entries[uid];
                        if (!ent || ent.disable || !ent.content) continue;
                        if (isOwnEntry(ent)) continue;
                        ent.world = names[n];
                        out.push(ent);
                    }
                }
            }
        } catch (e) { warn('采集世界书失败', e); }

        return out.slice(0, limit || 15);
    }

    /** 是否为本插件写入的条目（自我污染过滤） */
    function isOwnEntry(entry) {
        var comment = String((entry && entry.comment) || '');
        return comment.indexOf(WI_PREFIX) === 0;
    }

    /** 「可埋性」排序（设计书 4.7） */
    var MYSTERY_WORDS = ['失踪', '消失', '据说', '传闻', '不知为何', '从未有人', '封印', '禁忌', '没人知道', '秘密', '隐瞒', '真正的', '其实'];

    function scoreEntry(e) {
        var score = 0;
        var content = String(e.content || '');
        for (var i = 0; i < MYSTERY_WORDS.length; i++) {
            if (content.indexOf(MYSTERY_WORDS[i]) !== -1) { score += 3; break; }
        }
        if (/[？?]/.test(content)) score += 1;
        var keys = [].concat(e.key || [], e.keysecondary || []);
        var uid = (e.world || '') + '::' + (e.uid !== undefined ? e.uid : e.comment || '');
        if (worldInfoLog.indexOf(uid) === -1) score += 2;   // 从未被触发过 = 天然的伏笔候选
        if (e.constant) score += 1;                          // 常量规则类，适合规则型伏笔
        if (typeof e.order === 'number') score += Math.min(2, e.order / 100);
        return score;
    }

    function renderWorldInfoForPlanner(limit) {
        var entries = collectWorldInfoEntries(200);
        entries.sort(function (a, b) { return scoreEntry(b) - scoreEntry(a); });
        var top = entries.slice(0, limit || 15);

        if (!top.length) return { text: '（未找到关联世界书条目）', dormant: [] };

        var lines = [];
        for (var i = 0; i < top.length; i++) {
            var e = top[i];
            var keys = [].concat(e.key || []).join('/');
            lines.push('【' + (e.comment || e.world || '条目') + '】' + (keys ? '（键：' + keys + '）' : ''));
            var content = String(e.content || '');
            if (content.length > 700) content = content.slice(0, 700) + '…';
            lines.push(content);
            lines.push('');
        }

        // 沉睡素材：从未被触发的
        var dormant = [];
        for (var j = 0; j < entries.length && dormant.length < 8; j++) {
            var en = entries[j];
            var uid = (en.world || '') + '::' + (en.uid !== undefined ? en.uid : en.comment || '');
            if (worldInfoLog.indexOf(uid) === -1) dormant.push(en.comment || en.world || ('条目' + j));
        }

        return { text: lines.join('\n'), dormant: dormant };
    }

    // ─────────────────────────────────────────────────────────
    // 规划器调用
    // ─────────────────────────────────────────────────────────

    var OUTPUT_SCHEMA = {
        type: 'object',
        additionalProperties: false,
        required: ['runMeta', 'patches'],
        properties: {
            runMeta: {
                type: 'object',
                additionalProperties: false,
                required: ['fromFloor', 'toFloor'],
                properties: {
                    fromFloor: { type: 'integer' },
                    toFloor: { type: 'integer' },
                    summary: { type: 'string', maxLength: 200 }
                }
            },
            patches: {
                type: 'array',
                maxItems: 12,
                items: {
                    type: 'object',
                    required: ['op'],
                    properties: {
                        op: { enum: ['create', 'update', 'state', 'hint_used', 'reinforce', 'abandon', 'request_detail'] },
                        id: { type: 'string' },
                        tempId: { type: 'string' },
                        reason: { type: 'string' },
                        floor: { type: 'integer' },
                        evidence: { type: 'string' },
                        hintId: { type: 'string' },
                        to: { enum: ['planted', 'reinforced', 'resolved', 'abandoned', 'contradicted'] },
                        requestIds: { type: 'array', items: { type: 'string' } },
                        fields: { type: 'object', additionalProperties: true },
                        entry: { type: 'object', additionalProperties: true }
                    }
                }
            },
            questions: { type: 'array', maxItems: 5, items: { type: 'object', additionalProperties: true } }
        }
    };

    var SYSTEM_PROMPT = [
        '你是一名叙事结构设计师，服务于长篇角色扮演游戏。你的唯一职责是管理「伏笔」：',
        '规划何时埋设、何时强化、何时回收，并保证长线逻辑自洽。',
        '',
        '## 你的工作原则',
        '1. 增量优先：你接收到的是一份【既有台账】。在它之上做最小必要修改，',
        '   绝不推翻已有规划，绝不改写已发生的事实（已埋设楼层、已强化记录）。',
        '2. 证据优先：任何「状态推进」（planned→planted、reinforced→resolved）都必须在',
        '   【近期对话】中找到明确证据。证据必须是【正文里的逐字原句】（8 字以上），',
        '   不得转述、不得概括、不得引用你自己上一轮的判断。程序会做子串校验。',
        '3. 自然优先：伏笔靠场景与细节承载，不靠角色突然说破。',
        '   每条 hint 必须能在日常场景里自然发生，不能是「主角突然想起了什么」。',
        '4. 克制：宁可少提一条，也不要为了推进而硬塞。同一轮最多推进 3 条线。',
        '5. 【指令写作铁律】凡是要注入给叙事模型执行的文本（recovery.goal / hints[].text），',
        '   必须是【单句、结果式】，禁止写台词，禁止写分步脚本（禁止「先…然后…」）。',
        '   写不成一句话，说明方案还没想清楚。',
        '6. 只输出 JSON：不要解释、不要 markdown 代码块、不要注释。',
        '',
        '## 你可以做的操作（patches）',
        '- create        新建伏笔（不要自己编 id，可给 tempId）',
        '- update        修改既有伏笔字段（必须引用真实存在的 id）',
        '- state         推进状态（必须带 evidence 与 floor）',
        '- hint_used     标记某条 hint 已使用（必须带 hintId、evidence、floor）',
        '- reinforce     记录一次强化（带 floor、reinforceType）',
        '- abandon       放弃某条线（必须给 reason）',
        '- request_detail 申请查看某些条目的完整细节',
        '',
        '## 状态机（不可违反）',
        'planned → planted → reinforced(可自环) → resolved → 归档',
        '任意状态可 → abandoned / contradicted',
        '终态（resolved/abandoned/contradicted）不可复活。',
        '',
        '## 硬性约束',
        '- 已存在的 id 不可修改、不可删除、不可重复创建。',
        '- locked=true 的条目不得改动任何字段，只能追加新 hint。',
        '- 已归档的伏笔不得重新创建（会造成同一秘密揭晓两次）。',
        '- 同一轮提出的新伏笔不超过 3 条，状态推进不超过 3 条。',
        '- 状态推进只是【提议】，最终由用户确认。',
        '- 如果本轮没有任何值得做的改动，返回空 patches 数组。这是完全可接受的答案。',
        '',
        '## 输出格式',
        '{"runMeta":{"fromFloor":N,"toFloor":N,"summary":"..."},"patches":[...]}',
        'patches 里的每条形如：',
        '{"op":"state","id":"fs_0001","to":"planted","floor":24,"evidence":"正文逐字原句"}',
        '{"op":"create","tempId":"n1","entry":{"title":"...","kind":"identity","importance":0.8,',
        ' "keywords":["..."],"hints":[{"text":"单句结果式细节","condition":"何时"}],',
        ' "plant":{"status":"not_yet","targetFloor":30},',
        ' "recovery":{"goal":"单句结果式目标","plan":"single_reveal","targetFloor":150,',
        ' "windowStart":140,"windowEnd":170,"conditions":[],"requiredBeats":[]},',
        ' "secret":{"intent":"真相","revealAt":"何时揭晓","impact":"对读者的影响"}}}'
    ].join('\n');

    function buildPlannerMessages() {
        var floor = currentFloor();
        var fromFloor = Math.max(1, floor - (settings.recentFloors || 20) + 1);
        var wi = renderWorldInfoForPlanner(settings.worldInfoLimit);

        // 到期/过期提醒
        var overdue = [];
        for (var i = 0; i < ledger.active.length; i++) {
            var e = ledger.active[i];
            if (C.isOverdue(e, floor)) overdue.push(e.title + '（已过期，窗口 ' + (e.recovery.windowStart || '?') + '-' + (e.recovery.windowEnd || e.recovery.targetFloor || '?') + '）');
            else if (C.isDueSoon(e, floor)) overdue.push(e.title + '（即将到期）');
        }

        var userPrompt = [
            '## 一、既有伏笔台账（压缩视图）',
            C.buildCompactView(ledger, { floor: floor }),
            '',
            '## 二、世界书素材（当前角色关联，已剔除本插件自己的条目）',
            wi.text,
            '',
            '## 三、近期对话（楼层 ' + fromFloor + ' - ' + floor + '）',
            collectRecentChat(fromFloor, floor) || '（无）',
            '',
            '## 四、运行时信号',
            '- 当前楼层：' + floor,
            '- 到期/过期提醒：' + (overdue.join('；') || '（无）'),
            '- 未触发过的世界书条目（潜在素材）：' + (wi.dormant.join('、') || '（无）'),
            '- 当前角色：' + ((getCtx() && getCtx().name2) || '（未知）'),
            '',
            '## 五、你的任务',
            '基于以上信息输出本轮的 patches。特别注意：',
            '1. 检查【近期对话】里是否已发生某条伏笔计划中的埋设点或回收点；',
            '   若是，用 state / hint_used 推进，并附上【正文逐字引用】。',
            '2. 判断是否有新伏笔值得从【世界书素材】或【近期对话】中提取。宁缺毋滥。',
            '3. 对【到期/过期提醒】中的每一条给出处置：强化 / 回收 / 推迟 / 放弃，并说明理由。',
            '4. 注入类文本必须单句、结果式。',
            '5. 需要完整细节才能决策时用 request_detail 申请，不要凭猜测修改。'
        ].join('\n');

        return [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt }
        ];
    }

    // ── mock 规划器：不用 API key 也能跑通全流程 ──
    function mockPlanner() {
        var floor = currentFloor();
        var patches = [];

        // 1) 台账空 → 从世界书里挑一条创建伏笔
        if (!ledger.active.length) {
            var entries = collectWorldInfoEntries(50);
            entries.sort(function (a, b) { return scoreEntry(b) - scoreEntry(a); });
            var seed = entries[0];
            if (seed) {
                var content = String(seed.content || '');
                var title = String(seed.comment || '世界书线索').slice(0, 20);
                patches.push({
                    op: 'create',
                    tempId: 'mock_1',
                    entry: {
                        title: title,
                        kind: 'worldbuilding',
                        importance: 0.7,
                        subtlety: 0.6,
                        keywords: [].concat(seed.key || []).slice(0, 4),
                        linkedEntities: [],
                        hints: [{
                            text: '（mock）让「' + title + '」的相关细节自然出现一次',
                            condition: '场景合适时'
                        }],
                        plant: { status: 'not_yet', targetFloor: floor + 5 },
                        recovery: {
                            goal: '（mock）「' + title + '」开始引起主角注意',
                            plan: 'single_reveal',
                            targetFloor: floor + 60,
                            windowStart: floor + 50,
                            windowEnd: floor + 80,
                            conditions: [],
                            requiredBeats: []
                        },
                        secret: {
                            intent: '（mock）这条线索背后另有隐情：' + content.slice(0, 60),
                            revealAt: '（mock）中段',
                            impact: '（mock）改变主角对局势的判断'
                        },
                        notes: '【mock 规划器生成】配置真实 API 后可获得真正的规划。'
                    }
                });
            }
        } else {
            // 2) 有 planned 条目 → 尝试埋设（用最近一条 AI 消息做证据，故意可能失败，用来演示接地校验）
            for (var i = 0; i < ledger.active.length && patches.length < 2; i++) {
                var e = ledger.active[i];
                if (e.state !== 'planned') continue;
                var text = lastAssistantText();
                var ev = text ? text.replace(/\s+/g, '').slice(0, 12) : '';
                patches.push({
                    op: 'state',
                    id: e.id,
                    to: 'planted',
                    floor: floor,
                    evidence: ev,
                    reason: '（mock）在最近一条正文里检测到可对应之处'
                });
                break;
            }
            // 3) 已埋设且过期 → 提议回收
            for (var j = 0; j < ledger.active.length && patches.length < 3; j++) {
                var e2 = ledger.active[j];
                if (e2.state !== 'planted' && e2.state !== 'reinforced') continue;
                if (!C.isDueSoon(e2, floor, 30)) continue;
                var t2 = lastAssistantText();
                patches.push({
                    op: 'state',
                    id: e2.id,
                    to: 'resolved',
                    floor: floor,
                    evidence: t2 ? t2.replace(/\s+/g, '').slice(0, 12) : '',
                    reason: '（mock）进入回收窗口'
                });
                break;
            }
        }

        return {
            runMeta: { fromFloor: Math.max(1, floor - (settings.recentFloors || 20)), toFloor: floor, summary: '（mock 规划器）', tier: 'mock' },
            patches: patches
        };
    }

    // ── 容错 JSON 解析（设计书 7.4） ──
    function parsePlannerOutput(raw) {
        if (raw && typeof raw === 'object') return raw;
        var text = String(raw || '').trim();
        if (!text) return null;

        function tryParse(s) {
            try { return JSON.parse(s); } catch (e) { return null; }
        }

        // 1) 直接解析
        var r = tryParse(text);
        if (r) return r;

        // 2) 剥离 ```json 围栏
        var fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fence) { r = tryParse(fence[1].trim()); if (r) return r; }

        // 3) 取第一个 { 到最后一个 }
        var s = text.indexOf('{'), e = text.lastIndexOf('}');
        if (s >= 0 && e > s) {
            var sub = text.slice(s, e + 1);
            r = tryParse(sub);
            if (r) return r;
            // 4) 修常见错误：尾逗号
            r = tryParse(sub.replace(/,\s*([}\]])/g, '$1'));
            if (r) return r;
        }

        // 5) 局部修复：只抽出 patches 数组逐条解析
        var ps = text.indexOf('"patches"');
        if (ps >= 0) {
            var as = text.indexOf('[', ps), ae = text.lastIndexOf(']');
            if (as >= 0 && ae > as) {
                var arr = tryParse(text.slice(as, ae + 1).replace(/,\s*([}\]])/g, '$1'));
                if (Array.isArray(arr)) {
                    var good = [];
                    for (var i = 0; i < arr.length; i++) {
                        if (arr[i] && typeof arr[i] === 'object' && arr[i].op) good.push(arr[i]);
                    }
                    warn('JSON 局部修复：保留 ' + good.length + '/' + arr.length + ' 条 patch');
                    return { runMeta: { summary: '（局部修复）' }, patches: good };
                }
            }
        }

        // 6) 全部失败
        return null;
    }

    function extractContent(data) {
        if (!data) return '';
        if (typeof data === 'string') return data;
        if (typeof data.content === 'string') return data.content;
        if (data.choices && data.choices[0]) {
            var ch = data.choices[0];
            if (ch.message && typeof ch.message.content === 'string') return ch.message.content;
            if (typeof ch.text === 'string') return ch.text;
        }
        return '';
    }

    // ── 真实 API 调用 ──
    function callDirect(messages) {
        var c = getCtx();
        var d = settings.direct;
        var url = String(d.url || '').replace(/\/+$/, '');
        if (!url) throw new Error('未配置 API 地址');

        var headers = { 'Content-Type': 'application/json' };
        if (d.apiKey) headers['Authorization'] = 'Bearer ' + d.apiKey;

        var body = {
            model: d.model,
            messages: messages,
            temperature: d.temperature,
            max_tokens: d.maxTokens,
            stream: false
        };
        if (d.jsonSchema) {
            body.response_format = {
                type: 'json_schema',
                json_schema: { name: 'ForeshadowPatches', strict: false, schema: OUTPUT_SCHEMA }
            };
        }

        var ctrl = null;
        try { ctrl = new AbortController(); } catch (e) { ctrl = null; }
        var timer = null;
        if (ctrl) timer = setTimeout(function () { ctrl.abort(); }, d.timeoutMs || 90000);

        // 路径 B：经酒馆后端转发（规避 CORS）
        if (settings.plannerMode === 'direct_via_backend') {
            var backendBody = {
                chat_completion_source: 'custom',
                custom_url: url,
                model: d.model,
                messages: messages,
                temperature: d.temperature,
                max_tokens: d.maxTokens,
                stream: false
            };
            if (d.apiKey) backendBody.custom_include_headers = 'Authorization: "Bearer ' + d.apiKey + '"';
            if (d.jsonSchema) backendBody.json_schema = { name: 'ForeshadowPatches', description: '伏笔规划补丁', strict: false, value: OUTPUT_SCHEMA };

            return fetch('/api/backends/chat-completions/generate', {
                method: 'POST',
                headers: c.getRequestHeaders ? c.getRequestHeaders() : { 'Content-Type': 'application/json' },
                body: JSON.stringify(backendBody),
                signal: ctrl ? ctrl.signal : undefined
            }).then(function (res) {
                if (timer) clearTimeout(timer);
                if (!res.ok) return res.text().then(function (t) { throw new Error('HTTP ' + res.status + ': ' + t.slice(0, 300)); });
                return res.json();
            }).then(extractContent);
        }

        // 路径 A：浏览器直连
        return fetch(url + '/chat/completions', {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(body),
            signal: ctrl ? ctrl.signal : undefined
        }).then(function (res) {
            if (timer) clearTimeout(timer);
            if (!res.ok) return res.text().then(function (t) { throw new Error('HTTP ' + res.status + ': ' + t.slice(0, 300)); });
            return res.json();
        }).then(extractContent);
    }

    function callProfile(messages) {
        var c = getCtx();
        if (!c.ConnectionManagerRequestService || typeof c.ConnectionManagerRequestService.sendRequest !== 'function') {
            throw new Error('此版本酒馆缺少 ConnectionManagerRequestService');
        }
        if (!settings.profileId) throw new Error('未选择连接配置档');

        return c.ConnectionManagerRequestService.sendRequest(
            settings.profileId,
            messages,
            settings.direct.maxTokens || 4000,
            { stream: false, extractData: true, signal: null },
            {}
        ).then(function (result) {
            return (result && (result.content || result)) || '';
        });
    }

    function runPlanner() {
        if (settings.plannerMode === 'mock') {
            return Promise.resolve(mockPlanner());
        }
        var messages = buildPlannerMessages();
        var p = (settings.plannerMode === 'profile') ? callProfile(messages) : callDirect(messages);
        return p.then(function (raw) {
            var parsed = parsePlannerOutput(raw);
            if (!parsed) {
                var err = new Error('规划器输出无法解析为 JSON');
                err.raw = String(raw || '').slice(0, 2000);
                throw err;
            }
            if (!Array.isArray(parsed.patches)) parsed.patches = [];
            return parsed;
        });
    }

    // ─────────────────────────────────────────────────────────
    // 规划主流程
    // ─────────────────────────────────────────────────────────

    function plan() {
        if (planning) { toast('上一次规划仍在进行中', 'warning'); return Promise.resolve(null); }
        if (!settings.enabled) { toast('伏笔引擎未启用', 'warning'); return Promise.resolve(null); }

        planning = true;
        var floor = currentFloor();
        toast('开始规划…', 'info');
        if (window.FSPUI && window.FSPUI.setBusy) window.FSPUI.setBusy(true);

        return runPlanner().then(function (output) {
            // 撤销快照
            undoSnapshot = JSON.parse(JSON.stringify(ledger));

            var fromFloor = Math.max(1, floor - (settings.recentFloors || 20) + 1);
            var result = C.mergeLedger(ledger, output, {
                floor: floor,
                now: Date.now(),
                replyTextByFloor: replyTextMap(fromFloor, floor),
                currentReplyText: lastAssistantText(),
                options: {
                    strategy: settings.mergeStrategy,
                    shiftThreshold: settings.shiftThreshold,
                    duplicateThreshold: settings.duplicateThreshold,
                    minEvidenceLength: settings.minEvidenceLength
                }
            });

            lastResult = result;
            persistLedger();

            // 有需要用户裁决的 → 暂存待裁决 patches
            var needsReview = result.conflicts.filter(function (c) {
                return c.staged || c.type === 'locked_entry' || c.type === 'large_shift' ||
                    c.type === 'monotonic_violation' || c.type === 'secret_after_plant' ||
                    c.type === 'illegal_transition';
            });
            staging = needsReview.length ? { output: output, conflicts: needsReview, at: floor } : null;

            refreshInjections();

            var msg = '规划完成：采纳 ' + result.applied.length +
                ' · 候选 ' + result.candidates.length +
                ' · 冲突 ' + result.conflicts.length;
            toast(msg, result.conflicts.length ? 'warning' : 'success');
            if (window.FSPUI && window.FSPUI.refresh) window.FSPUI.refresh();
            return result;
        }).catch(function (e) {
            warn('规划失败', e);
            toast('规划失败：' + (e && e.message ? e.message : e), 'error');
            if (window.FSPUI && window.FSPUI.refresh) window.FSPUI.refresh();
            return null;
        }).then(function (r) {
            planning = false;
            if (window.FSPUI && window.FSPUI.setBusy) window.FSPUI.setBusy(false);
            return r;
        });
    }

    /** 用户批准一条被拦下的 patch */
    function approvePatch(patch) {
        if (!patch) return;
        var floor = currentFloor();
        var fromFloor = Math.max(1, floor - (settings.recentFloors || 20) + 1);
        var approved = JSON.parse(JSON.stringify(patch));
        approved.force = true;
        var r = C.mergeLedger(ledger, { patches: [approved] }, {
            floor: floor,
            now: Date.now(),
            replyTextByFloor: replyTextMap(fromFloor, floor),
            currentReplyText: lastAssistantText(),
            options: { strategy: settings.mergeStrategy }
        });
        persistLedger();
        refreshInjections();
        if (window.FSPUI && window.FSPUI.refresh) window.FSPUI.refresh();
        return r;
    }

    function undoLast() {
        if (!undoSnapshot) { toast('没有可撤销的规划', 'warning'); return; }
        ledger = undoSnapshot;
        var store = ledgerStore();
        if (store) store[currentChatKey()] = ledger;
        undoSnapshot = null;
        staging = null;
        persistLedger();
        refreshInjections();
        if (window.FSPUI && window.FSPUI.refresh) window.FSPUI.refresh();
        toast('已撤销上一次规划', 'success');
    }

    // ─────────────────────────────────────────────────────────
    // 注入
    // ─────────────────────────────────────────────────────────

    /**
     * 现场推导并写入全部注入槽（设计书 5.2.1：绝不缓存）。
     * scan 参数（设计书 C-2 / D-8.1）：
     *   含实体名的层 = true（让「管家」「阁楼」这类词能触发世界书条目）
     *   概览层 / 协议层 = false（避免误触发）
     */
    function refreshInjections() {
        var c = getCtx();
        if (!c || typeof c.setExtensionPrompt !== 'function') return;
        if (!ledger) return;

        var types = c.extension_prompt_types || {};
        var roles = c.extension_prompt_roles || {};
        var IN_PROMPT = types.IN_PROMPT === undefined ? 0 : types.IN_PROMPT;
        var IN_CHAT = types.IN_CHAT === undefined ? 1 : types.IN_CHAT;
        var NONE = types.NONE === undefined ? -1 : types.NONE;
        var MAX_DEPTH = 10000;
        var SYSTEM = roles.SYSTEM === undefined ? 0 : roles.SYSTEM;

        var floor = currentFloor();

        if (!settings.enabled) {
            setSlot('fsp_index', '', NONE, MAX_DEPTH, false, SYSTEM);
            setSlot('fsp_schedule', '', NONE, MAX_DEPTH, false, SYSTEM);
            setSlot('fsp_contract', '', NONE, MAX_DEPTH, false, SYSTEM);
            setSlot('fsp_pulse', '', NONE, MAX_DEPTH, false, SYSTEM);
            lastInjections = { index: '', schedule: '', contract: '', pulse: '' };
            return;
        }

        var schedule = C.buildSchedule(ledger, { floor: floor, max: settings.maxSchedule, minGap: settings.minGap });
        var recentText = lastAssistantText();

        var contractHits = C.detectContractTriggers(ledger, { recentChatText: recentText });
        var pulseCandidates = C.buildPulseCandidates(ledger, { floor: floor });

        var idx = settings.injectIndex ? C.renderIndex(ledger, { floor: floor }) : '';
        var sch = settings.injectSchedule ? C.renderSchedule(schedule, { floor: floor }) : '';
        var con = settings.injectContract ? C.renderContract(contractHits, {}) : '';
        var pul = settings.injectPulse ? C.renderPulseProtocol(pulseCandidates) : '';

        // 自检：绝不允许泄漏秘密（设计书 5.2.1）
        for (var i = 0; i < ledger.active.length; i++) {
            var e = ledger.active[i];
            var checked = [idx, sch, con, pul];
            for (var j = 0; j < checked.length; j++) {
                var r = C.containsSecret(checked[j], e);
                if (r.leaked) {
                    warn('⛔ 注入层泄漏秘密，已中止本层注入', e.id, r.fragment);
                    if (j === 0) idx = '';
                    if (j === 1) sch = '';
                    if (j === 2) con = '';
                    if (j === 3) pul = '';
                }
            }
        }

        // L1 常驻索引 —— 概览层，scan=false
        setSlot('fsp_index', idx, idx ? IN_PROMPT : NONE, idx ? settings.indexDepth : MAX_DEPTH, false, SYSTEM);
        // L2 动态调度 —— 含实体名，scan=TRUE
        setSlot('fsp_schedule', sch, sch ? IN_CHAT : NONE, sch ? settings.scheduleDepth : MAX_DEPTH, true, SYSTEM);
        // 契约层 —— 含实体名，scan=TRUE
        setSlot('fsp_contract', con, con ? IN_CHAT : NONE, con ? settings.contractDepth : MAX_DEPTH, true, SYSTEM);
        // 落拍协议 —— 通用措辞，scan=false，depth 0（最靠后）
        setSlot('fsp_pulse', pul, pul ? IN_CHAT : NONE, pul ? 0 : MAX_DEPTH, false, SYSTEM);

        lastInjections = { index: idx, schedule: sch, contract: con, pulse: pul };
        log('注入已刷新', { index: idx.length, schedule: sch.length, contract: con.length, pulse: pul.length });

        function setSlot(key, value, pos, depth, scan, role) {
            try { c.setExtensionPrompt(key, value, pos, depth, scan, role); }
            catch (e) { warn('注入失败', key, e); }
        }
    }

    // ─────────────────────────────────────────────────────────
    // 落拍感应（设计书 4.2.1）
    // ─────────────────────────────────────────────────────────

    /**
     * 从叙事模型的回复里提取履约报告，做接地校验，只标记候选、绝不自动推进。
     * @returns {Array} 校验通过的报告
     */
    function processPulse(text) {
        var body = String(text || '');
        if (!body || body.indexOf('FSP') === -1) return [];

        var confirmed = [];

        // 第一遍：先算出「去掉报告行之后的正文」，供接地校验用
        var cleanBody = body.replace(makePulseRe(), '').replace(/<!--[\s\S]*?-->/g, '');

        // 第二遍：用【新的】正则实例提取报告，避免与上面的 replace 共享 lastIndex
        var re = makePulseRe();
        var m;
        while ((m = re.exec(body)) !== null) {
            // 防御：万一匹配到零长，强制前进，绝不允许死循环
            if (m.index === re.lastIndex) re.lastIndex++;

            var id = String(m[1] || '').trim();
            var kind = String(m[2] || '').trim();
            var quote = String(m[3] || '').trim();
            if (!id || !quote) continue;

            var entry = null;
            for (var i = 0; i < ledger.active.length; i++) if (ledger.active[i].id === id) entry = ledger.active[i];
            if (!entry) continue;

            var g = C.groundEvidence(quote, cleanBody, { minLength: settings.minEvidenceLength });
            if (!g.ok) {
                log('落拍报告未接地，丢弃', id, g.reason);
                continue;
            }

            confirmed.push({
                id: id,
                title: entry.title,
                kind: kind,
                quote: quote,
                floor: currentFloor(),
                patch: kind === 'reinforce'
                    ? { op: 'reinforce', id: id, floor: currentFloor(), reason: '落拍感应' }
                    : { op: 'state', id: id, to: 'resolved', floor: currentFloor(), evidence: quote, reason: '落拍感应' }
            });
        }

        if (confirmed.length) {
            staging = staging || { output: null, conflicts: [], at: currentFloor() };
            staging.pulseReports = confirmed;
            toast('检测到 ' + confirmed.length + ' 条履约报告，待你确认', 'info');
            if (window.FSPUI && window.FSPUI.refresh) window.FSPUI.refresh();
        }
        return confirmed;
    }

    function approvePulse(report) {
        if (!report || !report.patch) return;
        // 用户的显式确认 = 允许越过grounding（但报告本身已通过校验）
        var r = approvePatch(report.patch);
        var st = staging;
        if (st && st.pulseReports) {
            st.pulseReports = st.pulseReports.filter(function (x) { return x.id !== report.id; });
        }
        return r;
    }

    // ─────────────────────────────────────────────────────────
    // 事件接线
    // ─────────────────────────────────────────────────────────

    function bindEvents() {
        var c = getCtx();
        if (!c || !c.eventSource || !c.eventTypes) { warn('事件源不可用，跳过事件绑定'); return; }
        var es = c.eventSource;
        var et = c.eventTypes;

        function on(name, fn) {
            var key = et[name];
            if (!key) { log('事件不存在，跳过：' + name); return; }
            try { es.on(key, fn); } catch (e) { warn('绑定事件失败', name, e); }
        }

        // 切换聊天 → 重载台账 + 重推导全部注入槽（设计书 3.3.1）
        on('CHAT_CHANGED', function () {
            log('聊天已切换，重载台账');
            loadLedger();
            staging = null;
            undoSnapshot = null;
            refreshInjections();
            if (window.FSPUI && window.FSPUI.refresh) window.FSPUI.refresh();
        });

        // 世界书激活 → 记录，供「从未被触发过」统计
        on('WORLD_INFO_ACTIVATED', function (payload) {
            rememberActivated(payload);
        });

        // AI 消息渲染完成 → 处理落拍报告 + 重算注入
        on('CHARACTER_MESSAGE_RENDERED', function (messageId) {
            try {
                var c2 = getCtx();
                var msg = c2 && c2.chat && c2.chat[messageId];
                if (msg && msg.mes) {
                    var hits = processPulse(msg.mes);
                    if (hits.length) { /* 已在 processPulse 里提示 */ }
                }
            } catch (e) { warn('处理落拍报告失败', e); }
            refreshInjections();
        });

        // 用户消息渲染 → 重算（场景可能变了，契约层要重新判断）
        on('USER_MESSAGE_RENDERED', function () {
            refreshInjections();
        });

        // 生成前最后确认一次（注入必须是现场推导的）
        on('GENERATION_STARTED', function () {
            refreshInjections();
        });
    }

    // ─────────────────────────────────────────────────────────
    // 其它公开动作
    // ─────────────────────────────────────────────────────────

    function manualAdd(partial) {
        var floor = currentFloor();
        // 必须显式分配 id：createEntry 只在传入 partial.id 时才带 id，
        // 而用户手动添加时没有 id（对外部输入也不该信任）。见 core.js 的 nextId。
        var withId = Object.assign({ origin: 'user' }, partial);
        if (!withId.id) withId.id = C.nextId(ledger);
        var entry = C.createEntry(withId, { now: Date.now(), floor: floor });
        entry.hints = entry.hints.map(function (h, i) {
            return Object.assign({}, h, { id: h.id || ('h_' + (ledger.counters.nextHintId++)) });
        });
        ledger.active.push(entry);
        ledger.planningRuns.push({ runId: 'manual_' + Date.now(), at: Date.now(), tier: 'manual', diff: { applied: 1, candidates: 0, conflicts: 0 } });
        persistLedger();
        refreshInjections();
        if (window.FSPUI && window.FSPUI.refresh) window.FSPUI.refresh();
        return entry;
    }

    function toggleLock(id) {
        for (var i = 0; i < ledger.active.length; i++) {
            if (ledger.active[i].id === id) {
                ledger.active[i].locked = !ledger.active[i].locked;
                persistLedger();
                if (window.FSPUI && window.FSPUI.refresh) window.FSPUI.refresh();
                return ledger.active[i].locked;
            }
        }
        return null;
    }

    function deleteEntry(id) {
        for (var i = 0; i < ledger.active.length; i++) {
            if (ledger.active[i].id === id) {
                var e = ledger.active[i];
                e.state = 'abandoned';
                e.recovery.resolution = '用户手动删除';
                e.recovery.actualFloor = currentFloor();
                ledger.active.splice(i, 1);
                ledger.archive.push(e);
                persistLedger();
                refreshInjections();
                if (window.FSPUI && window.FSPUI.refresh) window.FSPUI.refresh();
                return true;
            }
        }
        return false;
    }

    function exportLedger() {
        return JSON.stringify({
            app: 'foreshadow-engine',
            version: 1,
            exportedAt: new Date().toISOString(),
            chatKey: ledger.chatKey,
            ledger: ledger
        }, null, 2);
    }

    function importLedger(json) {
        try {
            var data = JSON.parse(json);
            var incoming = data && data.ledger ? data.ledger : data;
            if (!incoming || !Array.isArray(incoming.active)) throw new Error('结构不正确');
            ledger = incoming;
            ledger.chatKey = currentChatKey();
            var store = ledgerStore();
            if (store) store[ledger.chatKey] = ledger;
            persistLedger();
            refreshInjections();
            if (window.FSPUI && window.FSPUI.refresh) window.FSPUI.refresh();
            return true;
        } catch (e) {
            toast('导入失败：' + e.message, 'error');
            return false;
        }
    }

    /**
     * 注册斜杠命令。
     *
     * ⚠️ 正确 API 是 SlashCommand.fromProps({ name, callback, aliases, helpString })。
     *    早期版本用了 `new SlashCommand(name, callback, [], help, true, false)`，
     *    那个签名不存在，会在控制台留一条 warn（实际测试中抓到）。
     *
     * 整个函数用 try/catch 包住：斜杠命令是锦上添花，绝不能因为它失败影响主功能。
     */
    function initSlashCommands() {
        var c = getCtx();
        if (!c || !c.SlashCommandParser || !c.SlashCommand) {
            log('无斜杠命令 API，跳过');
            return;
        }
        try {
            var Parser = c.SlashCommandParser;
            var SlashCommand = c.SlashCommand;
            if (typeof Parser.addCommandObject !== 'function' || typeof SlashCommand.fromProps !== 'function') {
                log('斜杠命令 API 形态不符，跳过');
                return;
            }

            var defs = [
                {
                    name: 'fsp',
                    helpString: '立即执行一次伏笔规划',
                    callback: function () { plan(); return ''; },
                },
                {
                    name: 'fsp-panel',
                    helpString: '打开伏笔台账面板',
                    callback: function () {
                        if (window.FSPUI && window.FSPUI.toggle) window.FSPUI.toggle(true);
                        return '';
                    },
                },
                {
                    name: 'fsp-list',
                    helpString: '列出当前所有活跃伏笔',
                    callback: function () {
                        var lines = ledger.active.map(function (e) {
                            return '#' + e.id + ' [' + e.state + '] ' + e.title;
                        });
                        toast(lines.length ? lines.join('\n') : '（台账为空）', 'info');
                        return '';
                    },
                },
            ];

            for (var i = 0; i < defs.length; i++) {
                try {
                    Parser.addCommandObject(SlashCommand.fromProps(defs[i]));
                } catch (e) {
                    warn('注册 /' + defs[i].name + ' 失败', e);
                }
            }
            log('斜杠命令已注册：/fsp /fsp-panel /fsp-list');
        } catch (e) {
            warn('注册斜杠命令失败（不影响主功能）', e);
        }
    }

    // ─────────────────────────────────────────────────────────
    // 初始化
    // ─────────────────────────────────────────────────────────

    function init() {
        loadSettings();
        loadLedger();
        refreshInjections();
        bindEvents();
        initSlashCommands();
        log('集成层就绪', { mode: settings.plannerMode, scope: settings.scope, enabled: settings.enabled });
    }

    // 等酒馆就绪
    function bootstrap() {
        var tries = 0;
        function attempt() {
            tries++;
            var c = null;
            try { if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) c = SillyTavern.getContext(); } catch (e) { c = null; }
            if (c && c.extensionSettings) {
                try { init(); } catch (e) { console.error('[伏笔引擎] 初始化失败', e); }
                return;
            }
            if (tries > 60) { console.error('[伏笔引擎] 等待酒馆就绪超时'); return; }
            setTimeout(attempt, 250);
        }
        attempt();
    }

    window.FSPIntegration = {
        MODULE_NAME: MODULE_NAME,
        DEFAULT_SETTINGS: DEFAULT_SETTINGS,
        OUTPUT_SCHEMA: OUTPUT_SCHEMA,
        SYSTEM_PROMPT: SYSTEM_PROMPT,

        // 供 UI 层取用
        getSettings: function () { return settings; },
        saveSettings: saveSettings,
        getLedger: function () { return ledger; },
        getLastResult: function () { return lastResult; },
        getStaging: function () { return staging; },
        getLastInjections: function () { return lastInjections; },
        getWorldInfoModule: getWorldInfoModuleCached,
        isPlanning: function () { return planning; },
        currentFloor: currentFloor,

        // 动作
        plan: plan,
        approvePatch: approvePatch,
        approvePulse: approvePulse,
        undoLast: undoLast,
        manualAdd: manualAdd,
        toggleLock: toggleLock,
        deleteEntry: deleteEntry,
        exportLedger: exportLedger,
        importLedger: importLedger,
        refreshInjections: refreshInjections,
        reloadLedger: function () { loadLedger(); refreshInjections(); },
        resetLedger: function () {
            ledger = C.createLedger(currentChatKey());
            var store = ledgerStore();
            if (store) store[ledger.chatKey] = ledger;
            persistLedger();
            refreshInjections();
        },
        buildPlannerMessages: buildPlannerMessages,
        collectWorldInfoEntries: collectWorldInfoEntries,
        parsePlannerOutput: parsePlannerOutput,
        processPulse: processPulse,
        isOwnEntry: isOwnEntry,
        associatedWorldNames: associatedWorldNames,
        toast: toast,

        init: init,
        bootstrap: bootstrap
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootstrap);
    } else {
        bootstrap();
    }
})();
