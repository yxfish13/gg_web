# Contamination Bisection Visualizer

测试套污染溯源 · 二分定位可视化。

N 个测试套串行执行，靠后的目标测试 X 失败、但单独跑却通过 —— 说明前面某个套留下了残留状态污染了它。后端用二分 / delta-debugging 对 `[0..X-1]` 前缀反复折半复跑来逼近污染源。本项目把这一过程可视化为一棵二分搜索树。

零运行时依赖的单页应用：TypeScript 编写，编译为 ES2020 原生模块，无前端框架。

## 快速开始

```bash
npm install      # 安装 TypeScript（唯一 devDependency）
npm run build    # 编译 src/app.ts → dist/app.js
npm run serve    # 起静态服务，浏览器打开 http://localhost:8765/index.html
```

开发时热编译 + 静态服务一起跑：

```bash
npm run dev
```

## 脚本

| 命令 | 作用 |
|------|------|
| `npm run build` | 编译 `src/app.ts` → `dist/app.js` |
| `npm run watch` | 监听源码增量编译 |
| `npm run typecheck` | 仅类型检查，不产出文件 |
| `npm run clean` | 删除 `dist/` |
| `npm run serve` | `python3 -m http.server 8765` |
| `npm run dev` | watch 编译 + 静态服务并行 |

## 目录结构

```
.
├── src/app.ts        # 全部逻辑：数据契约 / mock 层 / 布局 / 渲染 / 缩放 / 事件
├── index.html        # 页面骨架 + 样式，引用 dist/app.js
├── dist/             # 编译产物（gitignore，构建生成）
├── tsconfig.json     # rootDir=src, outDir=dist, ES2020 module, strict
└── package.json
```

## 运行模式与对接真实后端

`src/app.ts` 顶部有一个模式开关：

```ts
export const APP_MODE = "demo" as AppMode;   // "demo" | "live"
```

- **demo**（默认）：内置三套互斥的 mock 场景，顶部出现场景切换标签，仅用于展示三种可能的判定结局。
- **live**：真实部署模式。一次溯源只有**一个**会话、**一个** verdict，场景切换标签自动隐藏，改由 `fetchLiveSession()` 拉取唯一会话。

### 三种判定（互斥结局）

| verdict | 含义 | 二分表现 |
|---------|------|----------|
| `found` | 单一污染源 | 逐层收敛，最终锁定 `suite #i`（区间收敛到 `[i-i]`） |
| `combo` | 多个独立污染源 | 某次二分两半各自单独即可复现失败，停止 |
| `split` | 需两套共存才触发 | 某次二分两半单独都通过（恰好把它们劈开），停止 |

### 对接步骤

1. 把 `APP_MODE` 改为 `"live"`。
2. 实现 `fetchLiveSession()`（已给出默认骨架，改成你的接口即可）：

```ts
export async function fetchLiveSession(): Promise<Session> {
  const res = await fetch("/api/trace/latest");
  if (!res.ok) throw new Error(`fetchLiveSession failed: HTTP ${res.status}`);
  return (await res.json()) as Session;
}
```

只要后端返回的 JSON 满足 `Session` 契约（见 `src/app.ts` 顶部 “Data Contract” 段），前端无需任何其它改动。`dist/` 整段 mock 数据层在 live 模式下不会被调用，如需彻底剔除可删除 “Mock 数据层” 注释块。

## 数据契约（Session）

```ts
interface Session {
  id: string;
  totalSuites: number;        // N
  targetSuite: number;        // 失败目标 X
  verdict: "found" | "combo" | "split";
  culprit: number | null;     // found 时锁定的污染源 i
  comboRanges?: [number, number][];  // combo/split 涉及的套
  trials: Trial[];            // 二分调用记录（按执行顺序）
  converged: Trial;           // 收敛 / 停止所在的节点
}
```

每个 `Trial` 携带可展示的执行信息（耗时、注入区间、判定说明、执行日志），详见 `src/app.ts` 的 `TrialInfo`。

## 交互

- 点击树节点 / 底部序列芯片：查看该次试验详情，画布自动居中。
- 方向键 ← / →：按执行顺序前后切换。
- 缩放：右上角 +/−/Fit 按钮，或 `Ctrl/⌘ + 滚轮`（以鼠标为中心），或 `Ctrl/⌘ + +/-/0`。
- Replay：可选回放，逐个揭示节点后定位收敛点。

## 测试

源码做了浏览器环境守卫（`typeof document !== "undefined"`），可在 Node 下作为纯逻辑模块导入做冒烟测试：

```bash
npm run build
node --input-type=module -e '
import { SCENARIOS } from "./dist/app.js";
for (const [k, def] of Object.entries(SCENARIOS)) {
  const s = def.build();
  console.log(k, s.trials.length, s.verdict, [s.converged.a, s.converged.b]);
}'
```
