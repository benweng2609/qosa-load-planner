// 装柜计算 Worker：退火耗时较长（大货量 10s+），放后台线程避免阻塞 3D 交互
// 支持多柜分配（M6）：装不下的件自动转下一柜，每装完一柜回一条进度
import { expandLines } from './packer.js';
import { planFleet } from './fleet.js';

// box / plan 结果里有 Infinity（maxTop 默认）等不便序列化的引用，统一拍平成纯数据
function flatBoxes(boxes) {
  return boxes.map((b) => ({
    id: b.unit.id,
    lineName: b.unit.line.name,
    mass: b.unit.mass,
    l: b.unit.l, w: b.unit.w, h: b.unit.h,
    u0: b.u0, u1: b.u1, y0: b.y0, y1: b.y1, z0: b.z0, z1: b.z1,
    rot: b.rot, stop: b.stop,
  }));
}
function flatOut(out) {
  return out.map((o) => ({ id: o.unit.id, name: o.unit.line.name, reason: o.reason }));
}
function flatPlan(res) {
  return {
    containerId: res.container.id,
    boxes: flatBoxes(res.boxes),
    out: flatOut(res.out),
    summary: res.summary,
    checks: res.checks,
    violations: res.violations.map((v) => v.text),
    sev: res.sev,
    ms: res.ms,
    evals: res.evals,
  };
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type !== 'plan') return;
  try {
    const units = expandLines(msg.lines);
    const result = planFleet(msg.containerIds, units, {
      seed: msg.seed ?? 7,
      onContainer: (res, idx) =>
        self.postMessage({
          type: 'progress',
          stage: `第 ${idx} 柜（${res.container.id}）装完，装入 ${res.boxes.length} 件`,
        }),
    });
    self.postMessage({
      type: 'done',
      plans: result.plans.map(flatPlan),
      globalOut: flatOut(result.globalOut),
    });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
