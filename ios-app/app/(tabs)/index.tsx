import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  FlatList,
  StyleSheet,
  RefreshControl,
  Alert,
  Image,
  Animated,
  TouchableOpacity,
  LayoutAnimation,
  Platform,
  UIManager,
} from 'react-native';
import {
  Text,
  Dialog,
  Portal,
  TextInput,
  Button,
  useTheme,
  ActivityIndicator,
  Snackbar,
  Card,
  Chip,
  IconButton,
} from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import * as ImagePicker from 'expo-image-picker';
import { useEntities } from '../../hooks/useEntities';
import { useEntityStore, Entity } from '../../store/entityStore';
import { useAuthStore } from '../../store/authStore';
import { deviceApi } from '../../services/api';
import EntityCard from '../../components/EntityCard';
import BindingCodeCard from '../../components/BindingCodeCard';
import { MaterialCommunityIcons } from '@expo/vector-icons';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

export default function HomeScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();
  const { entities, isLoading, refetch } = useEntities();
  const { bindingCodes, setBindingCode, clearBindingCode, removeEntity, updateEntity } = useEntityStore();
  const { deviceId } = useAuthStore();

  const [broadcastVisible, setBroadcastVisible] = useState(false);
  const [broadcastText, setBroadcastText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [snackMessage, setSnackMessage] = useState('');
  const [snackVisible, setSnackVisible] = useState(false);
  const [isGeneratingCode, setIsGeneratingCode] = useState(false);

  // Add Entity section — collapsible (match Android)
  const [addEntityExpanded, setAddEntityExpanded] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<number | null>(null);

  // Rename dialog
  const [renameVisible, setRenameVisible] = useState(false);
  const [renameEntity, setRenameEntity] = useState<Entity | null>(null);
  const [newName, setNewName] = useState('');
  const [isRenaming, setIsRenaming] = useState(false);

  // Auto-expand add section when no entities
  useEffect(() => {
    if (entities.length === 0) {
      setAddEntityExpanded(true);
    }
  }, [entities.length]);

  const showSnack = (msg: string) => {
    setSnackMessage(msg);
    setSnackVisible(true);
  };

  // Find next empty slot (max 20 entities, index 0-19)
  const nextEmptySlot = () => {
    for (let i = 0; i < 20; i++) {
      if (!entities.find((e) => e.entityIndex === i)) return i;
    }
    return -1;
  };

  const handleGenerateCode = async () => {
    const slotIndex = selectedSlot ?? nextEmptySlot();
    if (slotIndex === -1) {
      showSnack(t('home.all_slots_full', 'All 20 slots are occupied'));
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

  // Avatar picker
  const handleAvatarPress = async (entity: Entity) => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.5,
      allowsEditing: true,
      aspect: [1, 1],
    });
    if (!result.canceled && result.assets[0].uri) {
      try {
        const response = await deviceApi.uploadAvatar(entity.entityId, result.assets[0].uri);
        if (response.data?.avatar) {
          updateEntity(entity.entityId, { avatarUrl: response.data.avatar });
        }
        showSnack(t('common.success'));
      } catch {
        showSnack(t('errors.server'));
      }
    }
  };

  // Name rename
  const handleNamePress = (entity: Entity) => {
    setRenameEntity(entity);
    setNewName(entity.name || '');
    setRenameVisible(true);
  };

  const handleRename = async () => {
    if (!renameEntity || !newName.trim()) return;
    setIsRenaming(true);
    try {
      await deviceApi.renameEntity(renameEntity.entityId, newName.trim());
      updateEntity(renameEntity.entityId, { name: newName.trim() });
      setRenameVisible(false);
      showSnack(t('common.success'));
    } catch {
      showSnack(t('errors.server'));
    } finally {
      setIsRenaming(false);
    }
  };

  // Long press → ActionSheet
  const handleEntityLongPress = (entity: Entity) => {
    const buttons: any[] = [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('entity.rename'),
        onPress: () => handleNamePress(entity),
      },
      {
        text: t('entityManager.agent_card', 'Agent Card'),
        onPress: () => router.push('/entity-manager'),
      },
    ];
    if (entities.length > 1) {
      buttons.push({
        text: t('entity.remove'),
        style: 'destructive',
        onPress: () => handleDelete(entity),
      });
    }
    Alert.alert(
      entity.name || `${entity.character || 'Entity'} #${entity.entityId}`,
      undefined,
      buttons,
    );
  };

  const handleDelete = async (entity: Entity) => {
    Alert.alert(
      t('entity.remove'),
      t('entity.remove_confirm', { name: entity.name || `${entity.character || 'Entity'} #${entity.entityId}` }),
      [
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
      ],
    );
  };

  const toggleAddEntity = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setAddEntityExpanded(!addEntityExpanded);
  };

  // Available slots for chip selector
  const availableSlots = Array.from({ length: 20 }, (_, i) => i).filter(
    (i) => !entities.find((e) => e.entityIndex === i)
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]} edges={['bottom']}>
      {isLoading && entities.length === 0 ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" />
        </View>
      ) : entities.length === 0 ? (
        <View style={styles.centered}>
          <Image
            source={require('../../assets/icon.png')}
            style={{ width: 64, height: 64, borderRadius: 16, marginBottom: 8 }}
          />
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
              onAvatarPress={() => handleAvatarPress(item)}
              onNamePress={() => handleNamePress(item)}
            />
          )}
          refreshControl={
            <RefreshControl refreshing={isLoading} onRefresh={refetch} />
          }
          contentContainerStyle={styles.list}
          ListFooterComponent={
            <View style={styles.footer}>
              {/* Binding code cards */}
              {Object.entries(bindingCodes).map(([slotIndex, code]) => (
                <BindingCodeCard
                  key={slotIndex}
                  code={code}
                  entityIndex={Number(slotIndex)}
                  onDismiss={() => clearBindingCode(Number(slotIndex))}
                />
              ))}

              {/* Collapsible Add Entity section — matches Android */}
              <Card style={[styles.addEntityCard, { backgroundColor: theme.colors.surfaceVariant }]}>
                <TouchableOpacity onPress={toggleAddEntity} activeOpacity={0.7}>
                  <View style={styles.addEntityHeader}>
                    <MaterialCommunityIcons name="plus-circle-outline" size={20} color={theme.colors.primary} />
                    <Text variant="titleSmall" style={{ flex: 1, color: theme.colors.onSurface }}>
                      {t('entityManager.add_entity', 'Add Entity')}
                    </Text>
                    <MaterialCommunityIcons
                      name={addEntityExpanded ? 'chevron-up' : 'chevron-down'}
                      size={20}
                      color={theme.colors.onSurfaceVariant}
                    />
                  </View>
                </TouchableOpacity>

                {addEntityExpanded && (
                  <Card.Content style={styles.addEntityContent}>
                    {/* Slot selector chips */}
                    {availableSlots.length > 0 && (
                      <>
                        <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginBottom: 4 }}>
                          {t('home.select_slot', 'Select Slot:')}
                        </Text>
                        <View style={styles.slotChips}>
                          {availableSlots.slice(0, 10).map((slot) => (
                            <Chip
                              key={slot}
                              selected={selectedSlot === slot}
                              onPress={() => setSelectedSlot(slot)}
                              compact
                              style={styles.slotChip}
                            >
                              {String(slot)}
                            </Chip>
                          ))}
                        </View>
                      </>
                    )}

                    {/* Generate + Copy buttons */}
                    <View style={styles.addEntityButtons}>
                      <Button
                        mode="contained"
                        icon="key-variant"
                        onPress={handleGenerateCode}
                        loading={isGeneratingCode}
                        disabled={isGeneratingCode}
                        style={{ flex: 1 }}
                      >
                        {t('home.generate_binding_code')}
                      </Button>
                    </View>
                    <Text
                      variant="bodySmall"
                      style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center', marginTop: 4 }}
                    >
                      {t('home.binding_code_hint')}
                    </Text>

                    {/* Official Borrow button */}
                    <Button
                      mode="outlined"
                      icon="robot"
                      onPress={() => router.push('/official-borrow')}
                      style={{ marginTop: 12 }}
                    >
                      {t('official_borrow.title', 'Official Bot Borrow')}
                    </Button>
                  </Card.Content>
                )}
              </Card>

              {/* Entity count — matches Android tvEntityCount */}
              <Text
                variant="bodySmall"
                style={[styles.entityCount, { color: theme.colors.onSurfaceVariant }]}
              >
                {entities.length} / 20 entities
              </Text>

              {/* Broadcast button */}
              {entities.length > 0 && (
                <Button
                  mode="outlined"
                  icon="bullhorn"
                  onPress={() => setBroadcastVisible(true)}
                  style={{ marginHorizontal: 16, marginTop: 8 }}
                >
                  {t('home.broadcast')}
                </Button>
              )}
            </View>
          }
        />
      )}

      {/* Rename Dialog */}
      <Portal>
        <Dialog visible={renameVisible} onDismiss={() => setRenameVisible(false)}>
          <Dialog.Title>{t('entity.rename')}</Dialog.Title>
          <Dialog.Content>
            <TextInput
              mode="outlined"
              label={t('entity.rename_placeholder')}
              value={newName}
              onChangeText={setNewName}
              maxLength={30}
              autoFocus
            />
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setRenameVisible(false)}>{t('common.cancel')}</Button>
            <Button
              mode="contained"
              onPress={handleRename}
              loading={isRenaming}
              disabled={!newName.trim() || isRenaming}
            >
              {t('common.save')}
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>

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
  list: { paddingVertical: 8, paddingBottom: 24 },
  footer: {
    paddingBottom: 40,
  },
  addEntityCard: {
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 16,
    overflow: 'hidden',
  },
  addEntityHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 14,
  },
  addEntityContent: {
    paddingTop: 0,
    paddingBottom: 16,
    gap: 8,
  },
  slotChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 8,
  },
  slotChip: {
    height: 28,
  },
  addEntityButtons: {
    flexDirection: 'row',
    gap: 8,
  },
  entityCount: {
    textAlign: 'center',
    marginTop: 12,
  },
});
