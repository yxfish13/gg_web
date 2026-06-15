/**
 * 测试套污染溯源 · 二分定位可视化
 * ------------------------------------------------------------------
 * 把后端「对失败目标 X 反复二分 [0..X-1] 前缀以逼近污染源」的调用记录，
 * 可视化为一棵二分搜索树。本文件是纯前端逻辑层（无框架依赖）。
 *
 * 对接真实后端：只需替换 `fetchSession`，让它返回符合 `Session` 契约的数据。
 */

/* ============================================================
 * 数据契约 (Data Contract)
 * ============================================================ */
export type Side = "root" | "left" | "right";
export type TrialResult = "pass" | "fail";
export type Verdict = "found" | "combo" | "split";
export type LogLevel = "dim" | "ok" | "warn" | "err";

/** 一行执行日志 */
export interface LogLine {
  lvl: LogLevel;
  text: string;
}

/** 单次试验的附加信息（可由后端扩展，前端按需展示） */
export interface TrialInfo {
  duration: number;      // 执行耗时（秒）
  executed: number[];    // 实际注入的测试套（截断展示用）
  total: number;         // 注入区间的测试套总数
  note: string;          // 一句话判定说明
  logs: LogLine[];       // 执行日志
}

/** 一次二分试验：执行前缀 [a,b]，复跑目标 target，看是否仍失败 */
export interface Trial {
  id: number;
  parentId: number | null;
  side: Side;
  a: number;             // 注入区间起点
  b: number;             // 注入区间终点
  target: number;        // 复跑的失败目标 X
  result: TrialResult;   // X 在该前缀下是否仍失败
  depth: number;         // 树深度（root=0）
  info: TrialInfo;
  // —— 以下为前端布局时回填的坐标，后端无需提供 ——
  _px?: number;          // 节点中心 x（像素）
  _py?: number;          // 节点底部 y（像素，连线锚点）
  _x?: number;           // 布局中间量
  _y?: number;
}

/** 树布局的派生数据 */
export interface Layout {
  byId: Map<number, Trial>;
  kids: Map<number, Trial[]>;
  contentW: number;      // 画布内容宽（像素）
  contentH: number;      // 画布内容高（像素）
  maxDepth: number;
}

export type ComboRange = [number, number];

/** 一次完整溯源会话 —— 后端按此结构返回即可对接 */
export interface Session {
  id: string;
  totalSuites: number;            // N
  targetSuite: number;            // 失败目标 X
  verdict: Verdict;               // 最终结论
  culprit: number | null;         // found 时锁定的污染源 i
  comboRanges?: ComboRange[];     // combo/split 时涉及的套
  trials: Trial[];                // 二分调用记录（按执行顺序）
  converged: Trial;               // 收敛/停止所在的节点
  _layout?: Layout;               // 前端回填
}

/* ============================================================
 * Mock 数据层 —— 对接真实后端时整段可删除
 * ============================================================ */

/** 可复现的伪随机数（固定种子，保证每次刷新数据一致） */
const RNG: () => number = (seed => () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)(20260613);
const ri = (lo: number, hi: number): number => lo + Math.floor(RNG() * (hi - lo + 1));

/** 为一次试验生成 mock 的执行信息与日志 */
function mkInfo(a: number, b: number, target: number, result: TrialResult): TrialInfo {
  const cnt = b - a + 1;
  const dur = (cnt * ri(8, 22) + ri(120, 400)) / 1000;
  const executed: number[] = [];
  for (let i = a; i <= b && executed.length < 7; i++) executed.push(i);
  const logs: LogLine[] = [
    { lvl: "dim", text: `▶ Inject prefix suites [${a}..${b}] (${cnt} suites)` },
    { lvl: "ok", text: `✓ Prefix executed · ${(dur * 0.7).toFixed(2)}s` },
    { lvl: "dim", text: `▶ Re-run target suite #${target}` },
  ];
  if (result === "fail") {
    logs.push({ lvl: "err", text: `✗ suite #${target} FAILED · contamination reproduced` });
    logs.push({ lvl: "err", text: `  AssertionError: expected state to be clean` });
    logs.push({ lvl: "warn", text: `  ↳ residual source likely within [${a}..${b}]` });
  } else {
    logs.push({ lvl: "ok", text: `✓ suite #${target} PASSED · range is clean` });
  }
  return {
    duration: +dur.toFixed(2),
    executed,
    total: cnt,
    note: result === "fail" ? "Target failed again — culprit lies in this range" : "Target passed — this range can be ruled out",
    logs,
  };
}

/** 污染判定函数：返回 true 表示在前缀 [a,b] 下目标 X 仍失败 */
type EvalRange = (a: number, b: number) => boolean;

interface SimulateParams {
  N: number;
  target: number;
  evalRange: EvalRange;
  verdict: Verdict;
  culprit?: number;
  comboRanges?: ComboRange[];
}

/**
 * 二分模拟器：复现后端逻辑 —— 对失败目标 X，反复二分 [0..X-1] 前缀逼近污染源。
 * 每层把当前区间劈成左右两半各跑一次，依据结果决定收敛方向或停止。
 */
function simulate({ N, target, evalRange, verdict, culprit, comboRanges }: SimulateParams): Session {
  const trials: Trial[] = [];
  let tid = 0;
  const push = (parentId: number | null, side: Side, a: number, b: number, depth: number): Trial => {
    const result: TrialResult = evalRange(a, b) ? "fail" : "pass";
    const t: Trial = { id: tid++, parentId, side, a, b, target, result, depth, info: mkInfo(a, b, target, result) };
    trials.push(t);
    return t;
  };

  const root = push(null, "root", 0, target - 1, 0);   // 根：整段前缀 [0..X-1]
  let cur = root, depth = 1;
  while (cur.a < cur.b) {
    const mid = Math.floor((cur.a + cur.b) / 2);
    const L = push(cur.id, "left", cur.a, mid, depth);
    const R = push(cur.id, "right", mid + 1, cur.b, depth);
    depth++;
    const lf = L.result === "fail", rf = R.result === "fail";
    if (lf && rf) break;        // 两边都失败 → 多源污染，停止
    if (!lf && !rf) break;      // 两边都通过 → 跨界组合，停止
    cur = lf ? L : R;           // 收敛到失败的那一半
  }

  return {
    id: "trace-" + target,
    totalSuites: N,
    targetSuite: target,
    verdict,
    culprit: culprit ?? null,
    comboRanges,
    trials,
    converged: cur,
  };
}

/* ---- 三套预置场景 ---- */
// 场景一：正常收敛 —— 单一污染源，二分逐步逼近，锁定 suite #i
function scenarioFound(): Session {
  const N = 240, target = 187, culprit = 63;
  return simulate({ N, target, culprit, verdict: "found", evalRange: (a, b) => a <= culprit && culprit <= b });
}
// 场景二：两边都失败 —— 存在两个「独立」污染源，任一半区单独即可复现 → 多源污染
function scenarioCombo(): Session {
  const N = 320, target = 251, c1 = 40, c2 = 198;
  return simulate({
    N, target, comboRanges: [[c1, c1], [c2, c2]], verdict: "combo",
    evalRange: (a, b) => (a <= c1 && c1 <= b) || (a <= c2 && c2 <= b),
  });
}
// 场景三：两边都通过 —— 污染需两个套「共存」才触发，首次二分恰好把它们劈开 → 跨界组合
function scenarioSplit(): Session {
  const N = 160, target = 142, c1 = 70, c2 = 90;
  return simulate({
    N, target, comboRanges: [[c1, c1], [c2, c2]], verdict: "split",
    evalRange: (a, b) => a <= c1 && c1 <= b && a <= c2 && c2 <= b,
  });
}

export type ScenarioKey = "found" | "combo" | "split";

interface ScenarioDef {
  label: string;
  build: () => Session;
}

export const SCENARIOS: Record<ScenarioKey, ScenarioDef> = {
  found: { label: "✦ Located", build: scenarioFound },
  combo: { label: "⚇ Multi-source", build: scenarioCombo },
  split: { label: "⚡ Co-existence", build: scenarioSplit },
};

/**
 * 拉取一个内置 mock 场景（仅 demo 模式使用）。
 */
export async function fetchSession(key: ScenarioKey): Promise<Session> {
  return SCENARIOS[key].build();
}

/* ============================================================
 * 运行模式 (Run Mode)
 * ------------------------------------------------------------
 * demo —— 内置三套 mock 场景，顶部出现场景切换标签，仅用于展示。
 * live —— 对接真实后端：一次溯源只有一个会话、一个 verdict，
 *         隐藏场景标签，改由 fetchLiveSession() 拉取唯一会话。
 * 真实部署时把下面这行改为 "live"，并实现 fetchLiveSession 即可。
 * ============================================================ */
export type AppMode = "demo" | "live";
export const APP_MODE = "demo" as AppMode;

/**
 * 拉取真实后端的唯一溯源会话（live 模式）。这是对接真实 API 的唯一改动点：
 *   const res = await fetch("/api/trace/latest");
 *   return await res.json() as Session;
 * 只要返回的 JSON 满足 `Session` 契约，前端无需任何其它改动。
 */
export async function fetchLiveSession(): Promise<Session> {
  const res = await fetch("/api/trace/latest");
  if (!res.ok) throw new Error(`fetchLiveSession failed: HTTP ${res.status}`);
  return (await res.json()) as Session;
}

/* ============================================================
 * 全局状态
 * ============================================================ */
interface AppState {
  key: ScenarioKey;
  session: Session | null;
  selected: number | null;        // 当前选中的 trial id
  reveal: number | null;          // null=全展开；动画回放时为已显示数量
  replayTimer: number | null;
  zoom: number;                   // 树画布缩放倍率（1=100%）
}

const State: AppState = {
  key: "found",
  session: null,
  selected: null,
  reveal: null,
  replayTimer: null,
  zoom: 1,
};

const ZOOM_MIN = 0.3, ZOOM_MAX = 2.4, ZOOM_STEP = 1.2;

/* ============================================================
 * 整洁树布局 (tidy tree)
 * 叶子均分横向空间，内部节点居中于子节点之上；直接产出像素坐标，
 * 画布按内容尺寸撑开，可滚动浏览。
 * ============================================================ */
const NODE_W = 116, NODE_H = 54, LEVEL_GAP = 56;

function layoutTree(session: Session): void {
  const { trials } = session;
  const byId = new Map<number, Trial>(trials.map(t => [t.id, t]));
  const kids = new Map<number, Trial[]>(trials.map(t => [t.id, [] as Trial[]]));
  trials.forEach(t => { if (t.parentId != null) kids.get(t.parentId)!.push(t); });
  const root = trials.find(t => t.side === "root")!;
  const maxDepth = Math.max(...trials.map(t => t.depth));

  let leafX = 0;
  const assign = (t: Trial): void => {
    const ch = kids.get(t.id)!;
    if (ch.length === 0) { t._x = leafX * NODE_W; leafX++; return; }
    ch.forEach(assign);
    t._x = (ch[0]._x! + ch[ch.length - 1]._x!) / 2;   // 居中于子节点
  };
  assign(root);

  const xs = trials.map(t => t._x!);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  trials.forEach(t => { t._y = t.depth * (NODE_H + LEVEL_GAP); });
  const contentW = (maxX - minX) + NODE_W * 1.6;
  const contentH = (maxDepth + 1) * (NODE_H + LEVEL_GAP);
  trials.forEach(t => { t._px = (t._x! - minX) + NODE_W * 0.8; t._py = t._y! + NODE_H; });
  session._layout = { byId, kids, contentW, contentH, maxDepth };
}

/* ============================================================
 * 渲染层
 * ============================================================ */
const $ = <T extends HTMLElement = HTMLElement>(sel: string): T =>
  document.querySelector(sel) as T;

const SVGNS = "http://www.w3.org/2000/svg";

/** 当前会话（断言非空，渲染函数仅在 loadScenario 后调用） */
function sess(): Session {
  return State.session!;
}

function renderScenarioTabs(): void {
  const box = $("#scenario-tabs");
  box.innerHTML = "";
  // live 模式只有唯一会话，无需场景切换标签
  if (APP_MODE === "live") { box.style.display = "none"; return; }
  (Object.entries(SCENARIOS) as [ScenarioKey, ScenarioDef][]).forEach(([k, v]) => {
    const b = document.createElement("button");
    b.textContent = v.label;
    b.className = k === State.key ? "active" : "";
    b.onclick = () => void loadScenario(k);
    box.appendChild(b);
  });
}

function renderVerdict(): void {
  const s = sess(), el = $("#verdict"), txt = $("#verdict-text");
  el.className = "verdict " + s.verdict;
  if (s.verdict === "found") {
    txt.innerHTML = `Culprit located → <b>suite #${s.culprit}</b>`;
  } else if (s.verdict === "combo") {
    txt.innerHTML = `Multi-source → <b>#${s.comboRanges![0][0]} / #${s.comboRanges![1][0]} trigger independently</b>`;
  } else {
    txt.innerHTML = `Co-existence → <b>#${s.comboRanges![0][0]} + #${s.comboRanges![1][0]} must co-occur</b>`;
  }
}

/** 摘要横条：左=溯源结果，右=测试套统计 */
function renderInfoCards(): void {
  const s = sess(), L = s._layout!;

  // —— 左：溯源结果 ——
  $("#sm-target").innerHTML = `Failing target <b>suite #${s.targetSuite}</b>`;
  const reason = $("#sm-reason"), culprit = $("#sm-culprit");
  if (s.verdict === "found") {
    reason.textContent = "Single source: an earlier suite leaves residual state that makes the target fail when run afterwards.";
    culprit.innerHTML = `<span class="pill found">Culprit #${s.culprit}</span>`;
  } else if (s.verdict === "combo") {
    reason.textContent = "Multi-source: each half reproduces the failure on its own — multiple independent culprits exist.";
    culprit.innerHTML = s.comboRanges!
      .map(r => `<span class="pill combo">#${r[0]}</span>`).join("");
  } else {
    reason.textContent = "Co-existence: each half passes alone; contamination needs two suites together, and the first bisection split them apart.";
    culprit.innerHTML = `<span class="pill split">#${s.comboRanges![0][0]} + #${s.comboRanges![1][0]} together</span>`;
  }

  // —— 右：测试套统计胶囊 ——
  const conv = s.converged;
  const failCnt = s.trials.filter(t => t.result === "fail").length;
  const stats: [string, string, boolean][] = [
    ["TOTAL N", String(s.totalSuites), false],
    ["TRIALS", String(s.trials.length), true],
    ["FAILED", String(failCnt), false],
    ["DEPTH", String(L.maxDepth), false],
    ["CONVERGED", `[${conv.a}-${conv.b}]`, true],
  ];
  $("#sm-stats").innerHTML = stats.map(([k, v, acc]) =>
    `<div class="stat"><span class="k">${k}</span><span class="v${acc ? " accent" : ""}">${v}</span></div>`
  ).join("");
}

/** 时间轴：高亮「当前选中节点」对应的注入区间 */
function renderTimeline(): void {
  const s = sess(), N = s.totalSuites;
  $("#tl-count").textContent = `(N=${N})`;
  const sel = State.selected != null ? s.trials.find(t => t.id === State.selected) : null;

  const track = $("#track"); track.innerHTML = "";
  for (let i = 0; i < N; i++) {
    const c = document.createElement("div");
    c.className = "cell";
    if (sel && i >= sel.a && i <= sel.b) c.className += " in-range";
    if (i === s.targetSuite) c.className = "cell target";
    if (s.verdict === "found" && i === s.culprit) c.className = "cell culprit";
    if (s.verdict !== "found" && s.comboRanges && s.comboRanges.some(r => i >= r[0] && i <= r[1]) && i !== s.targetSuite) {
      c.className = "cell culprit";
    }
    track.appendChild(c);
  }
  const addFlag = (idx: number, cls: string, label: string): void => {
    const f = document.createElement("div");
    f.className = "flag " + cls; f.textContent = label;
    f.style.left = ((idx + 0.5) / N * 100) + "%";
    track.appendChild(f);
  };
  addFlag(s.targetSuite, "target", `X · #${s.targetSuite}`);
  if (s.verdict === "found" && s.culprit != null) addFlag(s.culprit, "culprit", `Culprit · #${s.culprit}`);
  if (s.verdict !== "found" && s.comboRanges) s.comboRanges.forEach(r => addFlag(r[0], "culprit", `#${r[0]}`));

  const ruler = $("#ruler"); ruler.innerHTML = "";
  [0, Math.floor(N / 4), Math.floor(N / 2), Math.floor(3 * N / 4), N - 1]
    .forEach(v => { const sp = document.createElement("span"); sp.textContent = "#" + v; ruler.appendChild(sp); });
}

/** 二分搜索树：默认全展开，可滚动浏览 */
function renderTree(): void {
  const s = sess(), L = s._layout!;
  const svg = $<HTMLElement>("#tree-canvas");
  const nodesEl = $("#tree-nodes"), content = $("#tree-content"), stage = $("#tree-stage");
  const W = L.contentW, H = L.contentH;
  content.style.width = W + "px"; content.style.height = H + "px";
  // tree-stage 撑开缩放后的实际占位，保证滚动条范围正确
  stage.style.width = (W * State.zoom) + "px"; stage.style.height = (H * State.zoom) + "px";
  content.style.transform = `scale(${State.zoom})`;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = ""; nodesEl.innerHTML = "";

  // reveal=null → 全部可见；否则只显示前 reveal 个（动画回放用）
  const showN = State.reveal == null ? s.trials.length : State.reveal;
  const visible = s.trials.slice(0, showN);
  const visIds = new Set(visible.map(t => t.id));
  const byId = L.byId, conv = s.converged;

  // 连线（父顶 → 子底），贝塞尔曲线，失败分支流光
  visible.forEach(t => {
    if (t.parentId == null || !visIds.has(t.parentId)) return;
    const p = byId.get(t.parentId)!;
    const ax = p._px!, ay = p._py!, bx = t._px!, by = t._py! - NODE_H;
    const midY = (ay + by) / 2;
    const path = document.createElementNS(SVGNS, "path");
    path.setAttribute("d", `M ${ax} ${ay} C ${ax} ${midY}, ${bx} ${midY}, ${bx} ${by}`);
    path.setAttribute("class", "svg-edge");
    path.setAttribute("stroke", t.result === "fail" ? "var(--fail)" : "var(--pass)");
    path.setAttribute("opacity", t.result === "fail" ? "0.8" : "0.4");
    if (t.result === "fail") {
      path.setAttribute("stroke-dasharray", "6 6");
      (path as unknown as HTMLElement).style.animation = "flow 0.8s linear infinite";
    }
    svg.appendChild(path);
  });

  // 节点卡片
  visible.forEach(t => {
    const isCulprit = conv.id === t.id && s.verdict === "found" && t.a === t.b;
    const node = document.createElement("div");
    node.className = `node ${t.result} ${State.selected === t.id ? "sel" : ""} ${isCulprit ? "culprit-node" : ""}`;
    node.style.left = t._px + "px"; node.style.top = (t._py! - NODE_H / 2) + "px";
    const sideLabel = t.side === "root" ? "ROOT" : t.side === "left" ? "◀ LEFT" : "RIGHT ▶";
    node.innerHTML = `
      <div class="card">
        <div class="rng">[${t.a}–${t.b}]</div>
        <div class="meta">
          <span class="badge">${t.result === "fail" ? "FAIL ✗" : "PASS ✓"}</span>
          <span class="count">${t.b - t.a + 1} suites</span>
        </div>
        <div class="node-side">${sideLabel}</div>
      </div>`;
    node.onclick = () => selectTrial(t.id);
    nodesEl.appendChild(node);
  });
}

/** 详情面板 */
function renderDetail(): void {
  const s = sess();
  const empty = $("#detail-empty"), content = $("#detail-content");
  const t = State.selected != null ? s.trials.find(x => x.id === State.selected) : null;
  if (!t) { empty.style.display = "grid"; content.style.display = "none"; return; }
  empty.style.display = "none"; content.style.display = "flex";

  $("#d-label").textContent = `TRIAL #${t.id} · ${t.side.toUpperCase()} · DEPTH ${t.depth}`;
  $("#d-range").innerHTML = `[${t.a} – ${t.b}] <small>${t.info.total} suites total</small>`;

  const verdictRow = t.result === "fail"
    ? `<span class="v fail">FAIL · contamination reproduced</span>`
    : `<span class="v pass">PASS · range is clean</span>`;
  const chips = t.info.executed.map(i => `<span class="chip">#${i}</span>`).join("")
    + (t.info.total > t.info.executed.length ? `<span class="more">… +${t.info.total - t.info.executed.length}</span>` : "")
    + `<span class="chip t">re-run #${t.target}</span>`;
  const logs = t.info.logs.map(l => `<div class="ln ${l.lvl}">${l.text}</div>`).join("");

  $("#d-body").innerHTML = `
    <div class="kv"><span class="k">Re-run result</span><span class="v ${t.result}">${verdictRow}</span></div>
    <div class="kv"><span class="k">Target suite</span><span class="v">#${t.target}</span></div>
    <div class="kv"><span class="k">Injected range</span><span class="v">[${t.a} .. ${t.b}]</span></div>
    <div class="kv"><span class="k">Duration</span><span class="v">${t.info.duration}s</span></div>
    <div class="kv"><span class="k">Verdict</span><span class="v">${t.info.note}</span></div>
    <div class="section-title">INJECTED PREFIX</div>
    <div class="suite-chips">${chips}</div>
    <div class="section-title">EXECUTION LOG</div>
    <div class="logbox">${logs}</div>`;
}

/** 选中某个 trial：刷新树/详情/控制条，并把节点滚到可视区中央 */
function selectTrial(id: number, scroll = true): void {
  State.selected = id;
  renderTree(); renderDetail(); renderControls(); renderTimeline();

  if (scroll) {
    const s = sess(), t = s.trials.find(x => x.id === id);
    const scroller = $("#tree-scroll");
    if (t && scroller) {
      // 节点在 stage 中的实际像素位置 = 布局坐标 × 缩放倍率
      const tx = t._px! * State.zoom - scroller.clientWidth / 2;
      const ty = (t._py! - NODE_H / 2) * State.zoom - scroller.clientHeight / 2;
      scroller.scrollTo({ left: Math.max(0, tx), top: Math.max(0, ty), behavior: "smooth" });
    }
    // 序列芯片滚入视野
    const chip = $(`#seq [data-id="${id}"]`);
    if (chip) chip.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }
}

/** 控制条：序列芯片导航 + 进度计数 */
function renderControls(): void {
  const s = sess();
  const conv = s.converged;
  const seq = $("#seq"); seq.innerHTML = "";
  s.trials.forEach((t, ix) => {
    const isCulprit = conv.id === t.id && s.verdict === "found" && t.a === t.b;
    const chip = document.createElement("button");
    chip.className = `step ${t.result} ${State.selected === t.id ? "sel" : ""} ${isCulprit ? "culprit" : ""}`;
    chip.dataset.id = String(t.id);
    chip.innerHTML = `<i class="dt"></i><span class="ix">${ix}</span><span class="rg">[${t.a}-${t.b}]</span>`;
    chip.onclick = () => selectTrial(t.id);
    seq.appendChild(chip);
  });

  const cur = State.selected != null ? s.trials.findIndex(t => t.id === State.selected) : -1;
  $("#p-cur").textContent = String(cur + 1);
  $("#p-total").textContent = String(s.trials.length);
  const sel = cur >= 0 ? s.trials[cur] : null;
  $("#p-desc").textContent = sel
    ? `${sel.side === "root" ? "Full prefix" : sel.side === "left" ? "Left half" : "Right half"} · ${sel.result === "fail" ? "contamination reproduced" : "range is clean"}`
    : "—";
}

/** 整页渲染 */
function renderAll(): void {
  renderScenarioTabs();
  renderVerdict();
  renderInfoCards();
  renderTimeline();
  renderTree();
  renderDetail();
  renderControls();
}

/** 按执行顺序前后移动选中项 */
function navSel(dir: 1 | -1): void {
  const s = sess();
  const cur = State.selected != null ? s.trials.findIndex(t => t.id === State.selected) : -1;
  const next = Math.min(s.trials.length - 1, Math.max(0, cur + dir));
  selectTrial(s.trials[next].id);
}

/* ---- 缩放 (Zoom) ---- */

/** 应用缩放：重绘树并刷新缩放比标签 */
function applyZoom(): void {
  renderTree();
  const lvl = $("#zoom-level");
  if (lvl) lvl.textContent = Math.round(State.zoom * 100) + "%";
}

/**
 * 设置缩放倍率（带钳制）。anchor 为可选的视口锚点（滚动容器内坐标），
 * 用于以鼠标位置为中心缩放，保持锚点下的内容不漂移。
 */
function setZoom(next: number, anchor?: { x: number; y: number }): void {
  const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
  if (z === State.zoom) return;
  const scroller = $("#tree-scroll");
  const old = State.zoom;
  // 记录锚点对应的内容坐标，缩放后回滚滚动位置使其不漂移
  const ax = anchor ? anchor.x : (scroller ? scroller.clientWidth / 2 : 0);
  const ay = anchor ? anchor.y : (scroller ? scroller.clientHeight / 2 : 0);
  const contentX = scroller ? (scroller.scrollLeft + ax) / old : 0;
  const contentY = scroller ? (scroller.scrollTop + ay) / old : 0;
  State.zoom = z;
  applyZoom();
  if (scroller) {
    scroller.scrollLeft = contentX * z - ax;
    scroller.scrollTop = contentY * z - ay;
  }
}

/** 适配窗口：按内容与视口比例自动选定缩放，并回到顶部居中 */
function zoomFit(): void {
  const s = State.session;
  const scroller = $("#tree-scroll");
  if (!s || !s._layout || !scroller) return;
  const { contentW, contentH } = s._layout;
  const pad = 32;
  const fitW = (scroller.clientWidth - pad) / contentW;
  const fitH = (scroller.clientHeight - pad) / contentH;
  State.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.min(fitW, fitH)));
  applyZoom();
  scroller.scrollTop = 0;
}

/** 可选回放：逐个揭示节点，结束后定位收敛点 */
function replay(): void {
  const s = sess();
  if (State.replayTimer != null) { clearInterval(State.replayTimer); State.replayTimer = null; }
  State.reveal = 0; State.selected = null;
  renderTree(); renderDetail(); renderControls();
  State.replayTimer = window.setInterval(() => {
    State.reveal = (State.reveal ?? 0) + 1;
    if (State.reveal >= s.trials.length) {
      clearInterval(State.replayTimer!); State.replayTimer = null;
      State.reveal = null;
      selectTrial(s.converged.id);
    } else {
      const last = s.trials[State.reveal - 1];
      selectTrial(last.id, false);
    }
  }, 650);
}

/** 把一个已拉取的会话装载进视图：布局 → 状态复位 → 渲染 → 定位收敛点 */
function applySession(session: Session): void {
  if (State.replayTimer != null) { clearInterval(State.replayTimer); State.replayTimer = null; }
  layoutTree(session);
  State.session = session;
  State.reveal = null;
  State.zoom = 1;
  State.selected = session.converged.id;
  renderAll();
  applyZoom();
  requestAnimationFrame(() => selectTrial(session.converged.id));
}

/** 加载内置 mock 场景（demo 模式） */
async function loadScenario(key: ScenarioKey): Promise<void> {
  State.key = key;
  applySession(await fetchSession(key));
}

/** 加载真实后端的唯一会话（live 模式） */
async function loadLive(): Promise<void> {
  applySession(await fetchLiveSession());
}

/* ============================================================
 * 事件绑定 + 初始化
 * ============================================================ */
function bindEvents(): void {
  const next = $<HTMLButtonElement>("#btn-next");
  const prev = $<HTMLButtonElement>("#btn-prev");
  const rep = $<HTMLButtonElement>("#btn-replay");
  if (next) next.onclick = () => navSel(1);
  if (prev) prev.onclick = () => navSel(-1);
  if (rep) rep.onclick = () => replay();

  // 缩放按钮
  const zin = $<HTMLButtonElement>("#zoom-in");
  const zout = $<HTMLButtonElement>("#zoom-out");
  const zfit = $<HTMLButtonElement>("#zoom-fit");
  if (zin) zin.onclick = () => setZoom(State.zoom * ZOOM_STEP);
  if (zout) zout.onclick = () => setZoom(State.zoom / ZOOM_STEP);
  if (zfit) zfit.onclick = () => zoomFit();

  // Ctrl/⌘ + 滚轮以鼠标为中心缩放
  const scroller = $("#tree-scroll");
  if (scroller) {
    scroller.addEventListener("wheel", e => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = scroller.getBoundingClientRect();
      const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      setZoom(State.zoom * factor, anchor);
    }, { passive: false });
  }

  document.addEventListener("keydown", e => {
    if (e.key === "ArrowRight") { e.preventDefault(); navSel(1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); navSel(-1); }
    else if ((e.ctrlKey || e.metaKey) && (e.key === "=" || e.key === "+")) { e.preventDefault(); setZoom(State.zoom * ZOOM_STEP); }
    else if ((e.ctrlKey || e.metaKey) && e.key === "-") { e.preventDefault(); setZoom(State.zoom / ZOOM_STEP); }
    else if ((e.ctrlKey || e.metaKey) && e.key === "0") { e.preventDefault(); zoomFit(); }
  });
}

// 仅在浏览器环境自动启动（便于在 Node 下作为纯逻辑模块导入测试）
if (typeof document !== "undefined") {
  bindEvents();
  // demo：加载首个 mock 场景；live：拉取后端唯一会话（失败时打印到控制台）
  if (APP_MODE === "live") {
    void loadLive().catch(err => console.error("[trace] load live session failed:", err));
  } else {
    void loadScenario("found");
  }
}
