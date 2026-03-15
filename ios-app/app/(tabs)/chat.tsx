import React from 'react';
import { View, FlatList, StyleSheet, TouchableOpacity } from 'react-native';
import { Text, Avatar, Badge, useTheme, Divider } from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useEntityStore } from '../../store/entityStore';
import { useChatStore } from '../../store/chatStore';
import { useEntities } from '../../hooks/useEntities';
import { CHARACTER_COLORS, STATUS_COLORS } from '../../constants/colors';

export default function ChatListScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();
  const { entities } = useEntityStore();
  const { unreadCounts } = useChatStore();
  useEntities(); // Keep entity list updated

  const CHARACTER_ICONS = { LOBSTER: '🦞', PIG: '🐷' };

  const handleEntityPress = (entityId: string) => {
    router.push(`/chat/${entityId}`);
  };

  if (entities.length === 0) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <View style={styles.empty}>
          <Text variant="headlineSmall">💬</Text>
          <Text variant="titleMedium">{t('home.no_entities')}</Text>
          <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
            {t('home.no_entities_desc')}
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]} edges={['bottom']}>
      <FlatList
        data={entities}
        keyExtractor={(item) => item.entityId}
        ItemSeparatorComponent={() => <Divider />}
        renderItem={({ item }) => {
          const unread = unreadCounts[item.entityId] ?? 0;
          return (
            <TouchableOpacity
              style={styles.row}
              onPress={() => handleEntityPress(item.entityId)}
              activeOpacity={0.7}
            >
              {/* Avatar */}
              <View style={styles.avatarWrapper}>
                {item.avatarUrl ? (
                  <Avatar.Image size={50} source={{ uri: item.avatarUrl }} />
                ) : (
                  <Avatar.Text
                    size={50}
                    label={CHARACTER_ICONS[item.character]}
                    style={{ backgroundColor: CHARACTER_COLORS[item.character] }}
                  />
                )}
                {unread > 0 && (
                  <Badge style={styles.badge}>{unread > 99 ? '99+' : unread}</Badge>
                )}
              </View>

              {/* Info */}
              <View style={styles.info}>
                <Text variant="titleMedium">{item.name}</Text>
                <Text
                  variant="bodySmall"
                  numberOfLines={1}
                  style={{ color: theme.colors.onSurfaceVariant }}
                >
                  {item.message || (item.isBound ? t('home.entity_online') : t('home.entity_offline'))}
                </Text>
              </View>

              {/* Online dot */}
              <View
                style={[
                  styles.onlineDot,
                  { backgroundColor: item.isBound ? STATUS_COLORS.online : theme.colors.outline },
                ]}
              />
            </TouchableOpacity>
          );
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  empty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
    padding: 32,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    gap: 12,
  },
  avatarWrapper: {
    position: 'relative',
  },
  badge: {
    position: 'absolute',
    top: -4,
    right: -4,
  },
  info: {
    flex: 1,
    gap: 2,
  },
  onlineDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
});
