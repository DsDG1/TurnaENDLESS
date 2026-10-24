/**
 * 世界状态表结构（第 5.5.1 节）。
 * DDL 与方案中的 SQL 一致；正式进 app 时由 Drizzle 定义同一份结构（见 oss-reuse 第 2.5 节），
 * 实验阶段驱动（node:sqlite / 内存）直接执行这里的 DDL。
 */

export interface EntityRow {
  id: string;
  kind: 'character' | 'location' | 'object' | 'organization' | string;
  name: string;
  home_channel: string | null;
  created_card: number;
  bible_ref: string | null;
}

/** 双时态事实：valid_from/valid_to 是世界时间，recorded 是记录时间。 */
export interface FactRow {
  id: number;
  subject: string;
  predicate: string;
  object: string;
  valid_from_card: number;
  /** NULL 表示当前仍成立 */
  valid_to_card: number | null;
  recorded_card: number;
  source_batch: string;
  source_scene: string | null;
  standing: 'canon' | 'stated' | 'rumor';
}

export interface EventRow {
  id: number;
  card: number;
  batch: string;
  channel: string;
  type: string;
  actors: string[];
  summary_en: string;
  user_choice: string | null;
  tags: string[] | null;
}

export interface ThreadRow {
  id: string;
  title: string;
  status: 'open' | 'advanced' | 'resolved' | 'abandoned';
  owner_channel: string;
  opened_card: number;
  last_touched_card: number;
  priority: number;
  setup: string;
  payoff_hint: string | null;
  expires_after_cards: number | null;
}

export interface UserFactRow {
  id: number;
  predicate: string;
  object: string;
  card: number;
  batch: string;
  /** 产生这条选择的场景 ID；老数据或外部库里可能是 null（只用于定位，不参与判定）。 */
  scene: string | null;
}

export interface EpisodeSummaryRow {
  channel: string;
  from_card: number;
  to_card: number;
  text: string;
}

export const WORLD_DDL = `
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
  home_channel TEXT, created_card INTEGER NOT NULL, bible_ref TEXT
);
CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY, subject TEXT NOT NULL, predicate TEXT NOT NULL, object TEXT NOT NULL,
  valid_from_card INTEGER NOT NULL,
  valid_to_card   INTEGER,
  recorded_card   INTEGER NOT NULL,
  source_batch TEXT NOT NULL, source_scene TEXT,
  standing TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, card INTEGER NOT NULL, batch TEXT NOT NULL, channel TEXT NOT NULL,
  type TEXT NOT NULL, actors TEXT NOT NULL,
  summary_en TEXT NOT NULL, user_choice TEXT, tags TEXT
);
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL,
  owner_channel TEXT NOT NULL, opened_card INTEGER NOT NULL, last_touched_card INTEGER NOT NULL,
  priority INTEGER NOT NULL, setup TEXT NOT NULL, payoff_hint TEXT, expires_after_cards INTEGER
);
CREATE TABLE IF NOT EXISTS user_facts (
  id INTEGER PRIMARY KEY, predicate TEXT NOT NULL, object TEXT NOT NULL,
  card INTEGER NOT NULL, batch TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS episode_summaries (
  channel TEXT NOT NULL, from_card INTEGER NOT NULL, to_card INTEGER NOT NULL, text TEXT NOT NULL
);
`;

/** 逐条 DDL（驱动用 prepare().run() 执行，避免多语句 exec）。与 WORLD_DDL 内容一致。 */
export const WORLD_DDL_STATEMENTS: string[] = WORLD_DDL.split(';')
  .map((s) => s.trim())
  .filter((s) => s.length > 0)
  .map((s) => `${s};`);
