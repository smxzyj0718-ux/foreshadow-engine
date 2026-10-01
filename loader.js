/**
 * 伏笔引擎 · 加载器（manifest.js 指向本文件）
 *
 * 为什么要一个加载器而不是直接加载 index.js：
 *   酒馆扩展的 js 字段是单个文件，但本插件分成 core / index / ui 三层。
 *   多文件加载在不同版本/平台（尤其安卓 WebView）表现不一致，
 *   所以这里用「script 标签注入 + fetch/eval 兜底 + 明确报错」三重保险。
 *
 * 顺序很重要：core.js（纯逻辑）→ index.js（集成）→ ui.js（界面）
 * 三层各自通过 window.FSPCore / FSPIntegration / FSPUI 挂载，互不依赖加载顺序之外的东西。
 */
(function () {
    'use strict';

    var VERSION = '0.1.0';
    var FILES = ['core.js', 'index.js', 'ui.js'];
    var EXPECTED = ['FSPCore', 'FSPIntegration', 'FSPUI'];

    var base = '';
    try {
        var own = document.currentScript && document.currentScript.src;
        if (own) base = own.replace(/[^/]*$/, '');
    } catch (e) { /* ignore */ }

    if (!base) {
        console.error('[伏笔引擎] 无法确定扩展目录（currentScript.src 为空）。');
        return;
    }

    console.log('[伏笔引擎] v' + VERSION + ' 正在从 ' + base + ' 加载');

    function injectScript(src, index) {
        return new Promise(function (resolve) {
            var s = document.createElement('script');
            s.src = src;
            s.async = false;
            s.onload = function () { resolve({ index: index, ok: true }); };
            s.onerror = function () { resolve({ index: index, ok: false, via: 'tag' }); };
            (document.head || document.documentElement).appendChild(s);
        });
    }

    /** 兜底：fetch 文本后用 script 标签 eval（比 new Function 更接近原生语义） */
    function evalFallback(src, index) {
        return fetch(src, { cache: 'no-cache' })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.text();
            })
            .then(function (code) {
                var s = document.createElement('script');
                s.textContent = code + '\n//# sourceURL=' + src;
                (document.head || document.documentElement).appendChild(s);
                return { index: index, ok: true, via: 'fetch-eval' };
            })
            .catch(function (e) {
                console.error('[伏笔引擎] 兜底加载也失败：' + src, e);
                return { index: index, ok: false, via: 'fetch-eval', error: e.message };
            });
    }

    function loadSequential() {
        var srcs = FILES.map(function (f) { return base + f; });
        var chain = Promise.resolve();
        var results = [];

        srcs.forEach(function (src, i) {
            chain = chain.then(function () {
                return injectScript(src, i).then(function (r) {
                    if (!r.ok) return evalFallback(src, i);
                    return r;
                }).then(function (r) {
                    results.push(r);
                    if (!r.ok) console.error('[伏笔引擎] 加载失败：' + src);
                });
            });
        });

        return chain.then(function () { return results; });
    }

    function verify() {
        var missing = [];
        for (var i = 0; i < EXPECTED.length; i++) {
            if (!window[EXPECTED[i]]) missing.push(EXPECTED[i]);
        }
        if (!missing.length) {
            console.log('[伏笔引擎] 三层已就绪：' + EXPECTED.join(' / '));
            return true;
        }
        console.error('[伏笔引擎] 以下模块未挂载：' + missing.join(', '));
        showFatal(missing);
        return false;
    }

    /** 加载失败时给用户一个可见的提示，而不是静默失灵 */
    function showFatal(missing) {
        try {
            if (typeof toastr !== 'undefined') {
                toastr.error(
                    '伏笔引擎加载失败：' + missing.join('、') +
                    '<br>请确认 data/&lt;用户&gt;/extensions/foreshadow-engine/ 下有 core.js、index.js、ui.js。',
                    '伏笔引擎', { timeOut: 0, extendedTimeOut: 0 }
                );
            }
        } catch (e) { /* ignore */ }

        try {
            var box = document.createElement('div');
            box.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:99999;' +
                'background:#3a1d1f;color:#ffd9da;border:1px solid #e5484d;border-radius:9px;' +
                'padding:11px 13px;font-size:13px;line-height:1.6;box-shadow:0 8px 24px rgba(0,0,0,.5)';
            box.innerHTML = '<b>伏笔引擎加载失败</b><br>' +
                '缺少模块：' + missing.join('、') + '<br>' +
                '请检查扩展目录下是否存在 core.js / index.js / ui.js。';
            var close = document.createElement('span');
            close.textContent = '✕';
            close.style.cssText = 'position:absolute;top:6px;right:10px;cursor:pointer;opacity:.7';
            close.onclick = function () { box.remove(); };
            box.style.position = 'fixed';
            box.appendChild(close);
            document.body.appendChild(box);
        } catch (e) { /* ignore */ }
    }

    loadSequential().then(function () {
        // 三层是异步初始化的（等酒馆就绪），这里只校验脚本是否挂载
        setTimeout(verify, 60);
    });
})();
