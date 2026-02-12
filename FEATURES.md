# Observable Dashboard 功能总览

`tools/observable_dashboard` 用于把轨线数据（`dump_all.pkl`）生成一个可交互的网页仪表盘，支持主页面可观测量分析和 3D 分子轨线查看。

- 主页面入口：`analysis_viz/index.html`
- 3D 页面入口：`analysis_viz/molecule3d.html`

---

## 快速开始

在仓库根目录运行（推荐）：

```bash
python -m tools.observable_dashboard.cli \
  -i run0/dump_all.pkl \
  -o analysis_viz \
  -c tools/viz_config.yaml
```

生成结果：

- 主页面：`analysis_viz/index.html`
- 3D 页面：`analysis_viz/molecule3d.html`
- 静态资源：`analysis_viz/assets/`

### 静态资源布局自动检查

目录重组后可运行以下脚本进行自动化冒烟校验（资源路径、模板脚本顺序、导出产物一致性）：

```bash
python tools/observable_dashboard/scripts/check_static_layout.py
```

### 离线 Vendor 依赖

前端第三方库已随仓库内置，不再依赖外网 CDN：

- `tools/observable_dashboard/static/vendor/plotly-2.35.2.min.js`
- `tools/observable_dashboard/static/vendor/3Dmol-min.js`（3dmol `2.0.3`）

当前文件校验值（sha256）：

- `plotly-2.35.2.min.js`: `6d21266ce1bd7d9e5ab4e115989c70c20de0382fd973a8f26ab58619eba4d603`
- `3Dmol-min.js`: `bc9fca2efffeaf8f5491c811ac232fc91a8f47600008d0eac98f94d5e471d690`

---

## 主页面功能（index.html）

### 1) 全局控件

- `Trajectory`：可选单条轨线或 `All`
- `Show ensemble (median + q25/q75)`：显示集合统计
- `Show all traces in All mode`：在 `All` 模式显示每条轨线
- `Open 3D Molecule View`：打开 3D 页面
- `PKL: ...`：显示当前读取的 pkl 文件名（悬浮可见完整路径）

### 2) 面板（Panel）机制

- `Add Panel`：新增面板
- `Remove Panel`：删除面板
- `Reset to Default`：恢复默认布局
- `Apply`：应用当前面板参数
- `Apply to all panels`：把当前面板设置复制到所有面板

### 3) 可观测量类型

可选项：

- `bond`
- `angle`
- `dihedral`
- `etot`
- `eig`
- `nac`
- `state`
- `|c|^2`

索引要求：

- `bond` 需要 2 个原子索引
- `angle` 需要 3 个原子索引
- `dihedral` 需要 4 个原子索引

### 4) All 模式显示说明

- 在 `All` 模式下，轨线 hover 第一行显示当前轨线编号（即子文件夹/`traj_id`）
- 统计线（median / q25 / q75 / mean）不显示轨线编号
- `|c|^2` 在 `All` 模式下与 `eig` 一致：按分量分别显示轨线与集合统计

---

## 3D 页面功能（molecule3d.html）

### 1) 基础浏览

- `Trajectory` 下拉切换轨线
- `Play / Pause` 播放或暂停
- `Frame` 滑条切帧
- `Atom Indices` 显示/隐藏原子编号（0-based）

### 2) 视角缩放行为

- 新轨线加载时自动 fit（`zoomTo`）
- 逐帧播放/拖动时不再自动缩放（避免不同帧间视角跳变）

### 3) XYZ 导出

- `Save Frame XYZ`：导出当前帧
- `Save Trajectory XYZ`：导出当前轨线全部帧

文件名规则：

- 当前帧：`traj_<trajId>_frame_<frame>.xyz`
- 全轨线：`traj_<trajId>_all_frames.xyz`

### 4) 几何量测量（Bond / Angle / Dihedral）

- 顶部提供 `Measure` 类型切换：`Bond` / `Angle` / `Dihedral`
- `Select <Type>`：进入当前类型选点模式（0-based）
  - `Bond`：点击 2 个原子
  - `Angle`：点击 3 个原子
  - `Dihedral`：点击 4 个原子
- 每次选定后会新增一个跟踪项（不设硬上限）；同一类型下支持多组并行跟踪
- 已跟踪项显示在列表中，点击任意项可切换高亮开关（支持多选高亮）
- 状态栏提供 `⚙ <Type> Colors` 按钮，可打开颜色设置面板逐条调整当前类型颜色
- 重复选择不会重复新增，而是确保已有项被高亮：
  - `Bond`：`1-3` 与 `3-1` 视为同一项
  - `Angle`：`1-2-3` 与 `3-2-1` 视为同一项
  - `Dihedral`：`1-2-3-4` 与 `4-3-2-1` 视为同一项
- 显示行为（仅对当前类型生效）：
  - 3D 模型中：仅高亮项显示虚线和当前帧数值标签
    - bond：两点连线 + `Å`
    - angle：两段连线 + `°`
    - dihedral：三段连线 + `°`
  - 下方子图：叠加当前类型所有已跟踪项的时间曲线（高亮项加粗，非高亮项淡化）
  - 子图中竖虚线始终指向当前帧时间
- `Clear <Type>`：批量清除当前类型所有高亮项（未高亮项保留）

说明：

- `Dihedral` 子图使用**展开后的连续角（unwrapped）**，避免 ±180° 跳变。
- 切换 `Measure` 类型时，各类型历史跟踪数据会保留并独立管理。

实现备注（开发者）：`molecule3d` 前端逻辑已按模块拆分为 `shared / geometry / measurement / viewer / io / page(orchestrator)`，便于维护与扩展。

---

## CLI 参数与配置要点

### 1) 常用 CLI 参数

- `-i, --input`：输入 pkl（默认 `run0/dump_all.pkl`）
- `-o, --out-dir`：输出目录（默认 `analysis_viz`）
- `-c, --config`：配置文件（默认 `tools/viz_config.yaml`）

可选数据键覆盖：

- `--time-key`
- `--coord-key`
- `--etot-key`
- `--eig-key`
- `--nac-key`

零帧过滤：

- `--drop-zero-frames`（默认开启）
- `--keep-zero-frames`（关闭过滤）

### 2) 配置文件能力（`viz_config.yaml`）

- `panels`：默认面板配置（observable + indices）
  - 若 observable 使用 `|c|^2`，YAML 中建议写为带引号字符串：`'|c|^2'`
- `plot`：
  - `show_ensemble_by_default`
  - `show_all_traces_in_all_mode`
- `ui`：
  - `default_panel_count`
  - `max_panels`

### 3) 输出 meta 关键项

输出 payload 的 `meta` 中包含（示例）：

- `traj_ids`
- `n_atoms`
- `n_states`
- `time_unit`
- `source_pkl`（当前输入 pkl 的绝对路径）

---

## 使用建议与已知限制

### 1) 大数据量性能

若 `dump_all.pkl` 很大，页面可能明显卡顿。主要原因：

- 生成后的 HTML 内嵌了较大的 `payload-json`
- 前端一次性 `JSON.parse` + 绘图
- `All` 模式下开启所有轨线会显著增加负载

建议：

- 平时默认关闭 `Show all traces in All mode`
- 先看单轨，再按需切 `All`

### 2) 几何量计算时机

- `bond / angle / dihedral`：前端按当前选择实时计算
- `etot / eig / nac / state / |c|^2`：主要来自预处理后的时间序列

因此切换几何量或频繁改索引时，开销会更明显。

### 3) 3D 依赖

3D 页面依赖 CDN：

- `3Dmol.js`
- `Plotly`

网络不可达时会影响 3D 或子图功能。

---

## 故障排查（Quick Troubleshooting）

### 1) 页面打不开或空白

优先检查：

1. CLI 是否成功执行并生成 `analysis_viz/index.html`
2. `analysis_viz/assets/` 是否存在且包含 JS/CSS
3. 浏览器控制台是否有脚本报错

### 2) 页面很卡

- 检查输入 pkl 体积
- 在 `All` 模式先关闭 `Show all traces in All mode`
- 减少同时打开的面板数量

### 3) 3D 页面异常

- 若状态栏提示 `3Dmol.js failed to load`：通常为网络问题
- 若子图不显示：检查 Plotly 是否可访问
- 若 `Select Bond` 无法选中：确认当前轨线有有效坐标帧，并在模型原子球上点击

### 4) 无可用轨线

CLI 报错 `No valid trajectories found after filtering` 时：

- 检查输入 pkl 是否包含目标键
- 尝试 `--keep-zero-frames` 再生成
