/** Display helpers shared by the tables, the detail modal and the dashboard. */

import type { PricingSnapshot, TokenCounts } from './types';

const numberFormat = new Intl.NumberFormat('en-US');
const PER_MILLION = 1_000_000;

/** Mirrors AMANAI_IDR_PER_CREDIT in server/src/services/amanaiCredits.ts. */
export const AMANAI_IDR_PER_CREDIT = 150_000 / 1_000_000_000;

export const formatTokens = (value: number): string => numberFormat.format(value);

/**
 * Costs here are routinely fractions of a cent, so a plain 2-decimal currency
 * format would render most rows as "$0.00". Show enough places to stay useful,
 * and fall back to a dash rather than "$0" when there is genuinely no price.
 */
export function formatCost(value: number | null, currency = 'USD'): string {
  if (value === null) return '—';
  const digits = value !== 0 && Math.abs(value) < 0.01 ? 6 : 2;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export const formatRate = (perMTok: number, currency = 'USD'): string =>
  `${new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(perMTok)}/MTok`;

/** Long prompts get an ellipsis in the table; the modal shows the whole thing. */
export function truncate(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export interface CostLine {
  key: 'input' | 'cache_read' | 'cache_write' | 'output';
  label: string;
  tokens: number;
  ratePerMTok: number;
  cost: number;
}

export interface CostBreakdown {
  lines: CostLine[];
  total: number;
  currency: string;
}

/** One component: tokens × $/MTok ÷ 1,000,000, matching the server's 10 dp. */
export function lineCost(tokens: number, ratePerMTok: number): number {
  return Number(((tokens * ratePerMTok) / PER_MILLION).toFixed(10));
}

/**
 * Per-component cost for the log detail popup. `tokens.total` is the sum of the
 * four lines and is not priced on its own — pricing it would double-count.
 */
export function costBreakdown(tokens: TokenCounts, snapshot: PricingSnapshot): CostBreakdown {
  const lines: CostLine[] = [
    {
      key: 'input',
      label: 'Input',
      tokens: tokens.input,
      ratePerMTok: snapshot.inputPerMTok,
      cost: lineCost(tokens.input, snapshot.inputPerMTok),
    },
    {
      key: 'cache_read',
      label: 'Cache read',
      tokens: tokens.cache_read,
      ratePerMTok: snapshot.cacheReadPerMTok,
      cost: lineCost(tokens.cache_read, snapshot.cacheReadPerMTok),
    },
    {
      key: 'cache_write',
      label: 'Cache write',
      tokens: tokens.cache_write,
      ratePerMTok: snapshot.cacheWritePerMTok,
      cost: lineCost(tokens.cache_write, snapshot.cacheWritePerMTok),
    },
    {
      key: 'output',
      label: 'Output',
      tokens: tokens.output,
      ratePerMTok: snapshot.outputPerMTok,
      cost: lineCost(tokens.output, snapshot.outputPerMTok),
    },
  ];
  const raw =
    (tokens.input * snapshot.inputPerMTok +
      tokens.cache_read * snapshot.cacheReadPerMTok +
      tokens.cache_write * snapshot.cacheWritePerMTok +
      tokens.output * snapshot.outputPerMTok) /
    PER_MILLION;
  return {
    lines,
    total: Number(raw.toFixed(10)),
    currency: snapshot.currency,
  };
}
