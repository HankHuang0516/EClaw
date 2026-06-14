import React, { useEffect, useRef } from 'react';
import { View, StyleSheet, TouchableOpacity, Animated, Easing } from 'react-native';
import { Card, Text, Avatar, IconButton, useTheme } from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import { Entity } from '../store/entityStore';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { CHARACTER_COLORS, STATUS_COLORS } from '../constants/colors';

interface EntityCardProps {
  entity: Entity;
  editMode?: boolean;
  onLongPress?: () => void;
  onAvatarPress?: () => void;
  onNamePress?: () => void;
  onRemovePress?: () => void;
}

const CHARACTER_ICONS: Record<string, string> = {
  LOBSTER: '🦞',
  PIG: '🐷',
};

const STATE_COLORS: Record<string, string> = {
  online: '#4CAF50',
  IDLE: '#4CAF50',
  idle: '#4CAF50',
  BUSY: '#FFC107',
  busy: '#FFC107',
  ERROR: '#F44336',
  error: '#F44336',
  offline: '#9E9E9E',
};

function formatTime(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function getStateLabel(state: string): string {
  const s = state?.toUpperCase() || 'OFFLINE';
  if (s === 'ONLINE') return 'IDLE';
  return s;
}

export default function EntityCard({ entity, editMode, onLongPress, onAvatarPress, onNamePress, onRemovePress }: EntityCardProps) {
  const { t } = useTranslation();
  const theme = useTheme();

  const stateLabel = getStateLabel(entity.state);
  const stateColor = STATE_COLORS[entity.state] || STATE_COLORS[stateLabel.toLowerCase()] || '#9E9E9E';
  const displayName = entity.name || `${entity.character || 'Entity'} #${entity.entityId}`;

  const xp = entity.xp ?? 0;
  const level = entity.level ?? 0;
  const xpNext = entity.xpForNextLevel ?? 100;
  const xpProgress = xpNext > 0 ? Math.min(xp / xpNext, 1) : 0;

  // Health-checking: breathing avatar pulse + 健檢中 label while the backend
  // passive health-check/repair runs (parity with the Web avatar ring).
  const healthChecking = !!entity.healthChecking;
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!healthChecking) {
      pulse.stopAnimation();
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 0.45,
          duration: 750,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 1,
          duration: 750,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [healthChecking, pulse]);

  return (
    <Card
      style={[styles.card, { backgroundColor: theme.colors.surfaceVariant }]}
      onLongPress={onLongPress}
    >
      <Card.Content style={styles.content}>
        {/* Avatar — tap to change */}
        <TouchableOpacity
          onPress={onAvatarPress}
          onLongPress={onLongPress}
          delayLongPress={500}
          activeOpacity={0.7}
        >
          <Animated.View
            style={[
              styles.avatarContainer,
              healthChecking && styles.avatarHealthRing,
              healthChecking && { opacity: pulse },
            ]}
          >
            {entity.avatarUrl ? (
              <Avatar.Image size={48} source={{ uri: entity.avatarUrl }} />
            ) : (
              <Avatar.Text
                size={48}
                label={CHARACTER_ICONS[entity.character] || '🦞'}
                style={{ backgroundColor: CHARACTER_COLORS[entity.character] || '#7C3AED' }}
              />
            )}
          </Animated.View>
        </TouchableOpacity>

        {/* Info section */}
        <View style={styles.info}>
          {/* Row 1: Name + ID + State badge */}
          <View style={styles.headerRow}>
            <TouchableOpacity
              onPress={onNamePress}
              onLongPress={onLongPress}
              delayLongPress={500}
              activeOpacity={0.7}
              style={styles.nameContainer}
            >
              <Text variant="titleMedium" numberOfLines={1} style={styles.name}>
                {entity.name || entity.character || 'Entity'}
              </Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                #{entity.entityIndex}
              </Text>
            </TouchableOpacity>
            <View style={[styles.stateBadge, { backgroundColor: stateColor + '22', borderColor: stateColor }]}>
              <Text style={[styles.stateText, { color: stateColor }]}>{stateLabel}</Text>
            </View>
            {editMode && onRemovePress ? (
              <IconButton
                icon="close-circle"
                size={20}
                iconColor="#F44336"
                onPress={onRemovePress}
                style={styles.removeBtn}
              />
            ) : null}
          </View>

          {/* Badges row: Channel + E2EE + Health-checking */}
          {(entity.channelBound || entity.encryptionStatus === 'e2ee' || healthChecking) && (
            <View style={styles.badgeRow}>
              {entity.channelBound && (
                <View style={[styles.badge, { backgroundColor: '#4CAF5022' }]}>
                  <Text style={[styles.badgeText, { color: '#4CAF50' }]}>⚡ Channel</Text>
                </View>
              )}
              {entity.encryptionStatus === 'e2ee' && (
                <View style={[styles.badge, { backgroundColor: '#60A5FA22' }]}>
                  <Text style={[styles.badgeText, { color: '#60A5FA' }]}>🔒 E2EE</Text>
                </View>
              )}
              {healthChecking && (
                <Animated.View style={[styles.badge, { backgroundColor: '#22D3EE22', opacity: pulse }]}>
                  <Text style={[styles.badgeText, { color: '#22D3EE' }]}>
                    {t('home.health_checking', 'Health-checking')}
                  </Text>
                </Animated.View>
              )}
            </View>
          )}

          {/* XP / Level bar */}
          {level > 0 && (
            <View style={styles.xpRow}>
              <Text style={styles.levelText}>Lv.{level}</Text>
              <View style={styles.xpBarBg}>
                <View style={[styles.xpBarFill, { width: `${xpProgress * 100}%` }]} />
              </View>
              <Text style={[styles.xpText, { color: theme.colors.onSurfaceVariant }]}>
                {xp}/{xpNext} XP
              </Text>
            </View>
          )}

          {/* Last message bubble */}
          {entity.message ? (
            <View style={styles.messageBubble}>
              <Text
                variant="bodySmall"
                numberOfLines={3}
                style={styles.messageText}
              >
                {entity.message}
              </Text>
              {entity.messageTime ? (
                <Text style={styles.messageTime}>{formatTime(entity.messageTime)}</Text>
              ) : null}
            </View>
          ) : null}
        </View>
      </Card.Content>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 16,
    marginVertical: 6,
    borderRadius: 16,
    elevation: 4,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 12,
  },
  avatarContainer: {
    marginTop: 2,
  },
  avatarHealthRing: {
    borderRadius: 28,
    borderWidth: 2,
    borderColor: '#22D3EE',
    padding: 2,
  },
  info: {
    flex: 1,
    gap: 6,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  nameContainer: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 6,
  },
  name: {
    fontWeight: '700',
    flexShrink: 1,
  },
  stateBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    borderWidth: 1,
  },
  stateText: {
    fontSize: 11,
    fontWeight: '600',
  },
  removeBtn: {
    margin: 0,
    marginLeft: -4,
  },
  badgeRow: {
    flexDirection: 'row',
    gap: 6,
  },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 8,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '600',
  },
  xpRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  levelText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#FFC107',
  },
  xpBarBg: {
    flex: 1,
    height: 6,
    backgroundColor: '#333',
    borderRadius: 3,
    overflow: 'hidden',
  },
  xpBarFill: {
    height: '100%',
    backgroundColor: '#FFC107',
    borderRadius: 3,
  },
  xpText: {
    fontSize: 10,
  },
  messageBubble: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 10,
    padding: 10,
    marginTop: 2,
  },
  messageText: {
    color: '#E0E0E0',
    fontSize: 13,
  },
  messageTime: {
    fontSize: 10,
    color: '#999',
    textAlign: 'right',
    marginTop: 4,
  },
});
