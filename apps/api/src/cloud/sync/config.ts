/**
 * 增量同步开关。与对象/导入一致：默认不挂载，能力发现如实报 false。
 *
 * 同步要求已导入的工作区（事件身份由导入激活时分配），因此必须同时启用导入；
 * 否则会出现「有事件流入口但没有任何工作区」的假可用状态。
 */
export function loadCloudSyncConfig(env: NodeJS.ProcessEnv, importsEnabled: boolean) {
  const enabled = env.ENDLESS_CLOUD_SYNC_ENABLED;
  if (enabled === undefined || enabled === '0') return undefined;
  if (enabled !== '1') throw new Error('ENDLESS_CLOUD_SYNC_ENABLED 必须为 0 或 1');
  if (!importsEnabled) throw new Error('增量同步要求显式启用存档导入');
  return { enabled: true } as const;
}
