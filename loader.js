/**
 * 伏笔引擎 · 加载器（manifest.json 的 js 字段指向本文件）
 *
 * ── 为什么需要一个加载器 ──
 * 酒馆扩展的 js 字段只能指定【一个】文件，但本插件分 core / index / ui 三层。
 *
 * ── 为什么用 import.meta.url 而不是 document.currentScript ──
 * 🔴 这是个踩过的坑，务必记住：
 *    酒馆（1.13.5 实测）用 `script.type = 'module'` 加载扩展脚本。
 *    而 **document.currentScript 在 ES module 里恒为 null**。
 *    早期版本用 currentScript.src 推导目录，结果 base 为空、加载器直接 return，
 *    表现是「扩展装上了、文件都在、但页面毫无反应」——极难排查。
 *    ES module 里取自身 URL 的正确方式是 import.meta.url。
 *
 * ── 为什么不用静态 import ──
 * 静态 import 一旦遇到 MIME 不符（部分安卓 WebView / 代理会返回 text/plain）
 * 会整包静默失败，连报错都看不到。这里改成「动态注入 script 标签 + fetch/eval 兜底」，
 * 让每一步都可观测、可降级。
 */
(function () {
    'use strict';

    // 顺序重要：core（纯逻辑）→ index（集成）→ ui（界面）
    var FILES = ['core.js', 'index.js', 'ui.js'];
    var EXPECTED = ['FSPCore', 'FSPIntegration', 'FSPUI'];

    // ── 确定扩展目录 ─────────────────────────────────────────
    var base = '';
    try {
        // ES module 里的正确做法
        if (typeof import.meta !== 'undefined' && import.meta.url) {
            base = String(import.meta.url).replace(/[?#].*$/, '').replace(/[^/]*$/, '');
        }
    } catch (e) { /* import.meta 不可用（被当普通脚本加载时） */ }

    if (!base) {
        // 退路一：普通脚本场景
        try {
            var own = document.currentScript && document.currentScript.src;
            if (own) base = String(own).replace(/[?#].*$/, '').replace(/[^/]*$/, '');
        } catch (e) { /* ignore */ }
    }

    // 退路二：从已加载的 script 标签里找自己
    if (!base) {
        try {
            var tags = document.querySelectorAll('script[src*="foreshadow"]');
            for (var i = 0; i < tags.length; i++) {
                var s = tags[i].getAttribute('src') || '';
                if (s.indexOf('loader.js') !== -1) {
                    base = s.replace(/[?#].*$/, '').replace(/[^/]*$/, '');
                    if (base.charAt(0) !== '/') {
                        base = '/' + base.replace(/^\.\//, '');
                    }
                    break;
                }
            }
        } catch (e) { /* ignore */ }
    }

    // 退路三：按酒馆已知的静态路径约定硬拼（用户目录挂载在 third-party/ 下）
    if (!base) {
        base = '/scripts/extensions/third-party/foreshadow-engine/';
    }

    if (base.charAt(base.length - 1) !== '/') base += '/';

    console.log('[伏笔引擎] 加载器启动，扩展目录 = ' + base);

    function url(file) {
        return base + file;
    }

    // ── 加载 ────────────────────────────────────────────────

    /** 用 script 标签注入；返回 Promise，永不 reject（失败信息在结果对象里） */
    function injectScript(src, label) {
        return new Promise(function (resolve) {
            var s = document.createElement('script');
            s.src = src;
            s.async = false;
            s.onload = function () {
                console.log('[伏笔引擎] ✓ ' + label);
                resolve({ ok: true, via: 'tag' });
            };
            s.onerror = function () {
                console.warn('[伏笔引擎] ✗ script 标签加载失败，转用 fetch 兜底：' + label);
                resolve({ ok: false, via: 'tag' });
            };
            (document.head || document.documentElement).appendChild(s);
        });
    }

    /** 兜底：fetch 成文本后用内联 script 执行，绕开某些环境的 MIME 限制 */
    function evalFallback(src, label) {
        return fetch(src, { cache: 'no-cache' })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.text();
            })
            .then(function (code) {
                var s = document.createElement('script');
                s.textContent = code + '\n//# sourceURL=' + src;
                (document.head || document.documentElement).appendChild(s);
                console.log('[伏笔引擎] ✓ ' + label + '（fetch 兜底）');
                return { ok: true, via: 'fetch' };
            })
            .catch(function (e) {
                console.error('[伏笔引擎] ✗ 兜底也失败：' + label + ' — ' + (e && e.message));
                return { ok: false, via: 'fetch', error: e && e.message };
            });
    }

    function loadOne(file) {
        var src = url(file);
        return injectScript(src, file).then(function (r) {
            return r.ok ? r : evalFallback(src, file);
        });
    }

    function loadAll() {
        var chain = Promise.resolve();
        FILES.forEach(function (f) {
            chain = chain.then(function () { return loadOne(f); });
        });
        return chain;
    }

    // ── 校验 ────────────────────────────────────────────────

    function missingModules() {
        var missing = [];
        for (var i = 0; i < EXPECTED.length; i++) {
            if (!window[EXPECTED[i]]) missing.push(EXPECTED[i]);
        }
        return missing;
    }

    /** 给用户一个看得见的失败提示，而不是静默失灵 */
    function showFatal(missing) {
        var detail = '缺少模块：' + missing.join('、') +
            '\n扩展目录：' + base +
            '\n请确认该目录下存在 core.js / index.js / ui.js。';
        try {
            if (typeof toastr !== 'undefined') {
                toastr.error(detail.replace(/\n/g, '<br>'), '伏笔引擎加载失败',
                    { timeOut: 0, extendedTimeOut: 0 });
            }
        } catch (e) { /* ignore */ }

        try {
            if (document.getElementById('fsp-fatal')) return;
            var box = document.createElement('div');
            box.id = 'fsp-fatal';
            box.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:99999;' +
                'background:#3a1d1f;color:#ffd9da;border:1px solid #e5484d;border-radius:9px;' +
                'padding:12px 34px 12px 14px;font-size:13px;line-height:1.6;' +
                'box-shadow:0 8px 24px rgba(0,0,0,.5);white-space:pre-wrap';
            box.textContent = '伏笔引擎加载失败\n' + detail;

            var close = document.createElement('span');
            close.textContent = '✕';
            close.style.cssText = 'position:absolute;top:6px;right:11px;cursor:pointer;opacity:.7;font-size:15px';
            close.onclick = function () { box.remove(); };
            box.appendChild(close);
            document.body.appendChild(box);
        } catch (e) { /* ignore */ }
    }

    /**
     * 校验分两次：
     *   第一次等脚本执行完（同步完成）
     *   第二次给集成层留一点时间去等酒馆就绪（它自己会轮询，最多 ~20s）
     * 只要 core 和 ui 在就算加载成功 —— 集成层挂载稍晚是正常的。
     */
    function verify(final) {
        var missing = missingModules();
        if (!missing.length) {
            console.log('[伏笔引擎] ✓ 三层已就绪：' + EXPECTED.join(' / '));
            return true;
        }
        // 集成层可能还在等酒馆就绪，不算致命
        var hardMissing = missing.filter(function (m) { return m !== 'FSPIntegration'; });
        if (hardMissing.length) {
            console.error('[伏笔引擎] ✗ 以下模块未挂载：' + hardMissing.join(', '));
            if (final) showFatal(hardMissing);
            return false;
        }
        if (final) {
            console.warn('[伏笔引擎] FSPIntegration 尚未挂载（可能在等酒馆就绪）。core / ui 已就绪。');
        }
        return false;
    }

    // ── 启动 ────────────────────────────────────────────────

    loadAll().then(function () {
        // 脚本执行是同步的，立刻校验一次
        setTimeout(function () { verify(false); }, 80);
        // 再给集成层 6 秒（它内部最长等 ~20s，但不该让加载器一直挂着）
        setTimeout(function () { verify(true); }, 6000);
    });
})();
