import React, { useState } from 'react';
import { View, FlatList, StyleSheet, Alert, ScrollView } from 'react-native';
import {
  Text,
  Card,
  Avatar,
  IconButton,
  Button,
  Dialog,
  Portal,
  TextInput,
  useTheme,
  Snackbar,
  ActivityIndicator,
  Chip,
} from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { useEntityStore, Entity } from '../store/entityStore';
import { CHARACTER_COLORS } from '../constants/colors';
import { deviceApi } from '../services/api';
import { useEntities } from '../hooks/useEntities';

export default function EntityManagerScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const navigation = useNavigation();
  const { entities, removeEntity, updateEntity } = useEntityStore();
  const { refetch } = useEntities();

  const [renameVisible, setRenameVisible] = useState(false);
  const [selectedEntity, setSelectedEntity] = useState<Entity | null>(null);
  const [newName, setNewName] = useState('');
  const [snack, setSnack] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  // Agent Card state
  const [acVisible, setAcVisible] = useState(false);
  const [acEntity, setAcEntity] = useState<Entity | null>(null);
  const [acDesc, setAcDesc] = useState('');
  const [acCaps, setAcCaps] = useState('');
  const [acProtos, setAcProtos] = useState('');
  const [acTags, setAcTags] = useState('');
  const [acVersion, setAcVersion] = useState('');
  const [acWebsite, setAcWebsite] = useState('');
  const [acEmail, setAcEmail] = useState('');
  const [acLoading, setAcLoading] = useState(false);

  React.useLayoutEffect(() => {
    navigation.setOptions({ title: t('settings.manage_entities'), headerShown: true });
  }, [navigation, t]);

  const handleRename = async () => {
    if (!selectedEntity || !newName.trim()) return;
    setIsLoading(true);
    try {
      await deviceApi.renameEntity(selectedEntity.entityId, newName.trim());
      updateEntity(selectedEntity.entityId, { name: newName.trim() });
      setRenameVisible(false);
      setSnack(t('common.success'));
    } catch {
      setSnack(t('errors.server'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleUpdateAvatar = async (entity: Entity) => {
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
        setSnack(t('common.success'));
      } catch {
        setSnack(t('errors.server'));
      }
    }
  };

  const handleRemove = (entity: Entity) => {
    Alert.alert(
      t('entity.remove'),
      t('entity.remove_confirm', { name: entity.name }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: async () => {
            try {
              await deviceApi.removeEntity(entity.entityId);
              removeEntity(entity.entityId);
              setSnack(t('home.unbind_success'));
            } catch {
              setSnack(t('errors.server'));
            }
          },
        },
      ]
    );
  };

  const handleAddEntity = async () => {
    setIsLoading(true);
    try {
      await deviceApi.addEntity();
      await refetch();
      setSnack('Entity added');
    } catch {
      setSnack(t('errors.server'));
    } finally {
      setIsLoading(false);
    }
  };

  const handlePermanentDelete = (entity: Entity) => {
    if (entities.length <= 1) {
      setSnack('Cannot delete the last entity');
      return;
    }
    Alert.alert(
      'Permanently Delete Entity',
      `This will permanently remove Entity #${entity.entityIndex} (${entity.name || 'unnamed'}). Chat history will be preserved but the slot will be gone forever.`,
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: 'Delete Permanently',
          style: 'destructive',
          onPress: async () => {
            try {
              await deviceApi.deleteEntityPermanent(entity.entityIndex);
              removeEntity(entity.entityId);
              setSnack('Entity permanently deleted');
            } catch {
              setSnack(t('errors.server'));
            }
          },
        },
      ]
    );
  };

  // Agent Card handlers
  const openAgentCard = async (entity: Entity) => {
    setAcEntity(entity);
    setAcDesc(''); setAcCaps(''); setAcProtos(''); setAcTags('');
    setAcVersion(''); setAcWebsite(''); setAcEmail('');
    setAcVisible(true);
    try {
      const res = await deviceApi.getAgentCard(entity.entityId);
      const card = res.data?.agentCard;
      if (card) {
        setAcDesc(card.description || '');
        setAcCaps((card.capabilities || []).map((c: any) => c.name).join(', '));
        setAcProtos((card.protocols || []).join(', '));
        setAcTags((card.tags || []).join(', '));
        setAcVersion(card.version || '');
        setAcWebsite(card.website || '');
        setAcEmail(card.contactEmail || '');
      }
    } catch {
      // No existing card — empty form is fine
    }
  };

  const saveAgentCard = async () => {
    if (!acEntity || !acDesc.trim()) {
      setSnack('Description is required');
      return;
    }
    setAcLoading(true);
    try {
      const capabilities = acCaps.split(',').map(s => s.trim()).filter(Boolean)
        .slice(0, 10).map(name => ({ id: name.toLowerCase().replace(/\s+/g, '-'), name, description: '' }));
      const protocols = acProtos.split(',').map(s => s.trim()).filter(Boolean).slice(0, 10);
      const tags = acTags.split(',').map(s => s.trim()).filter(Boolean).slice(0, 20);

      await deviceApi.updateAgentCard(acEntity.entityId, {
        description: acDesc.trim(),
        capabilities,
        protocols,
        tags,
        version: acVersion.trim(),
        website: acWebsite.trim(),
        contactEmail: acEmail.trim(),
      });
      setAcVisible(false);
      setSnack('Agent Card saved');
    } catch {
      setSnack('Failed to save Agent Card');
    } finally {
      setAcLoading(false);
    }
  };

  const deleteAgentCard = () => {
    if (!acEntity) return;
    Alert.alert('Delete Agent Card', 'Remove the Agent Card for this entity?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          try {
            await deviceApi.deleteAgentCard(acEntity.entityId);
            setAcVisible(false);
            setSnack('Agent Card deleted');
          } catch {
            setSnack('Failed to delete');
          }
        },
      },
    ]);
  };

  const CHARACTER_ICONS = { LOBSTER: '🦞', PIG: '🐷' };
  // CHARACTER_COLORS imported from constants/colors

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]} edges={['bottom']}>
      <FlatList
        data={entities}
        keyExtractor={(item) => item.entityId}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <Card style={styles.card}>
            <Card.Content style={styles.cardContent}>
              {/* Avatar */}
              <IconButton
                icon="camera"
                size={20}
                style={styles.cameraIcon}
                onPress={() => handleUpdateAvatar(item)}
              />
              {item.avatarUrl ? (
                <Avatar.Image size={56} source={{ uri: item.avatarUrl }} />
              ) : (
                <Avatar.Text
                  size={56}
                  label={CHARACTER_ICONS[item.character]}
                  style={{ backgroundColor: CHARACTER_COLORS[item.character] }}
                />
              )}

              {/* Info */}
              <View style={styles.info}>
                <Text variant="titleMedium">{item.name}</Text>
                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                  {t(`entity.character_${item.character.toLowerCase()}`)} • Slot {item.entityIndex + 1}
                </Text>
              </View>

              {/* Actions */}
              <View style={styles.actions}>
                <IconButton
                  icon="card-account-details-outline"
                  size={20}
                  onPress={() => openAgentCard(item)}
                />
                <IconButton
                  icon="pencil"
                  size={20}
                  onPress={() => {
                    setSelectedEntity(item);
                    setNewName(item.name);
                    setRenameVisible(true);
                  }}
                />
                <IconButton
                  icon="link-off"
                  size={20}
                  onPress={() => handleRemove(item)}
                />
                <IconButton
                  icon="delete-forever"
                  size={20}
                  iconColor={theme.colors.error}
                  onPress={() => handlePermanentDelete(item)}
                  disabled={entities.length <= 1}
                />
              </View>
            </Card.Content>
          </Card>
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
              {t('home.no_entities')}
            </Text>
          </View>
        }
        ListFooterComponent={
          <Button
            mode="outlined"
            icon="plus"
            onPress={handleAddEntity}
            loading={isLoading}
            style={{ marginTop: 8 }}
          >
            Add Entity
          </Button>
        }
      />

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
              loading={isLoading}
              disabled={!newName.trim() || isLoading}
            >
              {t('common.save')}
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>

      {/* Agent Card Dialog */}
      <Portal>
        <Dialog visible={acVisible} onDismiss={() => setAcVisible(false)} style={{ maxHeight: '85%' }}>
          <Dialog.Title>Agent Card{acEntity ? ` — ${acEntity.name}` : ''}</Dialog.Title>
          <Dialog.ScrollArea style={{ paddingHorizontal: 0 }}>
            <ScrollView contentContainerStyle={{ paddingHorizontal: 24, gap: 8, paddingBottom: 8 }}>
              <TextInput mode="outlined" dense label="Description *" value={acDesc} onChangeText={setAcDesc}
                maxLength={500} multiline numberOfLines={3} />
              <TextInput mode="outlined" dense label="Capabilities (comma-separated)" value={acCaps}
                onChangeText={setAcCaps} placeholder="e.g. chat, search, translate" />
              <TextInput mode="outlined" dense label="Protocols (comma-separated)" value={acProtos}
                onChangeText={setAcProtos} placeholder="e.g. A2A, REST, gRPC" />
              <TextInput mode="outlined" dense label="Tags (comma-separated)" value={acTags}
                onChangeText={setAcTags} placeholder="e.g. IoT, automation" />
              <TextInput mode="outlined" dense label="Version" value={acVersion}
                onChangeText={setAcVersion} maxLength={32} placeholder="e.g. 1.0.0" />
              <TextInput mode="outlined" dense label="Website" value={acWebsite}
                onChangeText={setAcWebsite} maxLength={500} keyboardType="url" />
              <TextInput mode="outlined" dense label="Contact Email" value={acEmail}
                onChangeText={setAcEmail} maxLength={255} keyboardType="email-address" />
            </ScrollView>
          </Dialog.ScrollArea>
          <Dialog.Actions>
            <Button onPress={deleteAgentCard} textColor={theme.colors.error}>Delete</Button>
            <Button onPress={() => setAcVisible(false)}>{t('common.cancel')}</Button>
            <Button mode="contained" onPress={saveAgentCard} loading={acLoading}
              disabled={!acDesc.trim() || acLoading}>
              {t('common.save')}
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>

      <Snackbar visible={!!snack} onDismiss={() => setSnack('')} duration={2000}>
        {snack}
      </Snackbar>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  list: { padding: 16, gap: 12, paddingBottom: 40 },
  card: { borderRadius: 16 },
  cardContent: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  cameraIcon: { position: 'absolute', top: 0, left: 0, zIndex: 1 },
  info: { flex: 1, gap: 4 },
  actions: { flexDirection: 'row' },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
});
