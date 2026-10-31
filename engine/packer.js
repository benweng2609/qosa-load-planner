// 智能装柜规划器 — 装箱引擎（纯 JS，零依赖，Node / 浏览器通用）
// 移植自 airsup.ai cargo-load 的装箱核心（已逆向），由卡车场景改造为海运集装箱场景：
//   - 放置引擎 extreme-point + 评分 + 全约束（对应原 Pe）
//   - 顶压递归分摊（对应原 Fe）
//   - 模拟退火优化，seeded 可复现（对应原 He / Ve）
//   - 车轴杠杆载荷 → 集装箱重心（CG）检查：纵向重心区间、横向偏心、重心高度
//   - 删除：温区 / 冷柜隔板 / 危险品隔离 / 车轴 / 多段行程轴荷
//
// 坐标约定：u = 纵向（0 = 柜首，L = 柜门），y = 横向（-W/2 .. +W/2，0 居中），z = 高度（0 = 地板）。
// LIFO 语义：stop 编号小 = 先卸货 = 应靠近柜门（u 大）；stop 大 = 后卸 = 装柜首。

const EPS = 1e-4;

const stopOf = (unit) => unit.line.stop ?? 1;

// ---------------------------------------------------------------- 预检（对应原 Oe）

export function precheck(container, unit) {
  if (unit.h > container.doorH + EPS)
    return `高 ${unit.h.toFixed(2)} m，超过柜门高 ${container.doorH.toFixed(2)} m`;
  if (unit.h > container.loadLine + EPS)
    return `高 ${unit.h.toFixed(2)} m，超过装载线 ${container.loadLine.toFixed(2)} m`;
  if (Math.min(unit.l, unit.w) > container.W + EPS)
    return `最小边 ${Math.min(unit.l, unit.w).toFixed(2)} m，超过柜宽 ${container.W.toFixed(2)} m`;
  if (Math.max(unit.l, unit.w) > container.L + EPS)
    return `最长边 ${Math.max(unit.l, unit.w).toFixed(2)} m，超过柜长 ${container.L.toFixed(2)} m`;
  if (unit.mass > container.payloadMax + EPS)
    return `单件 ${unit.mass} kg，超过柜限重 ${container.payloadMax} kg`;
  return null;
}

// ---------------------------------------------------------------- 分组（对应原 Ne，去掉冻品组）
// 按 stop 倒序分组（后卸的先进柜、放柜首）；组内按 stop/重量/id 排序（重的先放）。

export function groupUnits(container, units) {
  const idx = units.map((_, i) => i);
  const stops = [...new Set(idx.map((i) => stopOf(units[i])))].sort((a, b) => b - a);
  const cmp = (a, b) =>
    stopOf(units[a]) - stopOf(units[b]) ||
    units[b].mass - units[a].mass ||
    String(units[a].id).localeCompare(String(units[b].id));
  const groups = stops.map((s) => idx.filter((i) => stopOf(units[i]) === s).sort(cmp));
  // 热路径缓存：避免反复访问 .line
  const cache = units.map((u) => ({
    stop: stopOf(u),
    stackable: u.line.stackable ?? true,
    fragile: u.line.fragile ?? false,
    maxTop: u.line.maxTop ?? Infinity,
  }));
  return {
    genome: {
      groups,
      rot: units.map(() => false),
      floorOnly: units.map(() => false),
      gap: groups.map(() => 0),
    },
    ctx: { container, units, cache, multiStop: stops.length > 1 },
  };
}

// ---------------------------------------------------------------- 顶压分摊（对应原 Fe）
// 新叠放的箱子重量按底面接触面积比例分摊给下方支撑箱，并沿堆叠链递归下传。
// 直接操作列式缓冲（TypedArray），热路径零对象分配。

function distributeTop(B, nb, idx, mass) {
  const { U0, U1, Y0, Y1, Z1, TOP } = B;
  const z0 = B.Z0[idx];
  // 先收集支撑列表（局部数组，避免递归破坏共享草稿）
  let area = 0;
  const sup = [];
  for (let i = 0; i < nb; i++) {
    if (i !== idx && Math.abs(Z1[i] - z0) < 0.005) {
      const a =
        Math.max(0, Math.min(B.U1[idx], U1[i]) - Math.max(B.U0[idx], U0[i])) *
        Math.max(0, Math.min(B.Y1[idx], Y1[i]) - Math.max(B.Y0[idx], Y0[i]));
      if (a > EPS) { sup.push(i, a); area += a; }
    }
  }
  for (let k = 0; k < sup.length; k += 2) {
    const i = sup[k];
    const share = (mass * sup[k + 1]) / area;
    TOP[i] += share;
    if (B.Z0[i] > EPS) distributeTop(B, nb, i, share);
  }
}

// ---------------------------------------------------------------- 放置引擎（对应原 Pe，TypedArray 性能版）
// 按 genome 给定的分组顺序逐件放置：
//   - 候选纵向 u：当前装载前沿 + 所有已放箱的 u1（extreme points），找到解后剪枝
//   - 候选横向 y：两壁 + 地板箱边缘对齐
//   - 两种水平旋转；非 floorOnly 的箱子还尝试叠到每个可承重箱顶（四角对齐）
//   - 约束：边界 / 重叠 / 85% 底面支撑 / 顶压链 / 易碎不承压 / LIFO 不阻挡
//   - 评分：u0*1000 + z0*10 + |横向质量矩|/1000 → 先靠柜首、先落地、横向居中

export function place(ctx, genome, caps = {}) {
  const uCap = caps.uCap ?? Infinity;  // 退火期间限制扫描的 u 候选数
  const sCap = caps.sCap ?? Infinity;  // 退火期间限制扫描的支撑箱数
  const { container: C, units, cache } = ctx;
  const halfW = C.W / 2;
  const loadLine = C.loadLine;
  const CL = C.L;
  const payloadMax = C.payloadMax;
  const multiStop = ctx.multiStop; // 单一收货人时跳过 LIFO 检查
  const cap = units.length;

  // 列式缓冲：连续内存，扫描友好
  const B = {
    U0: new Float64Array(cap), U1: new Float64Array(cap),
    Y0: new Float64Array(cap), Y1: new Float64Array(cap),
    Z0: new Float64Array(cap), Z1: new Float64Array(cap),
    TOP: new Float64Array(cap), MASS: new Float64Array(cap),
    UI: new Int32Array(cap), STOP: new Int32Array(cap),
    ROT: new Uint8Array(cap), SEQ: new Int32Array(cap),
  };
  const { U0, U1, Y0, Y1, Z0, Z1, TOP, MASS, UI, STOP } = B;
  let nb = 0;

  const failed = [];
  const gaps = [];
  let massSum = 0;   // 已装总重
  let momentY = 0;   // 已装横向质量矩（用于评分中的居中倾向）
  let front = 0;     // 当前装载前沿
  let seq = 0;

  const uCands = [];
  const yCands = [];
  const stackSeen = new Set(); // 叠放候选去重（量化坐标）

  for (let g = 0; g < genome.groups.length; g++) {
    let gFront = front;
    const gap = genome.gap[g] || 0;
    if (gap > 0.005) {
      let edge = 0;
      for (let i = 0; i < nb; i++) if (U1[i] > edge) edge = U1[i];
      const t = Math.max(front, edge + gap);
      if (t > gFront) { gaps.push({ u0: edge, u1: t }); gFront = t; }
    }

    const grp = genome.groups[g];
    for (let gi = 0; gi < grp.length; gi++) {
      const ui = grp[gi];
      const unit = units[ui];
      const uc = cache[ui];

      if (massSum + unit.mass > payloadMax + EPS) {
        failed.push({ i: ui, reason: `超过限重 ${payloadMax} kg`, vol: unit.l * unit.w * unit.h });
        continue;
      }

      const ul = unit.l, uw = unit.w, uh = unit.h, um = unit.mass;
      const rotA = genome.rot[ui]; // true → 先尝试横放
      const mayStack = !genome.floorOnly[ui];
      const uStop = uc.stop;

      // 候选 u：前沿 + 已放箱的 u1，排序去重
      uCands.length = 0;
      uCands.push(gFront);
      for (let i = 0; i < nb; i++) if (U1[i] >= gFront - EPS) uCands.push(U1[i]);
      uCands.sort((a, b) => a - b);
      let un = 1; // 去重后的写入指针
      for (let i = 1; i < uCands.length; i++)
        if (uCands[i] - uCands[un - 1] > 0.0049) uCands[un++] = uCands[i];
      uCands.length = Math.min(un, uCap);

      // 最优解（标量，避免每次分配对象）
      let bFound = false, bRot = false, bScore = 0;
      let bu0 = 0, bu1 = 0, by0 = 0, by1 = 0, bz0 = 0, bz1 = 0;
      let bestU0 = Infinity;

      // 内联的候选评估：标量传参，三次扫描合并为一次
      const tryPlace = (u0, y0, z0, du, dy, rot) => {
        const u1 = u0 + du, y1 = y0 + dy, z1 = z0 + uh;
        if (u0 < gFront - EPS || u1 > CL + EPS ||
            y0 < -halfW - EPS || y1 > halfW + EPS || z1 > loadLine + EPS) return;
        const airborne = z0 > EPS;
        let supArea = 0;
        const footprint = airborne ? du * dy : 0;
        for (let i = 0; i < nb; i++) {
          const bu0i = U0[i], bu1i = U1[i], by0i = Y0[i], by1i = Y1[i], bz0i = Z0[i], bz1i = Z1[i];
          // 重叠
          if (u0 < bu1i - EPS && u1 > bu0i + EPS &&
              y0 < by1i - EPS && y1 > by0i + EPS &&
              z0 < bz1i - EPS && z1 > bz0i + EPS) return;
          // LIFO：后卸的不能挡住先卸的
          if (multiStop) {
            const bStop = STOP[i];
            if (bStop !== uStop) {
              const yOv = Math.min(by1i, y1) - Math.max(by0i, y0);
              const uOv = Math.min(bu1i, u1) - Math.max(bu0i, u0);
              if (bStop > uStop) {
                // b 后卸（应靠柜首），候选先卸（应靠门）：b 不能挡候选
                if ((bu0i >= u1 - 0.01 && yOv > 0.05) ||
                    (bz0i >= z1 - 0.01 && uOv > 0 && yOv > 0 &&
                      uOv * yOv > 0.01)) return;
              } else {
                // 候选后卸，b 先卸：候选不能挡 b
                if ((u0 >= bu1i - 0.01 && yOv > 0.05) ||
                    (z0 >= bz1i - 0.01 && uOv > 0 && yOv > 0 &&
                      uOv * yOv > 0.01)) return;
              }
            }
          }
          // 支撑统计
          if (airborne && Math.abs(bz1i - z0) < 0.005) {
            const a =
              Math.max(0, Math.min(u1, bu1i) - Math.max(u0, bu0i)) *
              Math.max(0, Math.min(y1, by1i) - Math.max(y0, by0i));
            if (a > EPS) supArea += a;
          }
        }
        if (airborne) {
          if (supArea < 0.85 * footprint) return; // 底面支撑 ≥85%
          // 顶压链检查（第二遍只扫支撑箱）
          for (let i = 0; i < nb; i++) {
            if (Math.abs(Z1[i] - z0) >= 0.005) continue;
            const a =
              Math.max(0, Math.min(u1, U1[i]) - Math.max(u0, U0[i])) *
              Math.max(0, Math.min(y1, Y1[i]) - Math.max(y0, Y0[i]));
            if (a <= EPS) continue;
            const bc = cache[UI[i]];
            if (!bc.stackable || bc.fragile) return;
            if (uStop > STOP[i]) return; // 后卸的不能压先卸的
            if (TOP[i] + (um * a) / supArea > bc.maxTop + EPS) return;
          }
        }
        const score = u0 * 1000 + z0 * 10 + Math.abs(momentY + um * (y0 + y1) / 2) / 1000;
        if (!bFound || score < bScore - 1e-9) {
          bFound = true; bScore = score; bRot = rot;
          bu0 = u0; bu1 = u1; by0 = y0; by1 = y1; bz0 = z0; bz1 = z1;
        }
      };

      // 地板候选
      const minFoot = Math.min(ul, uw);
      for (let ci = 0; ci < uCands.length; ci++) {
        const u = uCands[ci];
        if (u > bestU0 + 0.005) break; // 前沿剪枝
        if (u + minFoot > CL + EPS) break; // 柜尾放不下，后续 u 也不可能
        for (let r = 0; r < 2; r++) {
          const rot = rotA ? r === 0 : r === 1;
          const du = rot ? uw : ul;
          const dy = rot ? ul : uw;
          if (u + du > CL + EPS) continue; // 这个旋转超出柜尾，跳过 yCands 生成
          yCands.length = 0;
          yCands.push(-halfW, halfW - dy);
          for (let i = 0; i < nb; i++)
            if (Z0[i] < EPS && U1[i] > u + EPS && U0[i] < u + du - EPS)
              yCands.push(Y1[i], Y0[i] - dy);
          yCands.sort((a, b) => a - b);
          let yn = 1;
          for (let i = 1; i < yCands.length; i++)
            if (yCands[i] - yCands[yn - 1] > 0.0049) yCands[yn++] = yCands[i];
          yCands.length = yn;
          for (let yi = 0; yi < yCands.length; yi++) tryPlace(u, yCands[yi], 0, du, dy, rot);
        }
        if (bFound && bu0 < bestU0) bestU0 = bu0;
      }

      // 叠放候选（对齐每个可承重箱的四个角；按坐标去重——同规格货物角点大量重合；
      // 分数上界剪枝：u0*1000+z0*10 已不可能胜过当前最优时跳过）
      if (mayStack) {
        const seen = stackSeen; // Set 复用，key 为量化后的坐标
        seen.clear();
        let sTried = 0;
        for (let i = 0; i < nb && sTried < sCap; i++) {
          const bc = cache[UI[i]];
          if (!bc.stackable || bc.fragile) continue;
          const z0 = Z1[i];
          if (z0 + uh > loadLine + EPS) continue;
          const su0 = U0[i];
          if (su0 > bestU0 + 0.005) continue;
          if (bFound && su0 * 1000 + z0 * 10 > bScore) continue; // 上界剪枝
          sTried++;
          for (let r = 0; r < 2; r++) {
            const rot = rotA ? r === 0 : r === 1;
            const du = rot ? uw : ul;
            const dy = rot ? ul : uw;
            const cu0 = U0[i], cu1 = U1[i], cy0 = Y0[i], cy1 = Y1[i];
            // 四角
            for (let k = 0; k < 4; k++) {
              const pu0 = k < 2 ? cu0 : cu1 - du;
              const py0 = k % 2 === 0 ? cy0 : cy1 - dy;
              const key = ((pu0 * 2000 | 0) * 4096 + (py0 * 2000 + 3000 | 0)) * 8 + (z0 * 200 | 0) * 2 + (rot ? 1 : 0);
              if (seen.has(key)) continue;
              seen.add(key);
              tryPlace(pu0, py0, z0, du, dy, rot);
            }
          }
        }
      }

      if (!bFound) {
        failed.push({ i: ui, reason: '没有同时满足规则的位置', vol: ul * uw * uh });
        continue;
      }

      const idx = nb++;
      U0[idx] = bu0; U1[idx] = bu1;
      Y0[idx] = by0; Y1[idx] = by1;
      Z0[idx] = bz0; Z1[idx] = bz1;
      TOP[idx] = 0; MASS[idx] = um;
      UI[idx] = ui; STOP[idx] = uStop;
      B.ROT[idx] = bRot ? 1 : 0; B.SEQ[idx] = seq++;
      if (bz0 > EPS) distributeTop(B, nb, idx, um);
      massSum += um;
      momentY += um * ((by0 + by1) / 2);
    }
  }

  // 物化为对象数组（仅在最终输出时分配）
  const boxes = [];
  for (let i = 0; i < nb; i++) {
    boxes.push({
      unit: units[UI[i]], ui: UI[i], stop: STOP[i],
      u0: U0[i], u1: U1[i], y0: Y0[i], y1: Y1[i], z0: Z0[i], z1: Z1[i],
      rot: B.ROT[i] === 1, seq: B.SEQ[i], top: TOP[i],
    });
  }
  return { boxes, failed, gaps };
}

// ---------------------------------------------------------------- 重心与合规检查（Se/Ce 的集装箱版）
// 海运集装箱实务约束：
//   1. 纵向重心落在柜长 40%–60%（吊运/装卸安全，船公司常见要求）
//   2. 横向偏心 ≤ 柜宽 5%（对应原 left 45/55 检查）
//   3. 总重 ≤ payload（放置时已逐件拦截，此处汇总报告）
//   4. 重心高度仅报告并参与成本（海运无侧翻法规，但低重心利于稳定）

export function summarize(container, boxes) {
  let payload = 0, mu = 0, my = 0, mz = 0, vol = 0;
  for (const b of boxes) {
    const m = b.unit.mass;
    payload += m;
    mu += m * ((b.u0 + b.u1) / 2);
    my += m * ((b.y0 + b.y1) / 2);
    mz += m * ((b.z0 + b.z1) / 2);
    vol += (b.u1 - b.u0) * (b.y1 - b.y0) * (b.z1 - b.z0);
  }
  return {
    payload,
    cu: payload > 0 ? mu / payload : container.L / 2, // 纵向重心（距柜首 m）
    cy: payload > 0 ? my / payload : 0,               // 横向偏移（m）
    cz: payload > 0 ? mz / payload : 0,               // 重心高度（距地板 m）
    left: payload > 0 ? 0.5 - (my / payload) / container.W : 0.5, // 左右分布（0.5 = 居中）
    volumeUsed: vol,
    volumeRatio: vol / (container.L * container.W * container.H),
    weightRatio: payload / container.payloadMax,
  };
}

export function checkCG(container, sum) {
  const r = sum.cu / container.L;
  const dev = Math.abs(sum.left - 0.5);
  return [
    {
      key: 'cg-long', label: '纵向重心',
      value: sum.cu, limit: [0.4 * container.L, 0.6 * container.L],
      sev: r < 0.4 || r > 0.6 ? 'over' : r < 0.42 || r > 0.58 ? 'warn' : 'ok',
      note: '重心应位于柜长 40%–60% 区间',
    },
    {
      key: 'cg-side', label: '横向偏心',
      value: sum.left, limit: 0.55,
      sev: dev > 0.05 ? 'over' : dev > 0.04 ? 'warn' : 'ok',
      note: '左右重量分布应在 45/55 以内',
    },
    {
      key: 'payload', label: '总重',
      value: sum.payload, limit: container.payloadMax,
      sev: sum.payload > container.payloadMax + 0.5 ? 'over' : 'ok',
      note: '货物总重不超过柜限重',
    },
  ];
}

const sevOf = (checks) =>
  checks.some((c) => c.sev === 'over') ? 'over' :
  checks.some((c) => c.sev === 'warn') ? 'warn' : 'ok';

// ---------------------------------------------------------------- 成本函数（对应原 Be，车轴罚 → CG 罚）

function cost(container, packed, sum) {
  // 主目标按"未装体积"计：多柜场景下每个柜装进的体积直接决定柜数，
  // 而"少剩件数"会诱导放弃大件留小件（实测种子间填充率 77–85%）。
  // 件数降为次目标，同体积下优先少剩件。
  let failedVol = 0;
  for (const f of packed.failed) failedVol += f.vol || 0;
  let c = failedVol * 1e6 + packed.failed.length * 1e4;
  if (sum.payload > 0) {
    const cuN = sum.cu / container.L;
    if (cuN < 0.4) c += (0.4 - cuN) * 4e5;
    if (cuN > 0.6) c += (cuN - 0.6) * 4e5;
    c += Math.abs(cuN - 0.5) * 2e4;              // 轻罚：倾向纵向居中
    const lat = Math.abs(sum.left - 0.5);
    if (lat > 0.05) c += (lat - 0.05) * 4e5;     // 横向偏心超限重罚
    c += lat * 2e4;                              // 轻罚：倾向横向居中
    c += sum.cz * sum.payload * 0.03;            // 重心越低越好
  }
  let gapSum = 0;
  for (const g of packed.gaps) gapSum += g.u1 - g.u0;
  c += gapSum * 120;                             // 组间空隙（加固成本）
  return c;
}

// ---------------------------------------------------------------- 模拟退火（对应原 He / Ve / Z）
// 优化：无改进提前停止（stallLimit）

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 1831565813) >>> 0;
    let e = t;
    e = Math.imul(e ^ (e >>> 15), e | 1);
    e ^= e + Math.imul(e ^ (e >>> 7), e | 61);
    return ((e ^ (e >>> 14)) >>> 0) / 4294967296;
  };
}

const cloneGenome = (g) => ({
  groups: g.groups.map((x) => x.slice()),
  rot: g.rot.slice(),
  floorOnly: g.floorOnly.slice(),
  gap: g.gap.slice(),
});

export function anneal(ctx, genome, iters, seed, stallLimit = 400, startTemp = 3000) {
  const rand = mulberry32(seed);
  const C = ctx.container;
  // 注：曾尝试退火期间限制候选扫描规模（uCap/sCap），但会误判失败件、诱发重启，
  // 反而更慢更差。大货量的性能由自适应迭代次数 + 前端 Worker 承担。
  const caps = {};
  const evaluate = (g) => {
    const p = place(ctx, g, caps);
    const s = summarize(C, p.boxes);
    return { p, s, c: cost(C, p, s) };
  };
  let cur = cloneGenome(genome);
  let curEval = evaluate(cur);
  let best = { g: cloneGenome(cur), ...curEval };
  const trace = [curEval.c];
  let temp = startTemp;
  const nGroups = cur.groups.length;
  let sinceBest = 0;

  for (let i = 0; i < iters; i++) {
    const g = cloneGenome(cur);
    const r = rand();
    if (r < 0.34) {                          // 组内交换两件
      const gi = Math.floor(rand() * nGroups);
      const grp = g.groups[gi];
      if (grp.length > 1) {
        const a = Math.floor(rand() * grp.length);
        const b = Math.floor(rand() * grp.length);
        [grp[a], grp[b]] = [grp[b], grp[a]];
      }
    } else if (r < 0.5) {                    // 组内移动一件
      const gi = Math.floor(rand() * nGroups);
      const grp = g.groups[gi];
      if (grp.length > 1) {
        const [x] = grp.splice(Math.floor(rand() * grp.length), 1);
        grp.splice(Math.floor(rand() * grp.length), 0, x);
      }
    } else if (r < 0.64) {                   // 翻转一件的旋转
      const ui = Math.floor(rand() * g.rot.length);
      g.rot[ui] = !g.rot[ui];
    } else if (r < 0.76) {                   // 切换一件是否只允许落地
      const ui = Math.floor(rand() * g.floorOnly.length);
      g.floorOnly[ui] = !g.floorOnly[ui];
    } else {                                 // 调整组间空隙（加固距离）
      const gi = Math.floor(rand() * nGroups);
      const d = [0.1, 0.2, 0.4, 0.8][Math.floor(rand() * 4)] * (rand() < 0.5 ? -1 : 1);
      g.gap[gi] = Math.max(0, Math.min(3, +(g.gap[gi] + d).toFixed(2)));
    }
    const e = evaluate(g);
    if (e.c < curEval.c || rand() < Math.exp((curEval.c - e.c) / temp)) {
      cur = g; curEval = e;
    }
    // 只有"显著"改进（失败件减少，或成本下降超过 0.5%）才重置停滞计数，
    // 否则 CG 居中等连续小改进会让提前停止永远不触发
    const significant =
      e.p.failed.length < best.p.failed.length ||
      e.c < best.c - Math.max(1, Math.abs(best.c) * 0.005);
    if (significant && e.c < best.c) {
      best = { g: cloneGenome(g), ...e };
      sinceBest = 0;
    } else if (++sinceBest >= stallLimit && best.p.failed.length === 0) {
      break; // 已无失败件且长期无显著改进，提前收工
    }
    temp *= 0.992;
    if (i % 10 === 0) trace.push(best.c);
  }
  return { genome: best.g, packed: best.p, summary: best.s, cost: best.c, evals: iters + 1, trace };
}

// ---------------------------------------------------------------- 违规报告（对应原 Re，去车轴/温区/危险品）

function findViolations(container, boxes, cgChecks) {
  const out = [];
  const halfW = container.W / 2;
  for (const c of cgChecks)
    if (c.sev === 'over')
      out.push({ kind: 'cg', ids: [], text: `${c.label}超出范围（${c.note}）` });
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i];
    if (a.u0 < -0.01 || a.u1 > container.L + 0.01 ||
        a.y0 < -halfW - 0.01 || a.y1 > halfW + 0.01 || a.z1 > container.loadLine + 0.01)
      out.push({ kind: 'bounds', ids: [a.unit.id], text: `${a.unit.line.name} 超出装载空间` });
    for (let j = i + 1; j < boxes.length; j++) {
      const b = boxes[j];
      if (a.u0 < b.u1 - 0.005 && a.u1 > b.u0 + 0.005 &&
          a.y0 < b.y1 - 0.005 && a.y1 > b.y0 + 0.005 &&
          a.z0 < b.z1 - 0.005 && a.z1 > b.z0 + 0.005)
        out.push({ kind: 'overlap', ids: [a.unit.id, b.unit.id], text: `${a.unit.line.name} 与 ${b.unit.line.name} 重叠` });
      if (a.stop !== b.stop) {
        const [early, late] = a.stop < b.stop ? [a, b] : [b, a];
        const blocksX =
          (late.u0 >= early.u1 - 0.01 && Math.min(late.y1, early.y1) - Math.max(late.y0, early.y0) > 0.05) ||
          (late.z0 >= early.z1 - 0.01 &&
            Math.max(0, Math.min(late.u1, early.u1) - Math.max(late.u0, early.u0)) *
            Math.max(0, Math.min(late.y1, early.y1) - Math.max(late.y0, early.y0)) > 0.01);
        if (blocksX)
          out.push({
            kind: 'lifo', ids: [late.unit.id, early.unit.id],
            text: `${late.unit.line.name}（stop ${late.stop}）挡住了 stop ${early.stop} 的卸货路径`,
          });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- 主入口（对应原 Ge，单车改单柜）
// 每次尝试 = 一次完整退火 + 一段低温精调；仍不合法（CG 超限）时换种子重启。

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * 规划一个柜的装载方案。
 * @param container 柜型（engine/containers.js 中的定义）
 * @param units     展开后的货物单元数组（见 expandLines）
 * @param opts      { iters = 700, seed = 7, maxRestarts = 2 }
 */
export function plan(container, units, opts = {}) {
  const t0 = now();
  const maxRestarts = opts.maxRestarts ?? 2;
  const rejected = [];
  const ok = [];
  for (const u of units) {
    const reason = precheck(container, u);
    if (reason) rejected.push({ unit: u, reason });
    else ok.push(u);
  }

  // 迭代次数随货量自适应：件数越多单次放置越贵，用更少迭代保响应
  const n = ok.length;
  const iters = opts.iters ?? (n <= 50 ? 700 : n <= 120 ? 400 : 250);
  const seed = opts.seed ?? 7;

  if (!ok.length) {
    const sum = summarize(container, []);
    const checks = checkCG(container, sum);
    return {
      container, boxes: [], out: rejected, gaps: [],
      summary: sum, checks, violations: [], sev: rejected.length ? 'over' : 'ok',
      cost: NaN, ms: now() - t0, evals: 0,
    };
  }

  const { genome, ctx } = groupUnits(container, ok);
  const valid = (e) => e.packed.failed.length === 0 && sevOf(checkCG(container, e.summary)) !== 'over';
  let totalEvals = 0;
  let trace = [];

  // 实测（532 件真实装箱单）：旧两段式 pass2 重热到 3000 会打乱 pass1 成果，
  // 超载场景 3 次重启 ×(0.35+1) 共约千次评估反而不如一次完整退火
  // （78.1% vs 83.7% 填充）。因此每次尝试 = 一次完整退火 + 一段低温精调
  // （不重热）；大件量（>240 件）试 2 个种子保响应，小件量多试几次换种子。
  const attempts = ok.length > 240 ? 2 : maxRestarts + 1;
  let chosen = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const s = seed + attempt * 2;
    const a = anneal(ctx, attempt === 0 ? genome : cloneGenome(genome), iters, s);
    totalEvals += a.evals;
    const refine = anneal(ctx, a.genome, Math.round(iters * 0.35), s + 1, 400, 300);
    totalEvals += refine.evals;
    const cand = refine.cost <= a.cost ? refine : a;
    if (!chosen || cand.cost < chosen.cost) { chosen = cand; trace = cand.trace; }
    if (valid(chosen)) break; // 全装上且无超限，不再重启
  }

  // 最终方案用无上限候选重放一次，保证输出质量不受退火期间的扫描上限影响
  const packed = place(ctx, chosen.genome);
  totalEvals += 1;
  const sum = summarize(container, packed.boxes);
  const checks = checkCG(container, sum);
  const violations = findViolations(container, packed.boxes, checks);
  const out = [
    ...rejected,
    ...packed.failed.map((f) => ({ unit: ok[f.i], reason: `${f.reason}（转下一柜）` })),
  ];
  return {
    container,
    boxes: packed.boxes,
    out,
    gaps: packed.gaps,
    summary: sum,
    checks,
    violations,
    sev: violations.length ? 'over' : sevOf(checks),
    cost: cost(container, packed, sum),
    ms: now() - t0,
    evals: totalEvals,
    trace,
  };
}

// ---------------------------------------------------------------- 输入展开
// 业务层按"行"录入（一种货 × 件数），引擎按"件"工作。
// line 字段：{ name, l, w, h (m), weight (kg/件), qty, stackable = true, maxTop = Infinity (kg),
//              fragile = false, stop = 1 }

export function expandLines(lines) {
  const units = [];
  for (let li = 0; li < lines.length; li++) {
    const line = {
      stop: 1,
      stackable: true,
      fragile: false,
      maxTop: Infinity,
      ...lines[li],
    };
    for (let q = 0; q < (line.qty ?? 1); q++) {
      units.push({
        id: `L${li + 1}-${q + 1}`,
        l: line.l, w: line.w, h: line.h,
        mass: line.weight,
        line,
      });
    }
  }
  return units;
}
