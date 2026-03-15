import React from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { Card, Text, Chip, Avatar, useTheme } from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'expo-router';
import { Entity } from '../store/entityStore';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { CHARACTER_COLORS, STATUS_COLORS } from '../constants/colors';

interface EntityCardProps {
  entity: Entity;
  onLongPress?: () => void;
}

const CHARACTER_ICONS = {
  LOBSTER: '🦞',
  PIG: '🐷',
};

export default function EntityCard({ entity, onLongPress }: EntityCardProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();

  const isOnline = entity.state === 'online' || entity.isBound;
  const statusColor = isOnline ? STATUS_COLORS.online : theme.colors.onSurfaceVariant;

  const handlePress = () => {
    router.push(`/chat/${entity.entityId}`);
  };

  return (
    <Card
      style={[styles.card, { backgroundColor: theme.colors.surfaceVariant }]}
      onPress={handlePress}
      onLongPress={onLongPress}
    >
      <Card.Content style={styles.content}>
        {/* Avatar */}
        <View style={styles.avatarContainer}>
          {entity.avatarUrl ? (
            <Avatar.Image size={56} source={{ uri: entity.avatarUrl }} />
          ) : (
            <Avatar.Text
              size={56}
              label={CHARACTER_ICONS[entity.character]}
              style={{ backgroundColor: CHARACTER_COLORS[entity.character] }}
            />
          )}
          {/* Online indicator */}
          <View style={[styles.onlineIndicator, { backgroundColor: statusColor }]} />
        </View>

        {/* Info */}
        <View style={styles.info}>
          <Text variant="titleMedium" numberOfLines={1}>
            {entity.name}
          </Text>
          <Text
            variant="bodySmall"
            style={{ color: theme.colors.onSurfaceVariant }}
            numberOfLines={1}
          >
            {entity.message || t(`home.entity_${isOnline ? 'online' : 'offline'}`)}
          </Text>
          <View style={styles.chips}>
            <Chip
              compact
              icon={() => (
                <MaterialCommunityIcons
                  name="circle"
                  size={8}
                  color={statusColor}
                />
              )}
              style={styles.statusChip}
            >
              {t(`home.entity_${isOnline ? 'online' : 'offline'}`)}
            </Chip>
            <Chip compact style={styles.charChip}>
              {t(`entity.character_${entity.character.toLowerCase()}`)}
            </Chip>
          </View>
        </View>

        {/* Chat arrow */}
        <MaterialCommunityIcons
          name="chevron-right"
          size={24}
          color={theme.colors.onSurfaceVariant}
        />
      </Card.Content>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 16,
    marginVertical: 6,
    borderRadius: 16,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
  },
  avatarContainer: {
    position: 'relative',
  },
  onlineIndicator: {
    position: 'absolute',
    bottom: 2,
    right: 2,
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: 'white',
  },
  info: {
    flex: 1,
    gap: 4,
  },
  chips: {
    flexDirection: 'row',
    gap: 6,
    flexWrap: 'wrap',
  },
  statusChip: {
    height: 24,
  },
  charChip: {
    height: 24,
  },
});
