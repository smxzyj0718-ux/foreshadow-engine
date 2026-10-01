/**
 * 构建脚本：把三个源码文件拼成单个 index.js
 *
 * ── 为什么要合并 ──
 * 酒馆扩展的 manifest.json 只认【单个 JS 文件】。这是这个生态的硬约束——
 * 参考成熟插件 SoulLink：它把 18 个源码模块构建成单个 index.js 再发布。
 *
 * 早期版本试过「多文件 + 加载器」，结果在酒馆 1.18.0 上：
 * 扩展出现在列表里、被勾选启用，但脚本一行都不执行（连报错都没有）。
 * 所以老老实实合并。
 *
 * 用法：
 *   node build.mjs            构建
 *   node build.mjs --check    构建后校验语法
 *
 * 产物：ext/foreshadow-engine/index.js（不要手改，改 src 后重新构建）
 */

import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, 'ext', 'foreshadow-engine');
const OUT = join(SRC, 'index.js');

// 顺序不能变：core（纯逻辑）→ app（集成）→ ui（界面）
const PARTS = [
    { file: 'core.js', note: '纯逻辑层：三方合并 / 状态机 / 接地校验 / 调度 / 秘密自检' },
    { file: 'app.js', note: '集成层：采集 / 规划器 / 分层注入 / 持久化 / 落拍感应 / 事件' },
    { file: 'ui.js', note: '界面层：悬浮球 + 五页签面板' },
];

const HEADER = `/**
 * 伏笔引擎 (Foreshadow Engine) —— 单文件构建产物
 *
 * ⚠️ 本文件由 build.mjs 自动生成，请勿手改。
 *    要改代码：改 core.js / app.js / ui.js，然后运行  node build.mjs
 *
 * ── 为什么是单文件 ──
 * 酒馆扩展的 manifest.json 只认单个 JS 文件（这是生态硬约束）。
 * 三个源码文件按顺序拼进来，各自用 IIFE 隔离，通过 window.FSPCore /
 * window.FSPIntegration / window.FSPUI 互相通信。拼接不改变任何语义。
 *
 * 构建时间：${new Date().toISOString()}
 */

`;

function readPart(name) {
    const p = join(SRC, name);
    try {
        return readFileSync(p, 'utf8');
    } catch (e) {
        console.error(`✗ 读不到 ${name}：${e.message}`);
        process.exit(1);
    }
}

function build() {
    const chunks = [HEADER];
    let totalBytes = 0;

    for (const part of PARTS) {
        const code = readPart(part.file);
        totalBytes += Buffer.byteLength(code, 'utf8');

        chunks.push(
            `\n/* ${'='.repeat(72)}\n` +
            ` * 以下来自 ${part.file}\n` +
            ` * ${part.note}\n` +
            ` * ${'='.repeat(72)} */\n\n`,
        );
        chunks.push(code.trimEnd());
        chunks.push('\n');
    }

    const out = chunks.join('');
    writeFileSync(OUT, out, 'utf8');

    const size = statSync(OUT).size;
    console.log(`✓ 已生成 index.js`);
    console.log(`  来源：${PARTS.map((p) => p.file).join(' + ')}`);
    console.log(`  源码合计：${(totalBytes / 1024).toFixed(1)} KB`);
    console.log(`  产物大小：${(size / 1024).toFixed(1)} KB`);
    return size;
}

function check() {
    // 简单自检：产物里不应出现模块特有语法，也不应有多余的 import/export
    const code = readFileSync(OUT, 'utf8');
    const problems = [];

    // 去掉注释后检查
    const noComment = code
        .split('\n')
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .join('\n');

    if (/\bimport\.meta\b/.test(noComment)) problems.push('含 import.meta（模块特有语法）');
    if (/^\s*import\s+/m.test(noComment)) problems.push('含 import 语句');
    if (/^\s*export\s+/m.test(noComment)) problems.push('含 export 语句');

    // 三个挂载点必须都在
    for (const key of ['window.FSPCore', 'window.FSPIntegration', 'window.FSPUI']) {
        if (!code.includes(key)) problems.push(`缺少挂载点 ${key}`);
    }

    if (problems.length) {
        console.error('✗ 校验未通过：');
        problems.forEach((p) => console.error('  · ' + p));
        process.exit(1);
    }
    console.log('✓ 校验通过（无模块特有语法、三个挂载点齐全）');
}

build();
if (process.argv.includes('--check')) check();
