/**
 * 伏笔引擎 (Foreshadow Engine) —— 单文件构建产物
 *
 * ⚠️ 本文件由 build.mjs 自动生成，请勿手改。
 *    要改代码：改 core.js / app.js / ui.js，然后运行  node build.mjs
 *
 * ── 为什么是单文件 ──
 * 酒馆扩展的 manifest.json 只认单个 JS 文件（生态硬约束）。
 * 三个源码文件按顺序拼进来，各自用 IIFE 隔离，通过 window.FSPCore /
 * window.FSPIntegration / window.FSPUI 互相通信。拼接不改变任何语义。
 */


/* ========================================================================
 * 以下来自 core.js
 * 纯逻辑层：三方合并 / 状态机 / 接地校验 / 调度 / 秘密自检
 * ======================================================================== */

/**
 * 伏笔引擎 · 核心层（纯 JS，零 ST 依赖）
 *
 * 与 test/*.mjs 测试的那份逻辑一致，区别只有一个：
 * 本文件是经典脚本用的语法（无 import/export），因为安卓端酒馆的 WebView
 * 对 ES module 的 MIME 校验经常不通过，动态 import() 会失败。
 * 全部内联是刻意的兼容性选择。
 *
 * 依赖：无。挂载点：window.FSPCore
 */
(function () {
    'use strict';

    // ─────────────────────────────────────────────────────────
    // 常量
    // ─────────────────────────────────────────────────────────

    var STATES = ['planned', 'planted', 'reinforced', 'resolved', 'abandoned', 'contradicted'];
    var TERMINAL_STATES = ['resolved', 'abandoned', 'contradicted'];

    var TRANSITIONS = {
        planned: ['planted', 'abandoned', 'contradicted'],
        planted: ['reinforced', 'resolved', 'abandoned', 'contradicted'],
        reinforced: ['reinforced', 'resolved', 'abandoned', 'contradicted'],
        resolved: [],
        abandoned: [],
        contradicted: []
    };

    var MONOTONIC_PATHS = [
        'plant.actualFloor',
        'plant.actualMessageId',
        'plant.evidence',
        'recovery.actualFloor',
        'recovery.resolution'
    ];

    var SHIFT_PATHS = ['plant.targetFloor', 'recovery.targetFloor', 'recovery.windowStart', 'recovery.windowEnd'];

    var PROTECTED_FIELDS = {
        id: 1, locked: 1, createdAt: 1, createdAtFloor: 1, lastTouchedFloor: 1,
        mergeHistory: 1, plant: 1, recovery: 1, hints: 1, knows: 1, contract: 1, secret: 1
    };

    var DEFAULT_MERGE_OPTIONS = {
        strategy: 'balanced',
        shiftThreshold: 80,
        duplicateThreshold: 0.75,
        suggestThreshold: 0.5,
        minEvidenceLength: 8
    };

    var DEFAULT_URGENCY_WEIGHTS = { overdue: 1.0, importance: 0.6, silence: 0.5, recentPenalty: 0.8 };

    // ─────────────────────────────────────────────────────────
    // 小工具
    // ─────────────────────────────────────────────────────────

    function clamp01(v) {
        var n = Number(v);
        if (!isFinite(n)) return 0;
        return Math.min(1, Math.max(0, n));
    }

    function toIntOrNull(v) {
        if (v === null || v === undefined || v === '') return null;
        var n = Number(v);
        return isFinite(n) ? Math.round(n) : null;
    }

    function toStrArray(v) {
        if (Object.prototype.toString.call(v) === '[object Array]') {
            return v.filter(function (x) { return typeof x === 'string' && x.trim(); })
                .map(function (x) { return x.trim(); });
        }
        if (typeof v === 'string' && v.trim()) return [v.trim()];
        return [];
    }

    var FIELD_COERCE = {
        title: function (v) { return String(v === null || v === undefined ? '' : v).slice(0, 60); },
        kind: function (v) { return typeof v === 'string' ? v : 'event'; },
        importance: clamp01,
        subtlety: clamp01,
        confidence: clamp01,
        keywords: toStrArray,
        linkedEntities: toStrArray,
        linkedWIConditions: toStrArray,
        dependsOn: toStrArray,
        blocks: toStrArray,
        conflictsWith: toStrArray,
        nextReinforceFloor: toIntOrNull,
        reinforceInterval: function (v) {
            var n = toIntOrNull(v);
            return n === null ? null : Math.max(5, n);
        },
        notes: function (v) { return String(v === null || v === undefined ? '' : v).slice(0, 2000); },
        tabooPhrases: toStrArray
    };

    function getPath(obj, path) {
        var keys = path.split('.');
        var cur = obj;
        for (var i = 0; i < keys.length; i++) {
            if (cur === null || cur === undefined) return undefined;
            cur = cur[keys[i]];
        }
        return cur;
    }

    function setPath(obj, path, value) {
        var keys = path.split('.');
        var last = keys.pop();
        var cur = obj;
        for (var i = 0; i < keys.length; i++) {
            if (cur[keys[i]] === null || cur[keys[i]] === undefined || typeof cur[keys[i]] !== 'object') cur[keys[i]] = {};
            cur = cur[keys[i]];
        }
        cur[last] = value;
    }

    /** 归一化：用于证据接地校验与标题相似度 */
    function normalizeText(s) {
        return String(s === null || s === undefined ? '' : s)
            .replace(/\s+/g, '')
            .replace(/[，。！？、；：""''（）《》【】…—～·,.!?;:"'()<>\[\]`~\-_*#>]/g, '')
            .replace(/[\uFF01-\uFF5E]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xfee0); });
    }

    function tokenSet(text) {
        var set = {};
        var s = String(text === null || text === undefined ? '' : text);
        var words = s.match(/[A-Za-z0-9]+/g) || [];
        for (var i = 0; i < words.length; i++) set[words[i].toLowerCase()] = 1;
        var cjk = s.replace(/[^\u4e00-\u9fff]/g, '');
        for (var j = 0; j < cjk.length - 1; j++) set[cjk.slice(j, j + 2)] = 1;
        if (cjk.length === 1) set[cjk] = 1;
        return set;
    }

    function setSize(s) { return Object.keys(s).length; }

    /** 包含度相似度（比 Jaccard 对中文长短不一更公平） */
    function similarity(a, b) {
        var A = tokenSet(a), B = tokenSet(b);
        var na = setSize(A), nb = setSize(B);
        if (!na || !nb) return 0;
        var inter = 0;
        for (var k in A) if (A[k] && B[k]) inter++;
        return inter / Math.min(na, nb);
    }

    /** 组合去重信号：标题相似度(40%) + 关键词/实体重合度(60%) */
    function dedupeScore(incoming, existing) {
        var titleSim = similarity(incoming.title, existing.title);
        var kwSim = similarity(
            toStrArray(incoming.keywords).concat(toStrArray(incoming.linkedEntities)).join(' '),
            toStrArray(existing.keywords).concat(toStrArray(existing.linkedEntities)).join(' ')
        );
        return 0.4 * titleSim + 0.6 * kwSim;
    }

    // ─────────────────────────────────────────────────────────
    // 1. grounding
    // ─────────────────────────────────────────────────────────

    function groundEvidence(evidence, replyText, opts) {
        opts = opts || {};
        var minLength = opts.minLength === undefined ? DEFAULT_MERGE_OPTIONS.minEvidenceLength : opts.minLength;
        var anchorTerms = opts.anchorTerms || [];

        var ev = String(evidence === null || evidence === undefined ? '' : evidence).trim();
        if (!ev) return { ok: false, reason: 'evidence_empty' };

        var evNorm = normalizeText(ev);
        if (evNorm.length < minLength) return { ok: false, reason: 'evidence_too_short', length: evNorm.length };

        // 剥掉所有 HTML 注释：落拍报告行本身（<!--FSP|...-->）绝不能算作「正文证据」，
        // 否则模型只要写一行报告就能自我接地。多条报告时必须【全部】剥掉，不能只剥第一条。
        var text = String(replyText === null || replyText === undefined ? '' : replyText)
            .replace(/<!--[\s\S]*?-->/g, '');
        if (!text.trim()) return { ok: false, reason: 'no_reply_text' };

        var strict = normalizeText(text).indexOf(evNorm) !== -1;
        var loose = text.indexOf(ev) !== -1;
        if (!strict && !loose) return { ok: false, reason: 'not_verbatim_in_reply' };

        if (anchorTerms.length) {
            var textNorm = normalizeText(text);
            var hit = false;
            for (var i = 0; i < anchorTerms.length; i++) {
                var tn = normalizeText(anchorTerms[i]);
                if (tn && (evNorm.indexOf(tn) !== -1 || textNorm.indexOf(tn) !== -1)) { hit = true; break; }
            }
            if (!hit) return { ok: false, reason: 'no_anchor_overlap' };
        }

        return { ok: true, mode: strict ? 'normalized' : 'raw' };
    }

    /**
     * 检查一段文本是否含某条伏笔秘密的任何片段。
     *
     * 用途：注入层自检 —— 「秘密层绝不泄漏」这条铁律的自动化防线（设计书 5.2.1）。
     *
     * 探针设计（很重要，写成「前 N 字包含」会大量误报）：
     *   · 只取秘密里【长度 ≥ 8 且含中文/字母数字】的片段，逐段检查
     *   · 忽略纯括号/标点/空白构成的片段
     * 因为 title / keywords / hints 与 secret 之间常常共享人名地名，
     * 用短探针会把正常注入误判成泄漏，反而让这道防线变成噪声。
     */
    function secretNeedles(entry) {
        var secret = (entry && entry.secret) || {};
        var needles = [];
        var keys = ['intent', 'revealAt', 'impact'];
        for (var i = 0; i < keys.length; i++) {
            var value = String(secret[keys[i]] || '');
            if (!value) continue;
            // 按标点切成片段，只保留足够长且有意涵的
            var parts = value.split(/[，。！？、；：""''（）()\[\]【】…—～·\s]+/);
            for (var j = 0; j < parts.length; j++) {
                var p = parts[j].trim();
                if (p.length >= 8 && /[\u4e00-\u9fffA-Za-z0-9]/.test(p)) needles.push({ text: p, field: keys[i] });
            }
        }
        return needles;
    }

    function containsSecret(text, entry) {
        var hay = String(text === null || text === undefined ? '' : text);
        if (!hay) return { leaked: false };
        var CANDIDATES = [entry && entry.title];
        var kws = (entry && entry.keywords) || [];
        for (var k = 0; k < kws.length; k++) CANDIDATES.push(kws[k]);
        var ents = (entry && entry.linkedEntities) || [];
        for (var m = 0; m < ents.length; m++) CANDIDATES.push(ents[m]);
        var hs = (entry && entry.hints) || [];
        for (var n = 0; n < hs.length; n++) CANDIDATES.push(hs[n] && hs[n].text);
        var goal = entry && entry.recovery && entry.recovery.goal;
        if (goal) CANDIDATES.push(goal);

        var needles = secretNeedles(entry);
        for (var i = 0; i < needles.length; i++) {
            if (hay.indexOf(needles[i].text) === -1) continue;
            // 命中的片段如果本来就是这个伏笔对外可见的措辞，不算泄漏
            var benign = false;
            for (var c = 0; c < CANDIDATES.length; c++) {
                if (!CANDIDATES[c]) continue;
                if (String(CANDIDATES[c]).indexOf(needles[i].text) !== -1) { benign = true; break; }
            }
            if (benign) continue;
            return { leaked: true, field: needles[i].field, fragment: needles[i].text };
        }
        return { leaked: false };
    }

    // ─────────────────────────────────────────────────────────
    // 2. 状态机
    // ─────────────────────────────────────────────────────────

    function isLegalTransition(from, to) {
        if (STATES.indexOf(to) === -1) return false;
        return (TRANSITIONS[from] || []).indexOf(to) !== -1;
    }

    function isTerminal(state) {
        return TERMINAL_STATES.indexOf(state) !== -1;
    }

    // ─────────────────────────────────────────────────────────
    // 3. 台账构造
    // ─────────────────────────────────────────────────────────

    function createLedger(chatKey) {
        return {
            schemaVersion: 1,
            chatKey: chatKey || 'default',
            active: [],
            archive: [],
            planningRuns: [],
            counters: { nextId: 1, nextHintId: 1 }
        };
    }

    function createEntry(partial, ctx) {
        partial = partial || {};
        ctx = ctx || {};
        var now = ctx.now === undefined ? Date.now() : ctx.now;
        var floor = ctx.floor === undefined ? 0 : ctx.floor;

        var e = {
            id: partial.id,
            title: partial.title === undefined ? '(untitled)' : partial.title,
            kind: partial.kind === undefined ? 'event' : partial.kind,
            state: partial.state === undefined ? 'planned' : partial.state,

            secret: Object.assign({ intent: '', revealAt: '', impact: '' }, partial.secret || {}),
            hints: (partial.hints || []).map(function (h) {
                return {
                    id: h.id,
                    text: h.text === undefined ? '' : h.text,
                    condition: h.condition === undefined ? '' : h.condition,
                    used: h.used === undefined ? false : h.used,
                    usedAt: h.usedAt === undefined ? null : h.usedAt
                };
            }),

            plant: Object.assign({
                status: 'not_yet', targetFloor: null, actualFloor: null,
                actualMessageId: null, evidence: null, quality: null
            }, partial.plant || {}),

            recovery: Object.assign({
                goal: '', plan: 'none', targetFloor: null, windowStart: null, windowEnd: null,
                conditions: [], requiredBeats: [], actualFloor: null, resolution: null
            }, partial.recovery || {}),

            reinforcements: partial.reinforcements || [],
            nextReinforceFloor: partial.nextReinforceFloor === undefined ? null : partial.nextReinforceFloor,
            reinforceInterval: partial.reinforceInterval === undefined ? 45 : partial.reinforceInterval,

            keywords: partial.keywords || [],
            linkedEntities: partial.linkedEntities || [],
            linkedWIConditions: partial.linkedWIConditions || [],

            dependsOn: partial.dependsOn || [],
            blocks: partial.blocks || [],
            conflictsWith: partial.conflictsWith || [],

            knows: partial.knows || [],
            contract: Object.assign(
                { invariants: [], tabooPhrases: [], statedFacts: [] },
                partial.contract || {}
            ),

            importance: partial.importance === undefined ? 0.5 : partial.importance,
            subtlety: partial.subtlety === undefined ? 0.5 : partial.subtlety,
            confidence: partial.confidence === undefined ? 0.7 : partial.confidence,
            origin: partial.origin === undefined ? 'ai' : partial.origin,
            locked: partial.locked === undefined ? false : partial.locked,
            createdAt: now,
            createdAtFloor: floor,
            lastTouchedFloor: floor,
            userEditedFields: partial.userEditedFields || [],
            mergeHistory: [{ at: now, floor: floor, action: 'created', by: partial.origin || 'ai' }],
            notes: partial.notes === undefined ? '' : partial.notes
        };
        return e;
    }

    function nextId(ledger) {
        var n = ledger.counters.nextId++;
        var s = n.toString(36);
        while (s.length < 4) s = '0' + s;
        return 'fs_' + s;
    }

    // ─────────────────────────────────────────────────────────
    // 4. 三方合并
    // ─────────────────────────────────────────────────────────

    function mergeLedger(ledger, output, ctx) {
        ctx = ctx || {};
        var options = Object.assign({}, DEFAULT_MERGE_OPTIONS, ctx.options || {});
        var floor = ctx.floor === undefined ? 0 : ctx.floor;
        var now = ctx.now === undefined ? Date.now() : ctx.now;
        var strategy = options.strategy;

        var applied = [], candidates = [], conflicts = [];
        var patches = (output && Object.prototype.toString.call(output.patches) === '[object Array]') ? output.patches : [];

        for (var pi = 0; pi < patches.length; pi++) {
            var raw = patches[pi];
            if (!raw || typeof raw !== 'object' || !raw.op) {
                conflicts.push({ type: 'malformed_patch', index: pi, patch: raw });
                continue;
            }
            applyOne(raw, pi);
        }

        var run = {
            runId: 'run_' + (ledger.planningRuns.length + 1),
            at: now,
            fromFloor: (output && output.runMeta && output.runMeta.fromFloor !== undefined) ? output.runMeta.fromFloor : null,
            toFloor: (output && output.runMeta && output.runMeta.toFloor !== undefined) ? output.runMeta.toFloor : floor,
            tier: (output && output.runMeta && output.runMeta.tier) || 'standard',
            diff: { applied: applied.length, candidates: candidates.length, conflicts: conflicts.length }
        };
        ledger.planningRuns.push(run);

        return { applied: applied, candidates: candidates, conflicts: conflicts, run: run };

        // ── 内部 ──

        function findEntry(id) {
            var i;
            for (i = 0; i < ledger.active.length; i++) if (ledger.active[i].id === id) return ledger.active[i];
            for (i = 0; i < ledger.archive.length; i++) if (ledger.archive[i].id === id) return ledger.archive[i];
            return null;
        }

        function inArchive(id) {
            for (var i = 0; i < ledger.archive.length; i++) if (ledger.archive[i].id === id) return true;
            return false;
        }

        function collectEvidence(patch) {
            var out = [];
            if (typeof patch.evidence === 'string' && patch.evidence.trim()) out.push(patch.evidence.trim());
            var hs = (patch.fields && patch.fields.hints) || [];
            for (var i = 0; i < hs.length; i++) {
                if (hs[i] && typeof hs[i].evidence === 'string' && hs[i].evidence.trim()) out.push(hs[i].evidence.trim());
            }
            return out;
        }

        function replyTextFor(patchFloor) {
            var byFloor = ctx.replyTextByFloor || {};
            if (patchFloor !== null && patchFloor !== undefined && byFloor[patchFloor] !== undefined) return byFloor[patchFloor];
            if (byFloor[floor] !== undefined) return byFloor[floor];
            return ctx.currentReplyText || '';
        }

        function checkGrounding(patch, entry) {
            var evidences = collectEvidence(patch);
            if (!evidences.length) return { ok: false, reason: 'no_evidence' };
            var anchorTerms = entry ? toStrArray(entry.keywords).concat(toStrArray(entry.linkedEntities)) : [];
            var text = replyTextFor(patch.floor);
            var reasons = [];
            for (var i = 0; i < evidences.length; i++) {
                var r = groundEvidence(evidences[i], text, { minLength: options.minEvidenceLength, anchorTerms: anchorTerms });
                if (r.ok) return { ok: true, evidence: evidences[i], mode: r.mode };
                reasons.push(r.reason);
            }
            return { ok: false, reason: reasons[0] || 'not_grounded' };
        }

        function applyOne(patch, index) {
            switch (patch.op) {
                case 'create': return opCreate(patch, index);
                case 'update': return opUpdate(patch, index);
                case 'state': return opState(patch, index);
                case 'hint_used': return opHintUsed(patch, index);
                case 'reinforce':
                case 'activate': return opReinforce(patch, index);
                case 'abandon': return opAbandon(patch, index);
                case 'request_detail':
                    applied.push({ op: 'request_detail', id: patch.id, requestIds: patch.requestIds || [] });
                    return;
                default:
                    conflicts.push({ type: 'unknown_op', op: patch.op, index: index });
            }
        }

        function opCreate(patch, index) {
            var incoming = patch.entry || {};
            if (!incoming.title) {
                conflicts.push({ type: 'create_without_title', index: index, tempId: patch.tempId });
                return;
            }

            var best = null, bestScore = 0;
            var pool = ledger.active.concat(ledger.archive);
            for (var i = 0; i < pool.length; i++) {
                var s = dedupeScore(incoming, pool[i]);
                if (s > bestScore) { bestScore = s; best = pool[i]; }
            }

            if (best && bestScore >= options.duplicateThreshold) {
                var conflict = {
                    type: 'duplicate_suspect', index: index,
                    existing: best.id, existingTitle: best.title, incomingTitle: incoming.title,
                    score: Number(bestScore.toFixed(3)), resolvedAs: 'auto_merge', staged: false
                };
                conflicts.push(conflict);

                if (isTerminal(best.state) || best.locked) {
                    conflict.staged = true;
                    conflict.resolvedAs = 'needs_review';
                    conflict.reason = isTerminal(best.state) ? 'target_archived' : 'target_locked';
                    return;
                }
                applyFieldsTo(best, incoming, patch, index, { fromDuplicate: true });
                applied.push({ op: 'merged_duplicate', id: best.id, score: conflict.score, fromTitle: incoming.title });
                return;
            }

            if (best && bestScore >= options.suggestThreshold) {
                conflicts.push({
                    type: 'suggest_duplicate', index: index, tempId: patch.tempId,
                    existing: best.id, existingTitle: best.title, incomingTitle: incoming.title,
                    score: Number(bestScore.toFixed(3)), staged: true, needsReview: true,
                    pendingEntry: incoming,
                    options: [
                        { action: 'merge_into', targetId: best.id, label: '合并到「' + best.title + '」' },
                        { action: 'create_new', label: '作为新伏笔创建' }
                    ]
                });
                return;
            }

            var entry = createEntry(
                Object.assign({}, incoming, { id: nextId(ledger), origin: incoming.origin || 'ai' }),
                { now: now, floor: floor }
            );
            entry.hints = entry.hints.map(function (h) {
                return Object.assign({}, h, {
                    id: h.id || ('h_' + ledger.counters.nextHintId++),
                    text: h.text || '',
                    condition: h.condition || ''
                });
            });
            ledger.active.push(entry);
            applied.push({ op: 'create', id: entry.id, tempId: patch.tempId, title: entry.title });
        }

        function opUpdate(patch, index) {
            var target = findEntry(patch.id);
            if (!target) { conflicts.push({ type: 'unknown_id', id: patch.id, index: index }); return; }
            if (inArchive(target.id)) {
                conflicts.push({ type: 'update_archived', id: target.id, index: index, hint: '已归档条目不可修改' });
                return;
            }
            if (target.locked && !patch.force) {
                var keys = Object.keys(patch.fields || {});
                if (keys.length === 1 && keys[0] === 'hints') {
                    appendHints(target, patch.fields.hints || []);
                    applied.push({ op: 'append_hints_to_locked', id: target.id, count: (patch.fields.hints || []).length });
                    return;
                }
                conflicts.push({ type: 'locked_entry', id: target.id, index: index, keys: keys });
                return;
            }
            applyFieldsTo(target, patch.fields || {}, patch, index, {});
        }

        function appendHints(target, hints) {
            for (var i = 0; i < hints.length; i++) {
                var h = hints[i];
                target.hints.push({
                    id: h.id || ('h_' + ledger.counters.nextHintId++),
                    text: h.text || '',
                    condition: h.condition || '',
                    used: false,
                    usedAt: null
                });
            }
        }

        function applyFieldsTo(target, fields, patch, index, meta) {
            if (Object.prototype.toString.call(fields.hints) === '[object Array]') {
                appendHints(target, fields.hints);
                applied.push({ op: 'hint_added', id: target.id, count: fields.hints.length });
            }

            if (fields.secret && typeof fields.secret === 'object') {
                if (target.state === 'planned' || (meta && meta.secretAllowed)) {
                    Object.assign(target.secret, fields.secret);
                    applied.push({ op: 'secret_updated', id: target.id });
                } else {
                    conflicts.push({
                        type: 'secret_after_plant', id: target.id, index: index,
                        hint: '已埋设的伏笔不允许改写秘密（会与已注入的正文矛盾）'
                    });
                }
            }

            if (fields.plant && typeof fields.plant === 'object') applyNestedPath(target, 'plant', fields.plant, patch, index);
            if (fields.recovery && typeof fields.recovery === 'object') applyNestedPath(target, 'recovery', fields.recovery, patch, index);

            if (Object.prototype.toString.call(fields.knows) === '[object Array]') {
                target.knows = fields.knows;
                applied.push({ op: 'knows_updated', id: target.id });
            }
            if (fields.contract && typeof fields.contract === 'object') {
                Object.assign(target.contract, fields.contract);
                applied.push({ op: 'contract_updated', id: target.id });
            }

            var touched = [];
            for (var key in fields) {
                if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
                if (PROTECTED_FIELDS[key]) continue;
                if (!FIELD_COERCE[key]) continue;
                if (target.userEditedFields && target.userEditedFields.indexOf(key) !== -1) {
                    conflicts.push({ type: 'user_edited_field', id: target.id, key: key, index: index });
                    continue;
                }
                var value = FIELD_COERCE[key](fields[key]);
                if (key === 'reinforceInterval' && value === null) continue;
                if (target[key] !== value) { target[key] = value; touched.push(key); }
            }

            if (touched.length) {
                target.mergeHistory.push({ at: now, floor: floor, action: 'patched', keys: touched });
                applied.push({ op: 'update', id: target.id, keys: touched });
            }
        }

        function applyNestedPath(target, section, fields, patch, index) {
            for (var key in fields) {
                if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
                var path = section + '.' + key;

                if (target.userEditedFields && target.userEditedFields.indexOf(path) !== -1) {
                    conflicts.push({ type: 'user_edited_field', id: target.id, key: path, index: index });
                    continue;
                }

                if (MONOTONIC_PATHS.indexOf(path) !== -1) {
                    var existing = getPath(target, path);
                    var incoming = (key === 'resolution' || key === 'evidence') ? fields[key] : toIntOrNull(fields[key]);
                    if (existing !== null && existing !== undefined && incoming !== null &&
                        JSON.stringify(existing) !== JSON.stringify(incoming)) {
                        conflicts.push({
                            type: 'monotonic_violation', id: target.id, key: path,
                            existing: existing, incoming: incoming, index: index
                        });
                        continue;
                    }
                    if (existing === null || existing === undefined) setPath(target, path, incoming);
                    continue;
                }

                if (SHIFT_PATHS.indexOf(path) !== -1) {
                    var ex = getPath(target, path);
                    var inc = toIntOrNull(fields[key]);
                    if (ex !== null && ex !== undefined && inc !== null && Math.abs(ex - inc) > options.shiftThreshold) {
                        conflicts.push({
                            type: 'large_shift', id: target.id, key: path,
                            existing: ex, incoming: inc, delta: Math.abs(ex - inc),
                            reason: patch.reason || '', staged: true
                        });
                        if (strategy !== 'auto' && !patch.force) continue;
                    }
                    setPath(target, path, inc);
                    continue;
                }

                if (Object.prototype.toString.call(fields[key]) === '[object Array]') {
                    setPath(target, path, toStrArray(fields[key]));
                } else {
                    setPath(target, path, fields[key]);
                }
            }
        }

        function opState(patch, index) {
            var target = findEntry(patch.id);
            if (!target) { conflicts.push({ type: 'unknown_id', id: patch.id, index: index }); return; }
            if (target.locked && !patch.force) {
                conflicts.push({ type: 'locked_entry', id: target.id, index: index, to: patch.to });
                return;
            }
            if (!isLegalTransition(target.state, patch.to)) {
                conflicts.push({
                    type: 'illegal_transition', id: target.id, from: target.state, to: patch.to, index: index,
                    hint: isTerminal(target.state) ? '终态不可复活（铁律 3）' : undefined
                });
                return;
            }

            var needsEvidence = (patch.to === 'planted' || patch.to === 'resolved');
            if (needsEvidence && !patch.force) {
                var g = checkGrounding(patch, target);
                if (!g.ok) {
                    candidates.push({
                        type: 'state_proposal', id: target.id, from: target.state, to: patch.to,
                        floor: patch.floor === undefined ? floor : patch.floor,
                        reason: g.reason, evidence: collectEvidence(patch)[0] || null
                    });
                    return;
                }
                recordStateChange(target, patch, index, g);
                return;
            }
            recordStateChange(target, patch, index, null);
        }

        function recordStateChange(target, patch, index, grounding) {
            var patchFloor = patch.floor === undefined ? floor : patch.floor;
            var from = target.state;

            if (patch.to === 'planted' || patch.to === 'reinforced') target.plant.status = 'done';
            if (patch.to === 'reinforced') {
                target.reinforcements.push({
                    floor: patchFloor, messageId: patch.messageId === undefined ? patchFloor : patch.messageId,
                    type: patch.reinforceType || 'reminder', note: patch.reason || ''
                });
                target.nextReinforceFloor = patchFloor + (target.reinforceInterval || 45);
            }
            if (patch.to === 'resolved' || patch.to === 'abandoned' || patch.to === 'contradicted') {
                if (target.recovery.actualFloor === null || target.recovery.actualFloor === undefined) target.recovery.actualFloor = patchFloor;
                if (!target.recovery.resolution) target.recovery.resolution = patch.reason || patch.to;
            }
            if (patch.to === 'planted') {
                if (target.plant.actualFloor === null || target.plant.actualFloor === undefined) target.plant.actualFloor = patchFloor;
                if (target.plant.actualMessageId === null || target.plant.actualMessageId === undefined) {
                    target.plant.actualMessageId = patch.messageId === undefined ? patchFloor : patch.messageId;
                }
                if (!target.plant.evidence) {
                    target.plant.evidence = (grounding && grounding.evidence) || collectEvidence(patch)[0] || null;
                }
            }

            target.state = patch.to;
            target.lastTouchedFloor = patchFloor;
            target.mergeHistory.push({
                at: now, floor: patchFloor, action: 'state:' + from + '->' + patch.to,
                by: 'ai', evidence: (grounding && grounding.evidence) || null
            });

            applied.push({
                op: 'state', id: target.id, from: from, to: patch.to,
                floor: patchFloor, grounded: (grounding && grounding.mode) || null
            });

            if (isTerminal(patch.to)) archiveEntry(target);
        }

        function archiveEntry(entry) {
            var i = ledger.active.indexOf(entry);
            if (i >= 0) ledger.active.splice(i, 1);
            for (var j = 0; j < ledger.archive.length; j++) if (ledger.archive[j].id === entry.id) return;
            ledger.archive.push(entry);
        }

        function opHintUsed(patch, index) {
            var target = findEntry(patch.id);
            if (!target) { conflicts.push({ type: 'unknown_id', id: patch.id, index: index }); return; }
            var hint = null;
            for (var i = 0; i < target.hints.length; i++) if (target.hints[i].id === patch.hintId) hint = target.hints[i];
            if (!hint) { conflicts.push({ type: 'unknown_hint', id: target.id, hintId: patch.hintId, index: index }); return; }
            if (hint.used) { conflicts.push({ type: 'hint_already_used', id: target.id, hintId: patch.hintId, index: index }); return; }

            var g = checkGrounding(patch, target);
            if (!g.ok && !patch.force) {
                candidates.push({
                    type: 'hint_used_proposal', id: target.id, hintId: patch.hintId,
                    floor: patch.floor === undefined ? floor : patch.floor, reason: g.reason
                });
                return;
            }

            hint.used = true;
            hint.usedAt = patch.floor === undefined ? floor : patch.floor;
            target.lastTouchedFloor = hint.usedAt;
            target.mergeHistory.push({ at: now, floor: hint.usedAt, action: 'hint_used', hintId: hint.id });
            applied.push({ op: 'hint_used', id: target.id, hintId: hint.id, floor: hint.usedAt });
        }

        function opReinforce(patch, index) {
            var target = findEntry(patch.id);
            if (!target) { conflicts.push({ type: 'unknown_id', id: patch.id, index: index }); return; }
            if (target.locked && !patch.force) { conflicts.push({ type: 'locked_entry', id: target.id, index: index }); return; }
            var patchFloor = patch.floor === undefined ? floor : patch.floor;
            target.reinforcements.push({
                floor: patchFloor, messageId: patch.messageId === undefined ? patchFloor : patch.messageId,
                type: patch.reinforceType || 'reminder', note: patch.reason || ''
            });
            target.nextReinforceFloor = patchFloor + (target.reinforceInterval || 45);
            target.lastTouchedFloor = patchFloor;
            if (target.state === 'planted') target.state = 'reinforced';
            target.mergeHistory.push({ at: now, floor: patchFloor, action: 'reinforced' });
            applied.push({ op: 'reinforce', id: target.id, floor: patchFloor, total: target.reinforcements.length });
        }

        function opAbandon(patch, index) {
            var target = findEntry(patch.id);
            if (!target) { conflicts.push({ type: 'unknown_id', id: patch.id, index: index }); return; }
            if (target.locked && !patch.force) { conflicts.push({ type: 'locked_entry', id: target.id, index: index }); return; }
            if (isTerminal(target.state)) {
                conflicts.push({ type: 'illegal_transition', id: target.id, from: target.state, to: 'abandoned', index: index });
                return;
            }
            if (!patch.reason) { conflicts.push({ type: 'abandon_without_reason', id: target.id, index: index }); return; }
            var patchFloor = patch.floor === undefined ? floor : patch.floor;
            var from = target.state;
            target.state = 'abandoned';
            if (!target.recovery.resolution) target.recovery.resolution = patch.reason;
            if (target.recovery.actualFloor === null || target.recovery.actualFloor === undefined) target.recovery.actualFloor = patchFloor;
            target.lastTouchedFloor = patchFloor;
            target.mergeHistory.push({ at: now, floor: patchFloor, action: 'state:' + from + '->abandoned', reason: patch.reason });
            archiveEntry(target);
            applied.push({ op: 'abandon', id: target.id, floor: patchFloor, reason: patch.reason });
        }
    }

    // ─────────────────────────────────────────────────────────
    // 5. 压缩台账视图
    // ─────────────────────────────────────────────────────────

    function isOverdue(entry, floor) {
        if (isTerminal(entry.state)) return false;
        var end = entry.recovery.windowEnd;
        if (end === null || end === undefined) end = entry.recovery.targetFloor;
        return end !== null && end !== undefined && floor > end;
    }

    function isDueSoon(entry, floor, lead) {
        if (lead === undefined) lead = 10;
        if (isTerminal(entry.state)) return false;
        var start = entry.recovery.windowStart;
        if (start === null || start === undefined) start = entry.recovery.targetFloor;
        if (start === null || start === undefined) return false;
        var end = entry.recovery.windowEnd;
        if (end === null || end === undefined) end = start;
        return floor >= start - lead && floor <= end;
    }

    function buildCompactView(ledger, ctx) {
        ctx = ctx || {};
        var floor = ctx.floor === undefined ? 0 : ctx.floor;
        var lines = [
            '[既有伏笔台账 · 压缩视图]',
            '（这是你上一轮的规划结论，属【可修改的既有规划】，不是不可质疑的世界事实）',
            ''
        ];

        if (!ledger.active.length) {
            lines.push('（暂无活跃伏笔）');
        }

        for (var i = 0; i < ledger.active.length; i++) {
            var e = ledger.active[i];
            var detail = [];
            if (e.plant.actualFloor !== null && e.plant.actualFloor !== undefined) detail.push('已埋于 ' + e.plant.actualFloor + ' 楼');
            else if (e.plant.targetFloor !== null && e.plant.targetFloor !== undefined) detail.push('计划埋设 ' + e.plant.targetFloor + ' 楼');

            if (e.reinforcements.length) {
                var last = e.reinforcements[e.reinforcements.length - 1];
                detail.push('已强化 ' + e.reinforcements.length + ' 次（最近 ' + last.floor + ' 楼）');
            }
            if (e.recovery.targetFloor !== null && e.recovery.targetFloor !== undefined) {
                detail.push('计划回收 ' + e.recovery.targetFloor + ' 楼');
            }
            if (e.recovery.windowStart !== null && e.recovery.windowEnd !== null &&
                e.recovery.windowStart !== undefined && e.recovery.windowEnd !== undefined) {
                detail.push('回收窗口 ' + e.recovery.windowStart + '-' + e.recovery.windowEnd);
            }
            detail.push('重要度 ' + e.importance);
            if (e.locked) detail.push('🔒用户锁定');
            if (isOverdue(e, floor)) detail.push('⚠️已过期');

            lines.push('#' + e.id + ' [' + e.state + '] ' + e.title);
            lines.push('  ' + detail.join(' | '));
        }

        lines.push('');
        lines.push('说明：以上条目只能通过 patches 的 update/state/abandon 操作修改，必须引用真实存在的 id。');
        return lines.join('\n');
    }

    // ─────────────────────────────────────────────────────────
    // 6. 调度与紧迫度
    // ─────────────────────────────────────────────────────────

    function urgency(entry, floor, weights) {
        weights = weights || DEFAULT_URGENCY_WEIGHTS;
        if (isTerminal(entry.state)) return -Infinity;

        var interval = entry.reinforceInterval || 45;
        var next = entry.nextReinforceFloor;
        if (next === null || next === undefined) next = entry.plant.actualFloor;
        if (next === null || next === undefined) next = entry.plant.targetFloor;
        if (next === null || next === undefined) next = 0;

        var overdueRatio = Math.max(0, (floor - next) / interval);
        var lastTouch = entry.lastTouchedFloor;
        if (lastTouch === null || lastTouch === undefined) lastTouch = entry.createdAtFloor || 0;
        var silenceRatio = Math.min(1, (floor - lastTouch) / (interval * 2));

        var lastReinforce = entry.reinforcements.length
            ? entry.reinforcements[entry.reinforcements.length - 1].floor : -Infinity;
        var recentPenalty = (floor - lastReinforce < 20) ? 1 : 0;

        return weights.overdue * overdueRatio
            + weights.importance * (entry.importance || 0.5)
            + weights.silence * silenceRatio
            - weights.recentPenalty * recentPenalty;
    }

    function buildSchedule(ledger, ctx) {
        ctx = ctx || {};
        var floor = ctx.floor === undefined ? 0 : ctx.floor;
        var max = ctx.max === undefined ? 3 : ctx.max;
        var minGap = ctx.minGap === undefined ? 20 : ctx.minGap;

        var scored = [];
        for (var i = 0; i < ledger.active.length; i++) {
            var e = ledger.active[i];
            var score = urgency(e, floor);
            if (!isFinite(score) || score <= 0) continue;
            var last = e.reinforcements.length ? e.reinforcements[e.reinforcements.length - 1].floor : null;
            if (last !== null && floor - last < minGap && (e.importance || 0) <= 0.9) continue;
            scored.push({ entry: e, score: score });
        }

        scored.sort(function (a, b) { return b.score - a.score; });
        scored = scored.slice(0, max);

        return scored.map(function (item) {
            var e = item.entry;
            var unused = null;
            for (var j = 0; j < e.hints.length; j++) if (!e.hints[j].used) { unused = e.hints[j]; break; }
            var action = (isDueSoon(e, floor) && e.state !== 'planned') ? 'recall'
                : (e.state === 'planned' ? 'plant' : 'remind');
            return {
                id: e.id, title: e.title, action: action,
                instruction: unused ? unused.text : (e.recovery.goal || e.title),
                hintId: unused ? unused.id : null,
                subtlety: e.subtlety,
                score: Number(item.score.toFixed(3))
            };
        });
    }

    // ─────────────────────────────────────────────────────────
    // 7. 提示词渲染
    // ─────────────────────────────────────────────────────────

    var STATE_LABEL = {
        planned: '已规划', planted: '已埋设', reinforced: '已强化',
        resolved: '已回收', abandoned: '已放弃', contradicted: '已冲突'
    };
    var ACTION_LABEL = {
        plant: '植入', remind: '提及', recall: '回收',
        escalate: '加剧', misdirect: '误导', callback: '呼应'
    };
    var KNOWN_LABEL = {
        none: '完全不知情', partial: '部分知情', full: '完全知情',
        false_belief: '坚信一个错误版本'
    };
    var ATTITUDE_LABEL = {
        unaware: '无察觉', suspicious: '起疑', concealing: '正在隐瞒',
        lying: '正在说谎', protecting: '在保护某人', rationalizing: '自我合理化'
    };

    function renderIndex(ledger, ctx) {
        ctx = ctx || {};
        var floor = ctx.floor === undefined ? 0 : ctx.floor;
        if (!ledger.active.length) return '';

        var lines = ['[伏笔索引 · 内部调度表 · 不要引用本表，不要提及"伏笔"二字]', '活跃线索：'];
        for (var i = 0; i < ledger.active.length; i++) {
            var e = ledger.active[i];
            var bits = [STATE_LABEL[e.state] || e.state];
            if (e.reinforcements.length) bits.push('已提' + e.reinforcements.length + '次');
            if (e.recovery.targetFloor !== null && e.recovery.targetFloor !== undefined) {
                bits.push('计划 ' + e.recovery.targetFloor + ' 楼回收');
            }
            var tail = '';
            if (isOverdue(e, floor)) tail = '，⚠已过期';
            else if (isDueSoon(e, floor)) tail = '，即将到期';
            lines.push('· ' + e.title + '（' + bits.join('，') + tail + '）');
        }
        lines.push('规则：不得提前揭示任何真相；细节须由场景自然承载；时机不合可以跳过，跳过优于硬塞。');
        return lines.join('\n');
    }

    function renderSchedule(schedule, ctx) {
        if (!schedule || !schedule.length) return '';
        var lines = ['[本轮调度 · 只执行动作，不要解释原因，不要点明关联]'];
        for (var i = 0; i < schedule.length; i++) {
            var s = schedule[i];
            var subtle = s.subtlety >= 0.7 ? '极其克制，不可点明' : (s.subtlety >= 0.4 ? '轻描淡写' : '可以稍明显');
            lines.push((i + 1) + '. 【' + (ACTION_LABEL[s.action] || s.action) + '】' + s.instruction + '（' + subtle + '）');
        }
        lines.push('本轮若场景不允许，可跳过任何一条，无需说明。');
        return lines.join('\n');
    }

    function renderContract(entries, ctx) {
        var hits = [];
        for (var i = 0; i < entries.length; i++) {
            var c = entries[i].contract;
            if (c && ((c.invariants && c.invariants.length) || (c.tabooPhrases && c.tabooPhrases.length) ||
                (c.statedFacts && c.statedFacts.length))) hits.push(entries[i]);
        }
        if (!hits.length) return '';

        var lines = ['[认知约束 · 内部导演说明 · 不要提及本段]'];
        for (var j = 0; j < hits.length; j++) {
            var e = hits[j];
            var involved = [];
            for (var k = 0; k < (e.knows || []).length; k++) {
                var kn = e.knows[k];
                if (!kn.level || kn.level === 'none') continue;
                var label = kn.entity + '（' + (KNOWN_LABEL[kn.level] || kn.level);
                if (kn.attitude) label += '，' + (ATTITUDE_LABEL[kn.attitude] || kn.attitude);
                label += '）';
                involved.push(label);
            }
            if (involved.length) lines.push('当前场景涉及：' + involved.join('、'));

            if (e.contract.invariants && e.contract.invariants.length) {
                lines.push('演出要求：');
                for (var m = 0; m < e.contract.invariants.length; m++) lines.push('· ' + e.contract.invariants[m]);
            }
            if (e.contract.tabooPhrases && e.contract.tabooPhrases.length) {
                lines.push('· 不要使用这类词：' + e.contract.tabooPhrases.join('、'));
            }
            if (e.contract.statedFacts && e.contract.statedFacts.length) {
                lines.push('已发生且不得矛盾：');
                for (var n = 0; n < e.contract.statedFacts.length; n++) lines.push('· ' + e.contract.statedFacts[n]);
            }
        }
        return lines.join('\n');
    }

    function renderPulseProtocol(candidates) {
        if (!candidates || !candidates.length) return '';
        var names = candidates.map(function (c) { return c.title + '(' + c.id + ')'; }).join('、');
        return '[履约报告 · 仅在你确认本轮正文真的完成了以下事项时才写，否则整行省略]\n'
            + '候选事项：' + names + '\n'
            + '若本轮确实回收/强化了某条线，在正文最后另起一行写：\n'
            + '<!--FSP|{id}|{done|reinforce}|{从正文中逐字复制的那句话，8字以上}-->\n'
            + '要求：\n'
            + '· 复制的那句话必须【逐字】出现在本轮正文里，程序会做子串校验，编造无效。\n'
            + '· 没有真正完成就不要写这一行。宁可漏报，也不要虚报。\n'
            + '· 这一行不会显示给用户，不必为了好看而写。';
    }

    function renderEntryDetail(entry) {
        var lines = ['[伏笔详情 · 仅本条 · 不要引用本表]', '标题：' + entry.title];
        lines.push('当前状态：' + (STATE_LABEL[entry.state] || entry.state));
        if (entry.recovery.goal) lines.push('目标：' + entry.recovery.goal);
        var unused = (entry.hints || []).filter(function (h) { return !h.used; });
        if (unused.length) {
            lines.push('可用细节：');
            for (var i = 0; i < unused.length; i++) {
                lines.push('· ' + unused[i].text + (unused[i].condition ? '（时机：' + unused[i].condition + '）' : ''));
            }
        }
        lines.push('重申：不得提前揭示真相；以上细节须由场景自然承载。');
        return lines.join('\n');
    }

    function detectContractTriggers(ledger, ctx) {
        ctx = ctx || {};
        var recentText = String(ctx.recentChatText || '');
        var forced = ctx.forceContractIds || [];
        var CONFRONT = ['问', '追问', '为什么', '那天', '那晚', '你到底', '说实话', '解释', '究竟'];
        var DESC = /^(老|小|大|阿|某|那个|这位|那位|年轻的|年迈的)/;

        function norm(s) { return String(s || '').trim().replace(DESC, ''); }

        var out = [];
        for (var i = 0; i < ledger.active.length; i++) {
            var e = ledger.active[i];
            if (forced.indexOf(e.id) !== -1) { out.push(e); continue; }
            if (!e.knows || !e.knows.length) continue;

            var actorHit = false;
            for (var j = 0; j < e.knows.length; j++) {
                var k = e.knows[j];
                if (['concealing', 'lying', 'protecting', 'rationalizing'].indexOf(k.attitude) === -1) continue;
                var entity = String(k.entity || '').trim();
                if (!entity) continue;
                if (recentText.indexOf(entity) !== -1 ||
                    (norm(entity) && recentText.indexOf(norm(entity)) !== -1)) { actorHit = true; break; }
            }
            if (actorHit) { out.push(e); continue; }

            var hasKnower = false;
            for (var m = 0; m < e.knows.length; m++) {
                if (e.knows[m].level && e.knows[m].level !== 'none') { hasKnower = true; break; }
            }
            if (hasKnower) {
                for (var n = 0; n < CONFRONT.length; n++) {
                    if (recentText.indexOf(CONFRONT[n]) !== -1) { out.push(e); break; }
                }
            }
        }
        return out;
    }

    function buildPulseCandidates(ledger, ctx) {
        ctx = ctx || {};
        var floor = ctx.floor === undefined ? 0 : ctx.floor;
        var lead = ctx.pulseLead === undefined ? 15 : ctx.pulseLead;
        var out = [];
        for (var i = 0; i < ledger.active.length; i++) {
            var e = ledger.active[i];
            if (e.state !== 'planted' && e.state !== 'reinforced') continue;
            if (isDueSoon(e, floor, lead) || isOverdue(e, floor)) out.push({ id: e.id, title: e.title });
        }
        return out;
    }

    // ─────────────────────────────────────────────────────────
    // 导出
    // ─────────────────────────────────────────────────────────

    window.FSPCore = {
        // 常量
        STATES: STATES,
        TRANSITIONS: TRANSITIONS,
        DEFAULT_MERGE_OPTIONS: DEFAULT_MERGE_OPTIONS,
        STATE_LABEL: STATE_LABEL,
        ACTION_LABEL: ACTION_LABEL,
        KNOWN_LABEL: KNOWN_LABEL,
        ATTITUDE_LABEL: ATTITUDE_LABEL,

        // 工具
        normalizeText: normalizeText,
        similarity: similarity,
        dedupeScore: dedupeScore,
        clamp01: clamp01,
        toIntOrNull: toIntOrNull,
        toStrArray: toStrArray,

        // 校验
        groundEvidence: groundEvidence,
        containsSecret: containsSecret,
        isLegalTransition: isLegalTransition,
        isTerminal: isTerminal,
        isOverdue: isOverdue,
        isDueSoon: isDueSoon,

        // 台账
        createLedger: createLedger,
        createEntry: createEntry,
        nextId: nextId,
        mergeLedger: mergeLedger,
        buildCompactView: buildCompactView,

        // 调度
        urgency: urgency,
        buildSchedule: buildSchedule,

        // 渲染
        renderIndex: renderIndex,
        renderSchedule: renderSchedule,
        renderContract: renderContract,
        renderPulseProtocol: renderPulseProtocol,
        renderEntryDetail: renderEntryDetail,
        detectContractTriggers: detectContractTriggers,
        buildPulseCandidates: buildPulseCandidates
    };
})();

/* ========================================================================
 * 以下来自 app.js
 * 集成层：采集 / 规划器 / 分层注入 / 持久化 / 落拍感应 / 事件
 * ======================================================================== */

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

/* ========================================================================
 * 以下来自 ui.js
 * 界面层：悬浮球 + 五页签面板
 * ======================================================================== */

/**
 * 伏笔引擎 · 界面层
 *
 * 结构：悬浮球（右下角）→ 点击弹出面板
 * 面板五个标签页：台账 / 规划 / 注入预览 / 历史 / 设置
 *
 * 为什么样式全部内联为 <style> 字符串：酒馆扩展的 CSS 文件加载路径在不同版本/平台上
 * 表现不一致（尤其安卓 WebView）。内联一份可确保「装上就有样子」，不依赖外部文件。
 * 同时也会尝试加载同目录的 style.css，加载不到不影响可用性。
 *
 * 挂载点：window.FSPUI
 */
(function () {
    'use strict';

    var I = window.FSPIntegration;
    var C = window.FSPCore;
    if (!I || !C) {
        console.error('[伏笔引擎] 依赖未就绪，界面层中止');
        return;
    }

    var $ = {
        btn: null,
        panel: null,
        overlay: null,
        activeTab: 'ledger',
        busy: false,
        mount: null
    };

    // ─────────────────────────────────────────────────────────
    // 样式
    // ─────────────────────────────────────────────────────────

    var CSS = [
        '.fsp-fab{position:fixed;z-index:9998;width:46px;height:46px;border-radius:50%;',
        'display:flex;align-items:center;justify-content:center;cursor:pointer;',
        'background:linear-gradient(145deg,#3b3b46,#25252c);border:1.5px solid rgba(255,190,90,.45);',
        'box-shadow:0 4px 14px rgba(0,0,0,.45);font-size:20px;line-height:1;user-select:none;',
        'transition:transform .15s ease,box-shadow .15s ease;touch-action:manipulation}',
        '.fsp-fab:hover{transform:scale(1.08);box-shadow:0 6px 20px rgba(0,0,0,.55)}',
        '.fsp-fab.fsp-busy{animation:fsp-pulse 1s ease-in-out infinite}',
        '@keyframes fsp-pulse{0%,100%{box-shadow:0 4px 14px rgba(0,0,0,.45)}50%{box-shadow:0 0 0 8px rgba(255,190,90,.18)}}',
        '.fsp-fab .fsp-badge{position:absolute;top:-4px;right:-4px;min-width:18px;height:18px;',
        'border-radius:9px;background:#e5484d;color:#fff;font-size:11px;line-height:18px;',
        'text-align:center;padding:0 4px;font-weight:700;display:none}',
        '.fsp-fab .fsp-badge.fsp-show{display:block}',

        '.fsp-overlay{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.55);',
        'display:none;align-items:center;justify-content:center;padding:12px;box-sizing:border-box}',
        '.fsp-overlay.fsp-open{display:flex}',

        '.fsp-panel{width:100%;max-width:720px;max-height:88vh;display:none;flex-direction:column;',
        'background:#1c1c21;color:#e6e6ea;border:1px solid rgba(255,255,255,.12);border-radius:12px;',
        'box-shadow:0 18px 50px rgba(0,0,0,.6);font-size:13px;overflow:hidden}',
        '.fsp-panel.fsp-open{display:flex}',

        '.fsp-head{display:flex;align-items:center;gap:8px;padding:10px 12px;',
        'border-bottom:1px solid rgba(255,255,255,.1);background:#232329;flex:0 0 auto}',
        '.fsp-title{font-weight:700;font-size:14px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.fsp-scope{font-size:11px;opacity:.55;font-weight:400}',

        '.fsp-tabs{display:flex;gap:2px;padding:6px 8px 0;background:#232329;flex:0 0 auto;overflow-x:auto}',
        '.fsp-tab{padding:7px 12px;border-radius:7px 7px 0 0;cursor:pointer;white-space:nowrap;',
        'opacity:.6;border:1px solid transparent;border-bottom:none;user-select:none}',
        '.fsp-tab:hover{opacity:.85}',
        '.fsp-tab.fsp-on{opacity:1;background:#1c1c21;border-color:rgba(255,255,255,.12);font-weight:600}',

        '.fsp-body{flex:1 1 auto;overflow-y:auto;padding:12px;-webkit-overflow-scrolling:touch}',
        '.fsp-sec{margin-bottom:16px}',
        '.fsp-sec>h4{margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:.04em;',
        'text-transform:uppercase;opacity:.6}',

        '.fsp-card{border:1px solid rgba(255,255,255,.1);border-radius:9px;padding:9px 10px;',
        'margin-bottom:8px;background:rgba(255,255,255,.025)}',
        '.fsp-card.fsp-locked{border-color:rgba(255,190,90,.45)}',
        '.fsp-card-top{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap}',
        '.fsp-id{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;opacity:.45}',
        '.fsp-name{font-weight:600;flex:1;min-width:120px}',
        '.fsp-meta{font-size:11px;opacity:.62;margin-top:4px;line-height:1.6}',
        '.fsp-goal{font-size:12px;margin-top:5px;padding-left:8px;border-left:2px solid rgba(255,190,90,.4);opacity:.85}',
        '.fsp-hintline{font-size:11px;opacity:.6;margin-top:3px}',

        '.fsp-tag{display:inline-block;padding:1px 6px;border-radius:5px;font-size:10px;font-weight:700}',
        '.fsp-t-planned{background:rgba(120,140,255,.2);color:#9db0ff}',
        '.fsp-t-planted{background:rgba(90,200,140,.2);color:#68d69b}',
        '.fsp-t-reinforced{background:rgba(255,200,90,.2);color:#ffc85a}',
        '.fsp-t-resolved{background:rgba(150,150,160,.2);color:#a8a8b2}',
        '.fsp-t-abandoned{background:rgba(200,90,90,.2);color:#e08a8a}',
        '.fsp-t-contradicted{background:rgba(200,90,90,.2);color:#e08a8a}',
        '.fsp-overdue{background:rgba(229,72,77,.25);color:#ff8f92;padding:1px 6px;border-radius:5px;font-size:10px;font-weight:700}',

        '.fsp-btn{display:inline-block;padding:5px 10px;border-radius:6px;cursor:pointer;font-size:11px;',
        'border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.05);color:inherit;',
        'margin:3px 3px 0 0;user-select:none;transition:background .12s}',
        '.fsp-btn:hover{background:rgba(255,255,255,.12)}',
        '.fsp-btn.fsp-primary{background:rgba(90,200,140,.18);border-color:rgba(90,200,140,.5);color:#7ee0a8}',
        '.fsp-btn.fsp-primary:hover{background:rgba(90,200,140,.3)}',
        '.fsp-btn.fsp-danger{background:rgba(229,72,77,.15);border-color:rgba(229,72,77,.45);color:#ff9a9c}',
        '.fsp-btn.fsp-danger:hover{background:rgba(229,72,77,.28)}',
        '.fsp-btn.fsp-ghost{opacity:.75}',
        '.fsp-btn.fsp-disabled{opacity:.35;pointer-events:none}',

        '.fsp-row{display:flex;gap:8px;align-items:center;margin-bottom:9px;flex-wrap:wrap}',
        '.fsp-row>label{flex:0 0 auto;min-width:104px;font-size:12px;opacity:.75}',
        '.fsp-row>input[type=text],.fsp-row>input[type=password],.fsp-row>input[type=number],.fsp-row>select,.fsp-row>textarea{',
        'flex:1;min-width:120px;background:#15151a;color:#e6e6ea;border:1px solid rgba(255,255,255,.14);',
        'border-radius:6px;padding:6px 8px;font-size:12px;font-family:inherit}',
        '.fsp-row>textarea{min-height:70px;resize:vertical;width:100%}',
        '.fsp-row>input[type=checkbox]{width:16px;height:16px;accent-color:#5ac88c}',
        '.fsp-note{font-size:11px;opacity:.5;line-height:1.6;margin:-4px 0 10px}',

        '.fsp-pre{background:#141419;border:1px solid rgba(255,255,255,.1);border-radius:7px;padding:8px;',
        'font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;white-space:pre-wrap;',
        'word-break:break-word;max-height:230px;overflow:auto;line-height:1.55}',
        '.fsp-empty{opacity:.45;font-size:12px;padding:10px 0;text-align:center}',
        '.fsp-warn{border-left:3px solid #e5b34d;background:rgba(229,179,77,.09);padding:7px 9px;',
        'border-radius:5px;font-size:11.5px;line-height:1.65;margin-bottom:8px}',
        '.fsp-crit{border-left:3px solid #e5484d;background:rgba(229,72,77,.09);padding:7px 9px;',
        'border-radius:5px;font-size:11.5px;line-height:1.65;margin-bottom:8px}',
        '.fsp-ok{border-left:3px solid #5ac88c;background:rgba(90,200,140,.09);padding:7px 9px;',
        'border-radius:5px;font-size:11.5px;line-height:1.65;margin-bottom:8px}',
        '.fsp-kv{display:flex;gap:8px;font-size:11.5px;margin-bottom:3px}',
        '.fsp-kv>b{flex:0 0 auto;min-width:78px;opacity:.6;font-weight:600}',

        '@media (max-width:600px){.fsp-panel{max-height:94vh;font-size:12.5px}',
        '.fsp-row>label{min-width:100%;margin-bottom:2px}.fsp-head{padding:8px 10px}}'
    ].join('');

    function injectStyle() {
        if (document.getElementById('fsp-style')) return;
        var st = document.createElement('style');
        st.id = 'fsp-style';
        st.textContent = CSS;
        document.head.appendChild(st);

        // 顺带尝试加载同目录 style.css（可选增强，失败无影响）
        try {
            var own = document.currentScript && document.currentScript.src;
            if (own && own.indexOf('/third-party/') !== -1) {
                var href = own.replace(/[^/]+$/, '') + 'style.css';
                if (!document.querySelector('link[data-fsp-css]')) {
                    var link = document.createElement('link');
                    link.rel = 'stylesheet';
                    link.href = href;
                    link.setAttribute('data-fsp-css', '1');
                    document.head.appendChild(link);
                }
            }
        } catch (e) { /* ignore */ }
    }

    // ─────────────────────────────────────────────────────────
    // DOM 小工具
    // ─────────────────────────────────────────────────────────

    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined && text !== null) n.textContent = String(text);
        return n;
    }

    function btn(label, cls, onClick) {
        var b = el('button', 'fsp-btn' + (cls ? ' ' + cls : ''), label);
        b.type = 'button';
        b.addEventListener('click', function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            try { onClick(ev); } catch (e) { console.error('[伏笔引擎]', e); I.toast('操作出错：' + e.message, 'error'); }
        });
        return b;
    }

    function row(labelText, input) {
        var r = el('div', 'fsp-row');
        if (labelText) r.appendChild(el('label', null, labelText));
        r.appendChild(input);
        return r;
    }

    function textInput(value, onChange, type) {
        var i = el('input');
        i.type = type || 'text';
        i.value = value === undefined || value === null ? '' : value;
        i.addEventListener('change', function () { onChange(i.value); });
        return i;
    }

    function numInput(value, onChange, min, max, step) {
        var i = el('input');
        i.type = 'number';
        if (min !== undefined) i.min = min;
        if (max !== undefined) i.max = max;
        if (step !== undefined) i.step = step;
        i.value = value;
        i.addEventListener('change', function () {
            var n = Number(i.value);
            if (!isFinite(n)) return;
            if (min !== undefined && n < min) n = min;
            if (max !== undefined && n > max) n = max;
            onChange(n);
        });
        return i;
    }

    function checkInput(checked, onChange) {
        var i = el('input');
        i.type = 'checkbox';
        i.checked = !!checked;
        i.addEventListener('change', function () { onChange(i.checked); });
        return i;
    }

    function select(options, value, onChange) {
        var s = el('select');
        for (var k in options) {
            if (!Object.prototype.hasOwnProperty.call(options, k)) continue;
            var o = el('option', null, options[k]);
            o.value = k;
            if (k === value) o.selected = true;
            s.appendChild(o);
        }
        s.addEventListener('change', function () { onChange(s.value); });
        return s;
    }

    function stateTag(state) {
        return el('span', 'fsp-tag fsp-t-' + state, C.STATE_LABEL[state] || state);
    }

    // ─────────────────────────────────────────────────────────
    // 悬浮球
    // ─────────────────────────────────────────────────────────

    function buildFab() {
        var fab = el('div', 'fsp-fab');
        fab.title = '伏笔引擎';
        fab.appendChild(el('span', null, '🎯'));
        var badge = el('span', 'fsp-badge');
        fab.appendChild(badge);
        fab.addEventListener('click', function () { togglePanel(); });
        document.body.appendChild(fab);
        $.btn = fab;
        return fab;
    }

    function positionFab() {
        if (!$.btn) return;
        var s = I.getSettings();
        var pos = (s && s.buttonPos) || { right: 18, bottom: 120 };
        $.btn.style.right = (pos.right || 18) + 'px';
        $.btn.style.bottom = (pos.bottom || 120) + 'px';
        $.btn.style.display = (s && s.showFloatingButton) ? 'flex' : 'none';
    }

    function setBadge(n) {
        if (!$.btn) return;
        var b = $.btn.querySelector('.fsp-badge');
        if (!b) return;
        if (n > 0) { b.textContent = n > 99 ? '99+' : String(n); b.classList.add('fsp-show'); }
        else { b.classList.remove('fsp-show'); }
    }

    function setBusy(on) {
        $.busy = !!on;
        if ($.btn) $.btn.classList.toggle('fsp-busy', !!on);
    }

    // ─────────────────────────────────────────────────────────
    // 面板骨架
    // ─────────────────────────────────────────────────────────

    var TABS = [
        { id: 'ledger', label: '台账' },
        { id: 'plan', label: '规划' },
        { id: 'inject', label: '注入预览' },
        { id: 'history', label: '历史' },
        { id: 'settings', label: '设置' }
    ];

    function buildPanel() {
        var overlay = el('div', 'fsp-overlay');
        overlay.addEventListener('click', function (ev) { if (ev.target === overlay) togglePanel(false); });

        var panel = el('div', 'fsp-panel');
        panel.addEventListener('click', function (ev) { ev.stopPropagation(); });

        var head = el('div', 'fsp-head');
        var title = el('div', 'fsp-title', '伏笔引擎');
        title.appendChild(el('span', 'fsp-scope', ''));
        head.appendChild(title);
        head.appendChild(btn('规划', 'fsp-primary', function () { I.plan(); }));
        head.appendChild(btn('✕', 'fsp-ghost', function () { togglePanel(false); }));
        panel.appendChild(head);

        var tabs = el('div', 'fsp-tabs');
        for (var i = 0; i < TABS.length; i++) {
            (function (t) {
                var tb = el('div', 'fsp-tab', t.label);
                tb.setAttribute('data-tab', t.id);
                tb.addEventListener('click', function () { switchTab(t.id); });
                tabs.appendChild(tb);
            })(TABS[i]);
        }
        panel.appendChild(tabs);

        var body = el('div', 'fsp-body');
        panel.appendChild(body);

        overlay.appendChild(panel);
        document.body.appendChild(overlay);

        $.overlay = overlay;
        $.panel = panel;
        $.body = body;
        $.head = head;

        switchTab($.activeTab);
        return panel;
    }

    function switchTab(id) {
        $.activeTab = id;
        if (!$.panel) return;
        var tabs = $.panel.querySelectorAll('.fsp-tab');
        for (var i = 0; i < tabs.length; i++) {
            tabs[i].classList.toggle('fsp-on', tabs[i].getAttribute('data-tab') === id);
        }
        render();
    }

    function togglePanel(force) {
        if (!$.panel) buildPanel();
        var open = (force === undefined) ? !$.overlay.classList.contains('fsp-open') : !!force;
        $.overlay.classList.toggle('fsp-open', open);
        $.panel.classList.toggle('fsp-open', open);
        if (open) { $.activeTab = $.activeTab || 'ledger'; render(); }
    }

    // ─────────────────────────────────────────────────────────
    // 渲染
    // ─────────────────────────────────────────────────────────

    function refresh() {
        if (!$.overlay || !$.overlay.classList.contains('fsp-open')) {
            updateBadge();
            return;
        }
        scheduleRender();
    }

    /**
     * 合并渲染：refresh() 可能在一次交互里被调用多次（合并 → 持久化 → 注入 → 事件），
     * 每次都同步 render 会递归放大成 O(n²) 甚至爆栈。统一推迟一帧、只渲染最后一次。
     */
    var renderPending = false;
    function scheduleRender() {
        if (renderPending) return;
        renderPending = true;
        var run = function () {
            renderPending = false;
            try { render(); } catch (e) { console.error('[伏笔引擎] 渲染失败', e); }
        };
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
        else setTimeout(run, 0);
    }

    function updateBadge() {
        var n = 0;
        var st = I.getStaging();
        if (st) {
            n += (st.conflicts ? st.conflicts.length : 0);
            n += (st.pulseReports ? st.pulseReports.length : 0);
        }
        var res = I.getLastResult();
        if (res && res.candidates) n += res.candidates.length;
        setBadge(n);
    }

    function render() {
        if (!$.body) return;

        var titleEl = $.head.querySelector('.fsp-title');
        if (titleEl) {
            var s = I.getSettings();
            var ledger = I.getLedger();
            var scopeLabel = { per_chat: '本聊天', per_character: '本角色', per_world: '本世界书' }[s.scope] || s.scope;
            titleEl.textContent = '伏笔引擎';
            var sc = titleEl.querySelector('.fsp-scope');
            if (sc) sc.textContent = '　' + scopeLabel + ' · 活跃 ' + (ledger ? ledger.active.length : 0) + ' · 归档 ' + (ledger ? ledger.archive.length : 0) + ' · 楼层 ' + I.currentFloor();
        }

        $.body.innerHTML = '';
        if ($.activeTab === 'ledger') renderLedger();
        else if ($.activeTab === 'plan') renderPlan();
        else if ($.activeTab === 'inject') renderInject();
        else if ($.activeTab === 'history') renderHistory();
        else if ($.activeTab === 'settings') renderSettings();

        updateBadge();
    }

    // ── 台账 ──
    function renderLedger() {
        var ledger = I.getLedger();
        var floor = I.currentFloor();
        var s = I.getSettings();

        // 待办
        var todo = [];
        for (var i = 0; i < ledger.active.length; i++) {
            var e = ledger.active[i];
            if (C.isOverdue(e, floor)) todo.push({ e: e, why: '已过期' });
            else if (C.isDueSoon(e, floor)) todo.push({ e: e, why: '即将到期' });
            else if (e.state === 'planned') todo.push({ e: e, why: '待埋设' });
        }

        if (todo.length) {
            var sec0 = el('div', 'fsp-sec');
            sec0.appendChild(el('h4', null, '⚠ 待处理（' + todo.length + '）'));
            for (var t = 0; t < todo.length; t++) {
                sec0.appendChild(entryCard(todo[t].e, todo[t].why));
            }
            $.body.appendChild(sec0);
        }

        // 活跃
        var sec = el('div', 'fsp-sec');
        sec.appendChild(el('h4', null, '活跃线索（' + ledger.active.length + '）'));
        if (!ledger.active.length) {
            sec.appendChild(el('div', 'fsp-empty', '尚无伏笔。点上方「规划」让 AI 从世界书里找可埋的点，或手动添加。'));
        } else {
            var sorted = ledger.active.slice().sort(function (a, b) { return (b.importance || 0) - (a.importance || 0); });
            for (var j = 0; j < sorted.length; j++) sec.appendChild(entryCard(sorted[j]));
        }
        sec.appendChild(btn('＋ 手动添加伏笔', 'fsp-ghost', manualAddDialog));
        $.body.appendChild(sec);

        // 归档
        if (ledger.archive.length) {
            var sec2 = el('div', 'fsp-sec');
            var open = $.archiveOpen;
            var h = el('h4', null, (open ? '▾ ' : '▸ ') + '已归档（' + ledger.archive.length + '）');
            h.style.cursor = 'pointer';
            h.addEventListener('click', function () { $.archiveOpen = !$.archiveOpen; render(); });
            sec2.appendChild(h);
            if (open) {
                for (var k = ledger.archive.length - 1; k >= 0; k--) sec2.appendChild(entryCard(ledger.archive[k], null, true));
            }
            $.body.appendChild(sec2);
        }

        // 底部
        var foot = el('div', 'fsp-sec');
        foot.appendChild(btn('导出 JSON', 'fsp-ghost', function () {
            var text = I.exportLedger();
            copyToClipboard(text);
            I.toast('台账 JSON 已复制到剪贴板（' + text.length + ' 字符）', 'success');
        }));
        foot.appendChild(btn('导入 JSON', 'fsp-ghost', function () {
            var text = prompt('粘贴台账 JSON：');
            if (text) I.importLedger(text);
        }));
        foot.appendChild(btn('清空本作用域台账', 'fsp-danger', function () {
            if (confirm('确定清空当前作用域的台账？此操作不可撤销。')) {
                I.resetLedger();
                I.toast('已清空', 'success');
            }
        }));
        $.body.appendChild(foot);
    }

    function entryCard(e, why, archived) {
        var card = el('div', 'fsp-card' + (e.locked ? ' fsp-locked' : ''));

        var top = el('div', 'fsp-card-top');
        top.appendChild(el('span', 'fsp-id', '#' + e.id));
        top.appendChild(stateTag(e.state));
        top.appendChild(el('span', 'fsp-name', e.title));
        if (e.locked) top.appendChild(el('span', 'fsp-tag', '🔒'));
        if (why) {
            var w = el('span', why === '已过期' ? 'fsp-overdue' : 'fsp-tag', why);
            if (why !== '已过期') w.style.background = 'rgba(255,200,90,.2)';
            top.appendChild(w);
        }
        card.appendChild(top);

        // 元信息
        var bits = [];
        if (e.plant.actualFloor !== null && e.plant.actualFloor !== undefined) bits.push('埋于 ' + e.plant.actualFloor + ' 楼');
        else if (e.plant.targetFloor !== null && e.plant.targetFloor !== undefined) bits.push('计划埋设 ' + e.plant.targetFloor + ' 楼');
        if (e.reinforcements && e.reinforcements.length) bits.push('强化 ' + e.reinforcements.length + ' 次');
        if (e.recovery.targetFloor !== null && e.recovery.targetFloor !== undefined) bits.push('计划回收 ' + e.recovery.targetFloor + ' 楼');
        if (e.recovery.windowStart !== null && e.recovery.windowEnd !== null &&
            e.recovery.windowStart !== undefined && e.recovery.windowEnd !== undefined) {
            bits.push('窗口 ' + e.recovery.windowStart + '-' + e.recovery.windowEnd);
        }
        if (e.recovery.actualFloor !== null && e.recovery.actualFloor !== undefined) bits.push('回收于 ' + e.recovery.actualFloor + ' 楼');
        bits.push('重要度 ' + e.importance);
        if (e.keywords && e.keywords.length) bits.push('关键词 ' + e.keywords.join('/'));
        card.appendChild(el('div', 'fsp-meta', bits.join(' · ')));

        // 目标（指令层，可见）
        if (e.recovery.goal) card.appendChild(el('div', 'fsp-goal', '目标：' + e.recovery.goal));

        // 未用细节
        var unused = (e.hints || []).filter(function (h) { return !h.used; });
        for (var i = 0; i < Math.min(unused.length, 3); i++) {
            card.appendChild(el('div', 'fsp-hintline', '· ' + unused[i].text + (unused[i].condition ? '（' + unused[i].condition + '）' : '')));
        }

        // 秘密（折叠，默认不展开 —— 用户自己当然可以看）
        if (e.secret && e.secret.intent) {
            var open = $.secretOpen && $.secretOpen[e.id];
            var sh = el('div', 'fsp-hintline', (open ? '▾ ' : '▸ ') + '🔒 秘密层（规划器可见，叙事模型绝不可见）');
            sh.style.cursor = 'pointer';
            sh.style.marginTop = '5px';
            sh.addEventListener('click', function () {
                $.secretOpen = $.secretOpen || {};
                $.secretOpen[e.id] = !$.secretOpen[e.id];
                render();
            });
            card.appendChild(sh);
            if (open) {
                var box = el('div', 'fsp-pre');
                var lines = [];
                if (e.secret.intent) lines.push('意图：' + e.secret.intent);
                if (e.secret.revealAt) lines.push('揭晓：' + e.secret.revealAt);
                if (e.secret.impact) lines.push('冲击：' + e.secret.impact);
                if (e.contract && e.contract.invariants && e.contract.invariants.length) {
                    lines.push('');
                    lines.push('契约层（会注入叙事模型）：');
                    for (var q = 0; q < e.contract.invariants.length; q++) lines.push('· ' + e.contract.invariants[q]);
                    if (e.contract.tabooPhrases && e.contract.tabooPhrases.length) lines.push('· 禁忌词：' + e.contract.tabooPhrases.join('、'));
                    if (e.contract.statedFacts && e.contract.statedFacts.length) {
                        lines.push('· 已陈述事实：' + e.contract.statedFacts.join('；'));
                    }
                }
                if (e.knows && e.knows.length) {
                    lines.push('');
                    lines.push('知情状态：');
                    for (var w2 = 0; w2 < e.knows.length; w2++) {
                        var kk = e.knows[w2];
                        lines.push('· ' + kk.entity + ' — ' + (C.KNOWN_LABEL[kk.level] || kk.level) +
                            (kk.attitude ? '，' + (C.ATTITUDE_LABEL[kk.attitude] || kk.attitude) : ''));
                    }
                }
                box.textContent = lines.join('\n');
                card.appendChild(box);
            }
        }

        // 操作
        var acts = el('div');
        if (!archived) {
            acts.appendChild(btn('强化', null, function () {
                I.approvePatch({ op: 'reinforce', id: e.id, floor: I.currentFloor(), reason: '用户手动强化' });
                I.toast('已记录一次强化', 'success');
            }));
            if (e.state === 'planned' || e.state === 'planted' || e.state === 'reinforced') {
                acts.appendChild(btn('标记已回收', null, function () {
                    if (!confirm('强制标记「' + e.title + '」为已回收？\n（没有接地证据时会绕过校验，请自行确认剧情里确实回收了）')) return;
                    I.approvePatch({ op: 'state', id: e.id, to: 'resolved', floor: I.currentFloor(), reason: '用户手动确认回收' });
                    I.toast('已回收', 'success');
                }));
            }
            acts.appendChild(btn(e.locked ? '解锁' : '锁定', null, function () { I.toggleLock(e.id); }));
            acts.appendChild(btn('编辑', 'fsp-ghost', function () { editDialog(e); }));
            acts.appendChild(btn('删除', 'fsp-danger', function () {
                if (confirm('删除「' + e.title + '」？会移入归档。')) I.deleteEntry(e.id);
            }));
        }
        if (actions_has(acts)) card.appendChild(acts);
        return card;
    }

    function actions_has(n) { return n.childNodes.length > 0; }

    // ── 规划 ──
    function renderPlan() {
        var res = I.getLastResult();
        var st = I.getStaging();
        var s = I.getSettings();

        var info = el('div', 'fsp-sec');
        info.appendChild(el('h4', null, '当前规划器'));
        var kv = el('div');
        kv.appendChild(kvRow('模式', { mock: 'Mock（内置示例，无需 API）', direct: '直连自定义端点', direct_via_backend: '经酒馆后端转发', profile: '连接配置档' }[s.plannerMode] || s.plannerMode));
        if (s.plannerMode === 'direct' || s.plannerMode === 'direct_via_backend') {
            kv.appendChild(kvRow('端点', s.direct.url || '(未填)'));
            kv.appendChild(kvRow('模型', s.direct.model || '(未填)'));
            kv.appendChild(kvRow('API Key', s.direct.apiKey ? '已填（' + s.direct.apiKey.length + ' 字符）' : '未填'));
        }
        if (s.plannerMode === 'profile') kv.appendChild(kvRow('配置档', s.profileId || '(未选)'));
        info.appendChild(kv);

        var act = el('div');
        act.style.marginTop = '8px';
        act.appendChild(btn(I.isPlanning() ? '规划中…' : '🎯 立即规划', 'fsp-primary' + (I.isPlanning() ? ' fsp-disabled' : ''), function () { I.plan(); }));
        act.appendChild(btn('撤销上次规划', 'fsp-ghost', function () { I.undoLast(); }));
        act.appendChild(btn('查看发送给规划器的内容', 'fsp-ghost', function () { showPlannerPrompt(); }));
        info.appendChild(act);
        $.body.appendChild(info);

        // 待裁决
        if (st && st.conflicts && st.conflicts.length) {
            var sec = el('div', 'fsp-sec');
            sec.appendChild(el('h4', null, '⚠ 待你裁决（' + st.conflicts.length + '）'));
            for (var i = 0; i < st.conflicts.length; i++) sec.appendChild(conflictCard(st.conflicts[i], st));
            $.body.appendChild(sec);
        }
        if (st && st.pulseReports && st.pulseReports.length) {
            var sec2 = el('div', 'fsp-sec');
            sec2.appendChild(el('h4', null, '📡 落拍感应候选（' + st.pulseReports.length + '）'));
            sec2.appendChild(el('div', 'fsp-note', '叙事模型报告「本轮完成」，引用句已通过逐字接地校验。确认后才会真正推进状态 —— 绝不自动推进。'));
            for (var p = 0; p < st.pulseReports.length; p++) {
                (function (rep) {
                    var card = el('div', 'fsp-card');
                    card.appendChild(el('div', 'fsp-name', rep.title + '  →  ' + (rep.kind === 'reinforce' ? '强化' : '回收')));
                    card.appendChild(el('div', 'fsp-meta', '引用正文：' + rep.quote));
                    var b = el('div');
                    b.appendChild(btn('确认', 'fsp-primary', function () { I.approvePulse(rep); }));
                    b.appendChild(btn('忽略', 'fsp-ghost', function () {
                        var cur = I.getStaging();
                        if (cur && cur.pulseReports) cur.pulseReports = cur.pulseReports.filter(function (x) { return x !== rep; });
                        render();
                    }));
                    card.appendChild(b);
                    sec2.appendChild(card);
                })(st.pulseReports[p]);
            }
            $.body.appendChild(sec2);
        }

        // 上次结果
        if (res) {
            var sec3 = el('div', 'fsp-sec');
            sec3.appendChild(el('h4', null, '上次规划结果'));
            var box = el('div', 'fsp-pre');
            var lines = [];
            lines.push('采纳 ' + res.applied.length + ' · 候选 ' + res.candidates.length + ' · 冲突 ' + res.conflicts.length);
            lines.push('');
            for (var a = 0; a < res.applied.length; a++) lines.push('✅ ' + JSON.stringify(res.applied[a]));
            for (var c2 = 0; c2 < res.candidates.length; c2++) lines.push('🟡 ' + JSON.stringify(res.candidates[c2]));
            for (var c3 = 0; c3 < res.conflicts.length; c3++) lines.push('⚠️ ' + JSON.stringify(res.conflicts[c3]));
            if (!res.applied.length && !res.candidates.length && !res.conflicts.length) lines.push('（本轮无任何动作 —— 这是完全合法的结果）');
            box.textContent = lines.join('\n');
            sec3.appendChild(box);
            $.body.appendChild(sec3);
        } else {
            $.body.appendChild(el('div', 'fsp-empty', '还没有规划记录。点上面的按钮开始。'));
        }
    }

    function kvRow(k, v) {
        var r = el('div', 'fsp-kv');
        r.appendChild(el('b', null, k));
        r.appendChild(el('span', null, v));
        return r;
    }

    function conflictCard(c, st) {
        var card = el('div', 'fsp-card');
        var desc = conflictText(c);
        var cls = (c.type === 'illegal_transition' || c.type === 'locked_entry') ? 'fsp-crit' : 'fsp-warn';
        card.appendChild(el('div', cls, desc));

        var b = el('div');
        if (c.type === 'suggest_duplicate') {
            b.appendChild(btn('合并到既有', 'fsp-primary', function () {
                var pending = c.pendingEntry;
                if (!pending) return;
                I.approvePatch({ op: 'update', id: c.existing, force: true, fields: pending });
                removeConflict(st, c);
                render();
            }));
            b.appendChild(btn('作为新伏笔创建', null, function () {
                var pending = c.pendingEntry;
                if (!pending) return;
                I.manualAdd(pending);
                removeConflict(st, c);
                render();
            }));
        } else if (c.patch) {
            b.appendChild(btn('批准（force）', 'fsp-primary', function () {
                I.approvePatch(c.patch);
                removeConflict(st, c);
                render();
            }));
        } else if (c.type === 'large_shift' && c.id) {
            b.appendChild(btn('接受新值 ' + c.incoming, 'fsp-primary', function () {
                var f = {};
                var path = c.key.split('.');
                f[path[0]] = {};
                f[path[0]][path[1]] = c.incoming;
                I.approvePatch({ op: 'update', id: c.id, force: true, fields: f });
                removeConflict(st, c);
                render();
            }));
            b.appendChild(btn('保留原值 ' + c.existing, null, function () { removeConflict(st, c); render(); }));
        }
        b.appendChild(btn('忽略', 'fsp-ghost', function () { removeConflict(st, c); render(); }));
        card.appendChild(b);
        return card;
    }

    function removeConflict(st, c) {
        if (st && st.conflicts) st.conflicts = st.conflicts.filter(function (x) { return x !== c; });
    }

    function conflictText(c) {
        switch (c.type) {
            case 'large_shift':
                return '规划器想把「' + c.key + '」从 ' + c.existing + ' 改到 ' + c.incoming + '（偏移 ' + c.delta + '）。\n理由：' + (c.reason || '（未给）');
            case 'illegal_transition':
                return '非法状态迁移：' + c.from + ' → ' + c.to + '。' + (c.hint ? '\n' + c.hint : '');
            case 'locked_entry':
                return '想改动已锁定的条目 ' + (c.id || '') + '（字段：' + ((c.keys || []).join('、') || c.to || '') + '）。';
            case 'monotonic_violation':
                return '想改写单调字段「' + c.key + '」：' + JSON.stringify(c.existing) + ' → ' + JSON.stringify(c.incoming) + '。\n这是已发生的历史事实，不该被覆盖。';
            case 'secret_after_plant':
                return '想在已埋设后改写秘密（' + (c.id || '') + '）。\n这会与已经注入过的正文矛盾。';
            case 'suggest_duplicate':
                return '疑似与既有伏笔重复（相似度 ' + c.score + '）：\n既有「' + c.existingTitle + '」\n新来「' + c.incomingTitle + '」';
            case 'duplicate_suspect':
                return '疑似重复：' + c.existingTitle + ' ← ' + c.incomingTitle + '（' + c.score + '）';
            case 'user_edited_field':
                return '想覆盖你手改过的字段「' + c.key + '」（' + c.id + '）。';
            default:
                return c.type + '：' + JSON.stringify(c);
        }
    }

    // ── 注入预览 ──
    function renderInject() {
        var inj = I.getLastInjections();
        var s = I.getSettings();

        $.body.appendChild(el('div', 'fsp-note',
            '这是【本轮真正会注入给叙事模型】的内容。秘密层永不出现于此。' +
            '每次生成前都会现场重算，不做缓存。'));

        var layers = [
            { key: 'index', name: 'L1 常驻索引', where: 'IN_PROMPT · depth ' + s.indexDepth + ' · scan=false', on: s.injectIndex },
            { key: 'schedule', name: 'L2 动态调度', where: 'IN_CHAT · depth ' + s.scheduleDepth + ' · scan=true', on: s.injectSchedule },
            { key: 'contract', name: '契约层（条件加载）', where: 'IN_CHAT · depth ' + s.contractDepth + ' · scan=true', on: s.injectContract },
            { key: 'pulse', name: '落拍感应协议', where: 'IN_CHAT · depth 0 · scan=false', on: s.injectPulse }
        ];

        for (var i = 0; i < layers.length; i++) {
            var L = layers[i];
            var sec = el('div', 'fsp-sec');
            var h = el('h4', null, L.name + (L.on ? '' : '（已关闭）'));
            sec.appendChild(h);
            sec.appendChild(el('div', 'fsp-note', L.where));
            var text = inj[L.key] || '';
            if (!L.on) {
                sec.appendChild(el('div', 'fsp-empty', '该层已在设置中关闭'));
            } else if (!text) {
                sec.appendChild(el('div', 'fsp-empty', '（空 —— 本轮不注入，0 token）'));
            } else {
                var box = el('div', 'fsp-pre');
                box.textContent = text;
                sec.appendChild(box);

                // 秘密自检
                var ledger = I.getLedger();
                var leaked = [];
                for (var j = 0; j < ledger.active.length; j++) {
                    var r = C.containsSecret(text, ledger.active[j]);
                    if (r.leaked) leaked.push(ledger.active[j].id + ':' + r.fragment);
                }
                if (leaked.length) sec.appendChild(el('div', 'fsp-crit', '⛔ 检测到秘密泄漏：' + leaked.join('、')));
                else sec.appendChild(el('div', 'fsp-ok', '✓ 秘密层自检通过（未出现任何 secret 片段）'));

                var chars = text.length;
                sec.appendChild(el('div', 'fsp-note', '约 ' + chars + ' 字符（粗估 ~' + Math.round(chars / 1.7) + ' tokens）'));
            }
            $.body.appendChild(sec);
        }

        // 世界书采集情况
        var sec4 = el('div', 'fsp-sec');
        sec4.appendChild(el('h4', null, '世界书采集'));
        var entries = I.collectWorldInfoEntries(200);
        var own = 0;
        for (var k = 0; k < entries.length; k++) if (I.isOwnEntry(entries[k])) own++;
        sec4.appendChild(el('div', 'fsp-note',
            '可用条目 ' + entries.length + ' 条 · 关联书：' + (I.associatedWorldNames().join('、') || '（无）')));
        sec4.appendChild(el('div', 'fsp-note',
            '自我污染过滤：本插件写入的条目会以 comment 前缀 [FSP] 识别并整条剔除（防规划器读到自己上一轮的输出）。'));
        $.body.appendChild(sec4);
    }

    // ── 历史 ──
    function renderHistory() {
        var ledger = I.getLedger();
        var runs = ledger.planningRuns || [];

        $.body.appendChild(el('div', 'fsp-note', '规划历史（含每次的 diff 统计，是「可撤销」的前提）'));

        if (!runs.length) {
            $.body.appendChild(el('div', 'fsp-empty', '还没有规划记录'));
        } else {
            var sec = el('div', 'fsp-sec');
            for (var i = runs.length - 1; i >= 0; i--) {
                var r = runs[i];
                var card = el('div', 'fsp-card');
                var top = el('div', 'fsp-card-top');
                top.appendChild(el('span', 'fsp-id', r.runId));
                top.appendChild(el('span', 'fsp-name', r.tier + (r.toFloor !== null && r.toFloor !== undefined ? ' · 至 ' + r.toFloor + ' 楼' : '')));
                card.appendChild(top);
                var d = r.diff || {};
                card.appendChild(el('div', 'fsp-meta',
                    '采纳 ' + (d.applied || 0) + ' · 候选 ' + (d.candidates || 0) + ' · 冲突 ' + (d.conflicts || 0) +
                    (r.at ? ' · ' + new Date(r.at).toLocaleString() : '')));
                sec.appendChild(card);
            }
            $.body.appendChild(sec);
        }

        // 合并历史（逐条留痕）
        var sec2 = el('div', 'fsp-sec');
        sec2.appendChild(el('h4', null, '条目变更留痕'));
        var all = ledger.active.concat(ledger.archive);
        var rows = [];
        for (var j = 0; j < all.length; j++) {
            for (var k = 0; k < (all[j].mergeHistory || []).length; k++) {
                rows.push({ e: all[j], h: all[j].mergeHistory[k] });
            }
        }
        rows.sort(function (a, b) { return (b.h.at || 0) - (a.h.at || 0); });
        var box = el('div', 'fsp-pre');
        var lines = [];
        for (var m = 0; m < Math.min(rows.length, 120); m++) {
            var row = rows[m];
            lines.push('[' + (row.h.floor !== undefined ? row.h.floor + '楼' : '?') + '] #' + row.e.id + ' ' + row.h.action +
                (row.h.keys ? ' ' + row.h.keys.join(',') : '') +
                (row.h.evidence ? ' 「' + String(row.h.evidence).slice(0, 24) + '」' : ''));
        }
        box.textContent = lines.length ? lines.join('\n') : '（无）';
        sec2.appendChild(box);
        $.body.appendChild(sec2);
    }

    // ── 设置 ──
    function renderSettings() {
        var s = I.getSettings();
        var ledgers = null;

        function bind(key, val) { s[key] = val; I.saveSettings(); }

        // 总开关
        var sec0 = el('div', 'fsp-sec');
        sec0.appendChild(el('h4', null, '总开关'));
        sec0.appendChild(row('启用伏笔引擎', checkInput(s.enabled, function (v) {
            bind('enabled', v);
            I.refreshInjections();
            render();
        })));
        sec0.appendChild(el('div', 'fsp-note', '关闭后不注入任何内容，也不参与任何事件处理。'));
        sec0.appendChild(row('悬浮球', checkInput(s.showFloatingButton, function (v) {
            bind('showFloatingButton', v);
            positionFab();
        })));
        sec0.appendChild(row('作用域', select({
            per_chat: '每个聊天独立（推荐）',
            per_character: '同一角色共用',
            per_world: '同一世界书共用'
        }, s.scope, function (v) {
            bind('scope', v);
            I.reloadLedger();
            I.toast('作用域已切换，已重新载入台账', 'success');
            render();
        })));
        sec0.appendChild(row('显示调试日志', checkInput(s.debug, function (v) { bind('debug', v); })));
        $.body.appendChild(sec0);

        // 规划器
        var sec = el('div', 'fsp-sec');
        sec.appendChild(el('h4', null, '规划器 API'));
        sec.appendChild(row('模式', select({
            mock: 'Mock｜内置示例（无需 API，可先跑通流程）',
            direct: '直连自定义端点（浏览器直连）',
            direct_via_backend: '直连但经酒馆后端转发（规避 CORS）',
            profile: '使用酒馆连接配置档'
        }, s.plannerMode, function (v) { bind('plannerMode', v); render(); })));

        if (s.plannerMode === 'mock') {
            sec.appendChild(el('div', 'fsp-note',
                'Mock 模式不会调用任何 API：第一次规划会从你的世界书里挑一条最像伏笔的条目创建出来，' +
                '之后的规划会尝试用最近一条正文做证据来推进状态（故意可能失败，用来演示接地校验）。' +
                '先用它确认界面和注入效果，再换成真实 API。'));
        }

        if (s.plannerMode === 'direct' || s.plannerMode === 'direct_via_backend') {
            sec.appendChild(row('API 地址', textInput(s.direct.url, function (v) { s.direct.url = v; I.saveSettings(); }, 'text')));
            sec.appendChild(el('div', 'fsp-note', '不含 /chat/completions。例如 https://api.openai.com/v1 或 https://api.gemai.cc/v1'));
            sec.appendChild(row('API Key', textInput(s.direct.apiKey, function (v) { s.direct.apiKey = v; I.saveSettings(); }, 'password')));
            sec.appendChild(el('div', 'fsp-note', '存在酒馆的扩展设置里（settings.json）。如果不想让它落盘，请改用「连接配置档」模式。'));
            sec.appendChild(row('模型', textInput(s.direct.model, function (v) { s.direct.model = v; I.saveSettings(); }, 'text')));
            sec.appendChild(row('温度', numInput(s.direct.temperature, function (v) { s.direct.temperature = v; I.saveSettings(); }, 0, 2, 0.05)));
            sec.appendChild(row('输出上限', numInput(s.direct.maxTokens, function (v) { s.direct.maxTokens = v; I.saveSettings(); }, 256, 32000, 256)));
            sec.appendChild(row('超时(ms)', numInput(s.direct.timeoutMs, function (v) { s.direct.timeoutMs = v; I.saveSettings(); }, 5000, 600000, 1000)));
            sec.appendChild(row('请求结构化输出', checkInput(s.direct.jsonSchema, function (v) { s.direct.jsonSchema = v; I.saveSettings(); })));
            sec.appendChild(el('div', 'fsp-note', '部分第三方网关不支持 response_format，若报错就关掉它（程序有容错解析，纯文本 JSON 也能认）。'));
        }

        if (s.plannerMode === 'profile') {
            sec.appendChild(row('配置档 ID', textInput(s.profileId, function (v) { s.profileId = v; I.saveSettings(); }, 'text')));
            sec.appendChild(el('div', 'fsp-note',
                '请先在酒馆「连接配置」里建好一个专供伏笔引擎的配置档，然后把它在 extension_settings.connectionManager 里的 id 填到这里。' +
                '这是最安全的模式 —— API Key 由酒馆的 secret 机制保管。'));
        }
        $.body.appendChild(sec);

        // 注入
        var sec2 = el('div', 'fsp-sec');
        sec2.appendChild(el('h4', null, '注入'));
        sec2.appendChild(row('L1 常驻索引', checkInput(s.injectIndex, function (v) { bind('injectIndex', v); I.refreshInjections(); render(); })));
        sec2.appendChild(row('　索引 depth', numInput(s.indexDepth, function (v) { bind('indexDepth', v); I.refreshInjections(); }, 0, 100, 1)));
        sec2.appendChild(row('L2 动态调度', checkInput(s.injectSchedule, function (v) { bind('injectSchedule', v); I.refreshInjections(); render(); })));
        sec2.appendChild(row('　调度 depth', numInput(s.scheduleDepth, function (v) { bind('scheduleDepth', v); I.refreshInjections(); }, 0, 50, 1)));
        sec2.appendChild(el('div', 'fsp-note', 'depth 的语义：4 ≈「环境级叙事意图」。太浅会变牵线木偶，太深会被埋掉。（默认 4 有两条独立实践印证）'));
        sec2.appendChild(row('契约层', checkInput(s.injectContract, function (v) { bind('injectContract', v); I.refreshInjections(); render(); })));
        sec2.appendChild(row('　契约 depth', numInput(s.contractDepth, function (v) { bind('contractDepth', v); I.refreshInjections(); }, 0, 50, 1)));
        sec2.appendChild(row('落拍感应协议', checkInput(s.injectPulse, function (v) { bind('injectPulse', v); I.refreshInjections(); render(); })));
        sec2.appendChild(row('每轮最多调度条数', numInput(s.maxSchedule, function (v) { bind('maxSchedule', v); I.refreshInjections(); }, 1, 10, 1)));
        sec2.appendChild(row('同线最小间隔(楼)', numInput(s.minGap, function (v) { bind('minGap', v); I.refreshInjections(); }, 0, 200, 5)));
        $.body.appendChild(sec2);

        // 合并策略
        var sec3 = el('div', 'fsp-sec');
        sec3.appendChild(el('h4', null, '合并策略'));
        sec3.appendChild(row('冲突处理', select({
            auto: 'auto｜能自动的就自动，危险的静默丢弃',
            balanced: 'balanced｜安全的自动，危险的弹给你裁决（推荐）',
            strict: 'strict｜一切都记入冲突'
        }, s.mergeStrategy, function (v) { bind('mergeStrategy', v); })));
        sec3.appendChild(row('大偏移阈值(楼)', numInput(s.shiftThreshold, function (v) { bind('shiftThreshold', v); }, 10, 500, 10)));
        sec3.appendChild(el('div', 'fsp-note', '回收点被改动超过这个楼层数时，需要你亲自裁决。'));
        sec3.appendChild(row('去重阈值', numInput(s.duplicateThreshold, function (v) { bind('duplicateThreshold', v); }, 0.3, 1, 0.05)));
        sec3.appendChild(el('div', 'fsp-note', '综合信号 = 标题相似度×0.4 + 关键词/实体重合度×0.6。≥ 此值判定同一条；0.5~此值之间交你裁决。'));
        sec3.appendChild(row('证据最短长度', numInput(s.minEvidenceLength, function (v) { bind('minEvidenceLength', v); }, 2, 50, 1)));
        sec3.appendChild(el('div', 'fsp-note', '接地校验：证据必须是正文里的逐字原句，归一化后做子串比对。这是拦「模型谎报已回收」的唯一防线。'));
        $.body.appendChild(sec3);

        // 采集
        var sec4 = el('div', 'fsp-sec');
        sec4.appendChild(el('h4', null, '采集'));
        sec4.appendChild(row('近期对话楼层数', numInput(s.recentFloors, function (v) { bind('recentFloors', v); }, 4, 200, 2)));
        sec4.appendChild(row('世界书条目上限', numInput(s.worldInfoLimit, function (v) { bind('worldInfoLimit', v); }, 1, 100, 1)));
        $.body.appendChild(sec4);

        // 危险区
        var sec5 = el('div', 'fsp-sec');
        sec5.appendChild(el('h4', null, '诊断'));
        var dbg = el('div');
        dbg.appendChild(btn('打印注入内容到控制台', 'fsp-ghost', function () {
            var inj = I.getLastInjections();
            console.log('=== 伏笔引擎 · 注入内容 ===');
            console.log('L1 索引:\n' + inj.index);
            console.log('L2 调度:\n' + inj.schedule);
            console.log('契约层:\n' + inj.contract);
            console.log('落拍协议:\n' + inj.pulse);
            I.toast('已打印到控制台', 'success');
        }));
        dbg.appendChild(btn('打印台账 JSON', 'fsp-ghost', function () {
            console.log(JSON.stringify(I.getLedger(), null, 2));
            I.toast('已打印到控制台', 'success');
        }));
        sec5.appendChild(dbg);
        $.body.appendChild(sec5);
    }

    // ─────────────────────────────────────────────────────────
    // 对话框
    // ─────────────────────────────────────────────────────────

    function manualAddDialog() {
        var title = prompt('伏笔标题（简短，≤20 字）：');
        if (!title) return;
        var goal = prompt('目标（单句、结果式。例如「阁楼的第三个房间开始引起注意」）：') || '';
        var hint = prompt('第一个可自然出现的细节（可选）：') || '';
        var secret = prompt('秘密层：真相是什么？（规划器可见，叙事模型不可见。可留空）：') || '';

        var floor = I.currentFloor();
        I.manualAdd({
            title: title,
            kind: 'event',
            importance: 0.7,
            subtlety: 0.6,
            secret: secret ? { intent: secret, revealAt: '', impact: '' } : { intent: '', revealAt: '', impact: '' },
            hints: hint ? [{ text: hint, condition: '' }] : [],
            plant: { status: 'not_yet', targetFloor: floor + 5 },
            recovery: {
                goal: goal || title,
                plan: 'single_reveal',
                targetFloor: floor + 60,
                windowStart: floor + 50,
                windowEnd: floor + 80,
                conditions: [], requiredBeats: []
            }
        });
        I.toast('已添加', 'success');
    }

    function editDialog(e) {
        var title = prompt('标题：', e.title);
        if (title === null) return;
        e.title = title;
        var goal = prompt('目标（单句结果式）：', e.recovery.goal || '');
        if (goal !== null) e.recovery.goal = goal;
        var tf = prompt('计划回收楼层：', e.recovery.targetFloor === null || e.recovery.targetFloor === undefined ? '' : e.recovery.targetFloor);
        if (tf !== null) {
            var n = parseInt(tf, 10);
            e.recovery.targetFloor = isFinite(n) ? n : null;
        }
        var imp = prompt('重要度 0-1：', e.importance);
        if (imp !== null) {
            var v = parseFloat(imp);
            if (isFinite(v)) e.importance = Math.min(1, Math.max(0, v));
        }
        e.userEditedFields = e.userEditedFields || [];
        e.userEditedFields.push('title', 'importance');
        I.saveSettings();
        I.refreshInjections();
        render();
    }

    function showPlannerPrompt() {
        try {
            var msgs = I.buildPlannerMessages();
            var text = msgs.map(function (m) { return '=== ' + m.role + ' ===\n' + m.content; }).join('\n\n');
            $.previewText = text;
            var w = window.open('', '_blank');
            if (w) {
                w.document.write('<pre style="white-space:pre-wrap;font-family:monospace;font-size:12px;padding:16px;line-height:1.6">' +
                    escapeHtml(text) + '</pre>');
                w.document.title = '伏笔引擎 · 规划器输入';
                w.document.close();
            } else {
                copyToClipboard(text);
                I.toast('已复制到剪贴板（' + text.length + ' 字符）', 'success');
            }
        } catch (err) {
            I.toast('生成预览失败：' + err.message, 'error');
        }
    }

    function escapeHtml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function copyToClipboard(text) {
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text);
                return true;
            }
        } catch (e) { /* fallthrough */ }
        try {
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            return true;
        } catch (e2) { return false; }
    }

    // ─────────────────────────────────────────────────────────
    // 初始化
    // ─────────────────────────────────────────────────────────

    function init() {
        injectStyle();
        buildFab();
        positionFab();
        buildPanel();
        // 渲染一次头部信息
        setTimeout(function () { updateBadge(); }, 50);
        console.log('[伏笔引擎] 界面层就绪（右下角悬浮球 🎯）');
    }

    window.FSPUI = {
        init: init,
        toggle: togglePanel,
        open: function () { togglePanel(true); },
        close: function () { togglePanel(false); },
        refresh: refresh,
        render: render,
        setBusy: setBusy,
        positionFab: positionFab,
        updateBadge: updateBadge
    };

    function boot() {
        // 等集成层把设置/台账准备好
        var tries = 0;
        function wait() {
            var s = null;
            try { s = I.getSettings(); } catch (e) { s = null; }
            if (s) { try { init(); } catch (e) { console.error('[伏笔引擎] 界面初始化失败', e); } return; }
            if (++tries > 80) { console.error('[伏笔引擎] 等待集成层超时'); return; }
            setTimeout(wait, 250);
        }
        wait();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
