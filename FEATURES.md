# Observable Dashboard 功能总览

`tools/observable_dashboard` 当前以 **Python 后端计算模式** 运行：启动 API 服务加载 `dump_all.pkl`，前端只负责参数控制和图形展示（Index + Molecule3D 均已后端化）。

- 主页面入口：`http://127.0.0.1:8000/`（默认）
- 3D 页面入口：`http://127.0.0.1:8000/molecule3d.html`
- API 基址：`/api`

---

## 快速开始

在仓库根目录运行（推荐）：

```bash
python -m tools.observable_dashboard.serve \
  -i run0/dump_all.pkl \
  -c tools/viz_config.yaml \
  --host 127.0.0.1 \
  --port 8000
```

浏览器打开：

- `http://127.0.0.1:8000/`

> 说明：`python -m tools.observable_dashboard.cli` 的静态导出模式已移除，仅保留 `serve` 模式。

后端接口：

- `GET /api/healthz`
- `GET /api/bootstrap`
- `POST /api/series`
- `GET /api/molecule3d/trajectory/{traj_id}`

### 布局与路由自动检查

可运行以下脚本进行自动化冒烟校验（资源路径、模板脚本顺序、API-only 模板注入、关键路由可用性）：

```bash
python tools/observable_dashboard/scripts/check_static_layout.py
```

### 离线 Vendor 依赖

前端第三方库已随仓库内置，不再依赖外网 CDN：

- `tools/observable_dashboard/static/vendor/plotly-2.35.2.min.js`
- `tools/observable_dashboard/static/vendor/3Dmol-min.js`（3dmol `2.0.3`）
- `tools/observable_dashboard/static/vendor/gif.min.js`
- `tools/observable_dashboard/static/vendor/gif.worker.js`

当前文件校验值（sha256）：

- `plotly-2.35.2.min.js`: `6d21266ce1bd7d9e5ab4e115989c70c20de0382fd973a8f26ab58619eba4d603`
- `3Dmol-min.js`: `bc9fca2efffeaf8f5491c811ac232fc91a8f47600008d0eac98f94d5e471d690`
- `gif.min.js`: `a8b111071bb3b123c302e6182c01d6b3550f93a4b627398b07c46875d84090bb`
- `gif.worker.js`: `ca9e3048557ec05d619e18b83403cd3669c88939e5fa2d6034ce7625d445970d`

---

## 主页面功能（index.html）

### 1) 全局控件

- `Trajectory`：可选单条轨线或 `All`
- `Show ensemble (median + q25/q75)`：显示集合统计
- `Show all traces in All mode`：在 `All` 模式显示每条轨线
- `3D Molecule View`：打开 `molecule3d.html`（新标签页）
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
- `All` 模式不需要手动刷新：若当前 panel 缺数据，会自动触发后端计算并显示进度
- 快速连续改参数时，请求按顺序排队执行，完成后展示最终结果

---

## 3D 页面功能（molecule3d.html）

页面数据加载机制：

- 统一通过后端 API 拉取坐标：`GET /api/molecule3d/trajectory/{traj_id}`
- 按 traj 整条加载，切换 traj 时仅请求目标 traj
- 首次请求后命中后端 LRU 缓存会返回更快（响应字段 `cached=true`）

### 1) 基础浏览

- 顶部控件采用“主栏 + 折叠分组”：主栏常显 `Trajectory / Play / Frame / Export GIF`
- `Measure`、`Playback`（Speed/Stride）、`GIF Range`（Start/End）位于折叠分组，默认收起
- `Trajectory` 下拉切换轨线
- `Play / Pause` 播放或暂停
- `Speed` 滑条调节播放速率（`1x ~ 10x`，步长 `0.5x`，默认 `1x = 10 FPS`）
- `Stride` 滑条调节跳帧间隔（`x1 ~ x20`，步长 `1`，默认 `x1`）
- `Frame` 滑条切帧
- `Atom Indices` 显示/隐藏原子编号（0-based）

### 2) 视角缩放行为

- 新轨线加载时自动 fit（`zoomTo`）
- 逐帧播放/拖动时不再自动缩放（避免不同帧间视角跳变）
- 播放中拖动 `Speed` 会立即生效，不重置当前帧
- 播放中拖动 `Stride` 会立即生效，不重置当前帧
- `Speed` 控制整体前进速度，`Stride` 控制每次渲染跨过的帧数；增大 `Stride` 可降低渲染频率

### 3) XYZ 导出

- `Save Frame XYZ`：导出当前帧
- `Save Trajectory XYZ`：导出当前轨线全部帧

文件名规则：

- 当前帧：`traj_<trajId>_frame_<frame>.xyz`
- 全轨线：`traj_<trajId>_all_frames.xyz`

### 4) GIF 动图导出

- `GIF Start` / `GIF End`：导出区间（0-based，默认全轨线）
- `Export GIF`：导出 3D 视窗动图（仅 viewer 区域）
- `Cancel GIF`：导出过程中可取消
- 导出开始时会自动展开 `GIF Range` 分组，确保进度和取消按钮可见
- 导出采样跟随当前 `Stride`（导出帧序列按 `start..end` 以 `stride` 递增）
- 导出 fps 跟随当前播放有效帧率（`BASE_FPS * Speed / Stride`，带范围保护）
- 导出进度显示在控制区：`GIF current/total (percent%)`

文件名规则：

- `traj_<trajId>_frames_<start>_<end>_stride_<stride>_fps_<fps>.gif`

### 5) 几何量测量（Bond / Angle / Dihedral）

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

## 服务参数与配置要点

### 1) 常用 serve 参数

- `-i, --input`：输入 pkl（默认 `run0/dump_all.pkl`）
- `-c, --config`：配置文件（默认 `tools/viz_config.yaml`）
- `--host / --port`：服务地址与端口
- `--cache-size`：Index `/api/series` LRU 容量（默认 `512`）
- `--mol3d-cache-size`：3D 轨线坐标 LRU 容量（默认 `64`）

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

### 3) bootstrap/meta 关键项

`GET /api/bootstrap` 的 `meta` 中包含（示例）：

- `traj_ids`
- `n_atoms`
- `n_states`
- `time_unit`
- `source_pkl`（当前输入 pkl 的绝对路径）

---

## 使用建议与已知限制

### 1) 大数据量性能

若 `dump_all.pkl` 很大，页面可能明显卡顿。主要原因：

- `All` 模式下批量查询轨线会增加请求和绘图开销
- 同时打开过多面板会增加前端渲染负担
- 首次几何量查询（尤其 All 模式）会触发后端计算与缓存填充

建议：

- 平时默认关闭 `Show all traces in All mode`
- 先看单轨，再按需切 `All`

### 2) 几何量计算时机

- `index` 页面：所有 observable（包括 `bond/angle/dihedral`）都通过后端按需计算并缓存
- `molecule3d` 页面：测量曲线与 3D 标注继续在前端基于已加载 `coords` 计算

因此 `index` 中首次切换新参数时会有后端计算延迟；重复查询通常更快。

### 3) 3D 依赖

3D 页面依赖本地静态 vendor 文件（仓库内置），不依赖外网 CDN。

---

## 故障排查（Quick Troubleshooting）

### 1) 页面打不开或空白

优先检查：

1. `python -m tools.observable_dashboard.serve ...` 是否正常启动且无报错
2. 浏览器访问地址是否正确（默认 `http://127.0.0.1:8000/`）
3. 浏览器控制台是否有脚本报错

### 2) 页面很卡

- 检查输入 pkl 体积
- 在 `All` 模式先关闭 `Show all traces in All mode`
- 减少同时打开的面板数量

### 3) 3D 页面异常

- 若状态栏提示 `3Dmol.js failed to load`：通常是 `assets/vendor/3Dmol-min.js` 路径不可达
- 若子图不显示：检查 `assets/vendor/plotly-2.35.2.min.js` 是否可访问
- 若 GIF 导出失败：检查 `assets/vendor/gif.min.js` 与 `assets/vendor/gif.worker.js` 是否可访问
- 若 `Select Bond` 无法选中：确认当前轨线有有效坐标帧，并在模型原子球上点击

### 4) 无可用轨线

服务启动时报错 `No valid trajectories found after filtering` 时：

- 检查输入 pkl 是否包含目标键
- 尝试 `--keep-zero-frames` 再生成
