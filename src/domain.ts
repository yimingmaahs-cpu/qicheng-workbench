export const ACTIONS = ['idle', 'walk', 'react', 'drag', 'rest', 'restIn', 'restOut'] as const;
export type Action = typeof ACTIONS[number];
export type Axis = 'x' | 'y' | 'z';
export type Manifest = {
  version: 1; id: string; name: string; model: 'model.glb'; preview: 'preview.png';
  draft: boolean; scale: number; facing: number;
  look: { head: string; neck?: string; yawAxis: Axis; pitchAxis: Axis; yawSign: number; pitchSign: number; yawLimit: number; pitchLimit: number };
  animations: Record<Action, string>; walkSpeed: number;
};
export type Template = { manifest: Manifest; url: string; previewUrl: string; source: 'builtin' | 'imported' };
export type Point = { x: number; y: number };
export type Rect = Point & { width: number; height: number };
export type Settings = { templateId: string; size: number; position?: Point; walking: boolean; grounded: boolean };
export type Frame = {
  cursor: Point; bounds: Rect; walking: boolean; dragging: boolean; attention: boolean;
  direction: number; visible: boolean;
};
export type Bootstrap = { templates: Template[]; settings: Settings; frame: Frame };
export type Command = { type: 'select'; id: string } | { type: 'size'; size: number } | { type: 'walk'; enabled: boolean } | { type: 'bottom' | 'hide' | 'import' | 'quit' | 'panel' | 'chat' };
export interface PetAPI {
  bootstrap(): Promise<Bootstrap>;
  command(command: Command): Promise<void>;
  selectResult(id: string, ok: boolean, error?: string): void;
  hit(hit: boolean, head: Point, crown?: Point): void;
  pointer(kind: 'down' | 'up' | 'cancel'): void;
  menu(): void;
  onFrame(callback: (frame: Frame) => void): () => void;
  onSelect(callback: (template: Template) => void): () => void;
  onEvent(callback: (event: { type: string; message?: string }) => void): () => void;
}
export const DEFAULT_SETTINGS: Settings = { templateId: 'felt-beagle', size: 260, walking: true, grounded: true };
export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
export function clampWindow(rect: Rect, area: Rect): Rect {
  return { ...rect, x: Math.round(clamp(rect.x, area.x, area.x + Math.max(0, area.width - rect.width))), y: Math.round(clamp(rect.y, area.y, area.y + Math.max(0, area.height - rect.height))) };
}
export function attentionAt(previous: boolean, distance: number): boolean { return distance < (previous ? 380 : 300); }
export function dragged(start: Point, cursor: Point): boolean { return Math.hypot(cursor.x - start.x, cursor.y - start.y) > 6; }
export function validResourcePath(path: string): boolean {
  return /^[a-zA-Z0-9_./-]+$/.test(path) && !path.startsWith('/') && path.split('/').every(p => p !== '..' && p !== '.' && p.length > 0);
}
function fail(message: string): never { throw new Error(message); }
function record(v: unknown): Record<string, any> { if (!v || typeof v !== 'object' || Array.isArray(v)) fail('配置必须是对象'); return v as Record<string, any>; }
function number(v: unknown, min: number, max: number, name: string): number { if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail(`${name} 必须在 ${min}–${max} 之间`); return v as number; }
function name(v: unknown, field: string): string { if (typeof v !== 'string' || !v.trim() || v.length > 100 || /[\u0000-\u001f]/.test(v)) fail(`${field} 无效`); return v as string; }
export function parseManifest(value: unknown): Manifest {
  const m = record(value), l = record(m.look), a = record(m.animations);
  if (m.version !== 1) fail('不支持此模板版本（只支持 version: 1）');
  if (typeof m.id !== 'string' || !/^[a-z][a-z0-9-]{2,47}$/.test(m.id)) fail('模板标识需为 3–48 位小写字母、数字或连字符');
  if (m.model !== 'model.glb' || m.preview !== 'preview.png') fail('模型与预览必须命名为 model.glb 和 preview.png');
  if (m.draft !== undefined && typeof m.draft !== 'boolean') fail('draft 必须是布尔值');
  if (!['x','y','z'].includes(l.yawAxis) || !['x','y','z'].includes(l.pitchAxis) || l.yawAxis === l.pitchAxis) fail('头部旋转轴必须为两个不同的 x/y/z 轴');
  if (![1,-1].includes(l.yawSign) || ![1,-1].includes(l.pitchSign)) fail('旋转方向必须为 1 或 -1');
  const animations = Object.fromEntries(ACTIONS.map(key => [key, name(a[key], `缺少动作 ${key}`)])) as Record<Action, string>;
  if (new Set(Object.values(animations)).size !== ACTIONS.length) fail('每个动作必须映射到独立动画');
  return { version: 1, id: m.id, name: name(m.name, '名称'), model: 'model.glb', preview: 'preview.png', draft: m.draft === true,
    scale: number(m.scale, 0.2, 2, '比例'), facing: number(m.facing, -180, 180, '朝向'), walkSpeed: number(m.walkSpeed, 5, 150, '步速'), animations,
    look: { head: name(l.head, '头部骨骼'), ...(l.neck ? {neck: name(l.neck, '颈部骨骼')} : {}), yawAxis: l.yawAxis, pitchAxis: l.pitchAxis,
      yawSign: l.yawSign, pitchSign: l.pitchSign, yawLimit: number(l.yawLimit, 1, 75, '水平角度'), pitchLimit: number(l.pitchLimit, 1, 45, '俯仰角度') } };
}
export function readSettings(v: unknown): Settings {
  try { const o = record(v); return { templateId: typeof o.templateId === 'string' && /^[a-z][a-z0-9-]{2,47}$/.test(o.templateId) ? o.templateId : DEFAULT_SETTINGS.templateId,
    size: typeof o.size === 'number' && Number.isFinite(o.size) ? clamp(o.size, 180, 380) : 260,
    walking: typeof o.walking === 'boolean' ? o.walking : true, grounded: typeof o.grounded === 'boolean' ? o.grounded : true,
    ...(o.position && Number.isFinite(o.position.x) && Number.isFinite(o.position.y) ? { position: {x: o.position.x, y: o.position.y} } : {}) }; } catch { return {...DEFAULT_SETTINGS}; }
}
