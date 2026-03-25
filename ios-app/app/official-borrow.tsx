import React, { useState, useEffect } from 'react';
import { View, ScrollView, StyleSheet, Alert } from 'react-native';
import {
  Text,
  Card,
  Button,
  Chip,
  Checkbox,
  Divider,
  useTheme,
  ActivityIndicator,
  Snackbar,
} from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from 'expo-router';
import { officialBorrowApi, miscApi } from '../services/api';
import { useEntityStore } from '../store/entityStore';
import { TIER_COLORS } from '../constants/colors';

interface BorrowStatus {
  freeSlots: number;
  paidSlots: number;
  boundEntities: Array<{ entityId: string; tier: 'free' | 'paid'; boundSince: number }>;
}

interface FreeBotItem {
  botId: string;
  displayName: string;
  activeBindings: number;
  status: string;
}

export default function OfficialBorrowScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const navigation = useNavigation();
  const { entities } = useEntityStore();

  const [status, setStatus] = useState<BorrowStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [tosAgreed, setTosAgreed] = useState(false);
  const [snack, setSnack] = useState('');
  const [isBorrowing, setIsBorrowing] = useState<string | null>(null);
  const [freeBots, setFreeBots] = useState<FreeBotItem[]>([]);
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);

  React.useLayoutEffect(() => {
    navigation.setOptions({ title: t('official_borrow.title'), headerShown: true });
  }, [navigation, t]);

  const loadStatus = async () => {
    setIsLoading(true);
    try {
      const res = await officialBorrowApi.getStatus();
      setStatus(res.data);
      loadFreeBots();
    } catch {
      setSnack(t('errors.server'));
    } finally {
      setIsLoading(false);
    }
  };

  const loadFreeBots = async () => {
    try {
      const res = await officialBorrowApi.getFreeBots();
      const bots: FreeBotItem[] = res.data?.bots ?? [];
      setFreeBots(bots);
      if (bots.length > 0 && !selectedBotId) {
        setSelectedBotId(bots[0].botId);
      }
    } catch {
      // silent
    }
  };

  useEffect(() => {
    loadStatus();
  }, []);

  const handleBindFree = async (entityId: string) => {
    if (!tosAgreed) {
      setSnack(t('official_borrow.tos_agree'));
      return;
    }
    setIsBorrowing(entityId);
    try {
      await officialBorrowApi.bindFree(entityId, selectedBotId ?? undefined);
      await loadStatus();
      setSnack('✓ ' + t('official_borrow.webhook_success'));
    } catch {
      setSnack(t('errors.server'));
    } finally {
      setIsBorrowing(null);
    }
  };

  const handleUnbind = async (entityId: string) => {
    Alert.alert(t('official_borrow.unbind'), undefined, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('official_borrow.unbind'),
        style: 'destructive',
        onPress: async () => {
          try {
            await officialBorrowApi.unbind(entityId);
            await loadStatus();
          } catch {
            setSnack(t('errors.server'));
          }
        },
      },
    ]);
  };

  const isBound = (entityId: string) =>
    status?.boundEntities.some((b) => b.entityId === entityId) ?? false;

  const getBoundInfo = (entityId: string) =>
    status?.boundEntities.find((b) => b.entityId === entityId) ?? null;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        {isLoading ? (
          <View style={styles.centered}>
            <ActivityIndicator />
          </View>
        ) : (
          <>
            {/* Slot overview */}
            <Card style={styles.overviewCard}>
              <Card.Content>
                <View style={styles.slotRow}>
                  <View style={styles.slotItem}>
                    <Text variant="headlineMedium" style={{ color: theme.colors.primary }}>
                      {status?.freeSlots ?? 0}
                    </Text>
                    <Text variant="bodySmall">{t('official_borrow.free_tier')}</Text>
                    <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                      {t('official_borrow.slots_available', { count: status?.freeSlots ?? 0 })}
                    </Text>
                  </View>
                  <Divider style={{ height: '100%', width: 1 }} />
                  <View style={styles.slotItem}>
                    <Text variant="headlineMedium" style={{ color: TIER_COLORS.paid }}>
                      {status?.paidSlots ?? 0}
                    </Text>
                    <Text variant="bodySmall">{t('official_borrow.paid_tier')}</Text>
                    <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                      {t('official_borrow.slots_available', { count: status?.paidSlots ?? 0 })}
                    </Text>
                  </View>
                </View>
              </Card.Content>
            </Card>

            {/* TOS Checkbox */}
            <Card style={styles.card}>
              <Card.Content>
                <View style={styles.checkRow}>
                  <Checkbox
                    status={tosAgreed ? 'checked' : 'unchecked'}
                    onPress={() => setTosAgreed(!tosAgreed)}
                  />
                  <Text variant="bodyMedium" style={{ flex: 1 }}>
                    {t('official_borrow.tos_agree')}
                  </Text>
                </View>
              </Card.Content>
            </Card>

            {/* Free Bot Selector */}
            {freeBots.length > 0 && !status?.boundEntities.some((b) => b.tier === 'free') && (
              <Card style={styles.card}>
                <Card.Content>
                  <Text variant="titleSmall" style={{ marginBottom: 8 }}>
                    {t('official_borrow.select_bot')}
                  </Text>
                  {freeBots.map((bot) => (
                    <View
                      key={bot.botId}
                      style={[
                        styles.botRow,
                        {
                          borderColor: selectedBotId === bot.botId ? theme.colors.primary : theme.colors.outlineVariant,
                          backgroundColor: selectedBotId === bot.botId ? theme.colors.primaryContainer + '22' : 'transparent',
                        },
                      ]}
                    >
                      <Checkbox
                        status={selectedBotId === bot.botId ? 'checked' : 'unchecked'}
                        onPress={() => setSelectedBotId(bot.botId)}
                      />
                      <View style={{ flex: 1 }}>
                        <Text variant="bodyMedium">{bot.displayName}</Text>
                        <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                          {t('official_borrow.active_users')}: {bot.activeBindings}
                        </Text>
                      </View>
                    </View>
                  ))}
                </Card.Content>
              </Card>
            )}

            {/* Entity list */}
            {entities.map((entity) => {
              const bound = isBound(entity.entityId);
              const boundInfo = getBoundInfo(entity.entityId);
              return (
                <Card key={entity.entityId} style={styles.card}>
                  <Card.Content>
                    <View style={styles.entityRow}>
                      <Text variant="titleMedium" style={{ flex: 1 }}>
                        {entity.name}
                      </Text>
                      {bound && (
                        <Chip compact mode="outlined">
                          {t(`official_borrow.${boundInfo?.tier ?? 'free'}_tier`)}
                        </Chip>
                      )}
                    </View>
                    {bound && boundInfo && (
                      <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}>
                        {t('official_borrow.bound_since', {
                          date: new Date(boundInfo.boundSince).toLocaleDateString(),
                        })}
                      </Text>
                    )}
                  </Card.Content>
                  <Card.Actions>
                    {bound ? (
                      <Button
                        mode="outlined"
                        onPress={() => handleUnbind(entity.entityId)}
                        textColor={theme.colors.error}
                        compact
                      >
                        {t('official_borrow.unbind')}
                      </Button>
                    ) : (
                      <>
                        <Button
                          mode="outlined"
                          onPress={() => handleBindFree(entity.entityId)}
                          loading={isBorrowing === entity.entityId}
                          disabled={!tosAgreed || !!isBorrowing || (status?.freeSlots ?? 0) === 0}
                          compact
                        >
                          {t('official_borrow.bind_free')}
                        </Button>
                        <Button
                          mode="contained"
                          onPress={() => {
                            setSnack(t('official_borrow.iap_coming_soon'));
                          }}
                          compact
                        >
                          {t('official_borrow.bind_paid')}
                        </Button>
                      </>
                    )}
                  </Card.Actions>
                </Card>
              );
            })}
          </>
        )}
      </ScrollView>

      <Snackbar visible={!!snack} onDismiss={() => setSnack('')} duration={3000}>
        {snack}
      </Snackbar>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 16, gap: 12, paddingBottom: 40 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  overviewCard: { borderRadius: 16 },
  card: { borderRadius: 16 },
  slotRow: { flexDirection: 'row', justifyContent: 'space-around', gap: 16 },
  slotItem: { flex: 1, alignItems: 'center', gap: 4 },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  entityRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  botRow: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderRadius: 10, padding: 8, marginBottom: 6 },
});
