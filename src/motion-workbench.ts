// Development-only entry; not imported by the desktop app or shipped index.html.
import * as T from 'three';
import { Actor } from './actor';
import { parseManifest } from './domain';

const element = <E extends HTMLElement>(id: string) => document.getElementById(id) as E;
const variant = element<HTMLSelectElement>('variant'), appearance = element<HTMLSelectElement>('appearance');
const angle = element<HTMLSelectElement>('angle'), accessories = element<HTMLInputElement>('accessories');
const timeline = element<HTMLInputElement>('timeline'), progress = element<HTMLOutputElement>('progress');
const play = element<HTMLButtonElement>('play'), replay = element<HTMLButtonElement>('replay'), interrupt = element<HTMLButtonElement>('interrupt');
const status = element<HTMLParagraphElement>('status');
const species = ['beagle', 'rabbit'] as const;
const actors = species.map(name => new Actor(element(name)));
const directory = '/assets/motion-library/generated';
let loading = false, playing = false, elapsed = 0, phase = 0, mode: 'gesture' | 'drag' | 'idle' = 'gesture';
let last = performance.now(), loadGeneration = 0;
const ornaments: T.Object3D[] = [];

async function json(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`无法读取 ${url}（${response.status}）`);
  return response.json();
}

function draw() {
  for (const actor of actors) {
    actor.rotation = Number(angle.value) * Math.PI / 180;
    actor.anchor.rotation.y = actor.rotation;
    actor.scene.updateMatrixWorld(true);
    actor.render();
  }
}

function seek(fraction: number) {
  playing = false; mode = 'gesture'; phase = fraction; elapsed = 0; play.textContent = '播放';
  for (const actor of actors) {
    actor.mixer!.stopAllAction();
    const action = actor.actions.react!;
    action.reset().setEffectiveWeight(1).setEffectiveTimeScale(1).setLoop(T.LoopOnce, 1).play();
    action.clampWhenFinished = true;
    actor.mixer!.setTime(actor.duration('react') * fraction);
    actor.action = 'react';
    actor.baseHead.copy(actor.head!.quaternion); if (actor.neck) actor.baseNeck.copy(actor.neck.quaternion);
  }
  timeline.value = String(Math.round(fraction * 1000)); progress.value = `${Math.round(fraction * 100)}%`;
  draw();
}

function attach(actor: Actor) {
  const height = 3 / actor.model!.scale.y;
  for (const [socket, color, shape] of [['head', 0xd6a84a, 'ball'], ['back', 0x6e91a6, 'box'], ['rightHand', 0xc88569, 'ball']] as const) {
    const parent = actor.model!.getObjectByName('Socket_' + socket);
    if (!parent) throw new Error(`缺少挂点 ${socket}`);
    const geometry = shape === 'box' ? new T.BoxGeometry(height * .09, height * .11, height * .05) : new T.SphereGeometry(height * .035, 16, 12);
    const mesh = new T.Mesh(geometry, new T.MeshStandardMaterial({ color, roughness: .8 }));
    mesh.name = 'Sample_' + socket; mesh.visible = accessories.checked; parent.add(mesh); ornaments.push(mesh);
  }
}

async function load() {
  const generation = ++loadGeneration;
  loading = true; playing = false; play.textContent = '播放';
  play.disabled = replay.disabled = interrupt.disabled = true;
  variant.disabled = appearance.disabled = timeline.disabled = true;
  status.textContent = '正在加载动作样板…';
  ornaments.length = 0;
  try {
    // Decode the two dense textured characters in order to avoid a cold-start
    // image-decoding burst, while preserving the production Actor's deadline.
    for (const [index, actor] of actors.entries()) {
      const name = species[index];
      const manifest = parseManifest(await json(`/templates/felt-${name}/pet.json`));
      manifest.animations.react = variant.value === 'shared' ? 'GreetingShared' : variant.value === 'character' ? 'GreetingCharacter' : 'React';
      await actor.load({ manifest, url: `${directory}/${name}${appearance.value === 'proxy' ? '-proxy' : ''}.glb`, previewUrl: '', source: 'builtin' });
      attach(actor);
    }
    if (generation !== loadGeneration) return;
    const report = await json(directory + '/report.json');
    element('provenance').textContent = `共享动作源：assets/motion-library/source.blend\n动作源校验：${report.sourceSHA256}\n角色映射：assets/motion-library/characters.json\n片段时长：${actors.map((a, i) => `${species[i]} ${a.duration('react').toFixed(2)} 秒`).join(' / ')}\n已有肩袖问题仍需通过正式外观检查；白模不代表变形通过。`;
    seek(0);
    status.textContent = '已就绪。可播放、拖动进度条，或切换外观与视角。';
    play.disabled = replay.disabled = interrupt.disabled = timeline.disabled = false;
    document.body.dataset.ready = 'true';
  } catch (error) {
    document.body.dataset.ready = 'error';
    status.textContent = `加载失败：${error instanceof Error ? error.message : error}。请先运行动作库烘焙命令。`;
  } finally {
    loading = false; variant.disabled = appearance.disabled = false;
  }
}

function start() {
  if (phase >= 1 || mode !== 'gesture') seek(0);
  playing = true; play.textContent = '暂停';
}

play.onclick = () => { if (playing) { playing = false; play.textContent = '播放'; } else start(); };
replay.onclick = () => { seek(0); start(); };
interrupt.onclick = () => {
  for (const actor of actors) actor.play('drag', true);
  mode = 'drag'; elapsed = 0; playing = true; play.textContent = '暂停';
  status.textContent = '拖动动作会打断招呼，随后平滑回到待机。';
};
variant.onchange = appearance.onchange = () => { document.body.dataset.ready = 'false'; void load(); };
timeline.oninput = () => { if (!loading) seek(Number(timeline.value) / 1000); };
angle.onchange = draw;
accessories.onchange = () => { for (const mesh of ornaments) mesh.visible = accessories.checked; draw(); };

function tick(now: number) {
  const dt = Math.min((now - last) / 1000, .05); last = now;
  if (!loading && playing) {
    elapsed += dt;
    for (const actor of actors) actor.update(dt, 0, 0, Number(angle.value) * Math.PI / 180);
    if (mode === 'gesture') {
      phase = Math.min(1, Math.max(...actors.map(a => a.actions.react!.time / a.duration('react'))));
      timeline.value = String(Math.round(phase * 1000)); progress.value = `${Math.round(phase * 100)}%`;
      if (actors.every(a => a.actions.react!.time >= a.duration('react') - .001)) {
        for (const actor of actors) actor.play('idle'); mode = 'idle'; elapsed = 0;
        status.textContent = '招呼结束，已回到待机。';
      }
    } else if (mode === 'drag' && elapsed >= .8) {
      for (const actor of actors) actor.play('idle'); mode = 'idle'; elapsed = 0;
      status.textContent = '打断后已回到待机，可重播招呼。';
    }
    draw();
  }
  requestAnimationFrame(tick);
}

// Read-only measurements for the local verification harness.
Object.assign(window, { motionWorkbench: {
  state: () => ({ loading, playing, mode, phase, durations: actors.map(a => a.duration('react')),
    characters: actors.map(actor => ({ action: actor.action, scale: actor.model?.scale.toArray(),
      sockets: ['head', 'back', 'leftHand', 'rightHand'].map(name => {
        const socket = actor.model?.getObjectByName('Socket_' + name);
        return { name, position: socket?.getWorldPosition(new T.Vector3()).toArray(), parent: socket?.parent?.name };
      }) })) })
} });
window.addEventListener('beforeunload', () => actors.forEach(a => a.dispose()));
void load(); requestAnimationFrame(tick);
