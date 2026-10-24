/**
 * 完整备份：导出可校验的 `.endless.json` 容器，导入先校验引用闭包再原子提交。
 * 只含非秘密业务数据——不含临时 provider Key、环境配置或登录凭据。
 */
import { z } from 'zod';
import { WorkspaceSnapshotSchema, assertWorkspace, type Workspace, type WorkspaceSnapshot } from './index.js';

export const BACKUP_FORMAT = 'endless-backup' as const;

export const BackupSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  version: z.literal(1),
  exportedAt: z.string().datetime(),
  manifest: z.object({
    workspaceId: z.string().min(1),
    profileId: z.string().min(1),
    repositoryRevision: z.number().int().nonnegative(),
    counts: z.object({
      entries: z.number().int().nonnegative(), revisions: z.number().int().nonnegative(),
      branches: z.number().int().nonnegative(), volumes: z.number().int().nonnegative(),
      checkpoints: z.number().int().nonnegative(), tickets: z.number().int().nonnegative(),
      management: z.number().int().nonnegative(),
    }),
  }),
  workspace: WorkspaceSnapshotSchema,
});
export type Backup = z.infer<typeof BackupSchema>;

export function buildBackup(workspace: Workspace): Backup {
  return {
    format: BACKUP_FORMAT, version: 1, exportedAt: new Date().toISOString(),
    manifest: {
      workspaceId: workspace.identity.workspaceId, profileId: workspace.identity.profileId,
      repositoryRevision: workspace.identity.repositoryRevision,
      counts: {
        entries: workspace.entries.length, revisions: workspace.revisions.length,
        branches: workspace.branches.length, volumes: workspace.volumes.length,
        checkpoints: workspace.checkpoints.length, tickets: workspace.tickets.length,
        management: workspace.management.length,
      },
    },
    workspace: { identity: workspace.identity, data: workspace },
  };
}

export interface ImportPreview {
  backup: Backup;
  conflicts: { existingWorkspaceId: boolean };
}

/** 校验导入文件：schema → 引用闭包 → 与现有档案的冲突预览。不兼容旧存档格式。 */
export function parseBackup(raw: unknown, existing?: Workspace | null): ImportPreview {
  const parsed = BackupSchema.safeParse(raw);
  if (!parsed.success) throw new Error('备份文件格式不支持，已有档案未修改');
  const backup = parsed.data;
  const snapshot = backup.workspace as WorkspaceSnapshot;
  const c = backup.manifest.counts;
  const d = snapshot.data;
  if (c.entries !== d.entries.length || c.revisions !== d.revisions.length ||
    c.branches !== d.branches.length || c.volumes !== d.volumes.length ||
    c.checkpoints !== d.checkpoints.length ||
    c.tickets !== d.tickets.length || c.management !== d.management.length) {
    throw new Error('备份清单与实际内容不一致，可能已被篡改，导入已取消');
  }
  // 清单、快照身份与快照数据必须指向同一个档案：任一不一致说明文件被拼接过
  if (backup.manifest.workspaceId !== snapshot.identity.workspaceId ||
    backup.manifest.profileId !== snapshot.identity.profileId ||
    backup.manifest.repositoryRevision !== snapshot.identity.repositoryRevision ||
    snapshot.identity.workspaceId !== d.identity.workspaceId ||
    snapshot.identity.profileId !== d.identity.profileId ||
    snapshot.identity.repositoryRevision !== d.identity.repositoryRevision) {
    throw new Error('备份清单与快照身份不一致，可能已被篡改，导入已取消');
  }
  assertWorkspace(d);
  return { backup, conflicts: { existingWorkspaceId: !!existing && existing.identity.workspaceId === d.identity.workspaceId } };
}
