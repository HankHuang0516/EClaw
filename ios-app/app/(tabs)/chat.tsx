import React, { useState } from 'react';
import { View, FlatList, StyleSheet, TouchableOpacity } from 'react-native';
import { Text, Avatar, Badge, useTheme, Divider, Button, ActivityIndicator } from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useEntityStore } from '../../store/entityStore';
import { useAuthStore } from '../../store/authStore';
import { useChatStore } from '../../store/chatStore';
import { useEntities } from '../../hooks/useEntities';
import { deviceApi } from '../../services/api';
import { CHARACTER_COLORS, STATUS_COLORS } from '../../constants/colors';

export default function ChatListScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();
  const { entities, bindingCodes, setBindingCode } = useEntityStore();
  const { deviceId } = useAuthStore();
  const { unreadCounts } = useChatStore();
  useEntities(); // Keep entity list updated

  const [isGeneratingCode, setIsGeneratingCode] = useState(false);

  const CHARACTER_ICONS = { LOBSTER: '🦞', PIG: '🐷' };

  const handleEntityPress = (entityId: string) => {
    router.push(`/chat/${entityId}`);
  };

  const handleGenerateCode = async () => {
    // Find next empty slot
    for (let i = 0; i < 20; i++) {
      if (!entities.find((e) => e.entityIndex === i)) {
        if (!deviceId) return;
        setIsGeneratingCode(true);
        try {
          const res = await deviceApi.register(i);
          setBindingCode(i, res.data.bindingCode);
        } catch {
          // silently fail — home screen will show errors
        } finally {
          setIsGeneratingCode(false);
        }
        return;
      }
    }
  };

  if (entities.length === 0) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <View style={styles.empty}>
          <Text variant="headlineSmall">💬</Text>
          <Text variant="titleMedium">{t('home.chat_empty_title')}</Text>
          <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center' }}>
            {t('home.chat_empty_desc')}
          </Text>
          <Button
            mode="contained"
            icon="plus"
            onPress={handleGenerateCode}
            loading={isGeneratingCode}
            disabled={isGeneratingCode}
            style={styles.ctaButton}
            contentStyle={styles.ctaButtonContent}
            labelStyle={styles.ctaButtonLabel}
          >
            {t('home.generate_binding_code')}
          </Button>
          <Text
            variant="bodySmall"
            style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center', marginTop: 4 }}
          >
            {t('home.binding_code_hint')}
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
                <Text variant="titleMedium">{item.name || `${item.character || 'Entity'} #${item.entityId}`}</Text>
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
  ctaButton: {
    marginTop: 20,
    borderRadius: 28,
    elevation: 3,
  },
  ctaButtonContent: {
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  ctaButtonLabel: {
    fontSize: 16,
    fontWeight: '600',
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
