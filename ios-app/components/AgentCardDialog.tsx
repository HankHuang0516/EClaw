import React, { useState, useEffect } from 'react';
import { View, StyleSheet, ScrollView, Alert } from 'react-native';
import {
  Dialog,
  Portal,
  Button,
  TextInput,
  Text,
  Chip,
  useTheme,
  IconButton,
} from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import { deviceApi } from '../services/api';

interface Capability {
  id?: string;
  name: string;
  description?: string;
}

interface AgentCard {
  description?: string;
  version?: string;
  website?: string;
  contactEmail?: string;
  capabilities?: Array<Capability | string>;
  protocols?: string[];
  tags?: string[];
}

interface Props {
  visible: boolean;
  entityId: string;
  entityName: string;
  onDismiss: () => void;
  onSaved?: () => void;
}

// Normalize server response — capabilities can be string[] or object[]
function normalizeCapabilities(raw: Array<Capability | string> | undefined): Capability[] {
  if (!raw) return [];
  return raw.map((c) =>
    typeof c === 'string' ? { name: c, description: '' } : { name: c.name || '', description: c.description || '' }
  );
}

export default function AgentCardDialog({ visible, entityId, entityName, onDismiss, onSaved }: Props) {
  const { t } = useTranslation();
  const theme = useTheme();

  const [description, setDescription] = useState('');
  const [version, setVersion] = useState('');
  const [website, setWebsite] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [protocols, setProtocols] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);

  const [newCapName, setNewCapName] = useState('');
  const [newCapDesc, setNewCapDesc] = useState('');
  const [newProtocol, setNewProtocol] = useState('');
  const [newTag, setNewTag] = useState('');

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!visible || !entityId) return;
    setLoading(true);
    deviceApi
      .getAgentCard(entityId)
      .then((res) => {
        const card: AgentCard = res.data?.agentCard || {};
        setDescription(card.description || '');
        setVersion(card.version || '');
        setWebsite(card.website || '');
        setContactEmail(card.contactEmail || '');
        setCapabilities(normalizeCapabilities(card.capabilities));
        setProtocols(card.protocols || []);
        setTags(card.tags || []);
      })
      .catch(() => {
        // No existing card — start with empty form (matches Android behavior)
        setDescription('');
        setVersion('');
        setWebsite('');
        setContactEmail('');
        setCapabilities([]);
        setProtocols([]);
        setTags([]);
      })
      .finally(() => setLoading(false));
  }, [visible, entityId]);

  const addCapability = () => {
    if (!newCapName.trim() || capabilities.length >= 10) return;
    setCapabilities([...capabilities, { name: newCapName.trim(), description: newCapDesc.trim() }]);
    setNewCapName('');
    setNewCapDesc('');
  };

  const removeCapability = (idx: number) => {
    setCapabilities(capabilities.filter((_, i) => i !== idx));
  };

  const addProtocol = () => {
    const v = newProtocol.trim();
    if (!v || protocols.length >= 10 || protocols.includes(v)) return;
    setProtocols([...protocols, v]);
    setNewProtocol('');
  };

  const addTag = () => {
    const v = newTag.trim();
    if (!v || tags.length >= 20 || tags.includes(v)) return;
    setTags([...tags, v]);
    setNewTag('');
  };

  const handleSave = async () => {
    if (!description.trim()) {
      Alert.alert(t('entityManager.description_required', 'Description is required'));
      return;
    }
    setSaving(true);
    try {
      const agentCard = {
        description: description.trim(),
        version: version.trim(),
        website: website.trim(),
        contactEmail: contactEmail.trim(),
        capabilities: capabilities.map((c) => ({
          id: c.name.toLowerCase().replace(/\s+/g, '-'),
          name: c.name,
          description: c.description || '',
        })),
        protocols,
        tags,
      };
      await deviceApi.updateAgentCard(entityId, agentCard);
      onSaved?.();
      onDismiss();
    } catch (e) {
      Alert.alert(t('errors.server'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = () => {
    Alert.alert(
      t('entityManager.delete_agent_card_title', 'Delete Agent Card'),
      t('entityManager.delete_agent_card_message', 'Remove the Agent Card for this entity?'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: async () => {
            try {
              await deviceApi.deleteAgentCard(entityId);
              onSaved?.();
              onDismiss();
            } catch {
              Alert.alert(t('errors.server'));
            }
          },
        },
      ]
    );
  };

  return (
    <Portal>
      <Dialog visible={visible} onDismiss={onDismiss} style={{ maxHeight: '85%' }}>
        <Dialog.Title numberOfLines={1}>
          {t('entityManager.agent_card', 'Agent Card')} — {entityName}
        </Dialog.Title>
        <Dialog.ScrollArea style={{ paddingHorizontal: 0 }}>
          <ScrollView contentContainerStyle={styles.content}>
            <TextInput
              mode="outlined"
              dense
              label={t('entityManager.label_description', 'Description *')}
              value={description}
              onChangeText={setDescription}
              maxLength={500}
              multiline
              numberOfLines={3}
            />
            <TextInput
              mode="outlined"
              dense
              label={t('entityManager.label_version', 'Version')}
              value={version}
              onChangeText={setVersion}
              maxLength={32}
              placeholder="e.g. 1.0.0"
            />
            <TextInput
              mode="outlined"
              dense
              label={t('entityManager.label_website', 'Website')}
              value={website}
              onChangeText={setWebsite}
              maxLength={500}
              keyboardType="url"
              autoCapitalize="none"
            />
            <TextInput
              mode="outlined"
              dense
              label={t('entityManager.label_contact_email', 'Contact Email')}
              value={contactEmail}
              onChangeText={setContactEmail}
              maxLength={255}
              keyboardType="email-address"
              autoCapitalize="none"
            />

            {/* Capabilities */}
            <Text variant="labelMedium" style={styles.sectionTitle}>
              {t('entityManager.label_capabilities', 'Capabilities')} ({capabilities.length}/10)
            </Text>
            {capabilities.map((c, i) => (
              <View key={i} style={styles.capRow}>
                <View style={{ flex: 1 }}>
                  <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>{c.name}</Text>
                  {c.description ? (
                    <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                      {c.description}
                    </Text>
                  ) : null}
                </View>
                <IconButton icon="close" size={18} onPress={() => removeCapability(i)} />
              </View>
            ))}
            {capabilities.length < 10 && (
              <View style={styles.addRow}>
                <TextInput
                  mode="outlined"
                  dense
                  placeholder={t('entityManager.placeholder_capability_name', 'Name')}
                  value={newCapName}
                  onChangeText={setNewCapName}
                  style={{ flex: 1 }}
                />
                <TextInput
                  mode="outlined"
                  dense
                  placeholder={t('entityManager.placeholder_capability_desc', 'Description')}
                  value={newCapDesc}
                  onChangeText={setNewCapDesc}
                  style={{ flex: 1.3 }}
                />
                <IconButton icon="plus" onPress={addCapability} disabled={!newCapName.trim()} />
              </View>
            )}

            {/* Protocols */}
            <Text variant="labelMedium" style={styles.sectionTitle}>
              {t('entityManager.label_protocols', 'Protocols')} ({protocols.length}/10)
            </Text>
            <View style={styles.chipRow}>
              {protocols.map((p, i) => (
                <Chip
                  key={i}
                  compact
                  onClose={() => setProtocols(protocols.filter((_, idx) => idx !== i))}
                  style={styles.chip}
                >
                  {p}
                </Chip>
              ))}
            </View>
            {protocols.length < 10 && (
              <View style={styles.addRow}>
                <TextInput
                  mode="outlined"
                  dense
                  placeholder={t('entityManager.placeholder_protocols', 'e.g. A2A, REST')}
                  value={newProtocol}
                  onChangeText={setNewProtocol}
                  onSubmitEditing={addProtocol}
                  style={{ flex: 1 }}
                />
                <IconButton icon="plus" onPress={addProtocol} disabled={!newProtocol.trim()} />
              </View>
            )}

            {/* Tags */}
            <Text variant="labelMedium" style={styles.sectionTitle}>
              {t('entityManager.label_tags', 'Tags')} ({tags.length}/20)
            </Text>
            <View style={styles.chipRow}>
              {tags.map((tg, i) => (
                <Chip
                  key={i}
                  compact
                  onClose={() => setTags(tags.filter((_, idx) => idx !== i))}
                  style={styles.chip}
                >
                  {tg}
                </Chip>
              ))}
            </View>
            {tags.length < 20 && (
              <View style={styles.addRow}>
                <TextInput
                  mode="outlined"
                  dense
                  placeholder={t('entityManager.placeholder_tags', 'e.g. IoT, automation')}
                  value={newTag}
                  onChangeText={setNewTag}
                  onSubmitEditing={addTag}
                  style={{ flex: 1 }}
                />
                <IconButton icon="plus" onPress={addTag} disabled={!newTag.trim()} />
              </View>
            )}
          </ScrollView>
        </Dialog.ScrollArea>
        <Dialog.Actions>
          <Button onPress={handleDelete} textColor={theme.colors.error}>
            {t('common.delete')}
          </Button>
          <Button onPress={onDismiss}>{t('common.cancel')}</Button>
          <Button
            mode="contained"
            onPress={handleSave}
            loading={saving}
            disabled={saving || loading || !description.trim()}
          >
            {t('common.save')}
          </Button>
        </Dialog.Actions>
      </Dialog>
    </Portal>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: 24,
    gap: 8,
    paddingBottom: 8,
  },
  sectionTitle: {
    marginTop: 8,
    fontWeight: '600',
  },
  capRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 8,
    paddingLeft: 10,
  },
  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  chip: {
    height: 26,
  },
});
