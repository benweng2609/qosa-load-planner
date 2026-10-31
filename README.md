# QOSA Load Planner · 智能装柜规划器

海运集装箱 3D 装箱规划工具。**纯前端单页应用，数据不出浏览器**：装箱单只在本地解析，装箱计算在本地 Web Worker 里完成，没有任何服务器交互。

## 功能

- **柜型多选**：20GP / 40GP / 40HQ / 45HQ，自动分柜（多柜分配 + 尾部合并省柜）
- **货物录入**：手工逐行录入，或导入 Excel/CSV
  - 简单模板：名称 / 长宽高（支持 `400*800*100` 合并尺寸列，mm/cm/m 自动识别）
  - 货代双语装箱单：自动探测表头行，识别"打包数量 / 总体积 / 总重 / 自由格式尺寸列"，以"总体积 ÷ 件数"为锚还原每件形状，估算行标黄待复核
- **装箱引擎**：极限点放置 + 模拟退火（按"未装体积"优化填充率），水平旋转、堆叠/顶压/易碎约束、重心与限重检查
- **3D 可视化**：逐柜查看，旋转 / 俯视 / X 光透视 / 悬停查看货物
- **导出**：装箱单 Excel（汇总 + 每柜明细 + 未装入）、打印 / 存 PDF 报告（含每柜 3D 图）
- **未装入提示**：结果页直接列出哪件货没装上、原因是什么

## 快速开始

克隆后先拉取两个大体积第三方库（发布通道限制未直接入库，脚本固定版本并做 SHA256 校验）：

```bash
node scripts/fetch-vendor.mjs   # 需要 Node 18+
```

然后起任意静态服务器打开：

```bash
python3 -m http.server 8080     # 或 npx serve
# 浏览器访问 http://localhost:8080
```

> 开启在线演示：仓库 Settings → Pages → Deploy from a branch → `main` / `(root)`。

## 引擎测试

装箱引擎（`engine/`）零依赖，可直接用 Node 跑测试，无需浏览器：

```bash
node test/engine.test.mjs       # 14 个用例：预检 / 旋转 / 堆叠 / 易碎 / 重心 / 多柜 / 装箱单识别 …
```

## 目录结构

```
index.html              单页入口
ui/app.js               交互逻辑（录入 / 导入 / 导出 / 结果展示）
ui/view3d.js            Three.js 3D 视图
engine/packer.js        装箱引擎：极限点放置 + 模拟退火 + 约束检查
engine/fleet.js         多柜分配 + 尾部合并
engine/packinglist.js   货代装箱单识别适配层
engine/dims.js          尺寸列解析与单位识别
engine/containers.js    柜型参数
engine/worker.js        Web Worker 装配
vendor/                 Three.js r160 / SheetJS 0.18.5（本地化，不走 CDN）
test/engine.test.mjs    引擎测试
scripts/fetch-vendor.mjs 拉取 vendor 大文件
```

## 技术说明

- 无构建步骤：原生 ES Module，`index.html` 直接可跑
- Three.js r160（MIT）、SheetJS xlsx 0.18.5（Apache-2.0），许可见 `vendor/THIRD-PARTY-LICENSES.md`
- 坐标约定：u 轴沿柜长（0=柜首，L=柜门），货物仅允许水平旋转

## License

MIT（见 `LICENSE`）。第三方库保留其原有许可。
