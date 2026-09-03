import { Schema, model, type Document, type Model, type Types } from 'mongoose';

export type Role = 'admin' | 'user';
export type PricingSource = 'manual' | 'ai';

/* ------------------------------------------------------------------ User */

export interface UserDoc extends Document<Types.ObjectId> {
  name: string;
  email: string;
  passwordHash: string;
  role: Role;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<UserDoc>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, required: true, enum: ['admin', 'user'], default: 'user' },
  },
  { timestamps: true },
);

export const User: Model<UserDoc> = model<UserDoc>('User', userSchema);

/* -------------------------------------------------------------- ApiToken */

export interface ApiTokenDoc extends Document<Types.ObjectId> {
  userId: Types.ObjectId;
  label: string;
  tokenHash: string;
  tokenPrefix: string;
  revoked: boolean;
  /** Optional amanai API key for this token, AES-256-GCM encrypted. When set,
   *  requests made with this token attribute their exact amanai credit cost from
   *  the live usage log. Null = no amanai credit calculation for this token.
   *  Never serialised to any API response. */
  amanaiKeyEnc: string | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const apiTokenSchema = new Schema<ApiTokenDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    label: { type: String, default: '', trim: true },
    tokenHash: { type: String, required: true, unique: true },
    tokenPrefix: { type: String, required: true },
    revoked: { type: Boolean, default: false },
    amanaiKeyEnc: { type: String, default: null, select: false },
    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export const ApiToken: Model<ApiTokenDoc> = model<ApiTokenDoc>('ApiToken', apiTokenSchema);

/* ---------------------------------------------------------- ModelPricing */

export interface ModelPricingDoc extends Document<Types.ObjectId> {
  /** Opaque — `claude-sonnet-5`, `9r/claude-sonnet-5`, `amanai/combo-x`, … */
  modelId: string;
  inputPerMTok: number;
  cacheWritePerMTok: number;
  cacheReadPerMTok: number;
  outputPerMTok: number;
  currency: string;
  source: PricingSource;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const modelPricingSchema = new Schema<ModelPricingDoc>(
  {
    modelId: { type: String, required: true, unique: true, trim: true },
    inputPerMTok: { type: Number, required: true, min: 0 },
    cacheWritePerMTok: { type: Number, required: true, min: 0 },
    cacheReadPerMTok: { type: Number, required: true, min: 0 },
    outputPerMTok: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'USD', trim: true },
    source: { type: String, enum: ['manual', 'ai'], default: 'manual' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

export const ModelPricing: Model<ModelPricingDoc> = model<ModelPricingDoc>(
  'ModelPricing',
  modelPricingSchema,
);

/* -------------------------------------------------------------- UsageLog */

export interface TokenCounts {
  input: number;
  cache_read: number;
  cache_write: number;
  output: number;
  total: number;
}

/** The rates actually used for `estimatedCostUsd` — a copy, not a reference. */
export interface PricingSnapshot {
  modelPricingId: Types.ObjectId | null;
  inputPerMTok: number;
  cacheWritePerMTok: number;
  cacheReadPerMTok: number;
  outputPerMTok: number;
  currency: string;
}

export interface UsageLogDoc extends Document<Types.ObjectId> {
  userId: Types.ObjectId;
  apiTokenId: Types.ObjectId;
  project: string;
  /** The plugin's client-side `usageProjectLabel` override. Display only —
   *  renaming and filtering still operate on `project`. */
  projectLabel: string | null;
  promptDatetime: Date;
  receivedAt: Date;
  prompt: string;
  sessionId: string;
  /** The payload's `model`. Named `modelId` in storage because a schema path
   *  called `model` would shadow mongoose's own `Document.model()`. */
  modelId: string | null;
  /** The plugin's client-supplied `usageUser` label. Display only — never auth. */
  userLabel: string | null;
  /** The payload's `provider`: `claude-session`, or the scheme+host of a
   *  custom `ANTHROPIC_BASE_URL`. Null on logs ingested before this field
   *  existed, or admin-assignable afterwards (see routes/usageLogs.ts). */
  provider: string | null;
  tokens: TokenCounts;
  estimatedCostUsd: number | null;
  /** Exact amanai credit cost, attributed from the live usage log when an
   *  AMANAI_API_KEY is configured and a matching request is found. Null when
   *  no key is set, the model isn't amanai, or no usage-log match was found. */
  amanaiCredits: number | null;
  pricingSnapshot: PricingSnapshot | null;
  recalculatedAt: Date | null;
  /** The exact ingestion body, kept verbatim for debugging (FR-6 detail view). */
  rawPayload: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

const pricingSnapshotSchema = new Schema<PricingSnapshot>(
  {
    modelPricingId: { type: Schema.Types.ObjectId, ref: 'ModelPricing', default: null },
    inputPerMTok: { type: Number, required: true },
    cacheWritePerMTok: { type: Number, required: true },
    cacheReadPerMTok: { type: Number, required: true },
    outputPerMTok: { type: Number, required: true },
    currency: { type: String, required: true },
  },
  { _id: false },
);

const usageLogSchema = new Schema<UsageLogDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    apiTokenId: { type: Schema.Types.ObjectId, ref: 'ApiToken', required: true },
    project: { type: String, required: true, trim: true, index: true },
    projectLabel: { type: String, default: null, trim: true },
    promptDatetime: { type: Date, required: true, index: true },
    receivedAt: { type: Date, required: true },
    prompt: { type: String, default: '' },
    sessionId: { type: String, required: true },
    modelId: { type: String, default: null, index: true },
    userLabel: { type: String, default: null },
    provider: { type: String, default: null, trim: true, index: true },
    tokens: {
      input: { type: Number, required: true },
      cache_read: { type: Number, required: true },
      cache_write: { type: Number, required: true },
      output: { type: Number, required: true },
      total: { type: Number, required: true },
    },
    estimatedCostUsd: { type: Number, default: null },
    amanaiCredits: { type: Number, default: null },
    pricingSnapshot: { type: pricingSnapshotSchema, default: null },
    recalculatedAt: { type: Date, default: null },
    rawPayload: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

// The list view's default sort, and the dashboard's range scan.
usageLogSchema.index({ promptDatetime: -1 });

export const UsageLog: Model<UsageLogDoc> = model<UsageLogDoc>('UsageLog', usageLogSchema);

/* ------------------------------------------------------- AiProviderConfig */

export interface AiProviderConfigDoc extends Document<Types.ObjectId> {
  label: string;
  baseUrl: string;
  modelName: string;
  /** AES-256-GCM. Never serialised to any API response. */
  apiKeyEnc: string;
  createdBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const aiProviderConfigSchema = new Schema<AiProviderConfigDoc>(
  {
    label: { type: String, required: true, trim: true },
    baseUrl: { type: String, required: true, trim: true },
    modelName: { type: String, required: true, trim: true },
    apiKeyEnc: { type: String, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

export const AiProviderConfig: Model<AiProviderConfigDoc> = model<AiProviderConfigDoc>(
  'AiProviderConfig',
  aiProviderConfigSchema,
);

/* ------------------------------------------------------ ProviderPricingConfig */

/** Whether cost estimation is skipped for a `UsageLog.provider` value.
 *  Rows are created lazily — a provider with no doc here simply prices
 *  normally, same as a model with no `ModelPricing` row. */
export interface ProviderPricingConfigDoc extends Document<Types.ObjectId> {
  provider: string;
  pricingDisabled: boolean;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const providerPricingConfigSchema = new Schema<ProviderPricingConfigDoc>(
  {
    provider: { type: String, required: true, unique: true, trim: true },
    pricingDisabled: { type: Boolean, default: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

export const ProviderPricingConfig: Model<ProviderPricingConfigDoc> = model<ProviderPricingConfigDoc>(
  'ProviderPricingConfig',
  providerPricingConfigSchema,
);

/* ----------------------------------------------------------------- Project */

export interface ProjectRenameEntry {
  from: string;
  to: string;
  changedAt: Date;
  changedBy: Types.ObjectId | null;
}

/**
 * `UsageLog.project` remains the plain string it always was — this doc only
 * exists once a project is renamed at least once, keyed by its current name,
 * so the rename history survives the name changing out from under it.
 */
export interface ProjectDoc extends Document<Types.ObjectId> {
  name: string;
  history: ProjectRenameEntry[];
  createdAt: Date;
  updatedAt: Date;
}

const projectRenameSchema = new Schema<ProjectRenameEntry>(
  {
    from: { type: String, required: true },
    to: { type: String, required: true },
    changedAt: { type: Date, required: true },
    changedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { _id: false },
);

const projectSchema = new Schema<ProjectDoc>(
  {
    name: { type: String, required: true, unique: true, trim: true },
    history: { type: [projectRenameSchema], default: [] },
  },
  { timestamps: true },
);

export const Project: Model<ProjectDoc> = model<ProjectDoc>('Project', projectSchema);

/* ---------------------------------------------------------------- AuditLog */

export type AuditAction =
  | 'user.created'
  | 'user.deleted'
  | 'user.role_changed'
  | 'user.email_changed'
  | 'user.password_reset'
  | 'user.password_changed';

/** Snapshots actor/target name+email so an entry stays readable after either
 *  account is later deleted or renamed. */
export interface AuditLogDoc extends Document<Types.ObjectId> {
  action: AuditAction;
  actorId: Types.ObjectId | null;
  actorName: string;
  targetId: Types.ObjectId | null;
  targetName: string;
  targetEmail: string | null;
  meta: Record<string, unknown> | null;
  createdAt: Date;
}

const auditLogSchema = new Schema<AuditLogDoc>(
  {
    action: { type: String, required: true, index: true },
    actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    actorName: { type: String, required: true },
    targetId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    targetName: { type: String, required: true },
    targetEmail: { type: String, default: null },
    meta: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
auditLogSchema.index({ createdAt: -1 });

export const AuditLog: Model<AuditLogDoc> = model<AuditLogDoc>('AuditLog', auditLogSchema);
