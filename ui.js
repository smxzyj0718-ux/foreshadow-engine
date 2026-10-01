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
