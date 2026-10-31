// 货代装箱单识别（真实单据适配层，零依赖，Node 可测）
//
// 这类单据的特点（归纳自真实货代单据）：
// - 表头不在第一行，中英双语挤在一个单元格
// - 数量/重量/体积都是"整行合计"口径（打包後數量 = 件数，重量 = 总重 kg，体积 = 总体积 m³）
// - 尺寸列写法自由：干净三维 / 两维缺厚度 / 一格多规格（；；分隔）/ 尾部或 = 粘连件数 /
//   直径写法（φ950*750）/ 空白 / 甚至组装后尺寸（不可信）
//
// 策略：以"总体积 ÷ 打包件数"为每件体积的基准（订舱口径，最可靠）。
// 尺寸解析结果与体积对得上（比值 0.5–2）才采用，否则按体积反推形状。
// 所有估算都生成 flag，交由 UI 提示用户复核。

import { normalizeDims } from './dims.js';

const round4 = (x) => +x.toFixed(4);

// ---------------------------------------------------------------- 表头探测

const HEADER_KEYWORDS = [
  '名称', '物品', '货品', '品名', 'goods', 'item', 'description',
  '尺寸', '规格', 'size', 'dimension', '长', '宽', '高',
  '数量', '件数', 'qty', 'quantity', 'amount',
  '重量', 'weight', '体积', 'volume', 'cbm',
];

/** 在前 maxScan 行里找命中关键词最多的一行当表头；命中 < minHits 返回 -1（按简单模板处理） */
export function findHeaderRow(rows, { maxScan = 10, minHits = 3 } = {}) {
  let best = -1, bestHits = 0;
  const lim = Math.min(rows.length, maxScan);
  for (let r = 0; r < lim; r++) {
    const cells = (rows[r] || []).map((c) => String(c ?? '').toLowerCase());
    let hits = 0;
    for (const cell of cells)
      if (HEADER_KEYWORDS.some((k) => cell.includes(k))) hits++;
    if (hits > bestHits) { best = r; bestHits = hits; }
  }
  return bestHits >= minHits ? best : -1;
}

// ---------------------------------------------------------------- 尺寸列 → 规格序列
// 输出 [{ nums: [原始数字...], count: 件数|null, round: 是否直径写法 }]

export function parseSpecs(dimsStr) {
  const specs = [];
  for (const tok of String(dimsStr ?? '').split(/[；;、\n]+/)) {
    if (!/\d/.test(tok)) continue;
    const round = /φ|Φ|直径/.test(tok);
    const parts = tok.split('=');
    parts.forEach((part, pi) => {
      const nums = (part.match(/\d+(?:\.\d+)?/g) || []).map(Number);
      if (!nums.length) return;
      const isLast = pi === parts.length - 1;
      const hasStar = /[*×xX]/.test(part);
      // 纯计数段（"=2" 或 "*5" 里孤零零的尾巴）
      if (!hasStar && nums.length <= 2 && specs.length && isLast && pi > 0) {
        specs[specs.length - 1].count = nums[0];
        return;
      }
      if (nums.length > 3) {
        if (pi > 0 && specs.length) {
          // 段首粘着上一段的计数（"=1" + "5550*150*2200" 被读成 "15550*..." 之外的
          // 正常情况："=1*1200*600*1150"）：首数是上段计数
          specs[specs.length - 1].count = nums[0];
          specs.push({ nums: nums.slice(1, 4), count: null, round });
        } else {
          // 尾部带件数：1200*600*1150*5 → 前三位尺寸、末位件数
          specs.push({ nums: nums.slice(0, 3), count: nums[3], round });
        }
        return;
      }
      specs.push({ nums, count: null, round });
    });
  }
  return specs;
}

// 原始数字 → 米制三维；两维时返回 twoDim
function specToDims(spec) {
  const { nums, round } = spec;
  if (nums.length >= 3) {
    const n = normalizeDims(nums.slice(0, 3), null);
    return n ? { dims: n.dims } : null;
  }
  if (nums.length === 2) {
    const n = normalizeDims([...nums, Math.max(...nums)], null); // 借最大值定单位
    if (!n) return null;
    const [a, b] = n.dims;
    if (round) return { dims: [a, a, b] }; // φ直径×高 → 方柱近似
    return { dims: null, twoDim: [a, b] };
  }
  return null;
}

// 把三维调整到目标体积：先按比例缩放；比例缩放会超出柜内极限（宽 2.3 m / 长 13.4 m）时，
// 保持最大的两个面尺寸不变、只加厚最小维（板材打木架的真实形态）。
// 返回 [l, w, h]，始终按 长≥宽≥高 排列（引擎只允许水平旋转，h 保持竖直方向，
// 板材/管材必须躺平放，h 给最小维）。
function scaleToVolume(dims, targetVol) {
  const v = dims[0] * dims[1] * dims[2];
  if (!(v > 0) || !(targetVol > 0)) return null;
  const s = [...dims].sort((a, b) => a - b); // [小, 中, 大]
  const k = Math.cbrt(targetVol / v);
  const d = s.map((x) => x * k);
  if (d[2] <= 13.4 && d[1] <= 2.3 && d[0] > 0.005) return [round4(d[2]), round4(d[1]), round4(d[0])];
  const t = targetVol / (s[2] * s[1]);
  if (s[2] <= 13.4 && s[1] <= 2.3 && t > 0.005 && t <= s[1]) return [s[2], s[1], round4(t)];
  return null; // 面本身就超柜，保持原样交由预检拦截
}

const cubeOf = (vol) => {
  const s = round4(Math.cbrt(vol));
  return [s, s, s];
};

// ---------------------------------------------------------------- 行转换

/**
 * 一行货代装箱单 → 规划器货物行（一对多：一格多规格时拆多行）
 * @param row { name, qty(打包件数), weightTotal(kg), volumeTotal(m³), dimsStr }
 * @returns { lines: [{name,l,w,h,weight,qty,flag?}], flags: [字符串] }
 */
export function convertPackingListRow(row) {
  const name = row.name ?? '';
  const qty = +row.qty || 0;
  const weightTotal = +row.weightTotal || 0;
  const volumeTotal = +row.volumeTotal || 0;
  const flags = [];
  if (!(qty > 0)) return { lines: [], flags: [`${name}：打包件数缺失`] };
  const volPer = volumeTotal > 0 ? volumeTotal / qty : 0;
  const wPer = weightTotal > 0 ? weightTotal / qty : 0;
  const mk = (dims, q = qty, w = wPer, flag) =>
    ({ name, l: dims[0], w: dims[1], h: dims[2], weight: round4(w), qty: q, ...(flag ? { flag } : {}) });

  const specs = parseSpecs(row.dimsStr);

  // ---- 多规格段
  if (specs.length > 1) {
    const parsed = specs.map((s) => ({ ...s, ...specToDims(s) }));
    if (parsed.every((p) => p.dims || p.twoDim)) {
      // 两维段厚度：借用本行三维段的中位厚度
      const knownT = parsed.filter((p) => p.dims).map((p) => Math.min(...p.dims)).sort((a, b) => a - b);
      const medT = knownT.length ? knownT[Math.floor(knownT.length / 2)] : null;
      let lines = parsed.map((p, i) => {
        const q = p.count ?? 1;
        if (p.dims) return { dims: p.dims, q, i };
        if (medT) { flags.push(`规格「${p.nums.join('*')}」缺厚度，借用同批 ${medT} m`); return { dims: [p.twoDim[0], p.twoDim[1], medT], q, i }; }
        return null;
      });
      if (lines.every(Boolean)) {
        const sumVol = lines.reduce((s, l) => s + l.q * l.dims[0] * l.dims[1] * l.dims[2], 0);
        if (volumeTotal > 0 && (sumVol / volumeTotal < 0.5 || sumVol / volumeTotal > 2)) {
          flags.push(`尺寸合计 ${sumVol.toFixed(1)} m³ 与总体积 ${volumeTotal} m³ 对不上，按体积折算`);
        } else {
          // 重量按体积占比分摊
          lines = lines.map((l) => ({ ...l, share: (l.q * l.dims[0] * l.dims[1] * l.dims[2]) / (sumVol || 1) }));
          return {
            lines: lines.map((l) => ({
              name: `${name}-${l.i + 1}`, l: l.dims[0], w: l.dims[1], h: l.dims[2],
              weight: round4(weightTotal * l.share / l.q), qty: l.q,
            })),
            flags,
          };
        }
      }
    } else {
      flags.push('部分规格无法解析，按体积折算');
    }
    // 多规格失败 → 等效立方
    if (volPer > 0) return { lines: [mk(cubeOf(volPer), qty, wPer, `按每件 ${volPer.toFixed(2)} m³ 等效立方`)], flags };
    return { lines: [], flags: [...flags, `${name}：体积缺失，无法折算`] };
  }

  // ---- 单规格 / 空
  const spec = specs[0] ? { ...specs[0], ...specToDims(specs[0]) } : null;

  if (spec && spec.dims) {
    const v = spec.dims[0] * spec.dims[1] * spec.dims[2];
    const totalBySpec = v * qty;
    const ratio = volumeTotal > 0 ? totalBySpec / volumeTotal : 1;
    if (ratio >= 0.5 && ratio <= 2) {
      return { lines: [mk(spec.dims)], flags }; // 干净且对得上体积
    }
    const scaled = scaleToVolume(spec.dims, volPer);
    if (scaled) {
      flags.push(`尺寸与总体积对不上（可能是组装后尺寸或含木架），按比例调整到 ${scaled.join('×')} m`);
      return { lines: [mk(scaled, qty, wPer, '尺寸按体积调整')], flags };
    }
  }
  if (spec && spec.twoDim && volPer > 0) {
    const t = Math.max(0.01, volPer / (spec.twoDim[0] * spec.twoDim[1]));
    flags.push(`尺寸只有两维，厚度按体积反推为 ${round4(t)} m`);
    return { lines: [mk([spec.twoDim[0], spec.twoDim[1], round4(t)], qty, wPer, '厚度按体积反推')], flags };
  }
  if (volPer > 0) {
    flags.push(spec ? '尺寸不可用，按体积等效立方' : '无尺寸，按体积等效立方');
    return { lines: [mk(cubeOf(volPer), qty, wPer, `按每件 ${volPer.toFixed(2)} m³ 等效立方`)], flags };
  }
  return { lines: [], flags: [`${name}：尺寸与体积都不可用`] };
}
