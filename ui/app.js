// 主界面逻辑：货物录入 / Excel 导入导出 / 多柜计算调度 / 结果汇总 / 3D 视图联动
import { CONTAINERS, CONTAINER_IDS } from '../engine/containers.js';
import { resolveRowDims, unitFromHeader } from '../engine/dims.js';
import { findHeaderRow, convertPackingListRow } from '../engine/packinglist.js';
import { LoadViewer, lineColor } from './view3d.js';

const $ = (s) => document.querySelector(s);
const stage = $('#stage');
const viewer = new LoadViewer($('#gl'));
const tooltip = $('#tooltip');

let worker = null;
let timer = null;
let lastResult = null;   // { plans:[...], globalOut:[...] }
let activeTab = 0;

// ---------------------------------------------------------------- 柜型（多选，fleet 自动分柜）
const clist = $('#container-list');
for (const id of CONTAINER_IDS) {
  const c = CONTAINERS[id];
  const lab = document.createElement('label');
  lab.className = 'ctype';
  lab.title = `内尺寸 ${c.L}×${c.W}×${c.H} m · 容积 ${c.volume} m³ · 限重 ${c.payloadMax.toLocaleString()} kg`;
  lab.innerHTML = `<input type="checkbox" value="${id}" checked> ${id}`;
  lab.querySelector('input').addEventListener('change', showSpec);
  clist.appendChild(lab);
}
function selectedContainers() {
  return [...clist.querySelectorAll('input:checked')].map((i) => i.value);
}
function showSpec() {
  const ids = selectedContainers();
  $('#container-spec').textContent = ids.length
    ? `已选 ${ids.length} 种：${ids.join(' / ')}。一柜装不下时自动转下一柜，优先用容积够的最小柜型。`
    : '请至少选择一种柜型';
}
showSpec();

// ---------------------------------------------------------------- 货物表
const tbody = $('#cargo-table tbody');

function addRow(data = {}) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" data-f="name" placeholder="货物名称" value=""></td>
    <td><input type="number" data-f="l" step="0.01" min="0.01" placeholder="0.00"></td>
    <td><input type="number" data-f="w" step="0.01" min="0.01" placeholder="0.00"></td>
    <td><input type="number" data-f="h" step="0.01" min="0.01" placeholder="0.00"></td>
    <td><input type="number" data-f="weight" step="0.1" min="0.1" placeholder="0"></td>
    <td><input type="number" data-f="qty" step="1" min="1" placeholder="1"></td>
    <td><input type="checkbox" data-f="stackable" checked></td>
    <td><input type="number" data-f="maxTop" step="1" min="0" placeholder="不限"></td>
    <td><input type="checkbox" data-f="fragile"></td>
    <td><input type="number" data-f="stop" step="1" min="1" value="1" style="min-width:42px"></td>
    <td><button class="del-row" title="删除此行">×</button></td>`;
  for (const [k, v] of Object.entries(data)) {
    const el = tr.querySelector(`[data-f="${k}"]`);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v;
  }
  tr.querySelector('.del-row').addEventListener('click', () => tr.remove());
  tbody.appendChild(tr);
}

$('#add-row').addEventListener('click', () => addRow());
$('#clear-rows').addEventListener('click', () => { tbody.innerHTML = ''; });
$('#load-sample').addEventListener('click', () => {
  tbody.innerHTML = '';
  addRow({ name: '纸箱A', l: 0.6, w: 0.4, h: 0.4, weight: 12, qty: 60, stackable: true, stop: 1 });
  addRow({ name: '木箱B', l: 1.2, w: 0.8, h: 0.9, weight: 85, qty: 12, stackable: true, maxTop: 400, stop: 1 });
  addRow({ name: '精密仪', l: 0.8, w: 0.6, h: 0.5, weight: 30, qty: 8, stackable: true, fragile: true, stop: 2 });
  addRow({ name: '托盘C', l: 1.1, w: 1.1, h: 1.0, weight: 120, qty: 6, stackable: true, maxTop: 800, stop: 3 });
});
$('#load-sample').click(); // 首屏给一组示例，便于直接试算

function readLines() {
  const lines = [];
  let bad = null;
  for (const tr of tbody.rows) {
    const val = (f) => tr.querySelector(`[data-f="${f}"]`);
    const num = (f) => parseFloat(val(f).value);
    const line = {
      name: val('name').value.trim() || `货物${lines.length + 1}`,
      l: num('l'), w: num('w'), h: num('h'),
      weight: num('weight'),
      qty: parseInt(val('qty').value, 10),
      stackable: val('stackable').checked,
      maxTop: val('maxTop').value === '' ? Infinity : num('maxTop'),
      fragile: val('fragile').checked,
      stop: parseInt(val('stop').value, 10) || 1,
    };
    for (const el of tr.querySelectorAll('input')) el.style.borderColor = '';
    const mark = (f) => { val(f).style.borderColor = '#c0392b'; bad = bad || line.name; };
    if (!(line.l > 0)) mark('l');
    if (!(line.w > 0)) mark('w');
    if (!(line.h > 0)) mark('h');
    if (!(line.weight > 0)) mark('weight');
    if (!(line.qty >= 1)) mark('qty');
    lines.push(line);
  }
  return { lines, bad };
}

// ---------------------------------------------------------------- Excel / CSV 导入（M2）
const HEADER_MAP = [
  ['name', (h) => (h.includes('物品') && !h.includes('編號') && !h.includes('编号') && !h.includes('number') && !h.includes('照片') && !h.includes('photo') && !h.includes('image')) || h.includes('名称') || h === 'name' || h === 'sku' || h === 'goods'],
  ['qtyPack', (h) => h.includes('打包') || h.includes('package')],
  ['weightTotal', (h) => h.includes('重量') || h === 'weighttotal'],
  ['volumeTotal', (h) => h.includes('体积') || h.includes('體積') || h.includes('volume') || h === 'cbm'],
  ['weight', (h) => h.includes('单件重') || h.includes('每件重') || h === 'weight'],
  ['qty', (h) => h.includes('件数') || h.includes('数量') || h === 'qty' || h === 'quantity'],
  ['maxTop', (h) => h.includes('顶压') || h === 'maxtop'],
  ['stop', (h) => h.includes('卸货') || h.includes('卸序') || h === 'stop'],
  ['stackable', (h) => h.includes('可叠') || h.includes('stackable')],
  ['fragile', (h) => h.includes('易碎') || h === 'fragile'],
  ['dims', (h) => h.includes('尺寸') || h.includes('规格') || h === 'dim' || h === 'dims' || h === 'size' || h.includes('dimension')],
  ['l', (h) => h.includes('长') || h === 'l' || h === 'length'],
  ['w', (h) => h.includes('宽') || h === 'w' || h === 'width'],
  ['h', (h) => h.includes('高') || h === 'h' || h === 'height'],
];
const truthy = (v) => /^(是|y|yes|true|1|✓|√)$/i.test(String(v ?? '').trim());

$('#import-btn').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const wb = XLSX.read(await file.arrayBuffer());
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
    if (rows.length < 2) { alert('文件里没有数据行'); return; }
    // 表头不一定在第一行（货代单据常有标题行）：自动探测
    const headIdx = findHeaderRow(rows) >= 0 ? findHeaderRow(rows) : 0;
    const heads = rows[headIdx].map((h) => String(h).trim().toLowerCase().replace(/[\s()（）]/g, ''));
    const colOf = {};
    heads.forEach((h, i) => {
      for (const [field, match] of HEADER_MAP)
        if (!(field in colOf) && match(h)) colOf[field] = i;
    });

    // 货代装箱单模式：有"打包後數量"或"体积"列 → 走体积为基准的转换器
    if ('qtyPack' in colOf || 'volumeTotal' in colOf) {
      if (!('qtyPack' in colOf) || !('weightTotal' in colOf) || !('volumeTotal' in colOf)) {
        alert('识别为装箱单格式，但需要同时有「打包後數量 / 重量 / 体积」三列，请检查后重试');
        return;
      }
      let n = 0, flagged = 0, skipped = 0;
      tbody.innerHTML = '';
      for (const r of rows.slice(headIdx + 1)) {
        if (!r.some((c) => String(c).trim() !== '')) continue;
        const rawName = 'name' in colOf ? String(r[colOf.name]) : '';
        // 双语名称：换行或两个以上空格分隔，取中文部分
        const name = rawName.split(/\n|\s{2,}/)[0].trim() || rawName.trim();
        const conv = convertPackingListRow({
          name: name || `货物${n + 1}`,
          qty: parseFloat(r[colOf.qtyPack]),
          weightTotal: parseFloat(r[colOf.weightTotal]),
          volumeTotal: parseFloat(r[colOf.volumeTotal]),
          dimsStr: 'dims' in colOf ? r[colOf.dims] : '',
        });
        if (!conv.lines.length) { skipped++; continue; }
        for (const line of conv.lines) {
          addRow({ name: line.name, l: line.l, w: line.w, h: line.h, weight: line.weight, qty: line.qty });
          if (line.flag) {
            flagged++;
            const tr = tbody.lastElementChild;
            tr.classList.add('est');
            tr.querySelector('[data-f=name]').title = line.flag;
          }
          n++;
        }
      }
      alert(`装箱单导入完成：${n} 条货物` +
        (flagged ? `，其中 ${flagged} 条按体积估算形状（黄色标记，请复核）` : '') +
        (skipped ? `，${skipped} 行数据不全被跳过` : '') +
        '。请检查后点击「开始计算装载方案」。');
      return;
    }

    // 简单模板模式：分开的长宽高列 或 合并尺寸列
    if (!('l' in colOf || 'dims' in colOf)) {
      alert('没认出来尺寸列：可以是分开的 长/宽/高 三列，也可以是一列合并尺寸（如 400*800*100）。请对照「下载导入模板」的表头格式');
      return;
    }
    const dimsUnit = 'dims' in colOf ? unitFromHeader(rows[headIdx][colOf.dims]) : null;
    let n = 0, skipped = 0, converted = 0;
    tbody.innerHTML = '';
    for (const r of rows.slice(headIdx + 1)) {
      const got = resolveRowDims({
        l: 'l' in colOf ? parseFloat(r[colOf.l]) : NaN,
        w: 'w' in colOf ? parseFloat(r[colOf.w]) : NaN,
        h: 'h' in colOf ? parseFloat(r[colOf.h]) : NaN,
        combined: 'dims' in colOf ? r[colOf.dims] : '',
        unit: dimsUnit,
      });
      if (!got.dims) { if (r.some((c) => c !== '')) skipped++; continue; }
      if (got.unit !== 'm') converted++;
      addRow({
        name: 'name' in colOf ? String(r[colOf.name]).split('\n')[0].trim() : '',
        l: got.dims[0], w: got.dims[1], h: got.dims[2],
        weight: 'weight' in colOf ? parseFloat(r[colOf.weight]) : ('weightTotal' in colOf && 'qty' in colOf ? parseFloat(r[colOf.weightTotal]) / (parseInt(r[colOf.qty], 10) || 1) : ''),
        qty: 'qty' in colOf ? parseInt(r[colOf.qty], 10) : 1,
        stackable: 'stackable' in colOf ? truthy(r[colOf.stackable]) : true,
        maxTop: 'maxTop' in colOf && r[colOf.maxTop] !== '' ? parseFloat(r[colOf.maxTop]) : '',
        fragile: 'fragile' in colOf ? truthy(r[colOf.fragile]) : false,
        stop: 'stop' in colOf && r[colOf.stop] !== '' ? parseInt(r[colOf.stop], 10) : 1,
      });
      n++;
    }
    alert(`导入完成：${n} 行货物` +
      (converted ? `，其中 ${converted} 行尺寸按毫米/厘米自动换算为米` : '') +
      (skipped ? `，${skipped} 行因尺寸缺失被跳过` : '') +
      '。请检查后点击「开始计算装载方案」。');
  } catch (err) {
    alert('导入失败：' + (err && err.message || err));
  }
});

$('#tpl-btn').addEventListener('click', () => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['名称', '尺寸(mm)', '单件重kg', '件数', '可叠放', '顶压上限kg', '易碎', '卸货顺序'],
    ['纸箱A', '600*400*400', 12, 60, '是', '', '否', 1],
    ['木箱B', '1200*800*900', 85, 12, '是', 400, '否', 1],
  ]);
  ws['!cols'] = [{ wch: 14 }, { wch: 16 }, { wch: 10 }, { wch: 8 }, { wch: 8 }, { wch: 12 }, { wch: 8 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, ws, '货物清单');
  XLSX.writeFile(wb, '货物导入模板.xlsx');
});

// ---------------------------------------------------------------- 计算（Worker + 多柜）
$('#run').addEventListener('click', () => {
  const containerIds = selectedContainers();
  if (!containerIds.length) { alert('请至少选择一种柜型'); return; }
  const { lines, bad } = readLines();
  if (!lines.length) { alert('请先录入至少一行货物'); return; }
  if (bad) { alert(`「${bad}」的尺寸/重量/件数需要填大于 0 的数字`); return; }

  if (worker) worker.terminate();
  worker = new Worker('./engine/worker.js', { type: 'module' });

  $('#run').disabled = true;
  $('#progress-wrap').classList.add('on');
  const t0 = performance.now();
  const totalQty = lines.reduce((s, l) => s + l.qty, 0);
  let stageText = `正在优化布局（共 ${totalQty} 件）`;
  timer = setInterval(() => {
    $('#progress-text').textContent =
      `${stageText}… 已用时 ${((performance.now() - t0) / 1000).toFixed(1)} s`;
  }, 100);
  $('#progress-text').textContent = stageText + '…';

  worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'progress') { stageText = msg.stage; return; }
    clearInterval(timer);
    $('#progress-wrap').classList.remove('on');
    $('#run').disabled = false;
    if (msg.type === 'error') { alert('计算失败：' + msg.message); return; }
    lastResult = msg;
    renderFleet();
  };
  worker.postMessage({ type: 'plan', containerIds, lines });
});

// ---------------------------------------------------------------- 结果渲染
const pct = (x) => (x * 100).toFixed(1) + '%';

function renderFleet() {
  const { plans, globalOut } = lastResult;
  $('#summary').style.display = '';
  $('#empty-hint').style.display = 'none';

  // 总览行 + 全局状态
  const tally = {};
  for (const p of plans) tally[p.containerId] = (tally[p.containerId] || 0) + 1;
  const fleetDesc = Object.entries(tally).map(([id, n]) => `${n}×${id}`).join(' + ');
  const totalLoaded = plans.reduce((s, p) => s + p.boxes.length, 0);
  const lastOut = plans.length ? plans[plans.length - 1].out : [];
  const unloaded = lastOut.length + globalOut.length;
  $('#fleet-line').textContent =
    `共 ${plans.length} 柜（${fleetDesc}）· 装入 ${totalLoaded} 件` +
    (unloaded ? ` · ${unloaded} 件未装入` : '');
  const anyOver = plans.some((p) => p.sev === 'over') || globalOut.length > 0 || lastOut.length > 0;
  const anyWarn = plans.some((p) => p.sev !== 'ok');
  const badge = $('#sev-badge');
  badge.textContent = anyOver ? '有违规/未装完' : anyWarn ? '有警告' : '方案可行';
  badge.className = 'badge ' + (anyOver ? 'over' : anyWarn ? 'warn' : 'ok');

  // 未装入明细（含原因），让用户能直接定位并修正问题行
  const outDetail = $('#out-detail');
  outDetail.innerHTML = '';
  if (unloaded) {
    outDetail.style.display = '';
    for (const o of [...globalOut, ...lastOut].slice(0, 8)) {
      const li = document.createElement('li');
      li.textContent = `${o.name || o.id}：${o.reason.replace('（转下一柜）', '（所有柜均未能装下）')}`;
      outDetail.appendChild(li);
    }
    if (unloaded > 8) {
      const li = document.createElement('li');
      li.textContent = `…其余 ${unloaded - 8} 件见导出 Excel「未装入」表`;
      outDetail.appendChild(li);
    }
  } else {
    outDetail.style.display = 'none';
  }

  // 柜选项卡
  const tabs = $('#ctabs');
  tabs.innerHTML = '';
  plans.forEach((p, i) => {
    const b = document.createElement('button');
    b.className = 'ctab';
    b.textContent = `柜 ${i + 1} · ${p.containerId}`;
    b.addEventListener('click', () => { activeTab = i; renderContainer(); });
    tabs.appendChild(b);
  });
  tabs.classList.toggle('on', plans.length > 1);
  if (activeTab >= plans.length) activeTab = 0;
  renderContainer();
}

function renderContainer() {
  const { plans, globalOut } = lastResult;
  const p = plans[activeTab];
  if (!p) return;
  [...$('#ctabs').children].forEach((el, i) => el.classList.toggle('active', i === activeTab));

  const c = CONTAINERS[p.containerId];
  const s = p.summary;
  const boxes = p.boxes.map((b) => ({
    ...b,
    unit: { id: b.id, mass: b.mass, l: b.l, w: b.w, h: b.h, line: { name: b.lineName } },
  }));
  viewer.setPlan(c, boxes);

  // 图例
  const legend = $('#legend');
  const names = [...new Set(p.boxes.map((b) => b.lineName))];
  legend.innerHTML = names.map((n) => {
    const i = p.boxes.find((b) => b.lineName === n);
    const idx = parseInt(/^L(\d+)-/.exec(i.id)?.[1] || '1', 10) - 1;
    return `<div class="li"><span class="sw" style="background:#${lineColor(idx).toString(16).padStart(6, '0')}"></span>${n}</div>`;
  }).join('');
  legend.classList.toggle('on', names.length > 0);

  $('#summary-kv').innerHTML = `
    <span class="k">装入件数</span><span class="v">${p.boxes.length}</span>
    <span class="k">体积利用率</span><span class="v">${pct(s.volumeRatio)}</span>
    <span class="k">总重</span><span class="v">${s.payload.toLocaleString()} / ${c.payloadMax.toLocaleString()} kg（${pct(s.weightRatio)}）</span>
    <span class="k">纵向重心</span><span class="v">${s.cu.toFixed(2)} m / ${c.L} m（${pct(s.cu / c.L)}）</span>
    <span class="k">横向分布</span><span class="v">${pct(s.left)} / ${pct(1 - s.left)}</span>
    <span class="k">重心高度</span><span class="v">${s.cz.toFixed(2)} m</span>
    <span class="k">计算耗时</span><span class="v">${(p.ms / 1000).toFixed(1)} s（${p.evals} 次评估）</span>`;

  $('#checks').innerHTML = p.checks.map((ch) =>
    `<li><span class="badge ${ch.sev}">${ch.label}</span> ${ch.note}</li>`
  ).join('') + p.violations.map((v) =>
    `<li><span class="badge over">违规</span> ${v}</li>`
  ).join('');

  // 未装入：最后一个柜的剩余 + 全局拒装（任何柜型都装不下的）
  const isLast = activeTab === plans.length - 1;
  const items = [
    ...(isLast ? p.out.map((o) => ({ ...o, reason: o.reason.replace('（转下一柜）', '（所有柜均未能装下）') })) : []),
    ...globalOut,
  ];
  const rw = $('#rejects-wrap');
  if (items.length) {
    rw.style.display = '';
    $('#rejects').innerHTML = items.map((o) => `<li>${o.name}（${o.id}）：${o.reason}</li>`).join('');
  } else {
    rw.style.display = 'none';
  }
}

// ---------------------------------------------------------------- 导出 Excel 装箱单（M5）
$('#export-xlsx').addEventListener('click', () => {
  if (!lastResult) return;
  const { plans, globalOut } = lastResult;
  const wb = XLSX.utils.book_new();

  const sumRows = [['柜号', '柜型', '装入件数', '体积利用率', '总重kg', '纵向重心m', '横向分布(左/右)', '重心高度m', '状态']];
  plans.forEach((p, i) => {
    const s = p.summary;
    sumRows.push([
      `柜${i + 1}`, p.containerId, p.boxes.length, pct(s.volumeRatio),
      Math.round(s.payload), +s.cu.toFixed(2),
      `${pct(s.left)} / ${pct(1 - s.left)}`, +s.cz.toFixed(2),
      { ok: '可行', warn: '警告', over: '违规' }[p.sev],
    ]);
  });
  const wsSum = XLSX.utils.aoa_to_sheet(sumRows);
  wsSum['!cols'] = [{ wch: 8 }, { wch: 8 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 16 }, { wch: 10 }, { wch: 8 }];
  XLSX.utils.book_append_sheet(wb, wsSum, '汇总');

  plans.forEach((p, i) => {
    const rows = [['箱号', '货物名称', '摆放长m', '摆放宽m', '摆放高m', '单件重kg', '卸货顺序', 'u起m(距柜首)', 'u止m', 'y起m', 'y止m', 'z起m(距地板)', 'z止m', '已旋转']];
    for (const b of p.boxes) {
      rows.push([
        b.id, b.lineName,
        +(b.u1 - b.u0).toFixed(3), +(b.y1 - b.y0).toFixed(3), +(b.z1 - b.z0).toFixed(3),
        b.mass, b.stop,
        +b.u0.toFixed(3), +b.u1.toFixed(3), +b.y0.toFixed(3), +b.y1.toFixed(3),
        +b.z0.toFixed(3), +b.z1.toFixed(3), b.rot ? '是' : '否',
      ]);
    }
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = rows[0].map(() => ({ wch: 11 }));
    XLSX.utils.book_append_sheet(wb, ws, `柜${i + 1}-${p.containerId}`);
  });

  const lastOut = plans.length ? plans[plans.length - 1].out : [];
  if (lastOut.length || globalOut.length) {
    const rows = [['箱号', '货物名称', '原因']];
    for (const o of lastOut) rows.push([o.id, o.name, o.reason.replace('（转下一柜）', '（所有柜均未能装下）')]);
    for (const o of globalOut) rows.push([o.id, o.name, o.reason]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), '未装入');
  }

  XLSX.writeFile(wb, `装箱单_${new Date().toISOString().slice(0, 10)}.xlsx`);
});

// ---------------------------------------------------------------- 打印 / 存 PDF 报告（M5）
$('#export-pdf').addEventListener('click', () => {
  if (!lastResult) return;
  const { plans, globalOut } = lastResult;
  const esc = (s) => String(s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  const keepTab = activeTab;

  let html = `<h1>QOSA 智能装柜方案报告</h1>
    <div class="pmeta">生成时间：${new Date().toLocaleString('zh-CN')} · 共 ${plans.length} 柜 ·
    装入 ${plans.reduce((s, p) => s + p.boxes.length, 0)} 件</div>`;

  plans.forEach((p, i) => {
    const c = CONTAINERS[p.containerId];
    const s = p.summary;
    const boxes = p.boxes.map((b) => ({
      ...b,
      unit: { id: b.id, mass: b.mass, l: b.l, w: b.w, h: b.h, line: { name: b.lineName } },
    }));
    viewer.setPlan(c, boxes);
    viewer.renderer.render(viewer.scene, viewer.camera);
    const img = viewer.renderer.domElement.toDataURL('image/png');
    html += `<div class="csec"><h2>柜 ${i + 1} · ${c.name}</h2>
      <table><tr><th>装入件数</th><th>体积利用率</th><th>总重</th><th>纵向重心</th><th>横向分布</th><th>重心高度</th><th>状态</th></tr>
      <tr><td>${p.boxes.length}</td><td>${pct(s.volumeRatio)}</td>
      <td>${Math.round(s.payload).toLocaleString()} / ${c.payloadMax.toLocaleString()} kg</td>
      <td>${s.cu.toFixed(2)} m（${pct(s.cu / c.L)}）</td>
      <td>${pct(s.left)} / ${pct(1 - s.left)}</td><td>${s.cz.toFixed(2)} m</td>
      <td>${{ ok: '可行', warn: '警告', over: '违规' }[p.sev]}</td></tr></table>
      <img src="${img}" alt="柜${i + 1} 3D 视图">
      <table><tr><th>货物</th><th>件数</th><th>单件尺寸 m</th><th>单件重 kg</th></tr>
      ${groupByLine(p.boxes).map(([n, arr]) =>
        `<tr><td>${esc(n)}</td><td>${arr.length}</td><td>${arr[0].l}×${arr[0].w}×${arr[0].h}</td><td>${arr[0].mass}</td></tr>`).join('')}
      </table></div>`;
  });

  const lastOut = plans.length ? plans[plans.length - 1].out : [];
  if (lastOut.length || globalOut.length) {
    html += `<h2>未装入</h2><table><tr><th>箱号</th><th>货物</th><th>原因</th></tr>` +
      [...lastOut, ...globalOut].map((o) =>
        `<tr><td>${esc(o.id)}</td><td>${esc(o.name)}</td><td>${esc(o.reason.replace('（转下一柜）', ''))}</td></tr>`).join('') +
      '</table>';
  }

  $('#print-report').innerHTML = html;
  // 恢复 3D 视图到当前选项卡
  activeTab = keepTab;
  renderContainer();
  window.print();
});

function groupByLine(boxes) {
  const m = new Map();
  for (const b of boxes) {
    if (!m.has(b.lineName)) m.set(b.lineName, []);
    m.get(b.lineName).push(b);
  }
  return [...m.entries()];
}

// ---------------------------------------------------------------- hover 单件信息
viewer.onHover = (info, x, y) => {
  if (!info) { tooltip.style.display = 'none'; return; }
  const u = info.unit;
  const dim = (info.u1 - info.u0).toFixed(2) + '×' + (info.y1 - info.y0).toFixed(2) + '×' + (info.z1 - info.z0).toFixed(2);
  tooltip.innerHTML =
    `<b>${u.line.name}</b>（${u.id}）<br>` +
    `摆放尺寸 ${dim} m${info.rot ? '（已旋转）' : ''}<br>` +
    `单件重 ${u.mass} kg · 卸货顺序 ${info.stop}<br>` +
    `位置 u ${info.u0.toFixed(2)}–${info.u1.toFixed(2)} m · 高 ${info.z0.toFixed(2)}–${info.z1.toFixed(2)} m`;
  tooltip.style.display = 'block';
  const r = stage.getBoundingClientRect();
  const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
  tooltip.style.left = Math.min(x + 14, r.width - tw - 8) + 'px';
  tooltip.style.top = Math.min(y + 14, r.height - th - 8) + 'px';
};

// ---------------------------------------------------------------- 视角工具
$('#view-reset').addEventListener('click', () => viewer.resetView());
$('#view-top').addEventListener('click', () => viewer.topView());
$('#view-xray').addEventListener('click', (e) => {
  const on = !e.currentTarget.classList.contains('active');
  e.currentTarget.classList.toggle('active', on);
  viewer.setXray(on);
});
