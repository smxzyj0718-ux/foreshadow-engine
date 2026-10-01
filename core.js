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
