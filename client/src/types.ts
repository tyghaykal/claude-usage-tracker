export type Role = 'admin' | 'user';
export type PricingSource = 'manual' | 'ai';

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  createdAt: string;
}

/** What `/me/directory` returns — every signed-in user can see this much. */
export interface UserDirectoryEntry {
  id: string;
  name: string;
}

export interface ApiTokenView {
  id: string;
  label: string;
  tokenPrefix: string;
  revoked: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface TokenCounts {
  input: number;
  cache_read: number;
  cache_write: number;
  output: number;
  total: number;
}

export interface PricingSnapshot {
  modelPricingId: string | null;
  inputPerMTok: number;
  cacheWritePerMTok: number;
  cacheReadPerMTok: number;
  outputPerMTok: number;
  currency: string;
}

export interface UsageLogRow {
  id: string;
  userId: string;
  project: string;
  projectLabel: string | null;
  promptDatetime: string;
  model: string | null;
  tokens: TokenCounts;
  estimatedCostUsd: number | null;
  currency: string | null;
  pricingOutdated: boolean;
}

export interface UsageLogDetail extends UsageLogRow {
  apiTokenId: string;
  prompt: string;
  sessionId: string;
  userLabel: string | null;
  receivedAt: string;
  pricingSnapshot: PricingSnapshot | null;
  recalculatedAt: string | null;
  rawPayload: Record<string, unknown> | null;
}

export interface ModelPricingView {
  id: string;
  modelId: string;
  inputPerMTok: number;
  cacheWritePerMTok: number;
  cacheReadPerMTok: number;
  outputPerMTok: number;
  currency: string;
  source: PricingSource;
  updatedBy: string | null;
  updatedAt: string;
}

export interface ModelsListResponse {
  models: ModelPricingView[];
  catalog: string[];
}

export interface AiProviderView {
  id: string;
  label: string;
  baseUrl: string;
  modelName: string;
  hasKey: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Result of the connectivity probe run on save, or on demand. */
export interface ProviderTestResult {
  ok: boolean;
  status: number | null;
  latencyMs: number;
  message: string;
}

export interface SuggestedPricing {
  inputPerMTok: number;
  cacheWritePerMTok: number;
  cacheReadPerMTok: number;
  outputPerMTok: number;
  currency: string;
  notes?: string;
}

export interface AiSearchResponse {
  modelId: string;
  providerId: string;
  suggested: SuggestedPricing;
  raw: string;
  fromCache: boolean;
  disclaimer: string;
}

export interface SummaryTotals {
  prompts: number;
  totalTokens: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface SummaryBucket extends SummaryTotals {
  key: string | null;
}

/** `label` is the project's most recently reported `usageProjectLabel`, if any. */
export interface ProjectSummaryBucket extends SummaryBucket {
  label: string | null;
}

export interface DashboardSummary {
  totals: SummaryTotals;
  byDay: SummaryBucket[];
  byModel: SummaryBucket[];
  byProject: ProjectSummaryBucket[];
  byUser: SummaryBucket[];
}

export interface ProjectRenameEntry {
  from: string;
  to: string;
  changedAt: string;
  changedBy: string | null;
}

export interface ProjectHistory {
  name: string;
  history: ProjectRenameEntry[];
}

export interface UsageFilter {
  project?: string;
  userId?: string;
  model?: string;
  dateFrom?: string;
  dateTo?: string;
}
