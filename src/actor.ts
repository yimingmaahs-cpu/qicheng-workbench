import * as T from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ACTIONS, clamp, type Action, type Manifest, type Template } from './domain';
import { maskHit, maskTop } from './hit-mask';

export function disposeModel(model: T.Object3D) {
  const geometries=new Set<T.BufferGeometry>(),materials=new Set<T.Material>(),textures=new Set<T.Texture>(),skeletons=new Set<T.Skeleton>();
  model.traverse(object=>{
    const mesh=object as T.Mesh;if(mesh.geometry)geometries.add(mesh.geometry);
    if(mesh.material)for(const material of Array.isArray(mesh.material)?mesh.material:[mesh.material]){
      materials.add(material);for(const value of Object.values(material))if(value instanceof T.Texture)textures.add(value);
    }
    if((object as T.SkinnedMesh).isSkinnedMesh)skeletons.add((object as T.SkinnedMesh).skeleton);
  });
  for(const texture of textures){texture.dispose();const image=texture.image;if(typeof ImageBitmap!=='undefined' && image instanceof ImageBitmap)image.close();}
  for(const material of materials)material.dispose();for(const geometry of geometries)geometry.dispose();for(const skeleton of skeletons)skeleton.dispose();
}
export class Actor {
  readonly scene=new T.Scene();
  readonly camera=new T.OrthographicCamera(-2.5,2.5,3.56,-0.04,0.1,100);
  readonly renderer: T.WebGLRenderer;
  readonly anchor=new T.Group();
  model?: T.Group; manifest?: Manifest; mixer?: T.AnimationMixer;
  actions: Partial<Record<Action,T.AnimationAction>>={}; action: Action='idle';
  head?: T.Object3D; neck?: T.Object3D; baseHead=new T.Quaternion();baseNeck=new T.Quaternion();
  offsetYaw=0;offsetPitch=0;rotation=0;generation=0;
  private resizeObserver: ResizeObserver;
  private hitTarget?: T.WebGLRenderTarget;
  private hitPixels=new Uint8Array(0);
  private hitMaskAt=-Infinity;
  private silhouetteTop:number|undefined;
  private width=0;private height=0;
  constructor(readonly container: HTMLElement, readonly hitTesting=false) {
    this.renderer=new T.WebGLRenderer({alpha:true,antialias:true,powerPreference:'low-power'});
    this.renderer.setClearColor(0,0);this.renderer.setPixelRatio(Math.min(devicePixelRatio,2));
    this.renderer.outputColorSpace=T.SRGBColorSpace;this.renderer.toneMapping=T.ACESFilmicToneMapping;this.renderer.toneMappingExposure=1.22;
    this.renderer.domElement.setAttribute('aria-label','三维角色');container.append(this.renderer.domElement);
    this.renderer.domElement.style.width='100%';this.renderer.domElement.style.height='100%';
    this.camera.position.set(0,1.65,9);this.camera.lookAt(0,1.65,0);
    // Camera frustum coordinates are relative to camera centre.
    this.camera.top=3.56-1.65;this.camera.bottom=-0.04-1.65;
    this.scene.add(new T.HemisphereLight(0xfff5e7,0xadbeb2,2.3));
    const key=new T.DirectionalLight(0xfff5e8,3.2);key.position.set(-3,5,6);this.scene.add(key);
    const rim=new T.DirectionalLight(0xd6e9f2,1.8);rim.position.set(3,3,-3);this.scene.add(rim);
    this.scene.add(this.anchor);
    this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(container);this.resize();
  }
  resize() {
    const w=this.container.clientWidth,h=this.container.clientHeight;
    // Fractional Windows DPI may alternate by one CSS pixel while moving. Keep
    // the existing drawing buffer to avoid allocation and flashes on every step.
    if(!w||!h||Math.abs(w-this.width)<=2&&Math.abs(h-this.height)<=2)return;
    this.width=w;this.height=h;this.camera.left=-1.8*w/h;this.camera.right=1.8*w/h;this.camera.updateProjectionMatrix();this.renderer.setSize(w,h,false);
    if(this.hitTesting){
      this.hitTarget?.dispose();
      const scale=Math.min(.5,256/Math.max(w,h)),mw=Math.max(1,Math.ceil(w*scale)),mh=Math.max(1,Math.ceil(h*scale));
      this.hitTarget=new T.WebGLRenderTarget(mw,mh,{minFilter:T.NearestFilter,magFilter:T.NearestFilter,generateMipmaps:false});
      this.hitPixels=new Uint8Array(mw*mh*4);this.hitMaskAt=-Infinity;
    }
  }
  async load(template: Template): Promise<boolean> {
    const generation=++this.generation;
    const controller=new AbortController();let expired=false;
    let timeout: ReturnType<typeof setTimeout>;
    const deadline=new Promise<never>((_resolve,reject)=>{timeout=setTimeout(()=>{expired=true;controller.abort();reject(new Error('模型加载超过 15 秒，已保留原角色'));},15000);});
    const loading=(async()=>{
      const response=await fetch(template.url,{signal:controller.signal});if(!response.ok)throw new Error(`无法读取模型（${response.status}）`);
      const bytes=await response.arrayBuffer();
      if(bytes.byteLength>64*1024*1024)throw new Error('模型超过 64 MB');
      const manager=new T.LoadingManager();let resourceFailed=false;
      manager.onError=()=>{resourceFailed=true;};
      const result=await new GLTFLoader(manager).parseAsync(bytes,'');
      if(resourceFailed){disposeModel(result.scene);throw new Error('模型内嵌贴图读取失败，已保留原角色');}
      if(expired){disposeModel(result.scene);throw new Error('模型加载已取消');}
      return result;
    })();
    const gltf=await Promise.race([loading,deadline]).finally(()=>clearTimeout(timeout));
    if(generation!==this.generation){disposeModel(gltf.scene);return false;}
    const next=gltf.scene,m=template.manifest;
    try {
      const head=next.getObjectByName(m.look.head),neck=m.look.neck?next.getObjectByName(m.look.neck):undefined;
      if(!(head as T.Bone)?.isBone || (m.look.neck && !(neck as T.Bone)?.isBone))throw new Error('模型缺少头颈骨骼');
      const mixer=new T.AnimationMixer(next),actions: Partial<Record<Action,T.AnimationAction>>={};
      for(const key of ACTIONS){const clip=gltf.animations.find(c=>c.name===m.animations[key]);if(!clip||clip.duration<=0)throw new Error(`模型缺少有效动作 ${key}`);actions[key]=mixer.clipAction(clip);}
      next.updateMatrixWorld(true);
      const bounds=new T.Box3().setFromObject(next,true),size=bounds.getSize(new T.Vector3()),center=bounds.getCenter(new T.Vector3());
      if(!Number.isFinite(size.y)||size.y<0.0001||size.y>10000)throw new Error('模型尺寸无效');
      const factor=3/size.y*m.scale;
      next.scale.multiplyScalar(factor);next.position.set(-center.x*factor,-bounds.min.y*factor,-center.z*factor);
      next.traverse(o=>{if((o as T.Mesh).isMesh)o.frustumCulled=false;});
      if(this.model){this.mixer?.stopAllAction();this.mixer?.uncacheRoot(this.model);this.anchor.remove(this.model);disposeModel(this.model);}
      this.model=next;this.manifest=m;this.mixer=mixer;this.actions=actions;this.head=head;this.neck=neck;
      this.baseHead.copy(head!.quaternion);if(neck)this.baseNeck.copy(neck.quaternion);
      this.offsetYaw=0;this.offsetPitch=0;this.rotation=0;this.anchor.rotation.y=T.MathUtils.degToRad(m.facing);
      this.anchor.add(next);this.action='idle';actions.idle!.play();this.hitMaskAt=-Infinity;this.resize();this.render();return true;
    }catch(error){disposeModel(next);throw error;}
  }
  play(key: Action, restart=false) {
    if(!this.mixer||(!restart&&key===this.action))return;
    const previous=this.actions[this.action],next=this.actions[key];if(!next)return;
    next.reset();next.enabled=true;next.setEffectiveWeight(1);next.setEffectiveTimeScale(1);
    const once=['react','restIn','restOut'].includes(key);next.setLoop(once?T.LoopOnce:T.LoopRepeat,once?1:Infinity);next.clampWhenFinished=once;
    next.play();if(previous&&previous!==next)previous.crossFadeTo(next,0.2,false);
    this.action=key;
  }
  duration(key: Action) {return this.actions[key]?.getClip().duration??1;}
  update(dt: number, yaw: number, pitch: number, targetRotation: number, walkRate=1) {
    if(!this.model||!this.manifest)return;
    if(this.head)this.head.quaternion.copy(this.baseHead);if(this.neck)this.neck.quaternion.copy(this.baseNeck);
    if(this.actions.walk)this.actions.walk.timeScale=walkRate;
    this.mixer!.update(dt);
    if(this.head)this.baseHead.copy(this.head.quaternion);if(this.neck)this.baseNeck.copy(this.neck.quaternion);
    const l=this.manifest.look,smooth=1-Math.exp(-dt*9);
    this.offsetYaw=T.MathUtils.lerp(this.offsetYaw,clamp(yaw,-l.yawLimit,l.yawLimit),smooth);
    this.offsetPitch=T.MathUtils.lerp(this.offsetPitch,clamp(pitch,-l.pitchLimit,l.pitchLimit),smooth);
    const offset=(weight: number)=>{
      const e=new T.Euler();e[l.yawAxis]=T.MathUtils.degToRad(this.offsetYaw)*weight*l.yawSign;e[l.pitchAxis]=T.MathUtils.degToRad(this.offsetPitch)*weight*l.pitchSign;
      return new T.Quaternion().setFromEuler(e);
    };
    this.head?.quaternion.multiply(offset(this.neck?.isObject3D?0.75:1));this.neck?.quaternion.multiply(offset(0.25));
    let difference=targetRotation-this.rotation;while(difference>Math.PI)difference-=Math.PI*2;while(difference< -Math.PI)difference+=Math.PI*2;
    this.rotation+=difference*(1-Math.exp(-dt*6));this.anchor.rotation.y=this.rotation+T.MathUtils.degToRad(this.manifest.facing);
    this.scene.updateMatrixWorld(true);
  }
  headPoint() {const p=this.head?.getWorldPosition(new T.Vector3())??new T.Vector3(0,2.2,0);p.project(this.camera);return {x:(p.x+1)*this.container.clientWidth/2,y:(1-p.y)*this.container.clientHeight/2};}
  bubblePoint() {const p=this.headPoint();return {x:p.x,y:this.silhouetteTop===undefined?p.y:this.silhouetteTop*this.container.clientHeight};}
  hits(x: number,y: number) {
    if(!this.model||!this.hitTarget)return false;
    return maskHit(this.hitPixels,this.hitTarget.width,this.hitTarget.height,x,y,this.container.clientWidth,this.container.clientHeight);
  }
  render() {
    const now=performance.now();
    if(this.hitTarget&&now-this.hitMaskAt>=100){
      // Cache the actual animated silhouette. Mouse moves only read one alpha byte,
      // instead of skinning and intersecting 100,000 triangles on the CPU.
      const previous=this.renderer.getRenderTarget();
      try {
        this.renderer.setRenderTarget(this.hitTarget);this.renderer.render(this.scene,this.camera);
        this.renderer.readRenderTargetPixels(this.hitTarget,0,0,this.hitTarget.width,this.hitTarget.height,this.hitPixels);
        this.silhouetteTop=maskTop(this.hitPixels,this.hitTarget.width,this.hitTarget.height);
        this.hitMaskAt=now;
      } finally {this.renderer.setRenderTarget(previous);}
    }
    this.renderer.render(this.scene,this.camera);
  }
  dispose() {this.generation++;this.resizeObserver.disconnect();this.mixer?.stopAllAction();if(this.model)disposeModel(this.model);this.hitTarget?.dispose();this.renderer.dispose();this.renderer.domElement.remove();}
}
