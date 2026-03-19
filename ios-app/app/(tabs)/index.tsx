import React, { useState } from 'react';
import {
  View,
  FlatList,
  StyleSheet,
  RefreshControl,
  Alert,
} from 'react-native';
import {
  FAB,
  Text,
  Dialog,
  Portal,
  TextInput,
  Button,
  useTheme,
  ActivityIndicator,
  Snackbar,
} from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useEntities } from '../../hooks/useEntities';
import { useEntityStore, Entity } from '../../store/entityStore';
import { useAuthStore } from '../../store/authStore';
import { deviceApi } from '../../services/api';
import EntityCard from '../../components/EntityCard';
import BindingCodeCard from '../../components/BindingCodeCard';

export default function HomeScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { entities, isLoading, refetch } = useEntities();
  const { bindingCodes, setBindingCode, clearBindingCode, removeEntity } = useEntityStore();
  const { deviceId } = useAuthStore();

  const [broadcastVisible, setBroadcastVisible] = useState(false);
  const [broadcastText, setBroadcastText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [snackMessage, setSnackMessage] = useState('');
  const [snackVisible, setSnackVisible] = useState(false);
  const [isGeneratingCode, setIsGeneratingCode] = useState(false);

  const showSnack = (msg: string) => {
    setSnackMessage(msg);
    setSnackVisible(true);
  };

  // Find next empty slot (max 4 entities, index 0-3)
  const nextEmptySlot = () => {
    for (let i = 0; i < 4; i++) {
      if (!entities.find((e) => e.entityIndex === i)) return i;
    }
    return -1;
  };

  const handleGenerateCode = async () => {
    const slotIndex = nextEmptySlot();
    if (slotIndex === -1) {
      showSnack('All 4 slots are occupied');
      return;
    }
    if (!deviceId) return;

    setIsGeneratingCode(true);
    try {
      const res = await deviceApi.register(slotIndex);
      const code = res.data.bindingCode;
      setBindingCode(slotIndex, code);
    } catch (error) {
      showSnack(t('errors.server'));
    } finally {
      setIsGeneratingCode(false);
    }
  };

  const handleBroadcast = async () => {
    if (!broadcastText.trim()) return;
    setIsSending(true);
    try {
      await import('../../services/api').then(({ chatApi }) =>
        chatApi.speak({ message: broadcastText, broadcast: true })
      );
      setBroadcastText('');
      setBroadcastVisible(false);
      showSnack(t('home.broadcast_sent'));
    } catch {
      showSnack(t('errors.server'));
    } finally {
      setIsSending(false);
    }
  };

  const handleEntityLongPress = (entity: Entity) => {
    if (entities.length <= 1) return;
    Alert.alert(entity.name, undefined, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('entity.remove'),
        style: 'destructive',
        onPress: () => handleDelete(entity),
      },
    ]);
  };

  const handleDelete = async (entity: Entity) => {
    Alert.alert(t('entity.remove'), t('entity.remove_confirm', { name: entity.name }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: async () => {
          try {
            await deviceApi.deleteEntityPermanent(entity.entityIndex);
            removeEntity(entity.entityId);
            showSnack(t('entity.deleted'));
          } catch {
            showSnack(t('errors.server'));
          }
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]} edges={['bottom']}>
      {/* Binding code cards */}
      {Object.entries(bindingCodes).map(([slotIndex, code]) => (
        <BindingCodeCard
          key={slotIndex}
          code={code}
          entityIndex={Number(slotIndex)}
          onDismiss={() => clearBindingCode(Number(slotIndex))}
        />
      ))}

      {/* Entity list */}
      {isLoading && entities.length === 0 ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" />
        </View>
      ) : entities.length === 0 ? (
        <View style={styles.centered}>
          <Text variant="headlineSmall" style={{ marginBottom: 8 }}>
            🦞
          </Text>
          <Text variant="titleMedium">{t('home.no_entities')}</Text>
          <Text
            variant="bodyMedium"
            style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center', marginTop: 8 }}
          >
            {t('home.no_entities_desc')}
          </Text>
        </View>
      ) : (
        <FlatList
          data={entities}
          keyExtractor={(item) => item.entityId}
          renderItem={({ item }) => (
            <EntityCard
              entity={item}
              onLongPress={() => handleEntityLongPress(item)}
            />
          )}
          refreshControl={
            <RefreshControl refreshing={isLoading} onRefresh={refetch} />
          }
          contentContainerStyle={styles.list}
        />
      )}

      {/* FAB buttons */}
      <View style={styles.fabContainer}>
        <FAB
          icon="bullhorn"
          label={t('home.broadcast')}
          onPress={() => setBroadcastVisible(true)}
          variant="secondary"
          size="small"
          style={styles.broadcastFab}
        />
        <FAB
          icon={isGeneratingCode ? 'loading' : 'plus'}
          onPress={handleGenerateCode}
          loading={isGeneratingCode}
          style={styles.fab}
        />
      </View>

      {/* Broadcast Dialog */}
      <Portal>
        <Dialog visible={broadcastVisible} onDismiss={() => setBroadcastVisible(false)}>
          <Dialog.Title>{t('home.broadcast')}</Dialog.Title>
          <Dialog.Content>
            <TextInput
              mode="outlined"
              placeholder={t('home.broadcast_hint')}
              value={broadcastText}
              onChangeText={setBroadcastText}
              multiline
              numberOfLines={3}
            />
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setBroadcastVisible(false)}>{t('common.cancel')}</Button>
            <Button
              mode="contained"
              onPress={handleBroadcast}
              loading={isSending}
              disabled={!broadcastText.trim() || isSending}
            >
              {t('common.send')}
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>

      {/* Snackbar */}
      <Snackbar
        visible={snackVisible}
        onDismiss={() => setSnackVisible(false)}
        duration={2000}
      >
        {snackMessage}
      </Snackbar>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
    gap: 8,
  },
  list: { paddingVertical: 8, paddingBottom: 100 },
  fabContainer: {
    position: 'absolute',
    bottom: 24,
    right: 16,
    alignItems: 'flex-end',
    gap: 12,
  },
  fab: {},
  broadcastFab: {},
});
