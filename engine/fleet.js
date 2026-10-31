// 多柜分配（M6）：装不下的件自动转入下一柜。
// 选柜策略：在可用柜型里挑"装得下剩余货物"的最小柜（按容积），都不行就用最大柜兜底。
// 预检就拒装的件（超尺寸/超单件重）任何柜都装不下，进全局拒装列表，不再重试。

import { CONTAINERS } from './containers.js';
import { plan, precheck } from './packer.js';

/**
 * @param containerIds 可用柜型 id 数组（按用户偏好排序，仅作同容积时的 tiebreak）
 * @param units        展开后的货物单元
 * @param opts         { seed = 7, maxContainers = 20, iters = 自适应, defrag = true,
 *                       onContainer = null（每装完一柜回调 (res, idx)） }
 * @returns { plans: [plan结果...], globalOut: [{unit, reason}], containerSequence: [id...] }
 */
export function planFleet(containerIds, units, opts = {}) {
  const seed = opts.seed ?? 7;
  const maxContainers = opts.maxContainers ?? 20;
  const types = containerIds.map((id) => CONTAINERS[id]).filter(Boolean)
    .sort((a, b) => a.volume - b.volume);
  if (!types.length) throw new Error('至少需要一种可用柜型');

  // 任何柜型都过不了预检的件 → 全局拒装
  const globalOut = [];
  let remaining = [];
  for (const u of units) {
    const fittable = types.some((c) => !precheck(c, u));
    if (fittable) remaining.push(u);
    else globalOut.push({ unit: u, reason: precheck(types[types.length - 1], u) });
  }

  const plans = [];
  const fed = []; // 每柜的输入 units（尾部合并时用）
  while (remaining.length && plans.length < maxContainers) {
    const totalVol = remaining.reduce((s, u) => s + u.l * u.w * u.h, 0);
    const totalW = remaining.reduce((s, u) => s + u.mass, 0);
    // 经验系数 0.92：极端点布局实际利用率很难超过 92%
    const fit = types.find((c) =>
      c.volume * 0.92 >= totalVol && c.payloadMax >= totalW);
    const container = fit || types[types.length - 1];

    fed.push(remaining);
    const res = plan(container, remaining, { seed: seed + plans.length * 101, iters: opts.iters });
    plans.push(res);
    if (opts.onContainer) opts.onContainer(res, plans.length);

    const failedUnits = res.out
      .map((o) => o.unit)
      .filter((u) => !globalOut.some((g) => g.unit === u));
    if (failedUnits.length >= remaining.length) break; // 一件都没装上，避免死循环
    remaining = failedUnits;
  }

  // 尾部合并（M6 增强）：末柜装得太少时，把它的货并回前面的柜重排，
  // 成功就省一个柜。最多回并 defragDepth 个柜，控制耗时。
  if (opts.defrag !== false) defragTail(plans, fed, opts);

  return { plans, globalOut, containerSequence: plans.map((p) => p.container.id) };
}

function defragTail(plans, fed, opts) {
  const depth = opts.defragDepth ?? 2;
  while (plans.length >= 2) {
    const last = plans[plans.length - 1];
    const ratio = last.summary.volumeRatio;
    const weightRatio = last.summary.weightRatio;
    if (ratio > 0.35 && weightRatio > 0.35) break; // 末柜不算空，不动

    const tailUnits = fed[fed.length - 1];
    let merged = false;
    for (let i = plans.length - 2; i >= Math.max(0, plans.length - 1 - depth) && !merged; i--) {
      const candUnits = [...fed[i], ...tailUnits];
      // 合并重排对种子敏感，多试几组，提高省柜成功率
      for (const ds of [0, 1, 2]) {
        const cand = plan(fed[i].length ? plans[i].container : last.container, candUnits, {
          seed: (opts.seed ?? 7) + 977 + i * 10 + ds,
          iters: opts.iters,
        });
        if (cand.out.length === 0) {
          plans[i] = cand;          // 前面的柜扩容成功
          plans.pop(); fed.pop();   // 省掉末柜
          merged = true;
          break;
        }
      }
    }
    if (!merged) break;
  }
}
