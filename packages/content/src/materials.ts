/**
 * 应用素材注册表（创作草稿 v4）：AI 与校验器共用的同一份 ID 目录。
 * 全部素材为项目原创矢量图（React 内联 SVG 渲染，见 apps/web/src/components/art.tsx），
 * 亦提供独立 .svg 源文件（见 packages/content/materials/svg/ 与 apps/web/public/materials/）。
 * 来源与授权口径：项目原创，随仓库授权。
 */
import type { CharSpec } from '@endless/esl';

/** 与 @endless/world 的 EntityRow 结构一致（content 不直接依赖 world 包）。 */
export interface MaterialEntityRow {
  id: string; kind: string; name: string;
  home_channel: string | null; created_card: number; bible_ref: string | null;
}

export const MATERIAL_PROVENANCE = 'project-original';
export const MATERIAL_SOURCE_LABEL = 'ENDLESS original vector artwork';

export interface MaterialCharacter {
  id: string;
  /** 中文展示名（界面说话者名） */
  label: string;
  /** 英文显示名（气泡/消息署名） */
  name: string;
  tags: string[];
  spec: CharSpec;
}

export interface MaterialBackground {
  id: string;
  label: string;
  tags: string[];
}

export interface MaterialProp {
  id: string;
  label: string;
  tags: string[];
}

const EXPRESSIONS = ['neutral', 'happy', 'sad', 'nervous', 'surprised', 'thinking'];

const character = (id: string, label: string, name: string, tags: string[], extra: Partial<CharSpec> = {}): MaterialCharacter => ({
  id, label, name, tags,
  spec: { expr: EXPRESSIONS, hat: extra.hat ?? ['none'], props_allowed: extra.props_allowed ?? [] },
});

export const materialCharacters: readonly MaterialCharacter[] = [
  character('duck', '鸭侦探', 'Duck', ['侦探', '主角'], { hat: ['none', 'detective'] }),
  character('cat', '猫', 'Cat', ['紧张', '搭档']),
  character('moon', '月亮', 'Moon', ['客户', '帽子']),
  character('shopkeeper', '獾店主', 'Badger', ['店主', '商店']),
  character('delivery_mouse', '快递鼠', 'Mouse', ['快递', '包裹']),
  character('guide', '向导机器人', 'Guide', ['向导', '知识']),
  character('owl', '猫头鹰学者', 'Owl', ['学者', '顾问', '书籍']),
  character('dog', '警犬巡警', 'Dog', ['警官', '巡逻', '搭档'], { hat: ['none', 'cap'] }),
  character('rabbit', '兔烘焙师', 'Rabbit', ['烘焙', '甜品', '店员']),
  character('bear', '熊咖啡师', 'Bear', ['咖啡', '温暖', '店主']),
  character('fox', '狐狸写生家', 'Fox', ['艺术', '机敏', '写生'], { hat: ['none', 'beret'] }),
  character('penguin', '企鹅站长', 'Penguin', ['车站', '认真', '礼服'], { hat: ['none', 'stationmaster'] }),
];

export const materialBackgrounds: readonly MaterialBackground[] = [
  { id: 'agency_office', label: '事务所办公室', tags: ['侦探', '室内', '办公'] },
  { id: 'living_room', label: '客厅', tags: ['居家', '室内', '休息'] },
  { id: 'shop_counter', label: '商店柜台', tags: ['商店', '室内', '购物'] },
  { id: 'cafe', label: '咖啡馆', tags: ['饮品', '室内', '日常'] },
  { id: 'park', label: '公园', tags: ['户外', '自然', '散步'] },
  { id: 'station', label: '车站', tags: ['出行', '户外', '等车'] },
  { id: 'bakery', label: '烘焙坊', tags: ['食物', '室内', '烘焙'] },
  { id: 'library', label: '图书馆', tags: ['阅读', '室内', '知识'] },
  { id: 'rooftop', label: '天台屋顶', tags: ['户外', '高处', '俯瞰'] },
  { id: 'harbor', label: '港口码头', tags: ['户外', '水边', '出行'] },
  { id: 'garden', label: '花房温室', tags: ['自然', '室内', '植物'] },
  { id: 'street', label: '街角林荫道', tags: ['户外', '日常', '城镇'] },
];

export const materialProps: readonly MaterialProp[] = [
  { id: 'magnifying_glass', label: '放大镜', tags: ['侦探', '工具'] },
  { id: 'notebook', label: '笔记本', tags: ['文具', '记录'] },
  { id: 'top_hat', label: '礼帽', tags: ['服饰', '帽子'] },
  { id: 'key', label: '钥匙', tags: ['物品', '开锁'] },
  { id: 'box', label: '盒子', tags: ['容器', '物品'] },
  { id: 'bag', label: '袋子', tags: ['容器', '随身'] },
  { id: 'umbrella', label: '雨伞', tags: ['物品', '天气'] },
  { id: 'coffee', label: '咖啡', tags: ['饮品', '日常'] },
  { id: 'envelope', label: '信封', tags: ['信件', '文具'] },
  { id: 'clock', label: '时钟', tags: ['时间', '物品'] },
  { id: 'book', label: '书', tags: ['阅读', '物品'] },
  { id: 'apple', label: '苹果', tags: ['食物', '水果'] },
  { id: 'bread', label: '面包', tags: ['食物', '烘焙'] },
  { id: 'cup', label: '杯子', tags: ['饮品', '器皿'] },
  { id: 'ticket', label: '车票', tags: ['出行', '票据'] },
  { id: 'bicycle', label: '自行车', tags: ['出行', '交通'] },
  { id: 'plant', label: '盆栽', tags: ['自然', '装饰'] },
  { id: 'gift', label: '礼物', tags: ['物品', '心意'] },
  { id: 'coin', label: '硬币', tags: ['金钱', '物品'] },
  { id: 'jar', label: '玻璃罐', tags: ['容器', '物品'] },
  { id: 'photo', label: '相片', tags: ['记忆', '线索'] },
  { id: 'lamp', label: '台灯', tags: ['家具', '照明'] },
  { id: 'camera', label: '照相机', tags: ['工具', '记录'] },
  { id: 'mirror', label: '手镜', tags: ['物品', '日常'] },
  { id: 'newspaper', label: '报纸', tags: ['阅读', '资讯'] },
  { id: 'phone', label: '电话', tags: ['通讯', '日常'] },
  { id: 'tea', label: '茶壶', tags: ['饮品', '日常'] },
  { id: 'cake', label: '蛋糕', tags: ['食物', '甜品'] },
  { id: 'glasses', label: '眼镜', tags: ['配饰', '文具'] },
  { id: 'badge', label: '徽章', tags: ['服饰', '标志'] },
  { id: 'bell', label: '铜铃', tags: ['声音', '物品'] },
  { id: 'flower', label: '鲜花', tags: ['自然', '装饰'] },
  { id: 'candle', label: '蜡烛', tags: ['照明', '氛围'] },
  { id: 'feather', label: '羽毛笔', tags: ['文具', '书写'] },
  { id: 'compass', label: '指南针', tags: ['旅行', '探索'] },
  { id: 'cookie', label: '曲奇饼干', tags: ['食物', '小吃'] },
  { id: 'map', label: '地图', tags: ['旅行', '路线'] },
  { id: 'basket', label: '野餐篮', tags: ['容器', '生活'] },
  { id: 'scarf', label: '围巾', tags: ['服饰', '保暖'] },
  { id: 'guitar', label: '尤克里里', tags: ['音乐', '艺术'] },
];

/**
 * 道具 → 词库条目的显式图片对应：仅在词义确实匹配时登记，
 * 供 quiz「find（找一找）」把词和正确的图案对上；不做语义别名（不用桌子冒充椅子）。
 */
export const materialItemPictures: Readonly<Record<string, string>> = {
  notebook: 'lx:notebook#n.notepad',
  key: 'lx:key#n.opener',
  box: 'lx:box#n.container',
  bag: 'lx:bag#n.container',
  envelope: 'lx:envelope#n.cover',
  clock: 'lx:clock#n.timepiece',
  cup: 'lx:cup#n.drink-vessel',
  gift: 'lx:gift#n.present',
  coin: 'lx:coin#n.money-piece',
  jar: 'lx:jar#n.container',
  photo: 'lx:photo#n.picture',
};

/** 反向索引：词库条目 → 可考图片道具。 */
export function materialPictureOf(item: string): string | undefined {
  for (const [prop, mapped] of Object.entries(materialItemPictures)) {
    if (mapped === item) return prop;
  }
  return undefined;
}

/** 注册表新角色（试播之外的实体），首个 v4 文档进入内容库时追加。 */
export const materialEntityRows: readonly MaterialEntityRow[] = materialCharacters
  .filter((entry) => !['duck', 'cat', 'moon'].includes(entry.id))
  .map((entry) => ({
    id: entry.id, name: entry.name, kind: 'character',
    home_channel: null, created_card: 0, bible_ref: 'application',
  }));

/** v4 校验上下文用的素材目录（emojis = 道具、tags = 背景、chars = 全部角色规格）。 */
export function materialAssetCatalog() {
  return {
    emojis: new Set(materialProps.map((prop) => prop.id)),
    tags: new Set(materialBackgrounds.map((bg) => bg.id)),
    chars: new Map(materialCharacters.map((entry) => [entry.id, entry.spec])),
  };
}

const MATERIAL_IDS = new Set(materialCharacters.map((entry) => entry.id));

export function materialEntityExists(id: string): boolean {
  return MATERIAL_IDS.has(id);
}
