/**
 * 伏笔引擎 · 加载探针（诊断专用，不是正式版）
 *
 * 目的：用最小、最无依赖的代码判断「扩展脚本在宿主里到底有没有被执行」。
 *
 * 它只做三件事，任何一件不成功都能告诉我们卡在哪：
 *   1. 在页面顶部画一条醒目的横幅（能看见 = 脚本执行了）
 *   2. 把结果写进 document.title（连横幅都没出现时，看标签页也能判断）
 *   3. 输出到 console（有控制台时用）
 *
 * 没有 await / import / export / 箭头函数 / 可选链 —— 只用最古老的语法。
 */
(function () {
    'use strict';

    // 第一步：先改标题。这一步几乎不可能失败，所以标题变化 = 脚本进来了。
    try {
        document.title = '【探针1】脚本已执行';
    } catch (e) { /* 理论上不会失败 */ }

    function banner(text, bg) {
        try {
            var d = document.createElement('div');
            d.id = 'fsp-probe-banner';
            d.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483647;' +
                'background:' + bg + ';color:#fff;padding:12px 14px;font-size:15px;' +
                'font-family:sans-serif;line-height:1.6;text-align:center;' +
                'box-shadow:0 3px 12px rgba(0,0,0,.45);white-space:pre-wrap';
            d.textContent = text;
            if (document.body) {
                document.body.appendChild(d);
            } else {
                document.addEventListener('DOMContentLoaded', function () {
                    document.body.appendChild(d);
                });
            }
            return true;
        } catch (e) {
            try { document.title = '【探针2】画横幅失败:' + e.message; } catch (e2) { }
            return false;
        }
    }

    try {
        console.log('[FSP探针] 脚本开始执行');
    } catch (e) { }

    // 第二步：确认能看到酒馆的运行时
    var hasST = false;
    var stInfo = '无';
    try {
        hasST = typeof SillyTavern !== 'undefined' && !!SillyTavern.getContext;
        if (hasST) {
            var ctx = SillyTavern.getContext();
            stInfo = ctx ? '有 getContext，extensionSettings=' + (ctx.extensionSettings ? '有' : '无') : 'getContext 返回空';
        }
    } catch (e) {
        stInfo = '取 getContext 抛错: ' + e.message;
    }

    try {
        document.title = '【探针3】酒馆=' + (hasST ? 'OK' : '无');
    } catch (e) { }

    // 第三步：画横幅，把所有信息都写上去
    var lines = [
        '✅ 伏笔引擎探针：扩展脚本已经执行了',
        '文档就绪状态：' + document.readyState,
        '酒馆运行时：' + (hasST ? '✓ 找到' : '✗ 没找到'),
        '详情：' + stInfo,
        '脚本地址：' + (function () {
            try {
                var tags = document.getElementsByTagName('script');
                for (var i = 0; i < tags.length; i++) {
                    var s = tags[i].getAttribute('src') || '';
                    if (s.indexOf('foreshadow') !== -1) return s;
                }
            } catch (e) { }
            return '（未找到自己的 script 标签）';
        })(),
        '',
        '看到这条横幅 = 脚本执行成功，问题在正式版的代码里',
        '看不到 = 宿主没有执行扩展脚本'
    ];

    var ok = banner(lines.join('\n'), '#0b6b3a');

    try {
        console.log('[FSP探针] 横幅绘制结果: ' + ok);
        if (!ok) document.title = '【探针4】横幅绘制失败';
    } catch (e) { }

    // 额外：把结果塞进 localStorage，方便别的页面查
    try {
        localStorage.setItem('fsp_probe_result', JSON.stringify({
            at: new Date().toISOString(),
            hasST: hasST,
            stInfo: stInfo,
            bannerOk: ok,
            readyState: document.readyState
        }));
    } catch (e) { }
})();
