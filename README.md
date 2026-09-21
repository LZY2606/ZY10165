# 脉钟签证（Pulse-Clock Visa）

计时小组导入不同望次的脉冲到达时刻（TOA），用频率 `f0`、频率导数 `f1`、
色散量 DM 与仪器时钟事件解释残差。本服务重点处理**跨多个自转周期的整周模糊**：
不是只画一条拟合线，而是并行保留多个整数周假设分支，并在数据不足以区分时
明确标注“可识别性不足”。

## 安装与演示

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm test -- --run
corepack pnpm dev --host 127.0.0.1 --port 5505
```

浏览器访问 <http://127.0.0.1:5505>，页面标题为 **脉钟签证**。

其他命令：

- `corepack pnpm build`：TypeScript 严格类型检查（`--noEmit`）。
- `corepack pnpm start -- --db /path/to/file.sqlite`：用显式数据库路径启动。

## 页面能力

- 表格展示到达时刻（整数纳秒台钟时间）、观测频段、固化整数周 `N` 与包裹相位 `w`。
- Canvas 绘制包裹相位与两分支逐点残差柱状图。
- 在任一空档前后把周数偏移 `k` 加/减一个整数周（每分支独立）。
- 添加共同时钟跳变（整数纳秒），可指定任意 TOA 为“排除候选”。
- 每个分支保留：拟合参数（`phi0/f0/f1/DM`）、rms/χ²/dof、逐点残差、
  整周偏移、时钟事件、排除集合，以及所依赖的输入版本与输入哈希。
- 两个分支可按观测点逐点比较（整周编号、各自残差、Δ 残差）。
- 输入版本可在 `v1-baseline`（回退末端望次）与 `v2-with-endpoint`（含末端）间切换。

## 数据口径（固定 fixture）

固定夹具固化在 `src/core/fixtures/fixture.json`，生成器在
`src/core/fixtures/gen.ts`，可用 `corepack pnpm exec tsx scripts/snapshot-fixture.mts`
重新生成并校对。

| 项目 | 取值 |
| --- | --- |
| 历元 `tRef` | `1000000000000000000 ns`（整数纳秒） |
| 自转频率 `f0` | `100 Hz`（周期 10 ms） |
| 频率导数 `f1` | `0 Hz/s` |
| 色散量 DM | `100 pc cm^-3`（参考频率 1400 MHz） |
| DM 延迟 | `4.148808 ms · DM · (f^-2 − 1400^-2)`，f 以 MHz 计 |
| 望次 A | `tRef` 的 1400/800/400 MHz 三点 + `tRef+600 s` 的 1400 MHz 点 |
| 望次 B | 跨越 `2,592,000 s`（30 天）空档后的 1400 MHz 点 |
| 望次 C | B 之后 `1000 s` 的末端 1400 MHz 点（仅 v2） |

真值相位满足 `N + w = phase0 + f0·(tObs − ΔDM − tRef) + 0.5·f1·(…)^2`。
生成时 `N = floor(phase)` 以 BigInt 固化为字符串；运行期**不允许**由
`w` 通过浮点取模反推大计数。

### 为什么前半段并列、加末端才可区分

- v1 只有两个不同历元（A 簇与 B），常数整数周跳可以被二次多项式
  （`phi0/f0/f1`）在两个历元上完全吸收，因此 `k=0` 与 `k=1` 的 rms 都约为
  `1e-16 s`，统计并列 → 页面显示“可识别性不足”，两分支同时保留。
- v2 增加 B 后 1000 s 的末端点 C，出现第三个不同历元，错周方案无法同时满足
  三个历元：`k=0` rms 约 `2.7e-14 s`，`k=1` rms 约 `1.24e-6 s`，两分支可区分。
- 验收回退末端（切回 v1）后两个分支再次并列；加回末端（切到 v2）后可区分。

## 关键语义

### 整数周展开

`src/core/phase.ts` 的 `applyGapOffsets` / `expandedPhaseCycles` 一律使用
BigInt 做整数加法：

```
N_eff = N_stored + Σ gapOffset(gap)   // 观测位于该空档之后时
```

大计数（例如 `2^53` 以上）永远不经过 `% 1` 或 `Math.round` 推断；
测试 `test/integer-cycle.test.ts` 显式断言超过 `Number.MAX_SAFE_INTEGER`
时只有 BigInt 精确。

### 右连续时钟跳变

台钟读数与参考时的关系为

```
tObs = t + Σ { jump(event) : event.atNs ≤ tObs }
```

即跳变区间是 `[atNs, +∞)`：事件恰好落在观测时刻时，该观测**只应用一次**；
紧邻之前的观测不受影响。同一时刻多个事件按**不可变事件序号 `seq`** 升序合成，
合成结果与插入顺序无关。事件序号唯一，重放时按原序号重建。

### 分支与输入版本

- 每个分支记录 `baseVersion`、`gapOffsets`、`excluded`、时钟事件，
  以及由上述内容与 TOA 集合共同计算的 SHA-256 `inputHash`。
- 切换输入版本时，现有分支重定向到新版本 TOA 集合并标记拟合失效，
  分支本身不会被自动删除。
- 并列判定容差：rms 差 ≤ `1e-9 s`（`src/core/constants.ts` 的
  `TIE_RMS_TOL_S`）。

## 运行记录导出 / 清空复核

- `GET /api/export`（页面“导出运行记录”）导出 JSON 信封：内嵌两个 fixture
  版本的全部 TOA（BigInt 序列化为字符串）、全部分支状态与按序号排列的
  append-only 操作日志。
- `POST /api/import`（页面“导入并重放”）清空内存状态后，按操作序号逐条重放，
  重建分支、偏移、排除、时钟事件，再统一拟合并校验：
  - 重放后分支集合、偏移、排除集合、时钟事件（序号/时刻/跳变量）逐一比对；
  - 导出前后 fixture TOA 的 SHA-256 必须一致；
  - 导入同时覆写 SQLite，与“清空数据库后重新导入复核”等价。
- `POST /api/reset`（页面“重置”）清空所有 SQLite 表并重新导入固定 fixture 种子。

## SQLite

数据库默认 `data/purge-clock-visa.sqlite`（可用 `--db` 覆盖），由
better-sqlite3 提供（SQLite 3.53）。表：`dataset_versions`、`toas`、
`branches`、`clock_events`、`fits`、`operations`、`meta`。
时钟事件表 `seq` 全局自增且不可变；所有变更在事务中整体替换以保证一致性。

## 自动化测试

`corepack pnpm test -- --run` 运行 4 个套件共 18 个用例：

- `test/integer-cycle.test.ts`：BigInt 整周、大计数不取模、右连续边界、
  同时刻事件按序号合成。
- `test/identifiability.test.ts`：v1 并列标注、v2 可区分、版本反复切换。
- `test/service.test.ts`：边界时钟只作用一次、排除/恢复、SQLite 关闭重开恢复、
  导出→清空→重放哈希一致、重置复核。
- `test/http.test.ts`：真实端口端到端（标题“脉钟签证”、Canvas 客户端、
  API、版本切换、时钟边界、逐点比较）。

## 主要 API

| 方法 路径 | 说明 |
| --- | --- |
| `GET /api/state` | 当前版本 TOA、分支、拟合、并列对 |
| `POST /api/switch-version` | 切换 `v1-baseline` / `v2-with-endpoint` |
| `POST /api/branches` | 从某分支克隆新假设 |
| `POST /api/branches/adjust-offset` | 空档周数 ±整数 |
| `POST /api/branches/exclude` | 标记/恢复排除候选 |
| `POST /api/branches/clock-event` | 添加右连续时钟跳变 |
| `POST /api/branches/remove-clock-event` | 按序号删除事件 |
| `POST /api/compare` | 两分支逐点比较 |
| `POST /api/refit` | 重新拟合全部分支 |
| `GET /api/export` / `POST /api/import` | 运行记录导出/重放 |
| `POST /api/reset` | 清空并恢复种子 |
