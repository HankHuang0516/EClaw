import React, { useState, useEffect, useCallback } from 'react';
import { View, FlatList, StyleSheet, Alert } from 'react-native';
import {
  Text,
  Card,
  FAB,
  Chip,
  Switch,
  IconButton,
  Dialog,
  Portal,
  TextInput,
  Button,
  RadioButton,
  useTheme,
  ActivityIndicator,
  Snackbar,
} from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from 'expo-router';
import { scheduleApi } from '../services/api';
import { STATUS_COLORS } from '../constants/colors';

interface Schedule {
  id: string;
  message: string;
  frequency: string;
  targetEntityId: string | null;
  isActive: boolean;
  nextRunAt: number | null;
  status: 'pending' | 'active' | 'completed' | 'failed';
}

const FREQUENCY_OPTIONS = [
  'once',
  'every_5min',
  'every_15min',
  'every_30min',
  'every_hour',
  'every_3hours',
  'daily',
  'weekly',
] as const;

const FREQUENCY_CRON: Record<string, string> = {
  once: '',
  every_5min: '*/5 * * * *',
  every_15min: '*/15 * * * *',
  every_30min: '*/30 * * * *',
  every_hour: '0 * * * *',
  every_3hours: '0 */3 * * *',
  daily: '0 9 * * *',
  weekly: '0 9 * * 1',
};

export default function ScheduleScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const navigation = useNavigation();

  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [createVisible, setCreateVisible] = useState(false);
  const [newMessage, setNewMessage] = useState('');
  const [newFrequency, setNewFrequency] = useState<string>('every_hour');
  const [snack, setSnack] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  React.useLayoutEffect(() => {
    navigation.setOptions({ title: t('schedule.title'), headerShown: true });
  }, [navigation, t]);

  const loadSchedules = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await scheduleApi.list();
      setSchedules(res.data.schedules ?? []);
    } catch {
      setSnack(t('errors.server'));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadSchedules();
  }, [loadSchedules]);

  const handleToggle = async (schedule: Schedule) => {
    try {
      await scheduleApi.toggle(schedule.id);
      setSchedules((prev) =>
        prev.map((s) => (s.id === schedule.id ? { ...s, isActive: !s.isActive } : s))
      );
      setSnack(schedule.isActive ? t('schedule.toggle_off') : t('schedule.toggle_on'));
    } catch {
      setSnack(t('errors.server'));
    }
  };

  const handleDelete = (schedule: Schedule) => {
    Alert.alert(t('schedule.delete_confirm'), schedule.message, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: async () => {
          try {
            await scheduleApi.delete(schedule.id);
            setSchedules((prev) => prev.filter((s) => s.id !== schedule.id));
          } catch {
            setSnack(t('errors.server'));
          }
        },
      },
    ]);
  };

  const handleCreate = async () => {
    if (!newMessage.trim()) return;
    setIsSaving(true);
    try {
      const cron = FREQUENCY_CRON[newFrequency] || '';
      await scheduleApi.create({
        message: newMessage.trim(),
        cron,
        frequency: newFrequency,
        targetEntityId: null,
      });
      setCreateVisible(false);
      setNewMessage('');
      setNewFrequency('every_hour');
      await loadSchedules();
    } catch {
      setSnack(t('errors.server'));
    } finally {
      setIsSaving(false);
    }
  };

  const statusColor: Record<string, string> = {
    pending: theme.colors.onSurfaceVariant,
    active: STATUS_COLORS.success,
    completed: theme.colors.primary,
    failed: theme.colors.error,
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]} edges={['bottom']}>
      {isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator />
        </View>
      ) : (
        <FlatList
          data={schedules}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <Card style={styles.card}>
              <Card.Content>
                <View style={styles.cardHeader}>
                  <Text variant="bodyLarge" style={{ flex: 1 }} numberOfLines={2}>
                    {item.message}
                  </Text>
                  <Switch
                    value={item.isActive}
                    onValueChange={() => handleToggle(item)}
                  />
                </View>
                <View style={styles.chipRow}>
                  <Chip compact>{t(`schedule.${item.frequency}` as `schedule.${typeof item.frequency}`) || item.frequency}</Chip>
                  <Chip compact style={{ backgroundColor: statusColor[item.status] + '22' }}>
                    {t(`schedule.status_${item.status}`)}
                  </Chip>
                </View>
              </Card.Content>
              <Card.Actions>
                <IconButton
                  icon="delete"
                  size={20}
                  iconColor={theme.colors.error}
                  onPress={() => handleDelete(item)}
                />
              </Card.Actions>
            </Card>
          )}
          ListEmptyComponent={
            <View style={styles.centered}>
              <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                {t('schedule.add')}
              </Text>
            </View>
          }
        />
      )}

      <FAB icon="plus" style={styles.fab} onPress={() => setCreateVisible(true)} />

      <Portal>
        <Dialog visible={createVisible} onDismiss={() => setCreateVisible(false)}>
          <Dialog.Title>{t('schedule.add')}</Dialog.Title>
          <Dialog.ScrollArea style={{ maxHeight: 400 }}>
            <View style={{ padding: 16, gap: 12 }}>
              <TextInput
                mode="outlined"
                dense
                label={t('schedule.message')}
                value={newMessage}
                onChangeText={setNewMessage}
                multiline
                numberOfLines={3}
              />
              <Text variant="labelLarge">{t('schedule.frequency')}</Text>
              <RadioButton.Group onValueChange={setNewFrequency} value={newFrequency}>
                {FREQUENCY_OPTIONS.map((freq) => (
                  <RadioButton.Item
                    key={freq}
                    label={t(`schedule.${freq}`)}
                    value={freq}
                  />
                ))}
              </RadioButton.Group>
            </View>
          </Dialog.ScrollArea>
          <Dialog.Actions>
            <Button onPress={() => setCreateVisible(false)}>{t('common.cancel')}</Button>
            <Button
              mode="contained"
              onPress={handleCreate}
              loading={isSaving}
              disabled={!newMessage.trim() || isSaving}
            >
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
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  list: { padding: 16, paddingBottom: 100, gap: 12 },
  card: { borderRadius: 16 },
  cardHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  chipRow: { flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' },
  fab: { position: 'absolute', bottom: 24, right: 16 },
});
