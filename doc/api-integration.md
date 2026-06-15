# API 接入指南 · API Integration

如何把本可视化前端对接到你的真实溯源后端。整体设计见 [architecture.md](./architecture.md)。

## 1. 核心思路：一个改动点

前端所有数据获取都收敛到一个接口和一个常量：

```ts
// src/app.ts
export interface TraceDataSource {
  list(): Promise<SessionRef[]>;        // 列出可加载的会话
  fetch(id: string): Promise<Session>;  // 按 id 拉取完整会话
}

export const DATA_SOURCE: TraceDataSource = new MockDataSource();  // ← 改这里
```

**对接 = 实现 `TraceDataSource` + 替换 `DATA_SOURCE`**。渲染层、状态、布局全部无需改动，因为它们只依赖 `Session` 数据结构，不关心数据从哪来。

## 2. 三种对接方式

### 方式 A：用内置 HttpDataSource（最快）

项目已内置一个 HTTP 实现，约定两个端点。后端按约定提供接口后，只改一行：

```ts
export const DATA_SOURCE: TraceDataSource = new HttpDataSource("/api/trace");
```

`HttpDataSource` 的约定：

| 方法 | 请求 | 响应 |
|------|------|------|
| `list()` | `GET {baseUrl}/sessions` | `SessionRef[]` |
| `fetch(id)` | `GET {baseUrl}/sessions/:id` | `Session` |

`baseUrl` 默认 `/api/trace`，构造时可传入自定义值。

### 方式 B：自定义实现（路由/鉴权/数据形态不同）

后端路由或返回格式与约定不同时，自己实现接口：

```ts
class MyDataSource implements TraceDataSource {
  async list(): Promise<SessionRef[]> {
    const res = await fetch("/my/api/traces", {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    if (!res.ok) throw new Error(`list failed: ${res.status}`);
    const raw = await res.json();
    // 把后端格式映射成 SessionRef
    return raw.items.map((it: any) => ({ id: it.uuid, label: it.name }));
  }

  async fetch(id: string): Promise<Session> {
    const res = await fetch(`/my/api/traces/${id}`);
    if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
    return adaptToSession(await res.json());  // 映射成 Session 契约
  }
}

export const DATA_SOURCE: TraceDataSource = new MyDataSource();
```

### 方式 C：单一会话场景

如果一次只有一个溯源结果（无需列表选择），让 `list()` 返回单元素数组即可，加载按钮仍可用于刷新：

```ts
class SingleSessionSource implements TraceDataSource {
  async list() { return [{ id: "latest", label: "Latest Trace" }]; }
  async fetch(_id: string): Promise<Session> {
    const res = await fetch("/api/trace/latest");
    return (await res.json()) as Session;
  }
}
```

## 3. 后端需返回的数据契约

`fetch(id)` 必须返回满足 `Session` 的 JSON。**带 `_` 前缀的字段（`_layout`/`_px` 等）由前端计算，后端不要提供。**

### Session

```jsonc
{
  "id": "trace-187",
  "totalSuites": 240,         // N，测试套总数
  "targetSuite": 187,         // 失败目标 X
  "verdict": "found",         // "found" | "combo" | "split"
  "culprit": 63,              // found 时锁定的污染源 i；其它为 null
  "comboRanges": null,        // combo/split 时为 [[a,b],...]；found 可省略或 null
  "trials": [ /* Trial[]，按执行顺序 */ ],
  "converged": { /* trials 中收敛/停止所在的那个 Trial（同一对象内容） */ }
}
```

### Trial

```jsonc
{
  "id": 0,
  "parentId": null,           // 根为 null，其余为父节点 id
  "side": "root",             // "root" | "left" | "right"
  "a": 0, "b": 186,           // 注入的前缀区间 [a, b]
  "target": 187,              // 复跑的失败目标 X
  "result": "fail",           // "pass" | "fail"
  "depth": 0,                 // 树深度，root=0
  "info": { /* TrialInfo */ }
}
```

### TrialInfo

```jsonc
{
  "duration": 2.31,           // 执行耗时（秒）
  "executed": [0,1,2,3,4,5,6],// 实际注入的套（可截断，用于展示）
  "total": 187,               // 注入区间的套总数
  "note": "Target failed again — culprit lies in this range",
  "logs": [
    { "lvl": "dim", "text": "▶ Inject prefix suites [0..186] (187 suites)" },
    { "lvl": "err", "text": "✗ suite #187 FAILED · contamination reproduced" }
  ]
}
```

`LogLine.lvl` 取值：`dim`（灰）/ `ok`（绿）/ `warn`（橙）/ `err`（红）。

### SessionRef（list 返回）

```jsonc
{ "id": "trace-187", "label": "Latest Trace" }
```

`label` 是列表中展示的名称，前端不解析其语义。

## 4. 字段约束与一致性要求

前端**信任**后端数据，不做容错重算。以下约束需后端保证，否则渲染会异常：

| 约束 | 说明 |
|------|------|
| `trials` 含且仅含一个 `side: "root"` | 布局以 root 为树根，缺失会报错 |
| `parentId` 必须指向同 `trials` 内已存在的 id | 否则该节点连不上树 |
| `converged` 是 `trials` 中某个 trial | 加载后自动选中并居中它 |
| `verdict="found"` 时 `culprit` 应非 null | 时间轴/摘要会高亮该 suite |
| `verdict` 为 `combo`/`split` 时给 `comboRanges` | 用于时间轴标记涉及的套 |
| `depth` 与 `parentId` 链一致（root=0，逐层+1） | 决定节点纵向层级 |
| 坐标 / `_layout` 字段不要返回 | 由 `layoutTree` 计算回填 |

## 5. 验证对接是否成功

### 浏览器

替换 `DATA_SOURCE` 后 `npm run build`，刷新页面：

- 顶部加载器提示显示你的会话 `label`。
- 点击 `⟳ Load Data` 能轮转你 `list()` 返回的多个会话。
- 树、时间轴、摘要、详情随数据正确呈现，verdict 徽章与数据一致。

接口出错时不会崩，错误打印在浏览器控制台（`[trace] ...`）。

### Node 冒烟测试（无需浏览器）

核心逻辑有浏览器环境守卫，可在 Node 下导入数据源直接验证：

```bash
npm run build
node --input-type=module -e '
import { DATA_SOURCE } from "./dist/app.js";
for (const ref of await DATA_SOURCE.list()) {
  const s = await DATA_SOURCE.fetch(ref.id);
  console.log(ref.label, "| trials=" + s.trials.length, "| verdict=" + s.verdict);
}'
```

> 注意：若 `DATA_SOURCE` 改为 `HttpDataSource`，Node 环境需要 `fetch`（Node 18+ 内置）且后端可达，否则用 `MockDataSource` 验证逻辑、用浏览器验证真实接口。

## 6. 跨域 / 部署提示

- 前端是纯静态资源（`index.html` + `dist/`），可与后端**同源**部署（推荐，免跨域）。
- 跨域时后端需开启 CORS，或前端用反向代理把 `/api/trace` 转发到后端。
- 鉴权 token 等放在自定义 `TraceDataSource` 实现的请求头里，不要写进前端常量。
