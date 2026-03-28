import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { View, ScrollView, StyleSheet, Alert } from 'react-native';
import {
  Text,
  Button,
  TextInput,
  Chip,
  Card,
  IconButton,
  useTheme,
  ActivityIndicator,
  Snackbar,
  FAB,
} from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useEntityStore } from '../../store/entityStore';
import { missionApi, templateApi } from '../../services/api';
import type { SkillTemplate, SoulTemplate, RuleTemplate } from '../../services/api';
import { socketService } from '../../services/socketService';

type TabKey = 'todo' | 'missions' | 'done' | 'notes' | 'skills' | 'souls' | 'rules' | 'variables';

interface MissionItem {
  id: string;
  title: string;
  status: 'todo' | 'mission' | 'done';
  createdAt: number;
}

interface Dashboard {
  todos: MissionItem[];
  missions: MissionItem[];
  done: MissionItem[];
  notes: Array<{ id: string; content: string }>;
  skills: Array<{ id: string; name: string; description: string }>;
  souls: Array<{ id: string; name: string; personality: string }>;
  rules: Array<{ id: string; content: string; priority: number }>;
  version: number;
}

const TABS: { key: TabKey; i18nKey: string }[] = [
  { key: 'todo', i18nKey: 'mission.todo' },
  { key: 'missions', i18nKey: 'mission.missions' },
  { key: 'done', i18nKey: 'mission.done' },
  { key: 'notes', i18nKey: 'mission.notes' },
  { key: 'skills', i18nKey: 'mission.skills' },
  { key: 'souls', i18nKey: 'mission.souls' },
  { key: 'rules', i18nKey: 'mission.rules' },
  { key: 'variables', i18nKey: 'mission.variables' },
];

export default function MissionScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { entities } = useEntityStore();
  const selectedEntity = entities[0] ?? null;

  const [activeTab, setActiveTab] = useState<TabKey>('todo');
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [snack, setSnack] = useState('');

  // Template state
  const [skillTemplates, setSkillTemplates] = useState<SkillTemplate[]>([]);
  const [soulTemplates, setSoulTemplates] = useState<SoulTemplate[]>([]);
  const [ruleTemplates, setRuleTemplates] = useState<RuleTemplate[]>([]);
  const [templateSearch, setTemplateSearch] = useState('');

  const loadDashboard = useCallback(async () => {
    if (!selectedEntity) return;
    setIsLoading(true);
    try {
      const res = await missionApi.getDashboard(selectedEntity.entityId);
      setDashboard(res.data.dashboard);
    } catch {
      setSnack(t('errors.server'));
    } finally {
      setIsLoading(false);
    }
  }, [selectedEntity, t]);

  const saveDashboard = useCallback(async (updated: Dashboard) => {
    if (!selectedEntity || !updated) return;
    try {
      await missionApi.saveDashboard(
        selectedEntity.entityId,
        updated,
        updated.version
      );
      setDashboard(updated);
    } catch {
      setSnack(t('errors.server'));
    }
  }, [selectedEntity, t]);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  // Load templates when switching to a template tab
  useEffect(() => {
    if (activeTab === 'skills' && skillTemplates.length === 0) {
      templateApi.getSkillTemplates()
        .then((res) => { if (res.data.success) setSkillTemplates(res.data.templates); })
        .catch(() => {});
    } else if (activeTab === 'souls' && soulTemplates.length === 0) {
      templateApi.getSoulTemplates()
        .then((res) => { if (res.data.success) setSoulTemplates(res.data.templates); })
        .catch(() => {});
    } else if (activeTab === 'rules' && ruleTemplates.length === 0) {
      templateApi.getRuleTemplates()
        .then((res) => { if (res.data.success) setRuleTemplates(res.data.templates); })
        .catch(() => {});
    }
    setTemplateSearch('');
  }, [activeTab]); // eslint-disable-line react-hooks/exhaustive-deps


  const addTodo = async (title: string) => {
    if (!dashboard || !title.trim()) return;
    const newItem: MissionItem = {
      id: Date.now().toString(),
      title: title.trim(),
      status: 'todo',
      createdAt: Date.now(),
    };
    const updated = {
      ...dashboard,
      todos: [...dashboard.todos, newItem],
      version: dashboard.version + 1,
    };
    await saveDashboard(updated);
  };

  const markDone = async (item: MissionItem) => {
    if (!dashboard) return;
    const updated = {
      ...dashboard,
      todos: dashboard.todos.filter((t) => t.id !== item.id),
      missions: dashboard.missions.filter((m) => m.id !== item.id),
      done: [...dashboard.done, { ...item, status: 'done' as const }],
      version: dashboard.version + 1,
    };
    await saveDashboard(updated);
  };

  // Filtered templates
  const filteredSkills = useMemo(() => {
    if (!templateSearch) return skillTemplates;
    const q = templateSearch.toLowerCase();
    return skillTemplates.filter(
      (t) =>
        t.label.toLowerCase().includes(q) ||
        (t.title?.toLowerCase().includes(q)) ||
        (t.author?.toLowerCase().includes(q))
    );
  }, [skillTemplates, templateSearch]);

  const filteredSouls = useMemo(() => {
    if (!templateSearch) return soulTemplates;
    const q = templateSearch.toLowerCase();
    return soulTemplates.filter(
      (t) =>
        (t.label?.toLowerCase().includes(q)) ||
        (t.name?.toLowerCase().includes(q)) ||
        (t.author?.toLowerCase().includes(q))
    );
  }, [soulTemplates, templateSearch]);

  const filteredRules = useMemo(() => {
    if (!templateSearch) return ruleTemplates;
    const q = templateSearch.toLowerCase();
    return ruleTemplates.filter(
      (t) =>
        t.label.toLowerCase().includes(q) ||
        (t.name?.toLowerCase().includes(q)) ||
        (t.author?.toLowerCase().includes(q))
    );
  }, [ruleTemplates, templateSearch]);

  // Tab label with count for template tabs
  const getTabLabel = (tab: { key: TabKey; i18nKey: string }) => {
    const base = t(tab.i18nKey);
    if (tab.key === 'skills' && skillTemplates.length > 0) return `${base} (${skillTemplates.length})`;
    if (tab.key === 'souls' && soulTemplates.length > 0) return `${base} (${soulTemplates.length})`;
    if (tab.key === 'rules' && ruleTemplates.length > 0) return `${base} (${ruleTemplates.length})`;
    return base;
  };

  const renderTodos = () => {
    const items = dashboard?.todos ?? [];
    return (
      <View style={styles.tabContent}>
        {items.length === 0 ? (
          <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center' }}>
            {t('mission.no_todos')}
          </Text>
        ) : (
          items.map((item) => (
            <Card key={item.id} style={styles.itemCard}>
              <Card.Content style={styles.itemContent}>
                <Text variant="bodyLarge" style={{ flex: 1 }}>{item.title}</Text>
                <IconButton
                  icon="check"
                  size={20}
                  onPress={() => markDone(item)}
                />
              </Card.Content>
            </Card>
          ))
        )}
      </View>
    );
  };

  const renderNotes = () => {
    const notes = dashboard?.notes ?? [];
    return (
      <View style={styles.tabContent}>
        {notes.map((note) => (
          <Card key={note.id} style={styles.itemCard}>
            <Card.Content>
              <Text variant="bodyMedium">{note.content}</Text>
            </Card.Content>
          </Card>
        ))}
        {notes.length === 0 && (
          <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center' }}>
            {t('mission.no_notes')}
          </Text>
        )}
      </View>
    );
  };

  const renderSkillCard = (tpl: SkillTemplate) => {
    const hasVars = tpl.requiredVars && tpl.requiredVars.length > 0;
    return (
      <Card key={tpl.id} style={styles.itemCard}>
        <Card.Content>
          <View style={styles.templateHeader}>
            <Text variant="titleSmall" style={{ fontSize: 18, marginRight: 8 }}>
              {tpl.icon || '📦'}
            </Text>
            <View style={{ flex: 1 }}>
              <Text variant="titleSmall">{tpl.label}</Text>
              <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                by {tpl.author || '—'} · {tpl.updatedAt || ''}
              </Text>
            </View>
          </View>
          <Text
            variant="bodySmall"
            style={{ color: hasVars ? theme.colors.tertiary : theme.colors.onSurfaceVariant, marginTop: 4 }}
          >
            {hasVars
              ? `${t('mission.needs_vars', { vars: tpl.requiredVars.map((v) => v.key).join(', ') })}`
              : t('mission.no_api_key_needed')}
          </Text>
        </Card.Content>
      </Card>
    );
  };

  const renderSoulCard = (tpl: SoulTemplate) => (
    <Card key={tpl.id} style={styles.itemCard}>
      <Card.Content>
        <View style={styles.templateHeader}>
          <Text variant="titleSmall" style={{ fontSize: 18, marginRight: 8 }}>
            {tpl.icon || '🧠'}
          </Text>
          <View style={{ flex: 1 }}>
            <Text variant="titleSmall">{tpl.label || tpl.name}</Text>
            <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
              {tpl.author ? `by ${tpl.author}` : t('mission.builtin')} · {tpl.updatedAt || ''}
            </Text>
          </View>
        </View>
        {tpl.description ? (
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }} numberOfLines={2}>
            {tpl.description}
          </Text>
        ) : null}
      </Card.Content>
    </Card>
  );

  const renderRuleCard = (tpl: RuleTemplate) => (
    <Card key={tpl.id} style={styles.itemCard}>
      <Card.Content>
        <View style={styles.templateHeader}>
          <Text variant="titleSmall" style={{ fontSize: 18, marginRight: 8 }}>
            {tpl.icon || '📋'}
          </Text>
          <View style={{ flex: 1 }}>
            <Text variant="titleSmall">{tpl.label}</Text>
            <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
              by {tpl.author || '—'} · {tpl.ruleType || 'WORKFLOW'} · {tpl.updatedAt || ''}
            </Text>
          </View>
        </View>
        {tpl.description ? (
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }} numberOfLines={2}>
            {tpl.description}
          </Text>
        ) : null}
      </Card.Content>
    </Card>
  );

  const renderTemplateTab = (
    type: 'skills' | 'souls' | 'rules',
    items: SkillTemplate[] | SoulTemplate[] | RuleTemplate[],
    renderCard: (item: any) => React.ReactNode,
    emptyKey: string
  ) => (
    <View style={styles.tabContent}>
      <TextInput
        mode="outlined"
        dense
        placeholder={t('mission.search_placeholder')}
        value={templateSearch}
        onChangeText={setTemplateSearch}
        left={<TextInput.Icon icon="magnify" />}
        style={{ marginBottom: 12 }}
      />
      {items.length === 0 ? (
        <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center', marginTop: 16 }}>
          {t(emptyKey)}
        </Text>
      ) : (
        items.map(renderCard)
      )}
    </View>
  );

  if (!selectedEntity) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <View style={styles.centered}>
          <Text variant="titleMedium">{t('home.no_entities')}</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]} edges={['bottom']}>
      {/* Tab bar */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabBar}>
        {TABS.map((tab) => (
          <Chip
            key={tab.key}
            selected={activeTab === tab.key}
            onPress={() => setActiveTab(tab.key)}
            style={styles.tabChip}
            mode={activeTab === tab.key ? 'flat' : 'outlined'}
          >
            {getTabLabel(tab)}
          </Chip>
        ))}
      </ScrollView>

      {/* Content */}
      {isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator />
        </View>
      ) : (
        <ScrollView style={styles.content} contentContainerStyle={{ paddingBottom: 100 }}>
          {activeTab === 'todo' && renderTodos()}
          {activeTab === 'notes' && renderNotes()}
          {activeTab === 'missions' && (
            <View style={styles.tabContent}>
              {(dashboard?.missions ?? []).map((m) => (
                <Card key={m.id} style={styles.itemCard}>
                  <Card.Content style={styles.itemContent}>
                    <Text variant="bodyLarge" style={{ flex: 1 }}>{m.title}</Text>
                    <IconButton icon="check" size={20} onPress={() => markDone(m)} />
                  </Card.Content>
                </Card>
              ))}
              {(dashboard?.missions ?? []).length === 0 && (
                <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center' }}>
                  {t('mission.no_missions')}
                </Text>
              )}
            </View>
          )}
          {activeTab === 'skills' && renderTemplateTab('skills', filteredSkills, renderSkillCard, 'mission.no_skills')}
          {activeTab === 'souls' && renderTemplateTab('souls', filteredSouls, renderSoulCard, 'mission.no_souls')}
          {activeTab === 'rules' && renderTemplateTab('rules', filteredRules, renderRuleCard, 'mission.no_rules')}
          {activeTab === 'done' && (
            <View style={styles.tabContent}>
              {(dashboard?.done ?? []).map((item) => (
                <Card key={item.id} style={styles.itemCard}>
                  <Card.Content>
                    <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>{item.title}</Text>
                  </Card.Content>
                </Card>
              ))}
              {(dashboard?.done ?? []).length === 0 && (
                <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center' }}>
                  {t('mission.done')}
                </Text>
              )}
            </View>
          )}
          {activeTab === 'variables' && (
            <View style={styles.centered}>
              <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                {t('mission.variables')}
              </Text>
            </View>
          )}
        </ScrollView>
      )}

      {/* Add FAB — deprecated, redirect to Kanban */}
      {(activeTab === 'todo' || activeTab === 'missions' || activeTab === 'notes') && (
        <FAB
          icon="plus"
          style={[styles.fab, { opacity: 0.5 }]}
          onPress={() => {
            Alert.alert(
              t('mission.deprecated_title') || 'Feature Deprecated',
              t('mission.deprecated_msg') || 'Please use the Kanban board to add new items. The Kanban board has a complete ecosystem — let bots migrate existing items there gradually.'
            );
          }}
        />
      )}

      <Snackbar visible={!!snack} onDismiss={() => setSnack('')} duration={2000}>
        {snack}
      </Snackbar>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  tabBar: { paddingHorizontal: 12, paddingVertical: 8, flexGrow: 0 },
  tabChip: { marginRight: 6 },
  content: { flex: 1 },
  tabContent: { padding: 16, gap: 8 },
  itemCard: { marginBottom: 8, borderRadius: 16 },
  itemContent: { flexDirection: 'row', alignItems: 'center' },
  templateHeader: { flexDirection: 'row', alignItems: 'center' },
  fab: { position: 'absolute', bottom: 24, right: 16 },
});
