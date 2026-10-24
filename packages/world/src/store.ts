/**
 * 存储接口与内存实现（第 5.5.1 节）。
 * 包本身不依赖任何 Node 专有 API：驱动通过此接口注入。
 * 内存实现用于单元测试与纯模拟（S 系列运行不需要持久化）；
 * 实验 CLI 用 node:sqlite 实现同一接口（apps/lab/src/storage/sqlite.ts）。
 */
import type {
  EntityRow,
  EpisodeSummaryRow,
  EventRow,
  FactRow,
  ThreadRow,
  UserFactRow,
} from './schema.js';

export interface WorldStore {
  upsertEntity(row: EntityRow): void;
  getEntity(id: string): EntityRow | undefined;
  listEntities(channel?: string): EntityRow[];
  entityExists(id: string): boolean;

  insertFact(row: Omit<FactRow, 'id'>): FactRow;
  endFact(id: number, atCard: number): void;
  getFact(id: number): FactRow | undefined;
  currentFacts(subjects?: string[]): FactRow[];
  /** 全部事实（含已结束，评审的事实表用） */
  allFacts(): FactRow[];
  /** 最近结束的单值事实（供台词用过去时提及「曾经是」） */
  endedFacts(subject: string, limit?: number): FactRow[];
  factsAbout(subject: string): FactRow[];

  insertEvent(row: Omit<EventRow, 'id'>): EventRow;
  recentEvents(opts?: { channel?: string; sinceCard?: number; limit?: number }): EventRow[];
  allEvents(): EventRow[];

  upsertThread(row: ThreadRow): void;
  getThread(id: string): ThreadRow | undefined;
  openThreads(): ThreadRow[];
  allThreads(): ThreadRow[];

  insertUserFact(row: Omit<UserFactRow, 'id'>): UserFactRow;
  userFacts(predicate?: string): UserFactRow[];

  insertSummary(row: EpisodeSummaryRow): void;
  latestSummary(channel: string): EpisodeSummaryRow | undefined;

  close?(): void;
}

/** 纯内存实现：行按插入序自增 ID，行为与 SQLite 驱动一致。 */
export class InMemoryWorldStore implements WorldStore {
  private entities = new Map<string, EntityRow>();
  private facts: FactRow[] = [];
  private events: EventRow[] = [];
  private threads = new Map<string, ThreadRow>();
  private userFactRows: UserFactRow[] = [];
  private summaries: EpisodeSummaryRow[] = [];
  private seq = 0;

  upsertEntity(row: EntityRow): void {
    this.entities.set(row.id, row);
  }
  getEntity(id: string): EntityRow | undefined {
    return this.entities.get(id);
  }
  listEntities(channel?: string): EntityRow[] {
    return [...this.entities.values()].filter((e) => !channel || e.home_channel === channel);
  }
  entityExists(id: string): boolean {
    return this.entities.has(id);
  }

  insertFact(row: Omit<FactRow, 'id'>): FactRow {
    const full: FactRow = { ...row, id: ++this.seq };
    this.facts.push(full);
    return full;
  }
  endFact(id: number, atCard: number): void {
    const f = this.facts.find((x) => x.id === id);
    if (f && f.valid_to_card === null) f.valid_to_card = atCard;
  }
  getFact(id: number): FactRow | undefined {
    return this.facts.find((x) => x.id === id);
  }
  currentFacts(subjects?: string[]): FactRow[] {
    return this.facts.filter((f) => f.valid_to_card === null && (!subjects || subjects.includes(f.subject)));
  }
  allFacts(): FactRow[] {
    return [...this.facts];
  }
  endedFacts(subject: string, limit = 2): FactRow[] {
    return this.facts
      .filter((f) => f.subject === subject && f.valid_to_card !== null)
      .sort((a, b) => (b.valid_to_card ?? 0) - (a.valid_to_card ?? 0))
      .slice(0, limit);
  }
  factsAbout(subject: string): FactRow[] {
    return this.facts.filter((f) => f.subject === subject);
  }

  insertEvent(row: Omit<EventRow, 'id'>): EventRow {
    const full: EventRow = { ...row, id: ++this.seq };
    this.events.push(full);
    return full;
  }
  recentEvents(opts?: { channel?: string; sinceCard?: number; limit?: number }): EventRow[] {
    const limit = opts?.limit ?? 20;
    return this.events
      .filter(
        (e) =>
          (!opts?.channel || e.channel === opts.channel) &&
          (opts?.sinceCard === undefined || e.card >= opts.sinceCard),
      )
      .sort((a, b) => b.card - a.card || b.id - a.id)
      .slice(0, limit);
  }
  allEvents(): EventRow[] {
    return [...this.events].sort((a, b) => a.card - b.card || a.id - b.id);
  }

  upsertThread(row: ThreadRow): void {
    this.threads.set(row.id, row);
  }
  getThread(id: string): ThreadRow | undefined {
    return this.threads.get(id);
  }
  openThreads(): ThreadRow[] {
    return [...this.threads.values()].filter((t) => t.status === 'open');
  }
  allThreads(): ThreadRow[] {
    return [...this.threads.values()];
  }

  insertUserFact(row: Omit<UserFactRow, 'id'>): UserFactRow {
    const full: UserFactRow = { ...row, id: ++this.seq };
    this.userFactRows.push(full);
    return full;
  }
  userFacts(predicate?: string): UserFactRow[] {
    return this.userFactRows.filter((u) => !predicate || u.predicate === predicate);
  }

  insertSummary(row: EpisodeSummaryRow): void {
    this.summaries.push(row);
  }
  latestSummary(channel: string): EpisodeSummaryRow | undefined {
    const rows = this.summaries.filter((s) => s.channel === channel);
    return rows.length ? rows[rows.length - 1] : undefined;
  }

  /** 检查点导出：完整状态（含共享自增 seq，行 id 跨表交错）。 */
  dumpState() {
    return {
      seq: this.seq, entities: [...this.entities.values()], facts: [...this.facts],
      events: [...this.events], threads: [...this.threads.values()],
      userFacts: [...this.userFactRows], summaries: [...this.summaries],
    };
  }

  /** 检查点恢复：整表替换并保持原行 id 与 seq。 */
  restoreState(state: ReturnType<InMemoryWorldStore['dumpState']>) {
    this.entities = new Map(state.entities.map((row) => [row.id, row]));
    this.facts = [...state.facts];
    this.events = [...state.events];
    this.threads = new Map(state.threads.map((row) => [row.id, row]));
    this.userFactRows = [...state.userFacts];
    this.summaries = [...state.summaries];
    this.seq = state.seq;
  }
}
