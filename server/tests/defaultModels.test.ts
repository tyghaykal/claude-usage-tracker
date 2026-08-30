import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_IDS,
  DEFAULT_MODEL_RATES,
  seedDefaultModels,
  seedRatesFor,
  stripAmanaiPrefix,
} from '../src/defaultModels.js';
import { ModelPricing } from '../src/models.js';
import { hasPricedRates } from '../src/pricing.js';
import { makePricing, makeUserAndLogin, buildApp } from './helpers.js';
import request from 'supertest';

const { app } = buildApp();

describe('stripAmanaiPrefix', () => {
  it('drops a leading amanai/ prefix', () => {
    expect(stripAmanaiPrefix('amanai/claude-sonnet-5')).toBe('claude-sonnet-5');
  });

  it('leaves an unprefixed id alone', () => {
    expect(stripAmanaiPrefix('claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(stripAmanaiPrefix('9r/claude-sonnet-5')).toBe('9r/claude-sonnet-5');
  });
});

describe('DEFAULT_MODEL_IDS', () => {
  it('is the Amanai chat catalog with the vendor prefix removed', () => {
    expect(DEFAULT_MODEL_IDS).toContain('claude-sonnet-5');
    expect(DEFAULT_MODEL_IDS).toContain('grok-4.6');
    expect(DEFAULT_MODEL_IDS).toContain('gpt-5.4-mini');
    expect(DEFAULT_MODEL_IDS.every((id) => !id.startsWith('amanai/'))).toBe(true);
    expect(new Set(DEFAULT_MODEL_IDS).size).toBe(DEFAULT_MODEL_IDS.length);
    expect(DEFAULT_MODEL_IDS).toHaveLength(38);
    expect(DEFAULT_MODEL_IDS).not.toContain('glm-5.0');
    expect(DEFAULT_MODEL_IDS).not.toContain('glm-5.0-turbo');
  });
});

describe('DEFAULT_MODEL_RATES', () => {
  it('prices every catalog id, in USD per million tokens', () => {
    const rateIds = Object.keys(DEFAULT_MODEL_RATES);
    expect(rateIds.sort()).toEqual([...DEFAULT_MODEL_IDS].sort());
    expect(Object.values(DEFAULT_MODEL_RATES).every(hasPricedRates)).toBe(true);
    expect(DEFAULT_MODEL_RATES['claude-sonnet-5']).toEqual({
      inputPerMTok: 2,
      cacheWritePerMTok: 2.5,
      cacheReadPerMTok: 0.2,
      outputPerMTok: 10,
    });
  });
});

describe('seedRatesFor', () => {
  it('returns the OpenRouter rates for a listed id', () => {
    expect(seedRatesFor('claude-sonnet-5')).toEqual(DEFAULT_MODEL_RATES['claude-sonnet-5']);
  });

  it('returns zeros for an id that is not in the catalog', () => {
    expect(seedRatesFor('not-a-catalog-id')).toEqual({
      inputPerMTok: 0,
      cacheWritePerMTok: 0,
      cacheReadPerMTok: 0,
      outputPerMTok: 0,
    });
  });
});

describe('seedDefaultModels', () => {
  it('inserts every catalog id with OpenRouter rates when the collection is empty', async () => {
    const { inserted, updated } = await seedDefaultModels();
    expect(inserted).toBe(DEFAULT_MODEL_IDS.length);
    expect(updated).toBe(0);
    expect(await ModelPricing.countDocuments()).toBe(DEFAULT_MODEL_IDS.length);

    const sonnet = await ModelPricing.findOne({ modelId: 'claude-sonnet-5' }).exec();
    expect(sonnet).toMatchObject({
      ...DEFAULT_MODEL_RATES['claude-sonnet-5'],
      currency: 'USD',
      source: 'manual',
      updatedBy: null,
    });
    expect(hasPricedRates(sonnet)).toBe(true);
  });

  it('does not overwrite an existing priced row, and only inserts the missing ids', async () => {
    await makePricing('claude-sonnet-5');
    const { inserted, updated } = await seedDefaultModels();
    expect(inserted).toBe(DEFAULT_MODEL_IDS.length - 1);
    expect(updated).toBe(0);

    const sonnet = await ModelPricing.findOne({ modelId: 'claude-sonnet-5' }).exec();
    expect(sonnet!.inputPerMTok).toBe(3);
    expect(sonnet!.outputPerMTok).toBe(15);
    expect(await ModelPricing.countDocuments()).toBe(DEFAULT_MODEL_IDS.length);
  });

  it('fills an leftover all-zero catalog row with OpenRouter rates', async () => {
    await makePricing('claude-sonnet-5', {
      inputPerMTok: 0,
      cacheWritePerMTok: 0,
      cacheReadPerMTok: 0,
      outputPerMTok: 0,
    });
    const { inserted, updated } = await seedDefaultModels();
    expect(inserted).toBe(DEFAULT_MODEL_IDS.length - 1);
    expect(updated).toBe(1);

    const sonnet = await ModelPricing.findOne({ modelId: 'claude-sonnet-5' }).exec();
    expect(sonnet).toMatchObject(DEFAULT_MODEL_RATES['claude-sonnet-5']);
  });

  it('is a no-op when every catalog id is already present and priced', async () => {
    await seedDefaultModels();
    const { inserted, updated } = await seedDefaultModels();
    expect(inserted).toBe(0);
    expect(updated).toBe(0);
    expect(await ModelPricing.countDocuments()).toBe(DEFAULT_MODEL_IDS.length);
  });
});

describe('GET /api/models catalog', () => {
  it('returns the unprefixed default ids even before any row is saved', async () => {
    const { auth } = await makeUserAndLogin(app);
    const list = await request(app).get('/api/models').set('Authorization', auth);
    expect(list.status).toBe(200);
    expect(list.body.models).toEqual([]);
    expect(list.body.catalog).toEqual([...DEFAULT_MODEL_IDS]);
    expect(list.body.catalog).not.toContain('amanai/claude-sonnet-5');
  });
});
