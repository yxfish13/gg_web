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
├── src/app.ts        # 全部逻辑：数据契约 / 数据源抽象 / mock 层 / 布局 / 渲染 / 缩放 / 事件
├── index.html        # 页面骨架 + 样式，引用 dist/app.js
├── dist/             # 编译产物（gitignore，构建生成）
├── tsconfig.json     # rootDir=src, outDir=dist, ES2020 module, strict
└── package.json
```

## 数据加载与对接真实系统

### 设计：数据驱动渲染 + 数据源抽象

界面顶部只有**一个** `⟳ Load Data` 按钮。每次点击，从数据源**轮转**取出下一份数据集并加载；提示只显示中性名称 `Sample Dataset N · k/3`，**刻意不暴露 verdict 类型**。

这是有意为之：前端**不预先知道**将要加载的是哪种结局，完全靠返回数据里的 `session.verdict` 字段**自行判定并渲染**。这验证了展示是真正数据驱动的，而非靠场景名硬编码 —— 因此真实系统只要给出符合契约的数据，前端就能正确呈现。

> 这取代了旧版"三种结局切换标签"的设计。一次真实溯源只会有**一个** verdict，三种结局是互斥的，不应同时出现在切换器里。

### 数据源接口

`src/app.ts` 定义了统一的数据源接口，前端只依赖它，不关心数据来自 mock 还是真实后端：

```ts
interface SessionRef { id: string; label: string; }   // 会话的轻量引用

interface TraceDataSource {
  list(): Promise<SessionRef[]>;       // 列出可加载的会话
  fetch(id: string): Promise<Session>; // 按 id 拉取完整会话
}
```

内置两个实现：

- `MockDataSource`（默认）：把三套预置样本包装成数据源，用中性标签暴露。
- `HttpDataSource`：真实后端的 HTTP 对接骨架，约定两个端点：
  - `GET {baseUrl}/sessions` → `SessionRef[]`
  - `GET {baseUrl}/sessions/:id` → `Session`

### 对接步骤（唯一改动点）

把 `src/app.ts` 底部的 `DATA_SOURCE` 常量换成你的实现即可，渲染层无需任何改动：

```ts
// 默认（mock）：
export const DATA_SOURCE: TraceDataSource = new MockDataSource();

// 上线时改为内置 HTTP 实现：
export const DATA_SOURCE: TraceDataSource = new HttpDataSource("/api/trace");

// 或完全自定义：实现 TraceDataSource 接口后传入
export const DATA_SOURCE: TraceDataSource = new MyDataSource();
```

只要 `fetch(id)` 返回的 JSON 满足下面的 `Session` 契约，前端就能正确渲染。`MockDataSource` 及其引用的 mock 数据层在生产对接后不会被调用，如需彻底剔除可删除"Mock 数据层"注释块。

### 三种判定（互斥结局，由数据决定）

| verdict | 含义 | 二分表现 |
|---------|------|----------|
| `found` | 单一污染源 | 逐层收敛，最终锁定 `suite #i`（区间收敛到 `[i-i]`） |
| `combo` | 多个独立污染源 | 某次二分两半各自单独即可复现失败，停止 |
| `split` | 需两套共存才触发 | 某次二分两半单独都通过（恰好把它们劈开），停止 |

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

- 顶部 `⟳ Load Data`：轮转加载下一份数据集，前端按其 verdict 自动呈现对应结局。
- 点击树节点 / 底部序列芯片：查看该次试验详情，画布自动居中。
- 方向键 ← / →：按执行顺序前后切换。
- 缩放：右上角 +/−/Fit 按钮，或 `Ctrl/⌘ + 滚轮`（以鼠标为中心），或 `Ctrl/⌘ + +/-/0`。
- Replay：可选回放，逐个揭示节点后定位收敛点。

## 测试

源码做了浏览器环境守卫（`typeof document !== "undefined"`），可在 Node 下作为纯逻辑模块导入做冒烟测试。下面遍历 `MockDataSource` 列出的所有数据集，打印各自由数据驱动产出的 verdict：

```bash
npm run build
node --input-type=module -e '
import { MockDataSource } from "./dist/app.js";
const ds = new MockDataSource();
for (const ref of await ds.list()) {
  const s = await ds.fetch(ref.id);
  console.log(ref.label, "| trials=" + s.trials.length, "| verdict=" + s.verdict, "| converged=[" + s.converged.a + "-" + s.converged.b + "]");
}'
```

