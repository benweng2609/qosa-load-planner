// 装箱引擎 Node 测试夹具
// 运行：node test/engine.test.mjs

import { CONTAINERS } from '../engine/containers.js';
import { plan, expandLines, groupUnits, place } from '../engine/packer.js';
import { planFleet } from '../engine/fleet.js';
import { parseDims, normalizeDims, unitFromHeader, resolveRowDims } from '../engine/dims.js';
import { findHeaderRow, parseSpecs, convertPackingListRow } from '../engine/packinglist.js';

let passed = 0, failedCount = 0;
const results = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    results.push(`  PASS  ${name}`);
  } catch (e) {
    failedCount++;
    results.push(`  FAIL  ${name}\n        ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'not equal'}: expected ${b}, got ${a}`);
}

const C40 = CONTAINERS['40GP'];
const C40HQ = CONTAINERS['40HQ'];

// ---------------------------------------------------------------- T1 门高拒装
test('T1 超过门高的货被预检拒绝', () => {
  const units = expandLines([{ name: '高设备', l: 1, w: 1, h: 2.35, weight: 500, qty: 1 }]);
  // 2.35 > 门高 2.28，但 < 装载线 2.393 → 应被门高拒绝
  const r = plan(C40, units);
  assertEq(r.boxes.length, 0, '不应装入');
  assertEq(r.out.length, 1, '应有一条拒装记录');
  assert(r.out[0].reason.includes('柜门'), `原因应提及柜门，实际: ${r.out[0].reason}`);
});

// ---------------------------------------------------------------- T2 超宽拒装
test('T2 最小边超过柜宽的货被拒装', () => {
  const units = expandLines([{ name: '超宽件', l: 2.4, w: 2.4, h: 1, weight: 500, qty: 1 }]);
  const r = plan(C40, units);
  assertEq(r.boxes.length, 0, '不应装入');
  assert(r.out[0].reason.includes('柜宽'), `原因应提及柜宽，实际: ${r.out[0].reason}`);
});

// ---------------------------------------------------------------- T3 同尺寸满载
test('T3 1m³ 标准箱装满 40GP（48 件，两层）', () => {
  const units = expandLines([{ name: '标箱', l: 1, w: 1, h: 1, weight: 100, qty: 48, maxTop: 10000 }]);
  const r = plan(C40, units);
  assertEq(r.boxes.length, 48, `应装 48 件，实际 ${r.boxes.length}`);
  assertEq(r.out.length, 0, '不应有拒装');
  const ratio = r.summary.volumeRatio;
  assert(ratio > 0.7, `体积利用率应 >70%，实际 ${(ratio * 100).toFixed(1)}%`);
  assertEq(r.violations.length, 0, `不应有违规: ${JSON.stringify(r.violations)}`);
});

// ---------------------------------------------------------------- T4 易碎不承压
test('T4 易碎品上面不放任何东西（约束级 + 退火级）', () => {
  const units = expandLines([
    { name: '易碎', l: 1, w: 1, h: 1, weight: 100, qty: 24, fragile: true, stackable: true, maxTop: 10000 },
    { name: '普货', l: 1, w: 1, h: 1, weight: 100, qty: 24, stackable: true, maxTop: 10000 },
  ]);
  // 贪心直放（易碎在前）：地板恰好 24 位，若允许压易碎，普货会叠上去
  const { genome, ctx } = groupUnits(C40, units);
  const p = place(ctx, genome);
  const fragileBoxes = p.boxes.filter((b) => b.unit.line.name === '易碎');
  assertEq(fragileBoxes.length, 24, `易碎应全部落地装，实际 ${fragileBoxes.length}`);
  for (const fb of fragileBoxes)
    assert(fb.top < 1e-6, `易碎箱不应承压，实际 top=${fb.top}`);
  assertEq(p.boxes.length, 24, '普货不得叠到易碎上（应全部失败）');
  // 退火级：对抗场景允许少量失败，但易碎绝不能承压
  const r = plan(C40, units, { iters: 2000 });
  for (const b of r.boxes)
    if (b.unit.line.fragile) assert(b.top < 1e-6, '退火结果中易碎箱承压了');
  assert(r.boxes.length >= 46, `退火后应至少装 46 件，实际 ${r.boxes.length}`);
});

// ---------------------------------------------------------------- T5 顶压上限
test('T5 顶压上限生效：maxTop 不足时不能叠（约束级）', () => {
  // 用 place() 直放验证约束本身，排除退火随机性
  const mk = (maxTop) => expandLines([
    { name: '底座', l: 6, w: 2.3, h: 1, weight: 1000, qty: 1, stackable: true, maxTop },
    { name: '重件', l: 1, w: 1, h: 1, weight: 200, qty: 1, stackable: true, maxTop: 10000 },
  ]);
  const run = (us) => {
    const { genome, ctx } = groupUnits(C40, us);
    return place(ctx, genome);
  };
  const p1 = run(mk(50));
  const heavy1 = p1.boxes.find((b) => b.unit.line.name === '重件');
  assertEq(heavy1.z0, 0, `超过 maxTop 时应放地板，实际 z0=${heavy1.z0}`);

  const p2 = run(mk(500));
  const heavy2 = p2.boxes.find((b) => b.unit.line.name === '重件');
  assert(heavy2.z0 > 0.9, `maxTop 足够时应叠放（评分偏好低 u），实际 z0=${heavy2.z0}`);
});

// ---------------------------------------------------------------- T6 多收货人 LIFO
test('T6 两个收货人：先卸的靠门，无 LIFO 违规', () => {
  const units = expandLines([
    { name: 'A-先卸', l: 1, w: 1, h: 1, weight: 100, qty: 12, stop: 1, maxTop: 10000 },
    { name: 'B-后卸', l: 1, w: 1, h: 1, weight: 100, qty: 12, stop: 2, maxTop: 10000 },
  ]);
  const r = plan(C40, units);
  assertEq(r.boxes.length, 24, '应全装上');
  const lifoViol = r.violations.filter((v) => v.kind === 'lifo');
  assertEq(lifoViol.length, 0, `不应有 LIFO 违规: ${JSON.stringify(lifoViol)}`);
  const meanU = (name) => {
    const bs = r.boxes.filter((b) => b.unit.line.name === name && b.z0 < 0.01);
    return bs.reduce((s, b) => s + (b.u0 + b.u1) / 2, 0) / bs.length;
  };
  assert(meanU('B-后卸') < meanU('A-先卸'), '后卸的 B 应更靠柜首（u 小）');
});

// ---------------------------------------------------------------- T7 限重拦截
test('T7 总重超过限重时多余件被拒', () => {
  // 40 件 × 1000kg = 40000kg > 26730；空间够（4 层 × 24 位），应卡在限重
  const units = expandLines([{ name: '重货', l: 1, w: 1, h: 0.5, weight: 1000, qty: 40, maxTop: 50000 }]);
  const r = plan(C40, units);
  assert(r.summary.payload <= C40.payloadMax + 0.5, `总重 ${r.summary.payload} 不应超限`);
  const overweight = r.out.filter((o) => o.reason.includes('限重'));
  assert(overweight.length >= 13, `至少 14 件因限重被拒，实际 ${overweight.length}`);
});

// ---------------------------------------------------------------- T8 确定性
test('T8 同一 seed 结果完全可复现', () => {
  const lines = [
    { name: '甲', l: 1.2, w: 1, h: 1.1, weight: 400, qty: 10, maxTop: 800 },
    { name: '乙', l: 0.8, w: 0.6, h: 0.9, weight: 120, qty: 20, maxTop: 500 },
    { name: '丙', l: 1.1, w: 1.1, h: 0.8, weight: 650, qty: 6, stackable: false },
  ];
  const r1 = plan(C40HQ, expandLines(lines), { seed: 42 });
  const r2 = plan(C40HQ, expandLines(lines), { seed: 42 });
  const strip = (r) => JSON.stringify(r.boxes.map((b) => [b.unit.id, b.u0, b.y0, b.z0, b.rot]));
  assertEq(strip(r1), strip(r2), '两次运行结果不一致');
});

// ---------------------------------------------------------------- T9 典型混装实战 + CG + 性能
test('T9 典型混合货（约 80 件）：无违规、重心居中、秒级响应', () => {
  const lines = [
    { name: '纸箱A', l: 0.6, w: 0.4, h: 0.4, weight: 25, qty: 40, maxTop: 300 },
    { name: '纸箱B', l: 0.8, w: 0.6, h: 0.5, weight: 40, qty: 25, maxTop: 400 },
    { name: '木箱', l: 1.5, w: 1.1, h: 1.2, weight: 350, qty: 8, maxTop: 1000 },
    { name: '设备', l: 2.0, w: 1.2, h: 1.6, weight: 1200, qty: 3, stackable: false },
  ];
  const r = plan(C40HQ, expandLines(lines));
  const s = r.summary;
  console.log(`\n  [T9] 装入 ${r.boxes.length} 件 / 拒 ${r.out.length} 件 | ` +
    `体积利用率 ${(s.volumeRatio * 100).toFixed(1)}% | 总重 ${s.payload.toFixed(0)} kg | ` +
    `纵向重心 ${(s.cu / C40HQ.L * 100).toFixed(1)}% | 横向 ${(s.left * 100).toFixed(1)}% | ` +
    `重心高 ${s.cz.toFixed(2)} m | 耗时 ${r.ms.toFixed(0)} ms / ${r.evals} 次评估`);
  assertEq(r.violations.filter((v) => v.kind === 'overlap').length, 0, '不应有重叠');
  assertEq(r.violations.filter((v) => v.kind === 'bounds').length, 0, '不应有越界');
  assert(s.cu / C40HQ.L > 0.38 && s.cu / C40HQ.L < 0.62, `纵向重心 ${(s.cu / C40HQ.L * 100).toFixed(1)}% 应在合理区间`);
  assert(r.ms < 8000, `典型场景耗时应 <8s，实际 ${(r.ms / 1000).toFixed(1)}s`);
});

// ---------------------------------------------------------------- T10 极端货量（信息项，不断言耗时）
test('T10 极端货量（191 件）：全部装上、无违规', () => {
  const lines = [
    { name: '纸箱A', l: 0.6, w: 0.4, h: 0.4, weight: 25, qty: 120, maxTop: 300 },
    { name: '纸箱B', l: 0.8, w: 0.6, h: 0.5, weight: 40, qty: 60, maxTop: 400 },
    { name: '木箱', l: 1.5, w: 1.1, h: 1.2, weight: 350, qty: 8, maxTop: 1000 },
    { name: '设备', l: 2.0, w: 1.2, h: 1.6, weight: 1200, qty: 3, stackable: false },
  ];
  const r = plan(C40HQ, expandLines(lines));
  const s = r.summary;
  console.log(`\n  [T10] 装入 ${r.boxes.length} 件 / 拒 ${r.out.length} 件 | ` +
    `体积利用率 ${(s.volumeRatio * 100).toFixed(1)}% | 总重 ${s.payload.toFixed(0)} kg | ` +
    `纵向重心 ${(s.cu / C40HQ.L * 100).toFixed(1)}% | 耗时 ${(r.ms / 1000).toFixed(1)}s / ${r.evals} 次评估` +
    `（极端场景，M4 将移入 Web Worker 并显示进度）`);
  assertEq(r.violations.filter((v) => v.kind === 'overlap').length, 0, '不应有重叠');
  assertEq(r.violations.filter((v) => v.kind === 'bounds').length, 0, '不应有越界');
  assert(r.boxes.length >= 185, `极端场景应基本装完（≥185），实际 ${r.boxes.length}`);
});

// ---------------------------------------------------------------- T11 多柜分配
test('T11 多柜分配：超出一个柜的货自动转下一柜', () => {
  const lines = [
    { name: '纸箱A', l: 0.6, w: 0.4, h: 0.4, weight: 12, qty: 120, maxTop: 300 },
    { name: '木箱B', l: 1.2, w: 0.8, h: 0.9, weight: 85, qty: 24, maxTop: 500 },
  ];
  // 总量约 11.5 m³ + 20.7 m³ ≈ 32 m³，超 20GP 可用容积（33.2×0.92）→ 只允许 20GP 时应分到 2 柜
  const units = expandLines(lines);
  const r = planFleet(['20GP'], units);
  const loaded = r.plans.reduce((s, p) => s + p.boxes.length, 0);
  console.log(`\n  [T11] 用柜 ${r.plans.length} 个（${r.containerSequence.join(' + ')}）| ` +
    `装入 ${loaded}/${units.length} 件 | 全局拒装 ${r.globalOut.length} 件`);
  assert(r.plans.length >= 2, `应至少 2 柜，实际 ${r.plans.length}`);
  assertEq(loaded + r.globalOut.length, units.length, '装入 + 拒装应等于总件数');
  for (const p of r.plans) {
    assertEq(p.violations.filter((v) => v.kind === 'overlap').length, 0, '各柜不应有重叠');
  }
});

test('T12 多柜：所有柜都装不下的件进全局拒装且不致死循环', () => {
  const units = expandLines([
    { name: '超长件', l: 20, w: 1, h: 1, weight: 500, qty: 2 },  // 任何柜都放不下
    { name: '正常件', l: 0.5, w: 0.5, h: 0.5, weight: 10, qty: 4 },
  ]);
  const r = planFleet(['20GP'], units);
  assertEq(r.globalOut.length, 2, '超长件应全局拒装');
  assert(r.globalOut[0].reason.length > 0, '应有拒装原因');
  assert(r.plans.length === 1 && r.plans[0].boxes.length === 4, '正常件应装入一柜');
});

// ---------------------------------------------------------------- T13 尺寸列解析
test('T13 合并尺寸列解析与单位识别', () => {
  // 各种分隔符
  assertEq(parseDims('400*800*100').join(), '400,800,100', '星号分隔');
  assertEq(parseDims('400×800×100').join(), '400,800,100', '乘号分隔');
  assertEq(parseDims('40 x 80 x 10 cm').join(), '40,80,10', 'x 分隔带单位后缀');
  assertEq(parseDims('1.2*0.8*0.9').join(), '1.2,0.8,0.9', '米制小数');
  assertEq(parseDims('abc'), null, '非数字应返回 null');
  assertEq(parseDims('400*800'), null, '不足三个数应返回 null');

  // 单位启发式
  assertEq(normalizeDims([400, 800, 100]).dims.join(), '0.4,0.8,0.1', '毫米应换算为米');
  assertEq(normalizeDims([400, 800, 100]).unit, 'mm', '识别为 mm');
  assertEq(normalizeDims([120, 80, 90]).unit, 'cm', '超柜长但 ≤150 识别为 cm');
  assertEq(normalizeDims([120, 80, 90]).dims.join(), '1.2,0.8,0.9', 'cm 换算');
  assertEq(normalizeDims([1.2, 0.8, 0.9]).unit, 'm', '小数识别为 m');
  assertEq(normalizeDims([40, 80, 10], 'mm').dims.join(), '0.04,0.08,0.01', '表头 mm 优先于启发式');
  assertEq(normalizeDims([600, 400, 400], 'mm').dims.join(), '0.6,0.4,0.4', '显式 mm');

  // 表头单位识别
  assertEq(unitFromHeader('尺寸(mm)'), 'mm', '括号 mm');
  assertEq(unitFromHeader('尺寸cm'), 'cm', 'cm');
  assertEq(unitFromHeader('尺寸（毫米）'), 'mm', '中文毫米');
  assertEq(unitFromHeader('尺寸'), null, '无单位线索');

  // 行级回退：分列缺失时用合并列
  const r1 = resolveRowDims({ l: NaN, w: NaN, h: NaN, combined: '400*800*100' });
  assertEq(r1.dims.join(), '0.4,0.8,0.1', '分列缺失回退合并列');
  assertEq(r1.source, 'combined', '来源应为合并列');
  const r2 = resolveRowDims({ l: 600, w: 400, h: 400, combined: '' });
  assertEq(r2.dims.join(), '0.6,0.4,0.4', '分列写 mm 也应自动换算');
  assertEq(r2.source, 'cols', '来源为分列');
});

// ---------------------------------------------------------------- T14 货代装箱单识别
test('T14 真实装箱单格式（货代双语单据样本）', () => {
  // 表头探测：第 3 行（0 基 2），前两行是标题
  const rows = [
    ['Plan the shipment details (Demo Project)'],
    ['Demo Project - Item List'],
    ['項目\nNO', '領貨順序', '物品編號', '照片', '物品\nGoods', '物件數量', '單位', '打包後數量\nPackage amount', '單位', '体积(m³)  Volume', '材质', '尺寸（mm）Size', '重量（KG）', '备注'],
  ];
  assertEq(findHeaderRow(rows), 2, '表头应在第 3 行');
  assertEq(findHeaderRow([['名称', '长m', '宽m', '高m', '单件重kg', '件数']]), 0, '简单模板表头在第 1 行');

  // 规格段解析
  const s1 = parseSpecs('1200*600*1150*5');
  assertEq(s1.length, 1, '尾部计数单规格');
  assertEq(s1[0].count, 5, '末位是件数');
  assertEq(s1[0].nums.join(), '1200,600,1150', '前三位是尺寸');
  const s2 = parseSpecs('780*3725=2');
  assertEq(s2.length, 1, '等号计数');
  assertEq(s2[0].count, 2, '等号后是件数');
  const s3 = parseSpecs('400*600；400*400；200*400；200*200；');
  assertEq(s3.length, 4, '分号多规格');
  const s4 = parseSpecs('1436*150*2200=15550*150*2200=11325*150*2200=2');
  assertEq(s4.length, 3, '等号链式多规格');

  // 干净三维 + 体积吻合 → 直接用（金属肌理板：780*3725=2，2 件/包，J=0.5，H=1）
  // 厚度缺失 → 体积反推（包间门：1014*2200，H=1，J=0.4 → t≈0.179）
  const door = convertPackingListRow({ name: '包间门', qty: 1, weightTotal: 50, volumeTotal: 0.4, dimsStr: '1014*2200' });
  assertEq(door.lines.length, 1, '门应出一行');
  assert(Math.abs(door.lines[0].h - 0.1793) < 0.001, `厚度应体积反推 ≈0.179，实际 ${door.lines[0].h}`);
  assert(door.flags.length > 0, '应有估算标记');

  // 两维直径写法（餐桌 φ950*750）
  const tbl = convertPackingListRow({ name: '餐桌', qty: 2, weightTotal: 100, volumeTotal: 1.4, dimsStr: 'φ950*750' });
  assertEq(tbl.lines[0].l, 0.95, '直径作边长');
  assertEq(tbl.lines[0].h, 0.75, '高 750mm');

  // 组装后尺寸不可信 → 按体积调整（秀櫥窗框 3820*1500*20 仅 0.115 m³，J=2.5）
  const win = convertPackingListRow({ name: '秀櫥窗框', qty: 1, weightTotal: 200, volumeTotal: 2.5, dimsStr: '3820*1500*20' });
  const vWin = win.lines[0].l * win.lines[0].w * win.lines[0].h;
  assert(Math.abs(vWin - 2.5) < 0.01, `调整后体积应≈2.5，实际 ${vWin.toFixed(3)}`);
  assert(win.flags.some((f) => f.includes('对不上')), '应提示尺寸与体积对不上');

  // 多规格等号链与总体积对不上 → 等效立方兜底（不锈钢屏风，J=4，H=1）
  const scr = convertPackingListRow({ name: '不锈钢屏风', qty: 1, weightTotal: 360, volumeTotal: 4, dimsStr: '1436*150*2200=15550*150*2200=11325*150*2200=2' });
  assertEq(scr.lines.length, 1, '对不上应折成单行');
  const vScr = scr.lines[0].l ** 3;
  assert(Math.abs(vScr - 4) < 0.01, `立方体积应≈4，实际 ${vScr.toFixed(2)}`);

  // 无尺寸 → 等效立方（铝材天花 J=6 H=3 → 每件 2 m³）
  const ceil = convertPackingListRow({ name: '铝材天花', qty: 3, weightTotal: 500, volumeTotal: 6, dimsStr: '' });
  assertEq(ceil.lines.length, 1, '无尺寸出一行');
  assert(Math.abs(ceil.lines[0].l - Math.cbrt(2)) < 0.001, '每件 2 m³ 立方');
  assert(Math.abs(ceil.lines[0].weight - 500 / 3) < 0.01, '总重按件均摊');

  // 缺件数 → 拒收并说明
  const bad = convertPackingListRow({ name: '坏行', qty: 0, weightTotal: 10, volumeTotal: 1, dimsStr: '100*100*100' });
  assertEq(bad.lines.length, 0, '缺件数不出行');
  assert(bad.flags[0].includes('件数'), '应说明缺件数');
});

// ---------------------------------------------------------------- 汇总
console.log('\n装箱引擎测试\n' + '='.repeat(50));
for (const r of results) console.log(r);
console.log('='.repeat(50));
console.log(`${passed} passed, ${failedCount} failed\n`);
process.exit(failedCount ? 1 : 0);
