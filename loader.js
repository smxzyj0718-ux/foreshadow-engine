/**
 * 伏笔引擎 · 加载器
 *
 * ── 设计原则（都是踩坑换来的）──
 * 1. 只用最基础的 JS 语法。不用 import.meta、不用可选链、不用箭头函数。
 *    原因：酒馆把本文件当「模块」加载，万一某个手机浏览器对模块特有语法的解析
 *    有差异，整个文件会语法报错、一行都不执行 —— 表现就是「装上了但毫无反应，
 *    连报错都没有」，极难排查。宁可啰嗦，不要花活。
 *
 * 2. 不依赖 document.currentScript 推导目录。
 *    document.currentScript 在「模块」里恒为 null（酒馆就是用模块加载的）。
 *
 * 3. 目录靠「反查自己那个 script 标签」确定，不靠任何特殊变量。
 *
 * 4. 加载过程有可见反馈：右上角一个小徽章，会显示到哪一步了。
 *    这样出问题时不用翻控制台，看屏幕就知道。
 */
(function () {
    'use strict';

    var FILES = ['core.js', 'index.js', 'ui.js'];
    var EXPECTED = ['FSPCore', 'FSPIntegration', 'FSPUI'];
    var VERSION = '0.1.0';

    // ── 可见状态徽章 ────────────────────────────────────────
    // 用最朴素的方式创建一个固定定位的小标签，让加载过程可见
    var badge = null;
    function showBadge(text, color) {
        try {
            if (!document.body) return;
            if (!badge) {
                badge = document.createElement('div');
                badge.id = 'fsp-load-badge';
                badge.style.cssText = 'position:fixed;top:8px;right:8px;z-index:99998;' +
                    'padding:6px 10px;border-radius:7px;font-size:12px;line-height:1.5;' +
                    'font-family:system-ui,-apple-system,sans-serif;max-width:70vw;' +
                    'box-shadow:0 4px 14px rgba(0,0,0,.4);white-space:pre-wrap';
                document.body.appendChild(badge);
            }
            badge.style.background = color || '#2b2b33';
            badge.style.color = '#fff';
            badge.textContent = '伏笔引擎 ' + VERSION + '\n' + text;
        } catch (e) { /* 徽章只是辅助，失败不影响主流程 */ }
    }
    function hideBadge(delayMs) {
        try {
            if (!badge) return;
            var b = badge;
            badge = null;
            setTimeout(function () { if (b && b.parentNode) b.parentNode.removeChild(b); }, delayMs || 0);
        } catch (e) { /* ignore */ }
    }

    showBadge('启动中…', '#3a3a44');

    // ── 确定扩展目录（不依赖任何特殊变量）──────────────────
    function findBase() {
        // 思路：遍历页面上所有 script 标签，找到 src 里含 foreshadow 的那个，
        // 取它所在目录。这个办法在任何加载方式下都有效。
        try {
            var tags = document.getElementsByTagName('script');
            for (var i = 0; i < tags.length; i++) {
                var src = tags[i].getAttribute('src') || '';
                if (src.indexOf('foreshadow-engine') !== -1) {
                    // 去掉文件名，保留目录；补上开头的 /
                    var dir = src.replace(/[?#].*$/, '').replace(/[^/]*$/, '');
                    if (dir.charAt(0) !== '/') dir = '/' + dir.replace(/^\.\//, '');
                    if (dir.charAt(dir.length - 1) !== '/') dir += '/';
                    return dir;
                }
            }
        } catch (e) { /* 继续往下试 */ }

        // 退路：酒馆的固定路径约定（第三方扩展都存在 third-party 下）
        return '/scripts/extensions/third-party/foreshadow-engine/';
    }

    var base = findBase();
    console.log('[伏笔引擎] v' + VERSION + ' 扩展目录 = ' + base);
    showBadge('目录 ' + base + '\n加载中…', '#3a3a44');

    function urlOf(file) { return base + file; }

    // ── 加载一个文件 ────────────────────────────────────────
    function injectScript(src) {
        return new Promise(function (resolve) {
            var s = document.createElement('script');
            s.src = src;
            s.async = false;
            s.onload = function () { resolve(true); };
            s.onerror = function () { resolve(false); };
            (document.head || document.documentElement).appendChild(s);
        });
    }

    // 兜底：取回文本后直接执行，绕开 MIME 限制
    function fetchAndRun(src) {
        return fetch(src, { cache: 'no-cache' })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.text();
            })
            .then(function (code) {
                var s = document.createElement('script');
                s.textContent = code + '\n//# sourceURL=' + src;
                (document.head || document.documentElement).appendChild(s);
                return true;
            })
            .catch(function (e) {
                console.error('[伏笔引擎] 兜底也失败 ' + src, e);
                return false;
            });
    }

    function loadOne(file) {
        var src = urlOf(file);
        return injectScript(src).then(function (ok) {
            if (ok) {
                console.log('[伏笔引擎] ✓ ' + file);
                return true;
            }
            console.warn('[伏笔引擎] 标签加载失败，改用兜底：' + file);
            return fetchAndRun(src).then(function (ok2) {
                if (ok2) console.log('[伏笔引擎] ✓ ' + file + '（兜底）');
                return ok2;
            });
        });
    }

    // ── 顺序加载 ────────────────────────────────────────────
    function run() {
        var results = [];
        var i = 0;

        function next() {
            if (i >= FILES.length) return Promise.resolve(results);
            var f = FILES[i];
            showBadge('目录 ' + base + '\n加载 ' + (i + 1) + '/' + FILES.length + '：' + f, '#3a3a44');
            return loadOne(f).then(function (ok) {
                results.push({ file: f, ok: ok });
                i++;
                return next();
            });
        }

        return next();
    }

    // ── 校验 ────────────────────────────────────────────────
    function missing() {
        var out = [];
        for (var i = 0; i < EXPECTED.length; i++) {
            if (!window[EXPECTED[i]]) out.push(EXPECTED[i]);
        }
        return out;
    }

    function report(results) {
        var miss = missing();
        var failed = [];
        for (var i = 0; i < results.length; i++) {
            if (!results[i].ok) failed.push(results[i].file);
        }

        if (!miss.length) {
            console.log('[伏笔引擎] ✓ 三层已就绪');
            showBadge('✓ 加载成功', '#1f6b45');
            hideBadge(2500);
            return;
        }

        // 集成层要等酒馆就绪，可能稍晚，不算硬失败
        var hard = [];
        for (var j = 0; j < miss.length; j++) {
            if (miss[j] !== 'FSPIntegration') hard.push(miss[j]);
        }
        if (!hard.length) {
            console.log('[伏笔引擎] core / ui 已就绪，集成层仍在等酒馆就绪');
            showBadge('✓ 界面已就绪\n（集成层稍后）', '#1f6b45');
            hideBadge(2500);
            return;
        }

        console.error('[伏笔引擎] ✗ 未挂载：' + hard.join(', ') + '；加载失败的文件：' + failed.join(', '));
        var msg = '✗ 加载失败\n缺：' + hard.join('、');
        if (failed.length) msg += '\n取不到：' + failed.join('、');
        msg += '\n目录：' + base;
        showBadge(msg, '#8a1f24');
        // 失败时不自动消失，让用户能看到并截图
    }

    // ── 启动 ────────────────────────────────────────────────
    function boot() {
        run().then(function (results) {
            setTimeout(function () { report(results); }, 100);
            // 再复查一次（集成层可能在等酒馆就绪）
            setTimeout(function () {
                if (window.FSPCore && window.FSPUI && !window.FSPIntegration) {
                    console.warn('[伏笔引擎] 集成层尚未挂载（酒馆可能还没就绪）');
                }
            }, 5000);
        });
    }

    if (document.body) {
        boot();
    } else if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
