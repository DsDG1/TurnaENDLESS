import { parseWorkspace, type Workspace, type WorkspaceIdentity } from '@endless/content';
export type MetaRow = {
  key: string;
  identity: WorkspaceIdentity;
  profile: unknown;
  entries: unknown;
  obligations: unknown;
  activeBranchId: unknown;
  management?: unknown[];
};
export function workspaceRows(workspace: Workspace) {
  return {
    meta: { key: 'workspace', identity: workspace.identity, profile: workspace.profile, entries: workspace.entries, obligations: workspace.obligations, activeBranchId: workspace.activeBranchId },
    revisions: workspace.revisions,
    branches: workspace.branches,
    objects: [
      ...workspace.volumes.map((v) => ({ kind: 'volume', ...v })),
      ...workspace.checkpoints.map((c) => ({ kind: 'checkpoint', ...c })),
      ...workspace.tickets.map((t) => ({ kind: 'ticket', ...t })),
    ],
    management: workspace.management,
  };
}
export type WorkspaceRows = ReturnType<typeof workspaceRows>;
export function assembleWorkspace(meta: any, revisions: any[], branches: any[], objects: any[], management: any[]): Workspace {
  const workspace: Workspace = {
    identity: meta.identity,
    profile: meta.profile,
    entries: meta.entries,
    obligations: meta.obligations,
    activeBranchId: meta.activeBranchId,
    revisions,
    branches,
    volumes: objects.filter((o) => o.kind === 'volume'),
    checkpoints: objects.filter((o) => o.kind === 'checkpoint'),
    tickets: objects.filter((o) => o.kind === 'ticket'),
    management,
  };
  // 走完整契约校验：结构合法但引用闭包坏掉的存档不能进界面（否则渲染期才炸）
  return parseWorkspace(workspace);
}
