import type { Locale } from '../i18n/types.js';

/**
 * Named, one-shot conversation presets applied while a bot is provisioned.
 *
 * The marker records provenance only. Runtime behavior comes from the
 * materialized BotConfig fields below, so editing a field later wins and a
 * future preset revision can never silently rewrite an existing bot.
 */
export type ConversationPreset = 'workbench';

export interface ConversationPresetValues {
  conversationPreset: ConversationPreset;
  lang: Locale;
  p2pMode: 'chat';
  regularGroupMentionMode: 'topic';
  replyDelivery: 'transcript';
  cotEnabled: false;
  disableStreamingCard: true;
  silentTurnReactions: false;
}

export const WORKBENCH_CONVERSATION_PRESET: Readonly<ConversationPresetValues> = Object.freeze({
  conversationPreset: 'workbench',
  lang: 'en',
  p2pMode: 'chat',
  regularGroupMentionMode: 'topic',
  replyDelivery: 'transcript',
  cotEnabled: false,
  disableStreamingCard: true,
  silentTurnReactions: false,
});

export function normalizeConversationPreset(value: unknown): ConversationPreset | undefined {
  return value === 'workbench' ? value : undefined;
}

export function conversationPresetValues(value: unknown): ConversationPresetValues | undefined {
  return normalizeConversationPreset(value) === 'workbench'
    ? { ...WORKBENCH_CONVERSATION_PRESET }
    : undefined;
}
