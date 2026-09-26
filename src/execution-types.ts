import type { Provider, WorkerResult } from './adapters.js';

export interface RepairDecision {
  action: 'repair' | 'stop';
  reason: string;
  tasks: { owner: Provider; instructions: string }[];
}
export interface WorkerCheckpoint {
  directoryName: string;
  inputHash: string;
  contractHash: string;
  routeKey: string;
  treeHash: string;
  result: WorkerResult;
}
export interface ExecutionCycle {
  round: number;
  inputHash: string;
  owners: Provider[];
  feedback: RepairDecision | null;
  checkpoints: Partial<Record<Provider, WorkerCheckpoint>>;
  integration?: { sourceHash: string };
}
export interface ExecutionState {
  schemaVersion: 1;
  phase: 'workers' | 'check' | 'review' | 'triage' | 'complete';
  maxRepairRounds: number;
  reusedWorkers: number;
  cycle: ExecutionCycle;
  history: { round: number; sourceHash: string | null; checks: Record<string, unknown>[]; review: Record<string, unknown> | null; decision: RepairDecision }[];
}
