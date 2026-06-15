# 框架设计文档 · Architecture

测试套污染溯源可视化的整体设计。本文说明数据流、分层结构、核心数据结构与渲染管线，帮助理解"代码为什么这么组织"。API 对接细节见 [api-integration.md](./api-integration.md)。

## 1. 背景与问题

N 个测试套（suite）串行执行。靠后的目标套 X 单独跑能通过，但在完整序列里却失败 —— 说明前面某个套留下了残留状态，污染了 X。

后端用**二分 / delta-debugging** 定位污染源：对前缀区间 `[0..X-1]` 反复折半，每次只注入半区再复跑 X，根据 X 是否仍失败来收敛区间，最终逼近污染源。

本项目把这一过程可视化为一棵**二分搜索树**：每个节点是一次"注入某前缀区间 → 复跑 X"的试验，边表示二分的左右分支。

## 2. 设计原则

| 原则 | 落地方式 |
|------|----------|
| **数据驱动渲染** | 前端不预设结局类型，完全依据 `session.verdict` 等字段渲染。三种判定（found/combo/split）由数据决定，不靠场景名硬编码。 |
| **单一改动点对接** | 所有数据获取收敛到 `TraceDataSource` 接口 + `DATA_SOURCE` 常量，对接真实系统只改这一处，渲染层零改动。 |
| **零运行时依赖** | 纯 TypeScript 编译为 ES2020 原生模块，无前端框架、无打包器、无第三方库。 |
| **逻辑可独立测试** | 浏览器环境守卫 `typeof document !== "undefined"`，使核心逻辑能在 Node 下作为纯模块导入测试。 |
| **关注点分离** | 数据契约 / 数据源 / 状态 / 布局 / 渲染 / 事件，分层清晰、单向依赖。 |

## 3. 分层架构

`src/app.ts` 按职责自上而下分为六层，依赖单向向下：

```
┌─────────────────────────────────────────────────────────┐
│  ① 数据契约 (Data Contract)                                │
│     Side / TrialResult / Verdict / LogLine / TrialInfo    │
│     Trial / Layout / Session                              │
│     —— 前后端共享的类型定义，对接的"协议"                    │
├─────────────────────────────────────────────────────────┤
│  ② Mock 数据层 (可删除)                                     │
│     RNG / mkInfo / simulate / scenarioFound/Combo/Split   │
│     —— 内置样本，生产对接后不被调用                          │
├─────────────────────────────────────────────────────────┤
│  ③ 数据源抽象 (Data Source)        ★ 对接真实系统的唯一改动点 │
│     TraceDataSource 接口                                   │
│     MockDataSource / HttpDataSource                       │
│     DATA_SOURCE 常量                                       │
├─────────────────────────────────────────────────────────┤
│  ④ 全局状态 (State)                                        │
│     AppState：refs / cursor / loadedRef / session /       │
│     selected / reveal / replayTimer / zoom                │
├─────────────────────────────────────────────────────────┤
│  ⑤ 布局 + 渲染 (Layout & Render)                          │
│     layoutTree（整洁树布局，产出像素坐标）                   │
│     renderLoader / renderVerdict / renderInfoCards /      │
│     renderTimeline / renderTree / renderDetail /          │
│     renderControls / renderAll                            │
├─────────────────────────────────────────────────────────┤
│  ⑥ 交互 + 入口 (Events & Bootstrap)                        │
│     selectTrial / navSel / 缩放 / replay /                │
│     loadNext / init / bindEvents                          │
└─────────────────────────────────────────────────────────┘
```

> ②③ 是数据来源，可整体替换；①④⑤⑥ 是与数据来源无关的稳定核心。

## 4. 数据流

从点击按钮到画面更新的完整链路：

```
用户点击 ⟳ Load Data
   │
   ▼
loadNext()                       ← 从 State.refs 轮转取下一个 ref
   │
   ▼
DATA_SOURCE.fetch(ref.id)        ← ★ 数据源接口：mock 或 HTTP
   │  返回 Session
   ▼
applySession(session)
   │
   ├─ layoutTree(session)        ← 计算每个 trial 的像素坐标，回填 _layout
   ├─ 复位 State（reveal/zoom/selected）
   ├─ renderAll()                ← 七个 render* 函数刷新整页
   └─ selectTrial(converged.id)  ← 定位到收敛节点并居中
```

初始化 `init()` 先 `DATA_SOURCE.list()` 取得可加载列表（`SessionRef[]`），再 `loadNext()` 加载第一份。

关键点：**渲染只读 `Session`，不关心它从哪来**。`applySession` 之后的所有逻辑对 mock / 真实数据一视同仁。

## 5. 核心数据结构（数据契约）

这是前后端对接的"协议"，定义在 `src/app.ts` 顶部。

### Session —— 一次完整溯源会话

```ts
interface Session {
  id: string;                       // 会话唯一标识
  totalSuites: number;              // N，测试套总数
  targetSuite: number;              // 失败目标 X
  verdict: "found" | "combo" | "split";  // 最终结论（渲染据此分支）
  culprit: number | null;           // found 时锁定的污染源 i
  comboRanges?: [number, number][]; // combo/split 涉及的套
  trials: Trial[];                  // 二分调用记录（按执行顺序）
  converged: Trial;                 // 收敛 / 停止所在的节点
  _layout?: Layout;                 // 前端布局回填，后端不提供
}
```

### Trial —— 一次二分试验

```ts
interface Trial {
  id: number;
  parentId: number | null;          // 父节点 id（root 为 null）
  side: "root" | "left" | "right";  // 在二分树中的分支
  a: number; b: number;             // 注入的前缀区间 [a, b]
  target: number;                   // 复跑的失败目标 X
  result: "pass" | "fail";          // X 在该前缀下是否仍失败
  depth: number;                    // 树深度（root = 0）
  info: TrialInfo;                  // 可展示的附加信息
  _px?, _py?, _x?, _y?: number;     // 前端布局回填的坐标
}
```

### TrialInfo —— 单次试验的展示信息

```ts
interface TrialInfo {
  duration: number;     // 执行耗时（秒）
  executed: number[];   // 实际注入的测试套（截断展示）
  total: number;        // 注入区间的套总数
  note: string;         // 一句话判定说明
  logs: LogLine[];      // 执行日志（lvl: dim/ok/warn/err）
}
```

> 字段中带 `_` 前缀的（`_layout`/`_px` 等）由前端布局阶段回填，后端无需提供。

## 6. 三种判定（互斥结局）

`simulate()` 复现后端二分逻辑：每层把当前区间劈成左右两半各跑一次，依据结果决定收敛或停止。

| verdict | 触发条件 | 二分表现 | 收敛结果 |
|---------|----------|----------|----------|
| `found` | 单一污染源 | 每层只有一半失败，沿失败半区逐层收敛 | 区间收敛到 `[i, i]`，锁定 suite #i |
| `combo` | 多个独立污染源 | 某次二分**两半都失败**（各自单独即可复现） | 在该层停止，区间未收敛 |
| `split` | 需两套共存才触发 | 某次二分**两半都通过**（恰好把两个套劈开） | 在该层停止，区间未收敛 |

核心循环（简化）：

```ts
while (cur.a < cur.b) {
  const mid = (cur.a + cur.b) >> 1;
  const L = run(cur.a, mid);    // 左半
  const R = run(mid + 1, cur.b);// 右半
  if (L.fail && R.fail) break;  // → combo：多源
  if (!L.fail && !R.fail) break;// → split：共存
  cur = L.fail ? L : R;         // → found：沿失败半区收敛
}
```

## 7. 树布局算法（layoutTree）

采用**整洁树（tidy tree）**思路，直接产出像素坐标：

1. 建 `byId` / `kids` 映射，按 `parentId` 还原父子关系。
2. **后序遍历分配横坐标**：叶子从左到右依次占用 `NODE_W` 宽度；内部节点取首末子节点中点，居中于子节点之上。
3. **纵坐标按深度**：`_y = depth × (NODE_H + LEVEL_GAP)`。
4. 归一化平移到正坐标，算出画布内容尺寸 `contentW / contentH`，回填到 `session._layout`。

布局常量：`NODE_W=116, NODE_H=54, LEVEL_GAP=56`。

布局与渲染解耦：`layoutTree` 只算坐标，`renderTree` 只读坐标画 DOM + SVG，缩放时无需重新布局。

## 8. 渲染管线

`renderAll()` 串联七个渲染函数，各自只负责一块 DOM：

| 函数 | 负责区域 | 数据来源 |
|------|----------|----------|
| `renderLoader` | 顶部加载器提示 | `State.loadedRef` / `refs` |
| `renderVerdict` | 顶部结论徽章 | `session.verdict` |
| `renderInfoCards` | 摘要横条（结果 + 统计） | `session` + `_layout` |
| `renderTimeline` | 测试套全景时间轴 | `session` + 当前选中区间 |
| `renderTree` | 二分搜索树（SVG 边 + 节点卡片） | `_layout` + `State.zoom` |
| `renderDetail` | 右侧选中试验详情 | `State.selected` 对应 trial |
| `renderControls` | 底部序列芯片导航 | `session.trials` |

渲染全部是**幂等纯函数风格**：读 `State` + `Session`，重建对应 DOM，无增量 diff。数据量级（N≈100–500，trials 通常 < 20）下足够快。

## 9. 状态管理

单一 `State` 对象，无响应式框架，靠显式调用 `render*` 刷新：

```ts
interface AppState {
  refs: SessionRef[];           // 数据源列出的可加载会话
  cursor: number;               // 下一个要加载的下标（轮转）
  loadedRef: SessionRef | null; // 当前已加载的引用（用于中性提示）
  session: Session | null;      // 当前会话
  selected: number | null;      // 当前选中的 trial id
  reveal: number | null;        // null=全展开；回放时为已显示数量
  replayTimer: number | null;   // 回放定时器句柄
  zoom: number;                 // 树画布缩放倍率（1=100%）
}
```

## 10. 交互能力

- **加载**：`⟳ Load Data` 轮转加载下一份数据集（`loadNext`），加载期间按钮禁用防重入。
- **选择**：点击树节点 / 序列芯片 → `selectTrial`，刷新详情并把节点滚到视口中央。
- **导航**：方向键 ← / → 按执行顺序移动（`navSel`）。
- **缩放**：按钮 / `Ctrl⌘+滚轮`（以鼠标为锚点）/ `Ctrl⌘ +/-/0`，缩放保持锚点不漂移（`setZoom`），`Fit` 自适应窗口（`zoomFit`）。
- **回放**：`replay` 逐个揭示节点，结束后定位收敛点。

## 11. 构建与目录

```
.
├── src/app.ts        # 全部逻辑（六层）
├── index.html        # 页面骨架 + 样式，引用 dist/app.js
├── dist/             # tsc 编译产物（gitignore）
├── doc/              # 本文档目录
├── tsconfig.json     # rootDir=src, outDir=dist, ES2020 module, strict
└── package.json
```

`npm run build` → `tsc` 编译 `src/app.ts` → `dist/app.js`，`index.html` 以 `<script type="module">` 加载。无打包步骤。
