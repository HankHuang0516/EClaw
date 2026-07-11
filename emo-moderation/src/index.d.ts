/**
 * Type declarations for @eclaw/emo-moderation. The module source is JS; this
 * file exists so consumer TS projects and this project's `npm run typecheck`
 * gate get a stable contract.
 */

export type ModerationAction = 'pass' | 'soft_flag' | 'hard_block' | 'crisis_referral';

export interface ModerationCategories {
  [category: string]: boolean;
}

export interface ModerationScores {
  [category: string]: number;
}

export interface ModerationResult {
  flagged?: boolean;
  categories: ModerationCategories;
  category_scores?: ModerationScores;
  model?: string;
}

export interface ScreenOptions {
  openaiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  moderationResult?: ModerationResult;
  locale?: string;
  redactExtraPatterns?: RegExp[];
}

export interface CrisisResponse {
  schema: 'emo-moderation.crisis-response/v1';
  action: 'crisis_referral';
  locale: string;
  region: string;
  title: string;
  body: string;
  hotline: {
    name: string;
    number: string | null;
    url?: string;
    hours: string;
    cost: string;
  };
  alternates: unknown[];
  disclaimer: string;
  wordCount: number;
  truncated?: boolean;
}

export interface ScreenResult {
  action: ModerationAction;
  reason: string;
  matchedCategories: string[];
  redactedText?: string;
  crisisResponse?: CrisisResponse;
  model?: string;
}

export interface AgeAssessment {
  minAge: 4 | 9 | 12 | 17;
  reasons: string[];
}

export function screen(text: string, options?: ScreenOptions): Promise<ScreenResult>;

export function buildCrisisResponse(text: string | undefined, locale?: string): CrisisResponse;

export function assessAgeAppropriateness(
  text: string,
  options?: { moderation?: ModerationResult }
): AgeAssessment;

export function mapCategoriesToAction(
  categories: ModerationCategories
): { action: ModerationAction; matched: string[] };

export function redactText(
  text: string,
  options?: { extraPatterns?: RegExp[]; token?: string }
): string;

export function callOpenAIModeration(
  text: string,
  options: {
    openaiKey: string;
    model?: string;
    endpoint?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  }
): Promise<ModerationResult & { model: string }>;
