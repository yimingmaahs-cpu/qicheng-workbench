import { readFile, readdir, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import yauzl from 'yauzl';
import { ACTIONS, parseManifest, validResourcePath, type Manifest, type Template } from './domain';

export const MAX_PACKAGE = 80 * 1024 * 1024;
const ALLOWED = new Map([['pet.json', 32 * 1024], ['model.glb', 64 * 1024 * 1024], ['preview.png', 4 * 1024 * 1024], ['LICENSE.txt', 64 * 1024]]);
export function validateGLB(data: Uint8Array, m: Manifest): void {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (b.length < 28 || b.length > ALLOWED.get('model.glb')! || b.toString('ascii',0,4) !== 'glTF' || b.readUInt32LE(4) !== 2 || b.readUInt32LE(8) !== b.length) throw new Error('GLB 文件头或大小无效');
  const length = b.readUInt32LE(12);
  if (length > 4 * 1024 * 1024 || length % 4 || length + 20 > b.length || b.readUInt32LE(16) !== 0x4e4f534a) throw new Error('GLB JSON 数据无效');
  const json = JSON.parse(b.toString('utf8',20,20+length));
  const inspect = (o: any, depth = 0): void => {
    if (depth > 50) throw new Error('GLB 数据嵌套过深');
    if (!o || typeof o !== 'object') return;
    for (const [key,value] of Object.entries(o)) {
      if (key === 'uri') throw new Error('GLB 必须内嵌全部资源，不允许 URI');
      inspect(value, depth + 1);
    }
  };
  inspect(json);
  if (json.asset?.version !== '2.0' || !Array.isArray(json.nodes) || json.nodes.length > 1024 || !Array.isArray(json.meshes) || json.meshes.length > 256) throw new Error('GLB 场景结构或复杂度不受支持');
  const supported = ['KHR_materials_unlit', 'KHR_materials_emissive_strength', 'KHR_materials_ior', 'KHR_materials_specular', 'KHR_texture_transform'];
  if ((json.extensionsRequired ?? []).some((e: string) => !supported.includes(e))) throw new Error('请导出不依赖压缩解码器或自定义扩展的 GLB');
  if ((json.accessors ?? []).some((a: any) => !Number.isInteger(a.count) || a.count < 0 || a.count > 1000000) || (json.images ?? []).length > 32) throw new Error('模型顶点或贴图过多');
  if (!Array.isArray(json.buffers) || json.buffers.length !== 1 || !Number.isInteger(json.buffers[0].byteLength)) throw new Error('模型需要一个内嵌二进制缓冲区');
  const binOffset = 20 + length;
  if (binOffset + 8 > b.length || b.readUInt32LE(binOffset + 4) !== 0x004e4942 || b.readUInt32LE(binOffset) + binOffset + 8 !== b.length || json.buffers[0].byteLength > b.readUInt32LE(binOffset)) throw new Error('模型二进制数据不完整');
  for (const view of json.bufferViews ?? []) {
    if (view.buffer !== 0 || !Number.isInteger(view.byteLength) || view.byteLength < 0 || !Number.isInteger(view.byteOffset ?? 0) || (view.byteOffset ?? 0) < 0 || (view.byteOffset ?? 0) + view.byteLength > json.buffers[0].byteLength) throw new Error('模型缓冲区越界');
  }
  for (const mesh of json.meshes) for (const primitive of mesh.primitives ?? []) {
    for (const index of [...Object.values(primitive.attributes ?? {}), ...(primitive.indices === undefined ? [] : [primitive.indices])]) {
      if (!Number.isInteger(index) || !json.accessors?.[index as number]) throw new Error('模型引用了不存在的顶点数据');
    }
  }
  const names = json.nodes.map((n: any) => n.name);
  const joints = new Set<number>((json.skins ?? []).flatMap((s: any) => s.joints ?? []));
  for (const bone of [m.look.head, m.look.neck].filter(Boolean)) {
    const matches = names.map((n: string, i: number) => n === bone ? i : -1).filter((i: number) => i >= 0);
    if (matches.length !== 1 || !joints.has(matches[0])) throw new Error(`缺少或重复的蒙皮骨骼：${bone}`);
  }
  const animationNames = (json.animations ?? []).map((a: any) => a.name);
  for (const key of ACTIONS) {
    if (animationNames.filter((n: string) => n === m.animations[key]).length !== 1) throw new Error(`缺少或重复的动作：${key} → ${m.animations[key]}`);
    const animation = json.animations.find((a: any) => a.name === m.animations[key]);
    if (!animation.channels?.length || !animation.samplers?.length) throw new Error(`动作为空：${key}`);
  }
}
export function validatePackage(files: Map<string, Buffer>): Manifest {
  for (const name of ALLOWED.keys()) if (!files.has(name)) throw new Error(`模板包缺少 ${name}`);
  for (const [name, bytes] of files) if (!validResourcePath(name) || !ALLOWED.has(name) || bytes.length > ALLOWED.get(name)!) throw new Error(`不允许的文件或文件过大：${name}`);
  const manifest = parseManifest(JSON.parse(files.get('pet.json')!.toString('utf8')));
  const png = files.get('preview.png')!;
  if (png.length < 24 || png.subarray(0,8).toString('hex') !== '89504e470d0a1a0a' || png.readUInt32BE(16) < 1 || png.readUInt32BE(20) < 1 || png.readUInt32BE(16) > 2048 || png.readUInt32BE(20) > 2048) throw new Error('预览需为不超过 2048×2048 的 PNG');
  if (!files.get('LICENSE.txt')!.toString('utf8').trim()) throw new Error('请提供素材来源说明');
  validateGLB(files.get('model.glb')!, manifest);
  return manifest;
}
export async function readZip(path: string): Promise<Map<string, Buffer>> {
  const { stat } = await import('node:fs/promises');
  if ((await stat(path)).size > MAX_PACKAGE) throw new Error('压缩包不能超过 80 MB');
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip) return reject(error ?? new Error('无法读取 ZIP'));
      const files = new Map<string, Buffer>(); let total = 0, finished = false;
      const fail = (error: Error) => { if (!finished) { finished = true; zip.close(); reject(error); } };
      zip.on('error', fail);
      zip.on('entry', (entry: yauzl.Entry) => {
        const name = entry.fileName, mode = (entry.externalFileAttributes >>> 16) & 0xf000;
        if (!validResourcePath(name) || !ALLOWED.has(name) || files.has(name) || mode === 0xa000 || entry.isEncrypted() || entry.uncompressedSize > ALLOWED.get(name)!) return fail(new Error(`不允许的 ZIP 条目：${name}`));
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) return fail(error ?? new Error('无法读取文件'));
          const chunks: Buffer[] = []; let size = 0;
          stream.on('error', fail);
          stream.on('data', (chunk: Buffer) => {
            size += chunk.length; total += chunk.length;
            if (size > ALLOWED.get(name)! || total > MAX_PACKAGE) { stream.destroy(); fail(new Error('模板解压大小超限')); } else chunks.push(chunk);
          });
          stream.on('end', () => { if (!finished) { files.set(name, Buffer.concat(chunks)); zip.readEntry(); } });
        });
      });
      zip.on('end', () => { if (!finished) { finished = true; resolve(files); } });
      zip.readEntry();
    });
  });
}
export class TemplateStore {
  roots = new Map<string, string>();
  templates: Template[] = [];
  constructor(readonly builtins: string, readonly imports: string) {}
  async scan(): Promise<void> {
    const entries: Template[] = []; const roots = new Map<string, string>();
    for (const [root, source] of [[this.builtins, 'builtin'], [this.imports, 'imported']] as const) {
      const dirs = await readdir(root, {withFileTypes: true}).catch(() => []);
      for (const dir of dirs) if (dir.isDirectory() && !dir.name.startsWith('.')) {
        try {
          const path = join(root, dir.name);
          const files = new Map(await Promise.all([...ALLOWED.keys()].map(async key => [key, await readFile(join(path,key))] as const)));
          const manifest = validatePackage(files);
          if (roots.has(manifest.id)) continue;
          roots.set(manifest.id, path);
          entries.push({ manifest, source, url: `pet://assets/${manifest.id}/model.glb`, previewUrl: `pet://assets/${manifest.id}/preview.png` });
        } catch (e) { console.warn(`跳过无效模板 ${dir.name}: ${String(e)}`); }
      }
    }
    this.roots = roots; this.templates = entries;
  }
  async import(path: string): Promise<Template> {
    const files = await readZip(path), manifest = validatePackage(files);
    if (this.roots.has(manifest.id)) throw new Error('已有相同模板标识。请在 pet.json 使用新的 id，避免覆盖现有模板。');
    await mkdir(this.imports, {recursive: true});
    const staging = join(this.imports, `.import-${randomUUID()}`);
    await mkdir(staging);
    try {
      for (const [file,bytes] of files) await writeFile(join(staging,file),bytes,{flag:'wx'});
      await rename(staging,join(this.imports,manifest.id));
    } finally { await rm(staging,{recursive:true,force:true}); }
    await this.scan();
    const result = this.templates.find(t => t.manifest.id === manifest.id);
    if (!result) throw new Error('模板安装后验证失败');
    return result;
  }
}
