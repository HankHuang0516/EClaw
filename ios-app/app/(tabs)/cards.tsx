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
  Clipboard,
} from 'react-native';
import { useTheme } from 'react-native-paper';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { contactsApi } from '../../services/api';

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
  lastInteractedAt?: number;
  notes?: string;
  pinned: boolean;
  blocked?: boolean;
  category?: string;
  interactionCount: number;
}

interface MyCard {
  publicCode: string;
  entityId: number;
  name?: string;
  avatar?: string;
}

interface ChatMessage {
  content?: string;
  message?: string;
  direction?: string;
  fromDevice?: string;
  timestamp?: number;
}

type Section = 'my-cards' | 'recent' | 'collected';

export default function CardsScreen() {
  const theme = useTheme();
  const { t } = useTranslation();

  const [section, setSection] = useState<Section>('my-cards');
  const [myCards, setMyCards] = useState<MyCard[]>([]);
  const [recentCards, setRecentCards] = useState<CardEntry[]>([]);
  const [collectedCards, setCollectedCards] = useState<CardEntry[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedCard, setSelectedCard] = useState<CardEntry | null>(null);
  const [editNotes, setEditNotes] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [filter, setFilter] = useState('all');

  const loadAll = useCallback(async () => {
    await Promise.all([loadMyCards(), loadRecent(), loadCollected()]);
  }, []);

  const loadMyCards = async () => {
    try {
      const resp = await contactsApi.myCards();
      setMyCards(resp.data?.cards || []);
    } catch (e) {
      console.warn('Failed to load my cards:', e);
    }
  };

  const loadRecent = async () => {
    try {
      const resp = await contactsApi.recent();
      setRecentCards(resp.data?.contacts || []);
    } catch (e) {
      console.warn('Failed to load recent:', e);
    }
  };

  const loadCollected = async () => {
    try {
      const resp = await contactsApi.list({ includeBlocked: true });
      setCollectedCards(resp.data?.contacts || []);
    } catch (e) {
      console.warn('Failed to load collected:', e);
    }
  };

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const onRefresh = async () => {
    setRefreshing(true);
    await loadAll();
    setRefreshing(false);
  };

  const getAvatarValue = (c: { avatar?: string; character?: string }) =>
    c.avatar || (c.character === 'PIG' ? '\u{1F437}' : '\u{1F99E}');

  const renderAvatar = (c: { avatar?: string; character?: string }, size: number = 48, fontSize: number = 28) => {
    const val = getAvatarValue(c);
    if (val.startsWith('https://')) {
      return <Image source={{ uri: val }} style={{ width: size, height: size, borderRadius: size / 2 }} />;
    }
    return <Text style={{ fontSize }}>{val}</Text>;
  };

  const formatTimeAgo = (ts: number) => {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return t('cardHolder.justNow', 'just now');
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    return `${Math.floor(hrs / 24)}d`;
  };

  // ── Detail ──
  const openDetail = (card: CardEntry) => {
    setSelectedCard(card);
    setEditNotes(card.notes || '');
    setEditCategory(card.category || '');
    loadChatHistory(card.publicCode);
  };

  const closeDetail = () => {
    setSelectedCard(null);
    setChatHistory([]);
  };

  const loadChatHistory = async (publicCode: string) => {
    try {
      const resp = await contactsApi.chatHistoryByCode(publicCode);
      setChatHistory(resp.data?.messages || []);
    } catch {
      setChatHistory([]);
    }
  };

  const saveCard = async () => {
    if (!selectedCard) return;
    try {
      await contactsApi.update(selectedCard.publicCode, {
        notes: editNotes,
        category: editCategory || null,
      });
      setCollectedCards(prev => prev.map(c =>
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
      const updated = { ...selectedCard, pinned: !selectedCard.pinned };
      setCollectedCards(prev => prev.map(c =>
        c.publicCode === selectedCard.publicCode ? { ...c, pinned: updated.pinned } : c
      ));
      setSelectedCard(updated);
    } catch (e: any) {
      Alert.alert('Error', e.message);
    }
  };

  const toggleBlock = async () => {
    if (!selectedCard) return;
    const newBlocked = !selectedCard.blocked;
    if (newBlocked) {
      Alert.alert(
        t('cardHolder.block', 'Block'),
        t('cardHolder.blockConfirm', 'Block this agent? They will not be able to send you messages.'),
        [
          { text: t('common.cancel', 'Cancel'), style: 'cancel' },
          { text: t('cardHolder.block', 'Block'), style: 'destructive', onPress: () => doBlock(true) },
        ]
      );
    } else {
      doBlock(false);
    }
  };

  const doBlock = async (blocked: boolean) => {
    if (!selectedCard) return;
    try {
      await contactsApi.update(selectedCard.publicCode, { blocked });
      const updated = { ...selectedCard, blocked };
      setCollectedCards(prev => prev.map(c =>
        c.publicCode === selectedCard.publicCode ? { ...c, blocked } : c
      ));
      setSelectedCard(updated);
    } catch (e: any) {
      Alert.alert('Error', e.message);
    }
  };

  const refreshCard = async () => {
    if (!selectedCard) return;
    try {
      const resp = await contactsApi.refresh(selectedCard.publicCode);
      if (resp.data?.card) {
        setCollectedCards(prev => prev.map(c =>
          c.publicCode === selectedCard.publicCode
            ? { ...c, cardSnapshot: resp.data.card.cardSnapshot, lastRefreshed: resp.data.card.lastRefreshed }
            : c
        ));
      }
      Alert.alert('', t('cardHolder.refreshed', 'Card refreshed'));
    } catch (e: any) {
      Alert.alert('Error', e.message);
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
          text: t('common.delete', 'Remove'),
          style: 'destructive',
          onPress: async () => {
            try {
              await contactsApi.remove(selectedCard.publicCode);
              setCollectedCards(prev => prev.filter(c => c.publicCode !== selectedCard.publicCode));
              closeDetail();
            } catch (e: any) {
              Alert.alert('Error', e.message);
            }
          },
        },
      ]
    );
  };

  const showAddDialog = () => {
    Alert.prompt(
      t('cardHolder.addTitle', 'Add Card'),
      t('cardHolder.addPrompt', 'Enter public code'),
      async (code) => {
        if (!code) return;
        try {
          const resp = await contactsApi.add(code.trim().toLowerCase());
          if (resp.data?.success) loadCollected();
        } catch (e: any) {
          Alert.alert('Error', e.response?.data?.error || e.message);
        }
      },
      'plain-text', '', 'default'
    );
  };

  // ── Detail view ──
  if (selectedCard) {
    const snap = selectedCard.cardSnapshot || {};
    const caps = snap.capabilities || [];
    const protocols = snap.protocols || [];
    const tags = snap.tags || [];
    return (
      <SafeAreaView style={styles.container} edges={['bottom']}>
        <ScrollView style={styles.detailScroll}>
          <View style={styles.detailHeader}>
            {renderAvatar(selectedCard, 56, 40)}
            <View style={{ flex: 1 }}>
              <Text style={styles.detailName}>{selectedCard.name || selectedCard.publicCode}</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Text style={styles.cardCode}>{selectedCard.publicCode}</Text>
                <View style={[styles.statusDot, selectedCard.online ? styles.online : styles.offline]} />
                {selectedCard.blocked && <Text style={styles.blockedBadge}>{t('cardHolder.blockedLabel', 'Blocked')}</Text>}
              </View>
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

          {snap.contactEmail ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>{t('cardHolder.email', 'Email')}</Text>
              <Text style={styles.sectionBody}>{snap.contactEmail}</Text>
            </View>
          ) : null}

          {snap.website ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>{t('cardHolder.website', 'Website')}</Text>
              <Text style={styles.sectionBody}>{snap.website}</Text>
            </View>
          ) : null}

          {snap.version ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>{t('cardHolder.version', 'Version')}</Text>
              <Text style={styles.sectionBody}>{snap.version}</Text>
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
            {selectedCard.lastInteractedAt && <Text style={styles.detailRow}>{t('cardHolder.lastInteraction', 'Last Interaction')}: {new Date(selectedCard.lastInteractedAt).toLocaleString()}</Text>}
          </View>

          {/* Chat History */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{t('cardHolder.chatHistory', 'Chat History')}</Text>
            {chatHistory.length === 0 ? (
              <Text style={styles.chatEmpty}>{t('cardHolder.noChatHistory', 'No chat history')}</Text>
            ) : (
              chatHistory.slice(0, 20).map((m, i) => (
                <View key={i} style={[styles.chatMsg, m.direction === 'outgoing' ? styles.chatSent : styles.chatReceived]}>
                  <Text style={styles.chatText}>{m.content || m.message || ''}</Text>
                  {m.timestamp && <Text style={styles.chatTime}>{new Date(m.timestamp).toLocaleString()}</Text>}
                </View>
              ))
            )}
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
            <TouchableOpacity style={[styles.actionBtn, selectedCard.blocked ? styles.successBtn : styles.dangerBtn]} onPress={toggleBlock}>
              <Text style={[styles.actionText, { color: selectedCard.blocked ? '#4CAF50' : '#F44336' }]}>
                {selectedCard.blocked ? t('cardHolder.unblock', 'Unblock') : t('cardHolder.block', 'Block')}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.actionBtn} onPress={refreshCard}>
              <Text style={styles.actionText}>{t('cardHolder.refresh', 'Refresh')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.actionBtn, styles.primaryBtn]} onPress={saveCard}>
              <Text style={[styles.actionText, { color: '#fff' }]}>{t('common.save', 'Save')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.actionBtn, styles.dangerBtn]} onPress={removeCard}>
              <Text style={[styles.actionText, { color: '#F44336' }]}>{t('common.delete', 'Remove')}</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ── Filtered collected cards ──
  const filteredCollected = collectedCards
    .filter(c => {
      if (filter === 'pinned') return c.pinned;
      if (filter === 'blocked') return c.blocked;
      return !c.blocked;
    })
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return (b.addedAt || 0) - (a.addedAt || 0);
    });

  const renderCollectedCard = ({ item: c }: { item: CardEntry }) => {
    const snap = c.cardSnapshot || {};
    const tags = (snap.tags || []).slice(0, 3);
    return (
      <TouchableOpacity
        style={[styles.card, c.pinned && styles.cardPinned, c.blocked && styles.cardBlocked]}
        onPress={() => openDetail(c)}
        activeOpacity={0.7}
      >
        {c.pinned && !c.blocked && <Text style={styles.pinBadge}>{'\u{1F4CC}'}</Text>}
        {c.blocked && <Text style={styles.blockedCardBadge}>{t('cardHolder.blockedLabel', 'Blocked')}</Text>}
        <View style={styles.cardHeader}>
          {renderAvatar(c, 48, 28)}
          <View style={styles.cardMeta}>
            <Text style={styles.cardName} numberOfLines={1}>{c.name || c.publicCode}</Text>
            <Text style={styles.cardCode}>{c.publicCode}</Text>
          </View>
          <View style={[styles.statusDot, c.online ? styles.online : styles.offline]} />
        </View>
        {snap.description ? <Text style={styles.cardDesc} numberOfLines={2}>{snap.description}</Text> : null}
        {tags.length > 0 && (
          <View style={styles.tagRow}>
            {tags.map((tg, i) => <Text key={i} style={styles.tag}>#{tg}</Text>)}
          </View>
        )}
        <View style={styles.cardFooter}>
          <Text style={styles.exchangeBadge}>{(c.exchangeType || 'manual').replace('_', ' ')}</Text>
          {c.interactionCount > 0 && <Text style={styles.interactions}>{c.interactionCount} {'\u2194'}</Text>}
        </View>
      </TouchableOpacity>
    );
  };

  // ── Main view ──
  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      {/* Section Tabs */}
      <View style={styles.sectionTabs}>
        {(['my-cards', 'recent', 'collected'] as Section[]).map(s => (
          <TouchableOpacity
            key={s}
            style={[styles.sectionTab, section === s && styles.sectionTabActive]}
            onPress={() => setSection(s)}
          >
            <Text style={[styles.sectionTabText, section === s && styles.sectionTabTextActive]}>
              {s === 'my-cards' ? t('cardHolder.myCards', 'My Cards')
               : s === 'recent' ? t('cardHolder.recent', 'Recent')
               : t('cardHolder.collected', 'Collected')}
              {s === 'collected' && <Text style={styles.tabCount}> {collectedCards.filter(c => !c.blocked).length}</Text>}
            </Text>
          </TouchableOpacity>
        ))}
        <TouchableOpacity onPress={showAddDialog} style={styles.addBtnHeader}>
          <Text style={styles.addBtnText}>+</Text>
        </TouchableOpacity>
      </View>

      {/* My Cards Section */}
      {section === 'my-cards' && (
        <ScrollView
          style={styles.sectionContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        >
          {myCards.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyIcon}>{'\u{1F4CB}'}</Text>
              <Text style={styles.emptyText}>{t('cardHolder.myCardsEmpty', 'No agent cards configured')}</Text>
              <Text style={styles.emptySubText}>{t('cardHolder.myCardsEmptySub', 'Set up agent cards on your entities to share them')}</Text>
            </View>
          ) : (
            <View style={styles.myCardsRow}>
              {myCards.map(c => (
                <View key={c.publicCode} style={styles.myCardItem}>
                  {renderAvatar(c, 56, 36)}
                  <Text style={styles.myCardName}>{c.name || c.publicCode}</Text>
                  <Text style={styles.cardCode}>{c.publicCode}</Text>
                  <TouchableOpacity
                    style={styles.copyBtn}
                    onPress={() => {
                      Clipboard.setString(c.publicCode);
                      Alert.alert('', t('common.copy', 'Copied'));
                    }}
                  >
                    <Text style={styles.copyBtnText}>{t('common.copy', 'Copy')}</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}
        </ScrollView>
      )}

      {/* Recent Section */}
      {section === 'recent' && (
        <ScrollView
          style={styles.sectionContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        >
          {recentCards.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyIcon}>{'\u{1F552}'}</Text>
              <Text style={styles.emptyText}>{t('cardHolder.recentEmpty', 'No recent interactions')}</Text>
              <Text style={styles.emptySubText}>{t('cardHolder.recentEmptySub', 'Cards you interact with will appear here')}</Text>
            </View>
          ) : (
            recentCards.map(c => (
              <TouchableOpacity key={c.publicCode} style={styles.recentItem} onPress={() => openDetail(c)}>
                {renderAvatar(c, 48, 28)}
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardName}>{c.name || c.publicCode}</Text>
                  <Text style={styles.cardCode}>{c.publicCode}</Text>
                </View>
                <View style={[styles.statusDot, c.online ? styles.online : styles.offline]} />
                {c.lastInteractedAt && <Text style={styles.timeAgo}>{formatTimeAgo(c.lastInteractedAt)}</Text>}
              </TouchableOpacity>
            ))
          )}
        </ScrollView>
      )}

      {/* Collected Section */}
      {section === 'collected' && (
        <View style={{ flex: 1 }}>
          <View style={styles.filterBar}>
            {['all', 'pinned', 'blocked'].map(f => (
              <TouchableOpacity
                key={f}
                style={[styles.filterChip, filter === f && styles.filterChipActive]}
                onPress={() => setFilter(f)}
              >
                <Text style={[styles.filterChipText, filter === f && styles.filterChipTextActive]}>
                  {f === 'all' ? t('common.all', 'All')
                   : f === 'pinned' ? t('cardHolder.pin', 'Pinned')
                   : t('cardHolder.blockedLabel', 'Blocked')}
                </Text>
              </TouchableOpacity>
            ))}
            <Text style={styles.count}>{filteredCollected.length} / {collectedCards.length}</Text>
          </View>
          <FlatList
            data={filteredCollected}
            renderItem={renderCollectedCard}
            keyExtractor={c => c.publicCode}
            numColumns={2}
            contentContainerStyle={styles.grid}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
            ListEmptyComponent={
              <View style={styles.empty}>
                <Text style={styles.emptyIcon}>{'\u{1F4C7}'}</Text>
                <Text style={styles.emptyText}>
                  {filter === 'blocked'
                    ? t('cardHolder.noBlocked', 'No blocked cards')
                    : t('cardHolder.empty', 'No cards yet')}
                </Text>
              </View>
            }
          />
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0D0D1A' },
  sectionTabs: { flexDirection: 'row', borderBottomWidth: 2, borderBottomColor: '#333355', paddingHorizontal: 8 },
  sectionTab: { paddingVertical: 12, paddingHorizontal: 16 },
  sectionTabActive: { borderBottomWidth: 2, borderBottomColor: '#6C63FF', marginBottom: -2 },
  sectionTabText: { color: '#777', fontSize: 14, fontWeight: '500' },
  sectionTabTextActive: { color: '#6C63FF' },
  tabCount: { fontSize: 11, color: '#777' },
  addBtnHeader: { marginLeft: 'auto', justifyContent: 'center', paddingHorizontal: 12 },
  addBtnText: { color: '#6C63FF', fontSize: 22, fontWeight: '600' },
  sectionContent: { flex: 1, padding: 16 },
  // My Cards
  myCardsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  myCardItem: { backgroundColor: '#1A1A2E', borderRadius: 12, borderWidth: 1, borderColor: '#333355', padding: 16, alignItems: 'center', width: 160 },
  myCardAvatar: { fontSize: 36, marginBottom: 6 },
  myCardName: { color: '#fff', fontSize: 14, fontWeight: '600', textAlign: 'center' },
  copyBtn: { marginTop: 6, borderWidth: 1, borderColor: '#333355', borderRadius: 4, paddingHorizontal: 10, paddingVertical: 3 },
  copyBtnText: { color: '#777', fontSize: 11 },
  // Recent
  recentItem: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, backgroundColor: '#1A1A2E', borderRadius: 12, borderWidth: 1, borderColor: '#333355', marginBottom: 8 },
  timeAgo: { color: '#777', fontSize: 11 },
  // Filter
  filterBar: { flexDirection: 'row', gap: 8, padding: 12, alignItems: 'center' },
  filterChip: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 16, borderWidth: 1, borderColor: '#333355', backgroundColor: '#252540' },
  filterChipActive: { backgroundColor: '#6C63FF', borderColor: '#6C63FF' },
  filterChipText: { color: '#777', fontSize: 13 },
  filterChipTextActive: { color: '#fff' },
  count: { color: '#777', fontSize: 12, marginLeft: 'auto' },
  // Cards
  grid: { paddingHorizontal: 8 },
  card: { flex: 1, backgroundColor: '#1A1A2E', borderRadius: 12, borderWidth: 1, borderColor: '#333355', margin: 6, padding: 14, maxWidth: '48%' },
  cardPinned: { borderColor: '#FFD700' },
  cardBlocked: { opacity: 0.5, borderColor: '#F44336' },
  pinBadge: { position: 'absolute', top: 6, right: 8, fontSize: 12 },
  blockedCardBadge: { position: 'absolute', top: 6, right: 8, fontSize: 10, color: '#fff', backgroundColor: '#F44336', paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4, overflow: 'hidden' },
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
  emptySubText: { color: '#555', fontSize: 13, marginTop: 4, textAlign: 'center' },
  // Detail
  detailScroll: { flex: 1, padding: 16 },
  detailHeader: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 16 },
  detailAvatar: { fontSize: 40 },
  detailName: { color: '#fff', fontSize: 18, fontWeight: '700' },
  blockedBadge: { fontSize: 10, color: '#fff', backgroundColor: '#F44336', paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4, overflow: 'hidden' },
  closeBtn: { color: '#777', fontSize: 22, padding: 4 },
  section: { marginBottom: 16 },
  sectionTitle: { color: '#777', fontSize: 12, fontWeight: '600', textTransform: 'uppercase', marginBottom: 6 },
  sectionBody: { color: '#aaa', fontSize: 14, lineHeight: 20 },
  capItem: { backgroundColor: '#252540', borderRadius: 8, padding: 10, marginBottom: 6 },
  capName: { color: '#fff', fontSize: 13, fontWeight: '600' },
  capDesc: { color: '#aaa', fontSize: 12, marginTop: 2 },
  protocolBadge: { color: '#2196F3', fontSize: 12, backgroundColor: 'rgba(33,150,243,0.15)', paddingHorizontal: 10, paddingVertical: 3, borderRadius: 10 },
  detailRow: { color: '#aaa', fontSize: 13, paddingVertical: 4 },
  // Chat
  chatEmpty: { color: '#555', fontSize: 13, textAlign: 'center', paddingVertical: 16 },
  chatMsg: { padding: 8, borderRadius: 8, marginBottom: 4, maxWidth: '85%' },
  chatSent: { backgroundColor: 'rgba(108,99,255,0.15)', alignSelf: 'flex-end' },
  chatReceived: { backgroundColor: '#252540', alignSelf: 'flex-start' },
  chatText: { color: '#ddd', fontSize: 13 },
  chatTime: { color: '#555', fontSize: 10, marginTop: 2 },
  // Inputs
  notesInput: { backgroundColor: '#252540', borderRadius: 8, borderWidth: 1, borderColor: '#333355', color: '#fff', fontSize: 13, padding: 10, minHeight: 60, textAlignVertical: 'top' },
  categoryInput: { backgroundColor: '#252540', borderRadius: 8, borderWidth: 1, borderColor: '#333355', color: '#fff', fontSize: 13, padding: 10 },
  detailActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8, marginBottom: 32 },
  actionBtn: { flex: 1, minWidth: 80, alignItems: 'center', paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: '#333355' },
  actionText: { color: '#aaa', fontSize: 13, fontWeight: '600' },
  primaryBtn: { backgroundColor: '#6C63FF', borderColor: '#6C63FF' },
  dangerBtn: { borderColor: '#F44336' },
  successBtn: { borderColor: '#4CAF50' },
});
