// 尺寸列解析（M2 增强）：兼容"400*800*100"这类合并尺寸写法。
// 货代/工厂单据里常见一个单元格写 长×宽×高，且单位常是 mm 或 cm，引擎统一用 m。

// 从字符串提取前三个数字（分隔符可以是 × * x X 空格 逗号等任意非数字字符）
export function parseDims(str) {
  const nums = String(str ?? '').match(/\d+(?:\.\d+)?/g);
  if (!nums || nums.length < 3) return null;
  return nums.slice(0, 3).map(Number);
}

// 从表头猜单位：尺寸(mm) / 尺寸cm / 毫米 / 厘米
export function unitFromHeader(header) {
  const h = String(header ?? '').toLowerCase();
  if (/mm|毫米/.test(h)) return 'mm';
  if (/cm|厘米/.test(h)) return 'cm';
  if (/(^|[^c])m([^m]|$)|米/.test(h) && !/mm|cm/.test(h)) return 'm';
  return null;
}

/**
 * 把三个原始数字归一化为米。
 * unit 显式给出（'mm'|'cm'|'m'）时按给定单位；否则按量级启发式：
 *   max > 150      → mm（集装箱货物几乎不会用 cm 写超过 1.5 m 的数）
 *   13.6 < max ≤ 150 → cm（45HQ 柜长 13.556 m，超过它不可能是米）
 *   max ≤ 13.6     → m
 * 返回 { dims: [l,w,h]（米）, unit } 或 null。
 */
export function normalizeDims(raw, unit = null) {
  if (!raw || raw.some((d) => !(d > 0))) return null;
  const max = Math.max(...raw);
  let u = unit;
  if (!u) u = max > 150 ? 'mm' : max > 13.6 ? 'cm' : 'm';
  const f = u === 'mm' ? 0.001 : u === 'cm' ? 0.01 : 1;
  return { dims: raw.map((d) => +(d * f).toFixed(4)), unit: u };
}

/**
 * 一行货物的尺寸归一化入口：优先用分开的 长/宽/高 列；缺失或不合法时回退到合并尺寸列。
 * @returns { dims, unit, source } source = 'cols' | 'combined' | null
 */
export function resolveRowDims({ l, w, h, combined, unit }) {
  const sep = [l, w, h].map(Number);
  if (sep.every((d) => d > 0)) {
    // 分开列也可能写的是 mm/cm（如 长=600），超柜长的按量级换算
    const n = normalizeDims(sep, sep.every((d) => d <= 13.6) ? 'm' : unit);
    if (n) return { ...n, source: 'cols' };
  }
  const comb = parseDims(combined);
  if (comb) {
    const n = normalizeDims(comb, unit);
    if (n) return { ...n, source: 'combined' };
  }
  return { dims: null, unit: null, source: null };
}
