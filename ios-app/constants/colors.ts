/**
 * Centralized color constants for the EClaw iOS app.
 * Matches Android colors.xml and Web CSS variables.
 */

// Entity character avatar colors (synced across Web/Android/iOS)
export const CHARACTER_COLORS: Record<string, string> = {
  LOBSTER: '#FF6B6B',
  PIG: '#FFB6C1',
};

// Status indicator colors
export const STATUS_COLORS = {
  online: '#4CAF50',
  offline: '#9E9E9E',
  success: '#4CAF50',
  warning: '#FFD23F',
  danger: '#F44336',
  info: '#6C63FF',
};

// Subscription tier colors
export const TIER_COLORS = {
  free: '#4CAF50',
  paid: '#FFD700',
};
