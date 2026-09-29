import { afterEach, describe, expect, it } from 'vitest';

import { messages as enMessages } from '../src/i18n/en.js';
import {
  DEFAULT_LOCALE,
  botLocale,
  getDefaultLocale,
  localeForBot,
  setBotLookup,
  setDefaultLocale,
  shippedText,
  t,
} from '../src/i18n/index.js';
import { messages as zhMessages } from '../src/i18n/zh.js';
import { resolveSessionTagName } from '../src/services/feed-group-tagger.js';

describe('Workbench locale policy', () => {
  afterEach(() => {
    setBotLookup(undefined);
    setDefaultLocale(DEFAULT_LOCALE);
  });

  it('defaults fresh installs to English and preserves an explicit saved global locale', () => {
    setDefaultLocale(DEFAULT_LOCALE);
    expect(DEFAULT_LOCALE).toBe('en');
    expect(getDefaultLocale()).toBe('en');
    expect(botLocale(undefined)).toBe('en');
    expect(resolveSessionTagName({ botDisplayName: 'Workbench' })).toBe('Workbench chats');

    setDefaultLocale('zh');
    expect(getDefaultLocale()).toBe('zh');
    expect(botLocale(undefined)).toBe('zh');
  });

  it('resolves two bots independently before falling back to the saved global locale', () => {
    setDefaultLocale('zh');
    setBotLookup((appId) => ({
      config: appId === 'workbench-en' ? { lang: 'en' } : { lang: 'zh' },
    }));

    expect(localeForBot('workbench-en')).toBe('en');
    expect(localeForBot('legacy-zh')).toBe('zh');
    expect(t('workflow.v3.status.succeeded', undefined, localeForBot('workbench-en'))).toBe('Completed');
    expect(t('workflow.v3.status.succeeded', undefined, localeForBot('legacy-zh'))).toBe('已完成');
  });

  it('keeps every shipped product key present in both locales', () => {
    expect(Object.keys(enMessages).sort()).toEqual(Object.keys(zhMessages).sort());
    for (const [key, value] of Object.entries(enMessages)) {
      expect(value, `Chinese text leaked into English translation: ${key}`)
        .not.toMatch(/[\u3400-\u9fff]/u);
    }
    for (const key of Object.keys(enMessages).filter((key) => key.startsWith('workflow.v3.'))) {
      expect(enMessages[key], `empty English workflow translation: ${key}`).not.toBe('');
    }
  });

  it('makes a truly missing key loud instead of rendering an empty label', () => {
    expect(t('workbench.translation.does_not_exist', undefined, 'en'))
      .toBe('workbench.translation.does_not_exist');
    expect(shippedText('workbench.translation.does_not_exist', 'zh'))
      .toBe('workbench.translation.does_not_exist');
  });

  it('states the requested response-language policy without forbidding explicit language changes', () => {
    const policy = enMessages['ai.response.english_only'];
    expect(policy).toBe(
      'Respond in English by default. Use another language when the user explicitly requests it. '
      + 'Preserve quotations, code, identifiers and requested translations.',
    );
    expect(policy).not.toContain('every response must be English');
  });
});
