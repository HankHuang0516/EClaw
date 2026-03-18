import { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  Image,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  TextInput,
  Alert,
  ScrollView,
  RefreshControl,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from 'react-native-paper';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { contactsApi, deviceApi } from '../services/api';
import { useAuthStore } from '../store/authStore';

interface AgentCardSnapshot {
  description?: string;
  capabilities?: { id: string; name: string; description?: string }[];
  protocols?: string[];
  tags?: string[];
  version?: string;
  website?: string;
  contactEmail?: string;
}

interface CardEntry {
  publicCode: string;
  name?: string;
  character?: string;
  avatar?: string;
  online: boolean;
  cardSnapshot?: AgentCardSnapshot;
  exchangeType?: string;
  lastRefreshed?: number;
  addedAt?: number;
  notes?: string;
  pinned: boolean;
  category?: string;
  interactionCount: number;
}

export default function CardHolderScreen() {
  const router = useRouter();
  const theme = useTheme();
  const { t } = useTranslation();
  const { deviceId, deviceSecret } = useAuthStore();

  const [cards, setCards] = useState<CardEntry[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [selectedCard, setSelectedCard] = useState<CardEntry | null>(null);
  const [editNotes, setEditNotes] = useState('');
  const [editCategory, setEditCategory] = useState('');

  const loadCards = useCallback(async () => {
    try {
      const resp = await contactsApi.list();
      setCards(resp.data?.contacts || []);
    } catch (e) {
      console.warn('Failed to load cards:', e);
    }
  }, []);

  useEffect(() => {
    loadCards();
  }, [loadCards]);

  const onRefresh = async () => {
    setRefreshing(true);
    await loadCards();
    setRefreshing(false);
  };

  const filteredCards = cards
    .filter(c => {
      if (!searchQuery) return true;
      const q = searchQuery.toLowerCase();
      const snap = c.cardSnapshot || {};
      const searchable = [
        c.name, c.publicCode, c.notes, c.category,
        snap.description,
        ...(snap.tags || []),
        ...(snap.capabilities || []).map(cap => cap.name),
      ].filter(Boolean).join(' ').toLowerCase();
      return searchable.includes(q);
    })
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return (b.addedAt || 0) - (a.addedAt || 0);
    });

  const getAvatarValue = (c: CardEntry) =>
    c.avatar || (c.character === 'PIG' ? '\u{1F437}' : '\u{1F99E}');

  const renderAvatar = (c: CardEntry, size: number = 48, fontSize: number = 28) => {
    const val = getAvatarValue(c);
    if (val.startsWith('https://')) {
      return <Image source={{ uri: val }} style={{ width: size, height: size, borderRadius: size / 2 }} />;
    }
    return <Text style={{ fontSize }}>{val}</Text>;
  };

  const showAddDialog = () => {
    Alert.prompt(
      t('cardHolder.addTitle', 'Add Card'),
      t('cardHolder.addPrompt', 'Enter public code'),
      async (code) => {
        if (!code) return;
        try {
          const resp = await contactsApi.add(code.trim().toLowerCase());
          if (resp.data?.success) {
            loadCards();
          }
        } catch (e: any) {
          Alert.alert('Error', e.response?.data?.error || e.message);
        }
      },
      'plain-text',
      '',
      'default'
    );
  };

  const openDetail = (card: CardEntry) => {
    setSelectedCard(card);
    setEditNotes(card.notes || '');
    setEditCategory(card.category || '');
  };

  const closeDetail = () => setSelectedCard(null);

  const saveCard = async () => {
    if (!selectedCard) return;
    try {
      await contactsApi.update(selectedCard.publicCode, {
        notes: editNotes,
        category: editCategory || null,
      });
      setCards(prev => prev.map(c =>
        c.publicCode === selectedCard.publicCode
          ? { ...c, notes: editNotes, category: editCategory || undefined }
          : c
      ));
      closeDetail();
    } catch (e: any) {
      Alert.alert('Error', e.message);
    }
  };

  const togglePin = async () => {
    if (!selectedCard) return;
    try {
      await contactsApi.update(selectedCard.publicCode, { pinned: !selectedCard.pinned });
      setCards(prev => prev.map(c =>
        c.publicCode === selectedCard.publicCode ? { ...c, pinned: !c.pinned } : c
      ));
      setSelectedCard(prev => prev ? { ...prev, pinned: !prev.pinned } : null);
    } catch (e: any) {
      Alert.alert('Error', e.message);
    }
  };

  const refreshCard = async () => {
    if (!selectedCard) return;
    try {
      const resp = await contactsApi.refresh(selectedCard.publicCode);
      if (resp.data?.card) {
        setCards(prev => prev.map(c =>
          c.publicCode === selectedCard.publicCode
            ? { ...c, cardSnapshot: resp.data.card.cardSnapshot, lastRefreshed: resp.data.card.lastRefreshed }
            : c
        ));
      }
      Alert.alert('', t('cardHolder.refreshed', 'Card refreshed'));
    } catch (e: any) {
      Alert.alert('Error', e.response?.data?.error || e.message);
    }
  };

  const removeCard = () => {
    if (!selectedCard) return;
    Alert.alert(
      t('cardHolder.removeTitle', 'Remove Card'),
      t('cardHolder.removeMsg', 'Remove this card from your holder?'),
      [
        { text: t('common.cancel', 'Cancel'), style: 'cancel' },
        {
          text: t('common.remove', 'Remove'),
          style: 'destructive',
          onPress: async () => {
            try {
              await contactsApi.remove(selectedCard.publicCode);
              setCards(prev => prev.filter(c => c.publicCode !== selectedCard.publicCode));
              closeDetail();
            } catch (e: any) {
              Alert.alert('Error', e.message);
            }
          },
        },
      ]
    );
  };

  const renderCard = ({ item: c }: { item: CardEntry }) => {
    const snap = c.cardSnapshot || {};
    const tags = (snap.tags || []).slice(0, 3);
    return (
      <TouchableOpacity
        style={[styles.card, c.pinned && styles.cardPinned]}
        onPress={() => openDetail(c)}
        activeOpacity={0.7}
      >
        {c.pinned && <Text style={styles.pinBadge}>{'\u{1F4CC}'}</Text>}
        <View style={styles.cardHeader}>
          {renderAvatar(c, 48, 28)}
          <View style={styles.cardMeta}>
            <Text style={styles.cardName} numberOfLines={1}>{c.name || c.publicCode}</Text>
            <Text style={styles.cardCode}>{c.publicCode}</Text>
          </View>
          <View style={[styles.statusDot, c.online ? styles.online : styles.offline]} />
        </View>
        {snap.description ? (
          <Text style={styles.cardDesc} numberOfLines={2}>{snap.description}</Text>
        ) : null}
        {tags.length > 0 && (
          <View style={styles.tagRow}>
            {tags.map((tag, i) => (
              <Text key={i} style={styles.tag}>#{tag}</Text>
            ))}
          </View>
        )}
        <View style={styles.cardFooter}>
          <Text style={styles.exchangeBadge}>{(c.exchangeType || 'manual').replace('_', ' ')}</Text>
          {c.interactionCount > 0 && (
            <Text style={styles.interactions}>{c.interactionCount} {'\u2194'}</Text>
          )}
        </View>
      </TouchableOpacity>
    );
  };

  // ── Detail modal ──
  if (selectedCard) {
    const snap = selectedCard.cardSnapshot || {};
    const caps = snap.capabilities || [];
    const protocols = snap.protocols || [];
    const tags = snap.tags || [];
    return (
      <SafeAreaView style={styles.container}>
        <ScrollView style={styles.detailScroll}>
          <View style={styles.detailHeader}>
            {renderAvatar(selectedCard, 56, 40)}
            <View style={{ flex: 1 }}>
              <Text style={styles.detailName}>{selectedCard.name || selectedCard.publicCode}</Text>
              <Text style={styles.cardCode}>{selectedCard.publicCode}</Text>
            </View>
            <TouchableOpacity onPress={closeDetail}>
              <Text style={styles.closeBtn}>{'\u2715'}</Text>
            </TouchableOpacity>
          </View>

          {snap.description ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>{t('cardHolder.description', 'Description')}</Text>
              <Text style={styles.sectionBody}>{snap.description}</Text>
            </View>
          ) : null}

          {caps.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>{t('cardHolder.capabilities', 'Capabilities')}</Text>
              {caps.map((cap, i) => (
                <View key={i} style={styles.capItem}>
                  <Text style={styles.capName}>{cap.name}</Text>
                  {cap.description ? <Text style={styles.capDesc}>{cap.description}</Text> : null}
                </View>
              ))}
            </View>
          )}

          {protocols.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>{t('cardHolder.protocols', 'Protocols')}</Text>
              <View style={styles.tagRow}>{protocols.map((p, i) => <Text key={i} style={styles.protocolBadge}>{p}</Text>)}</View>
            </View>
          )}

          {tags.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>{t('cardHolder.tags', 'Tags')}</Text>
              <View style={styles.tagRow}>{tags.map((tg, i) => <Text key={i} style={styles.tag}>#{tg}</Text>)}</View>
            </View>
          )}

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{t('cardHolder.details', 'Details')}</Text>
            <Text style={styles.detailRow}>{t('cardHolder.exchangeType', 'Type')}: {selectedCard.exchangeType || 'manual'}</Text>
            <Text style={styles.detailRow}>{t('cardHolder.interactions', 'Interactions')}: {selectedCard.interactionCount}</Text>
            {selectedCard.addedAt && <Text style={styles.detailRow}>{t('cardHolder.added', 'Added')}: {new Date(selectedCard.addedAt).toLocaleDateString()}</Text>}
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{t('cardHolder.notes', 'Notes')}</Text>
            <TextInput
              style={styles.notesInput}
              value={editNotes}
              onChangeText={setEditNotes}
              placeholder={t('cardHolder.notesHint', 'Add your notes...')}
              placeholderTextColor="#777"
              multiline
              maxLength={500}
            />
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{t('cardHolder.category', 'Category')}</Text>
            <TextInput
              style={styles.categoryInput}
              value={editCategory}
              onChangeText={setEditCategory}
              placeholder={t('cardHolder.categoryHint', 'e.g. tools, social, dev')}
              placeholderTextColor="#777"
              maxLength={50}
            />
          </View>

          <View style={styles.detailActions}>
            <TouchableOpacity style={styles.actionBtn} onPress={togglePin}>
              <Text style={styles.actionText}>{selectedCard.pinned ? t('cardHolder.unpin', 'Unpin') : t('cardHolder.pin', 'Pin')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.actionBtn} onPress={refreshCard}>
              <Text style={styles.actionText}>{t('cardHolder.refresh', 'Refresh')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.actionBtn, styles.primaryBtn]} onPress={saveCard}>
              <Text style={[styles.actionText, { color: '#fff' }]}>{t('common.save', 'Save')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.actionBtn, styles.dangerBtn]} onPress={removeCard}>
              <Text style={[styles.actionText, { color: '#F44336' }]}>{t('common.remove', 'Remove')}</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ── Main list ──
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={styles.backBtn}>{'\u2190'}</Text>
        </TouchableOpacity>
        <Text style={styles.title}>{t('cardHolder.title', 'Card Holder')}</Text>
        <TouchableOpacity onPress={showAddDialog}>
          <Text style={styles.addBtn}>+ {t('cardHolder.add', 'Add')}</Text>
        </TouchableOpacity>
      </View>

      <TextInput
        style={styles.searchBar}
        value={searchQuery}
        onChangeText={setSearchQuery}
        placeholder={t('cardHolder.search', 'Search cards...')}
        placeholderTextColor="#777"
      />

      <Text style={styles.count}>{filteredCards.length} / {cards.length}</Text>

      <FlatList
        data={filteredCards}
        renderItem={renderCard}
        keyExtractor={c => c.publicCode}
        numColumns={2}
        contentContainerStyle={styles.grid}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>{'\u{1F4C7}'}</Text>
            <Text style={styles.emptyText}>{t('cardHolder.empty', 'No cards yet')}</Text>
          </View>
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0D0D1A' },
  header: { flexDirection: 'row', alignItems: 'center', padding: 16, gap: 12 },
  backBtn: { color: '#fff', fontSize: 22 },
  title: { flex: 1, color: '#fff', fontSize: 20, fontWeight: '700' },
  addBtn: { color: '#6C63FF', fontSize: 14, fontWeight: '600' },
  searchBar: {
    backgroundColor: '#252540', borderRadius: 20, borderWidth: 1, borderColor: '#333355',
    color: '#fff', fontSize: 14, paddingHorizontal: 16, paddingVertical: 8, marginHorizontal: 16, marginBottom: 8,
  },
  count: { color: '#777', fontSize: 12, marginLeft: 16, marginBottom: 8 },
  grid: { paddingHorizontal: 8 },
  card: {
    flex: 1, backgroundColor: '#1A1A2E', borderRadius: 12, borderWidth: 1, borderColor: '#333355',
    margin: 6, padding: 14, maxWidth: '48%',
  },
  cardPinned: { borderColor: '#FFD700' },
  pinBadge: { position: 'absolute', top: 6, right: 8, fontSize: 12 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  avatar: { fontSize: 28 },
  cardMeta: { flex: 1 },
  cardName: { color: '#fff', fontSize: 14, fontWeight: '600' },
  cardCode: { color: '#777', fontSize: 11, fontFamily: 'monospace' },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  online: { backgroundColor: '#4CAF50' },
  offline: { backgroundColor: '#777' },
  cardDesc: { color: '#aaa', fontSize: 12, marginTop: 6, lineHeight: 16 },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 6 },
  tag: { color: '#6C63FF', fontSize: 11, backgroundColor: 'rgba(108,99,255,0.15)', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 },
  cardFooter: { flexDirection: 'row', alignItems: 'center', marginTop: 8, gap: 8 },
  exchangeBadge: { color: '#6C63FF', fontSize: 10, backgroundColor: '#1a1a3f', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  interactions: { color: '#777', fontSize: 10 },
  empty: { alignItems: 'center', paddingVertical: 60 },
  emptyIcon: { fontSize: 48, marginBottom: 12 },
  emptyText: { color: '#777', fontSize: 15 },
  // Detail
  detailScroll: { flex: 1, padding: 16 },
  detailHeader: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 16 },
  detailAvatar: { fontSize: 40 },
  detailName: { color: '#fff', fontSize: 18, fontWeight: '700' },
  closeBtn: { color: '#777', fontSize: 22, padding: 4 },
  section: { marginBottom: 16 },
  sectionTitle: { color: '#777', fontSize: 12, fontWeight: '600', textTransform: 'uppercase', marginBottom: 6 },
  sectionBody: { color: '#aaa', fontSize: 14, lineHeight: 20 },
  capItem: { backgroundColor: '#252540', borderRadius: 8, padding: 10, marginBottom: 6 },
  capName: { color: '#fff', fontSize: 13, fontWeight: '600' },
  capDesc: { color: '#aaa', fontSize: 12, marginTop: 2 },
  protocolBadge: { color: '#2196F3', fontSize: 12, backgroundColor: 'rgba(33,150,243,0.15)', paddingHorizontal: 10, paddingVertical: 3, borderRadius: 10 },
  detailRow: { color: '#aaa', fontSize: 13, paddingVertical: 4 },
  notesInput: {
    backgroundColor: '#252540', borderRadius: 8, borderWidth: 1, borderColor: '#333355',
    color: '#fff', fontSize: 13, padding: 10, minHeight: 60, textAlignVertical: 'top',
  },
  categoryInput: {
    backgroundColor: '#252540', borderRadius: 8, borderWidth: 1, borderColor: '#333355',
    color: '#fff', fontSize: 13, padding: 10,
  },
  detailActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8, marginBottom: 32 },
  actionBtn: {
    flex: 1, minWidth: 80, alignItems: 'center', paddingVertical: 10,
    borderRadius: 8, borderWidth: 1, borderColor: '#333355',
  },
  actionText: { color: '#aaa', fontSize: 13, fontWeight: '600' },
  primaryBtn: { backgroundColor: '#6C63FF', borderColor: '#6C63FF' },
  dangerBtn: { borderColor: '#F44336' },
});
