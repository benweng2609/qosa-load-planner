// 智能装柜规划器 — 柜型定义（ISO 668 内尺寸）
// 坐标约定：u 轴原点 = 柜首（远离门的一端），u = L 处为柜门；y 轴横向居中（±W/2）；z 轴垂直向上。

export const CONTAINERS = {
  '20GP': {
    id: '20GP', name: '20 GP 标准柜',
    L: 5.898, W: 2.352, H: 2.393,
    doorH: 2.280, loadLine: 2.393,
    payloadMax: 21740, tare: 2250,
    volume: 33.2,
  },
  '40GP': {
    id: '40GP', name: '40 GP 标准柜',
    L: 12.032, W: 2.352, H: 2.393,
    doorH: 2.280, loadLine: 2.393,
    payloadMax: 26730, tare: 3750,
    volume: 67.7,
  },
  '40HQ': {
    id: '40HQ', name: '40 HQ 高柜',
    L: 12.032, W: 2.352, H: 2.698,
    doorH: 2.585, loadLine: 2.698,
    payloadMax: 26630, tare: 3900,
    volume: 76.4,
  },
  '45HQ': {
    id: '45HQ', name: '45 HQ 高柜',
    L: 13.556, W: 2.352, H: 2.698,
    doorH: 2.585, loadLine: 2.698,
    payloadMax: 25560, tare: 4700,
    volume: 86.0,
  },
};

export const CONTAINER_IDS = Object.keys(CONTAINERS);
