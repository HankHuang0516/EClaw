import React, { useState } from 'react';
import { View, ScrollView, StyleSheet } from 'react-native';
import {
  Text,
  List,
  Switch,
  Divider,
  Button,
  Dialog,
  Portal,
  RadioButton,
  useTheme,
  Snackbar,
} from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import i18next from 'i18next';
import { useAuthStore } from '../../store/authStore';
import { authApi } from '../../services/api';
import { SUPPORTED_LANGUAGES } from '../../i18n';
import Constants from 'expo-constants';

export default function SettingsScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();
  const { deviceId, clearCredentials, language, setLanguage } = useAuthStore();

  const [langDialogVisible, setLangDialogVisible] = useState(false);
  const [snack, setSnack] = useState('');
  const [notifBotReply, setNotifBotReply] = useState(true);
  const [notifBroadcast, setNotifBroadcast] = useState(true);

  const appVersion = Constants.expoConfig?.version ?? '1.0.0';

  const handleLanguageChange = async (code: string) => {
    setLanguage(code);
    await i18next.changeLanguage(code);
    setLangDialogVisible(false);
    try {
      await authApi.setLanguage(code);
    } catch {
      // Silent fail — language is still changed locally
    }
  };

  const handleLogout = async () => {
    await clearCredentials();
    setSnack(t('settings.logout'));
  };

  const currentLang = SUPPORTED_LANGUAGES.find((l) => l.code === language);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]} edges={['bottom']}>
      <ScrollView>
        {/* Account Section */}
        <List.Section title={t('settings.account')}>
          <List.Item
            title={t('settings.email_not_bound')}
            description={deviceId ? `Device: ${deviceId.slice(0, 8)}...` : ''}
            left={(props) => <List.Icon {...props} icon="account" />}
          />
          <List.Item
            title={t('settings.bind_email')}
            left={(props) => <List.Icon {...props} icon="email" />}
            right={(props) => <List.Icon {...props} icon="chevron-right" />}
            onPress={() => {}}
          />
        </List.Section>

        <Divider />

        {/* Subscription Section */}
        <List.Section title={t('settings.subscription')}>
          <List.Item
            title={t('settings.subscription_free')}
            description={t('settings.messages_used', { used: 0, total: 15 })}
            left={(props) => <List.Icon {...props} icon="star" />}
            right={() => (
              <Button mode="contained" compact onPress={() => {}}>
                {t('settings.upgrade')}
              </Button>
            )}
          />
        </List.Section>

        <Divider />

        {/* Language */}
        <List.Section title={t('settings.language')}>
          <List.Item
            title={currentLang?.nativeLabel ?? t('settings.system_language')}
            left={(props) => <List.Icon {...props} icon="translate" />}
            right={(props) => <List.Icon {...props} icon="chevron-right" />}
            onPress={() => setLangDialogVisible(true)}
          />
        </List.Section>

        <Divider />

        {/* Notifications */}
        <List.Section title={t('settings.notifications')}>
          <List.Item
            title={t('settings.notif_bot_reply')}
            left={(props) => <List.Icon {...props} icon="bell" />}
            right={() => (
              <Switch value={notifBotReply} onValueChange={setNotifBotReply} />
            )}
          />
          <List.Item
            title={t('settings.notif_broadcast')}
            left={(props) => <List.Icon {...props} icon="bullhorn" />}
            right={() => (
              <Switch value={notifBroadcast} onValueChange={setNotifBroadcast} />
            )}
          />
        </List.Section>

        <Divider />

        {/* Entities */}
        <List.Section title={t('settings.entities')}>
          <List.Item
            title={t('settings.manage_entities')}
            left={(props) => <List.Icon {...props} icon="account-multiple" />}
            right={(props) => <List.Icon {...props} icon="chevron-right" />}
            onPress={() => router.push('/entity-manager')}
          />
        </List.Section>

        <Divider />

        {/* More */}
        <List.Section>
          <List.Item
            title={t('settings.card_holder', 'Card Holder')}
            left={(props) => <List.Icon {...props} icon="card-account-details" />}
            right={(props) => <List.Icon {...props} icon="chevron-right" />}
            onPress={() => router.push('/card-holder')}
          />
          <List.Item
            title={t('settings.submit_feedback')}
            left={(props) => <List.Icon {...props} icon="message-alert" />}
            right={(props) => <List.Icon {...props} icon="chevron-right" />}
            onPress={() => router.push('/feedback')}
          />
          <List.Item
            title={t('settings.privacy_policy')}
            left={(props) => <List.Icon {...props} icon="shield-check" />}
            right={(props) => <List.Icon {...props} icon="chevron-right" />}
            onPress={() => {}}
          />
        </List.Section>

        <Divider />

        {/* Account Actions */}
        <View style={styles.bottomActions}>
          <Button
            mode="outlined"
            onPress={handleLogout}
            icon="logout"
            style={styles.logoutBtn}
          >
            {t('settings.logout')}
          </Button>
          <Text
            variant="bodySmall"
            style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center' }}
          >
            {t('settings.app_version', { version: appVersion })}
          </Text>
        </View>
      </ScrollView>

      {/* Language Dialog */}
      <Portal>
        <Dialog visible={langDialogVisible} onDismiss={() => setLangDialogVisible(false)}>
          <Dialog.Title>{t('settings.language')}</Dialog.Title>
          <Dialog.ScrollArea style={{ maxHeight: 400 }}>
            <ScrollView>
              <RadioButton.Group
                onValueChange={handleLanguageChange}
                value={language}
              >
                <RadioButton.Item
                  label={t('settings.system_language')}
                  value="system"
                />
                {SUPPORTED_LANGUAGES.map((lang) => (
                  <RadioButton.Item
                    key={lang.code}
                    label={lang.nativeLabel}
                    value={lang.code}
                  />
                ))}
              </RadioButton.Group>
            </ScrollView>
          </Dialog.ScrollArea>
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
  bottomActions: {
    padding: 24,
    gap: 16,
    alignItems: 'center',
  },
  logoutBtn: {
    width: '100%',
  },
});
