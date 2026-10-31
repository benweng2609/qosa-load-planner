// 3D 装载视图：Three.js 渲染柜体 + 货物，OrbitControls 交互，X光透视，hover 单件信息
import * as THREE from '../vendor/three.module.js';
import { OrbitControls } from '../vendor/OrbitControls.js';

const BRAND = 0x0055aa;

// 每种货物行一个颜色（按索引循环）
const PALETTE = [
  0x2e86de, 0xe67e22, 0x27ae60, 0x8e44ad, 0xc0392b,
  0x16a085, 0xf39c12, 0x2c3e50, 0xd35400, 0x7f8c8d,
  0x2980b9, 0x6c5ce7, 0x00b894, 0xe17055, 0x636e72,
];

export function lineColor(lineIdx) {
  return PALETTE[lineIdx % PALETTE.length];
}

export class LoadViewer {
  constructor(host) {
    this.host = host;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xeaf0f6);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const dir = new THREE.DirectionalLight(0xffffff, 1.1);
    dir.position.set(8, 14, 6);
    this.scene.add(dir);
    const dir2 = new THREE.DirectionalLight(0xdfeaf5, 0.4);
    dir2.position.set(-6, 4, -8);
    this.scene.add(dir2);

    this.containerGroup = null;   // 柜体（X光时半透明）
    this.cargoGroup = null;       // 货物箱
    this.pickMeshes = [];         // hover 拾取
    this.xray = false;

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.onHover = null;          // (info|null, x, y) => void，由 app.js 赋值
    this.renderer.domElement.addEventListener('pointermove', (e) => this._pick(e));
    this.renderer.domElement.addEventListener('pointerleave', () => this.onHover && this.onHover(null));

    this._resize = () => {
      const w = host.clientWidth, h = host.clientHeight;
      if (!w || !h) return;
      this.renderer.setSize(w, h);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    };
    new ResizeObserver(this._resize).observe(host);
    this._resize();

    const loop = () => {
      requestAnimationFrame(loop);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  /** 引擎坐标 (u 纵向 0=柜首, y 横向居中, z 高) → three 坐标 (x=u, y=z, z=y)，柜体中心移到原点 */
  setPlan(container, boxes) {
    if (this.containerGroup) this.scene.remove(this.containerGroup);
    if (this.cargoGroup) this.scene.remove(this.cargoGroup);
    this.pickMeshes = [];
    this.containerGroup = new THREE.Group();
    this.cargoGroup = new THREE.Group();
    const { L, W, H } = container;

    // 地板
    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(L, 0.06, W),
      new THREE.MeshLambertMaterial({ color: 0xb9c6d2 })
    );
    floor.position.set(L / 2, -0.03, 0);
    this.containerGroup.add(floor);

    // 柜壁线框（8 条棱的边框盒）
    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(L, H, W));
    const frame = new THREE.LineSegments(
      edges, new THREE.LineBasicMaterial({ color: BRAND, linewidth: 2 })
    );
    frame.position.set(L / 2, H / 2, 0);
    this.containerGroup.add(frame);

    // 半透明柜壁（X光切换的主体）
    this.wallMat = new THREE.MeshLambertMaterial({
      color: 0x9db8cf, transparent: true, opacity: 0.16,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const wallGeoNS = new THREE.PlaneGeometry(L, H); // 两侧壁
    for (const s of [-1, 1]) {
      const wall = new THREE.Mesh(wallGeoNS, this.wallMat);
      wall.position.set(L / 2, H / 2, s * W / 2);
      this.containerGroup.add(wall);
    }
    const wallGeoFront = new THREE.PlaneGeometry(W, H); // 柜首
    const front = new THREE.Mesh(wallGeoFront, this.wallMat);
    front.rotation.y = Math.PI / 2;
    front.position.set(0, H / 2, 0);
    this.containerGroup.add(front);
    const roof = new THREE.Mesh(new THREE.PlaneGeometry(L, W), this.wallMat); // 顶
    roof.rotation.x = Math.PI / 2;
    roof.position.set(L / 2, H, 0);
    this.containerGroup.add(roof);

    // 柜门端标记（u = L 处地面箭头提示）
    const doorMark = new THREE.Mesh(
      new THREE.PlaneGeometry(L * 0.06, W * 0.9),
      new THREE.MeshBasicMaterial({ color: BRAND, transparent: true, opacity: 0.25 })
    );
    doorMark.rotation.x = -Math.PI / 2;
    doorMark.position.set(L - L * 0.03, 0.005, 0);
    this.containerGroup.add(doorMark);

    // 货物箱
    const lineIdxOf = (b) => {
      const m = /^L(\d+)-/.exec(b.unit.id);
      return m ? parseInt(m[1], 10) - 1 : 0;
    };
    for (const b of boxes) {
      const du = b.u1 - b.u0, dw = b.y1 - b.y0, dh = b.z1 - b.z0;
      const color = lineColor(lineIdxOf(b));
      const mat = new THREE.MeshLambertMaterial({ color });
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(du, dh, dw), mat);
      mesh.position.set((b.u0 + b.u1) / 2, (b.z0 + b.z1) / 2, (b.y0 + b.y1) / 2);
      const edge = new THREE.LineSegments(
        new THREE.EdgesGeometry(mesh.geometry),
        new THREE.LineBasicMaterial({ color: 0x22303c, transparent: true, opacity: 0.35 })
      );
      mesh.add(edge);
      mesh.userData.boxInfo = b;
      this.cargoGroup.add(mesh);
      this.pickMeshes.push(mesh);
    }

    // 把柜体中心移到原点，便于环绕观察
    const off = new THREE.Vector3(-L / 2, 0, 0);
    this.containerGroup.position.copy(off);
    this.cargoGroup.position.copy(off);
    this.scene.add(this.containerGroup, this.cargoGroup);

    this.applyXray();
    this.resetView();
  }

  resetView() {
    const L = this.containerGroup
      ? this.containerGroup.children[0].geometry.parameters.width : 12;
    this.camera.position.set(L * 0.85, L * 0.5, L * 0.75);
    this.controls.target.set(0, 0.9, 0);
    this.controls.update();
  }

  topView() {
    const L = this.containerGroup
      ? this.containerGroup.children[0].geometry.parameters.width : 12;
    this.camera.position.set(0, L * 1.4, 0.001);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  setXray(on) {
    this.xray = on;
    this.applyXray();
  }

  applyXray() {
    if (!this.cargoGroup) return;
    if (this.wallMat) this.wallMat.opacity = this.xray ? 0.04 : 0.16;
    for (const m of this.pickMeshes) {
      m.material.transparent = this.xray;
      m.material.opacity = this.xray ? 0.45 : 1;
      m.material.depthWrite = !this.xray;
    }
  }

  _pick(e) {
    if (!this.onHover) return;
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.pickMeshes, false);
    if (hits.length) {
      this.onHover(hits[0].object.userData.boxInfo, e.clientX - r.left, e.clientY - r.top);
      this.renderer.domElement.style.cursor = 'pointer';
    } else {
      this.onHover(null);
      this.renderer.domElement.style.cursor = '';
    }
  }
}
