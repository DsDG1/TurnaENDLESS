import { z } from 'zod';
import type { Querier } from './db/client.js';

export const CloudEnvironmentSchema = z.enum(['development', 'test', 'staging', 'production']);
export type CloudEnvironment = z.infer<typeof CloudEnvironmentSchema>;
export interface CloudDeployment {
  id: string;
  environment: CloudEnvironment;
}

export async function bindCloudDeployment(q: Querier, environment: CloudEnvironment): Promise<CloudDeployment> {
  await q.query(
    'INSERT INTO cloud_deployment (environment) VALUES ($1) ON CONFLICT (singleton) DO NOTHING',
    [environment],
  );
  return assertCloudDeployment(q, environment);
}

export async function assertCloudDeployment(q: Querier, environment: CloudEnvironment): Promise<CloudDeployment> {
  const result = await q.query<CloudDeployment>('SELECT id, environment FROM cloud_deployment WHERE singleton = true');
  const deployment = result.rows[0];
  if (!deployment || deployment.environment !== environment) {
    throw new Error('云数据库环境绑定不匹配或缺失；必须使用该环境独立的数据库并执行受控迁移');
  }
  return deployment;
}

export function accountContext(deployment: CloudDeployment, accountId: string) {
  return {
    deploymentId: deployment.id,
    environment: deployment.environment,
    localNamespace: `endless-cloud:${deployment.id}:${accountId}`,
  };
}
