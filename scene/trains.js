/* 仮実装(TrainKit API の箱モデル)。本実装に置き換わる */
import * as THREE from '../vendor/three.module.min.js';

export const CAR_LEN = 20.0;

export class TrainKit {
  constructor() {
    this.mSide = new THREE.MeshStandardMaterial({ color: 0xc9ced2, roughness: 0.35, metalness: 0.5 });
    this.mDark = new THREE.MeshStandardMaterial({ color: 0x24282c, roughness: 0.85 });
    this.mHead = new THREE.MeshBasicMaterial({ color: 0xfff3d0 });
    this.mTail = new THREE.MeshBasicMaterial({ color: 0xff2a1a });
    this.geo = new THREE.BoxGeometry(2.9, 3.5, 19.5);
    this.geo.translate(0, 2.05, 0);
    this.lamp = new THREE.BoxGeometry(0.3, 0.2, 0.05);
  }

  makeCar({ lead = false, tail = false } = {}) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(this.geo, this.mSide);
    body.castShadow = true;
    g.add(body);
    if (lead || tail) {
      g.userData.head = []; g.userData.tail = [];
      [-0.9, 0.9].forEach((x) => {
        const h = new THREE.Mesh(this.lamp, this.mHead); h.position.set(x, 1.3, lead ? 9.78 : -9.78);
        const t = new THREE.Mesh(this.lamp, this.mTail); t.position.set(x * 0.8, 1.6, lead ? 9.78 : -9.78);
        g.add(h, t); g.userData.head.push(h); g.userData.tail.push(t);
      });
    }
    return g;
  }

  makeTrain(n = 8) {
    const group = new THREE.Group();
    const cars = [];
    for (let i = 0; i < n; i++) {
      const c = this.makeCar({ lead: i === 0, tail: i === n - 1 });
      c.position.z = -i * CAR_LEN;
      group.add(c); cars.push(c);
    }
    return { group, cars };
  }

  setNight() {}

  setLights(train, { head = true, tail = false } = {}) {
    const lead = train.cars[0].userData, last = train.cars[train.cars.length - 1].userData;
    (lead.head || []).forEach((m) => { m.visible = head; });
    (lead.tail || []).forEach((m) => { m.visible = false; });
    (last.head || []).forEach((m) => { m.visible = false; });
    (last.tail || []).forEach((m) => { m.visible = tail; });
  }

  setDest() {}

  dispose() {}
}
