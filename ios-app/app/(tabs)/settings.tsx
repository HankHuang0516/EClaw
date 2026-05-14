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
  TextInput,
  useTheme,
  Snackbar,
  ActivityIndicator,
} from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import i18next from 'i18next';
import { useAuthStore } from '../../store/authStore';
import { authApi } from '../../services/api';
import { Alert, Linking } from 'react-native';
import { SUPPORTED_LANGUAGES } from '../../i18n';
import Constants from 'expo-constants';

export default function SettingsScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();
  const { deviceId, user, authToken, clearUserSession, clearAll, language, setLanguage } = useAuthStore();

  const [langDialogVisible, setLangDialogVisible] = useState(false);
  const [emailDialogVisible, setEmailDialogVisible] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [emailLoading, setEmailLoading] = useState(false);
  const [boundEmail, setBoundEmail] = useState<string | null>(null);
  const [snack, setSnack] = useState('');
  const [notifBotReply, setNotifBotReply] = useState(true);
  const [notifBroadcast, setNotifBroadcast] = useState(true);

  const appVersion = Constants.expoConfig?.version ?? '1.0.0';

  // Mirrors Android SettingsActivity.showBindEmailDialog() — this is
  // account REGISTRATION (bind device to new email), not login.
  const handleBindEmail = async () => {
    if (!email.trim() || !password.trim()) {
      setSnack(t('settings.bind_email_fill_all', 'Please fill in all fields'));
      return;
    }
    // Password rules: ≥6 chars, must contain both letters and digits
    if (password.length < 6 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
      setSnack(t('settings.bind_email_password_invalid', 'Password must be at least 6 characters with both letters and numbers'));
      return;
    }
    if (password !== confirmPassword) {
      setSnack(t('settings.bind_email_password_mismatch', 'Passwords do not match'));
      return;
    }
    setEmailLoading(true);
    try {
      const res = await authApi.bindEmail(email.trim(), password.trim());
      if (res.data?.success) {
        setBoundEmail(email.trim());
        setEmailDialogVisible(false);
        setEmail('');
        setPassword('');
        setConfirmPassword('');
        setSnack(t('settings.bind_email_success', 'Email bound successfully'));
      } else {
        setSnack(res.data?.message || res.data?.error || t('settings.bind_email_fail', 'Binding failed'));
      }
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.response?.data?.message || err.message || 'Error';
      setSnack(msg);
    } finally {
      setEmailLoading(false);
    }
  };

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
    try {
      if (authToken) {
        await authApi.logout().catch(() => {}); // best-effort; invalidate server-side JWT
      }
    } finally {
      await clearUserSession();
      router.replace('/(auth)/login');
    }
  };

  const handleDeleteAccount = async () => {
    Alert.alert(
      t('auth.delete_account', 'Delete Account'),
      t('auth.delete_account_confirm', 'This will permanently delete your account and all data. This cannot be undone.'),
      [
        { text: t('common.cancel', 'Cancel'), style: 'cancel' },
        {
          text: t('auth.delete_account', 'Delete Account'),
          style: 'destructive',
          onPress: async () => {
            try {
              await authApi.deleteAccount();
              await clearAll();
              router.replace('/(auth)/login');
            } catch (err: any) {
              setSnack(err.message || String(err));
            }
          },
        },
      ]
    );
  };

  const providerLabel = () => {
    if (!user) return t('auth.current_provider_device', 'Device-only authentication');
    switch (user.provider) {
      case 'apple': return t('auth.current_provider_apple', 'Signed in with Apple');
      case 'google': return t('auth.current_provider_google', 'Signed in with Google');
      case 'facebook': return t('auth.current_provider_facebook', 'Signed in with Facebook');
      case 'email': return t('auth.current_provider_email', 'Signed in with Email');
      default: return t('auth.current_provider_device', 'Device-only authentication');
    }
  };

  const currentLang = SUPPORTED_LANGUAGES.find((l) => l.code === language);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]} edges={['bottom']}>
      <ScrollView>
        {/* Account Section */}
        <List.Section title={t('settings.account')}>
          <List.Item
            title={user?.email || boundEmail || t('settings.email_not_bound')}
            description={providerLabel()}
            left={(props) => <List.Icon {...props} icon="account" />}
          />
          {!user?.email && !boundEmail && (
            <List.Item
              title={t('auth.bind_email_cta', 'Bind Email')}
              description={t('auth.bind_email_banner', 'Bind an email to secure your account across devices')}
              left={(props) => <List.Icon {...props} icon="email-plus" />}
              right={(props) => <List.Icon {...props} icon="chevron-right" />}
              onPress={() => router.push('/bind-email')}
            />
          )}
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

        {/* Services */}
        <List.Section title={t('settings.services', 'Services')}>
          <List.Item
            title={t('settings.wallet', 'My Wallet')}
            left={(props) => <List.Icon {...props} icon="wallet" />}
            right={(props) => <List.Icon {...props} icon="chevron-right" />}
            onPress={() => router.push('/wallet')}
          />
          <List.Item
            title={t('settings.my_rentals', 'My Rentals')}
            left={(props) => <List.Icon {...props} icon="robot" />}
            right={(props) => <List.Icon {...props} icon="chevron-right" />}
            onPress={() => router.push('/my-rentals')}
          />
          <List.Item
            title={t('settings.invite_friends', 'Invite Friends')}
            left={(props) => <List.Icon {...props} icon="account-plus" />}
            right={(props) => <List.Icon {...props} icon="chevron-right" />}
            onPress={() => router.push('/invite')}
          />
          <List.Item
            title={t('settings.kanban_nudge', '📋 Kanban Nudge Settings')}
            left={(props) => <List.Icon {...props} icon="clipboard-list" />}
            right={(props) => <List.Icon {...props} icon="open-in-new" />}
            onPress={() => Linking.openURL('https://eclawbot.com/portal/settings.html#kanban-nudge-card').catch(() => {})}
          />
          <List.Item
            title={t('settings.mindmap', '🧠 Mind Map')}
            left={(props) => <List.Icon {...props} icon="graph-outline" />}
            right={(props) => <List.Icon {...props} icon="open-in-new" />}
            onPress={() => Linking.openURL('https://eclawbot.com/portal/mindmap.html').catch(() => {})}
          />
        </List.Section>

        <Divider />

        {/* More */}
        <List.Section>
          <List.Item
            title={t('settings.intro_guide', 'Tutorial & Intro')}
            description={t('settings.intro_guide_desc', 'Watch the 75s demo + Quick Start walkthrough')}
            left={(props) => <List.Icon {...props} icon="play-circle-outline" />}
            right={(props) => <List.Icon {...props} icon="open-in-new" />}
            onPress={() => Linking.openURL('https://eclawbot.com/info.html#guide').catch(() => {})}
          />
          <List.Item
            title={t('settings.file_manager', 'Files')}
            left={(props) => <List.Icon {...props} icon="folder" />}
            right={(props) => <List.Icon {...props} icon="chevron-right" />}
            onPress={() => router.push('/file-manager')}
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
            onPress={() => Linking.openURL('https://eclawbot.com/privacy-policy.html').catch(() => {})}
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
          <Button
            mode="text"
            onPress={handleDeleteAccount}
            icon="account-remove"
            textColor={theme.colors.error}
            style={styles.deleteBtn}
          >
            {t('auth.delete_account', 'Delete Account')}
          </Button>
          <Text
            variant="bodySmall"
            style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center' }}
          >
            {t('settings.app_version', { version: appVersion })}
          </Text>
        </View>
      </ScrollView>

      {/* Bind Email Dialog */}
      <Portal>
        <Dialog visible={emailDialogVisible} onDismiss={() => setEmailDialogVisible(false)}>
          <Dialog.Title>{t('settings.bind_email')}</Dialog.Title>
          <Dialog.Content>
            <TextInput
              label={t('settings.email_label', 'Email')}
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              mode="outlined"
              style={{ marginBottom: 12 }}
            />
            <TextInput
              label={t('settings.password_label', 'Password')}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              mode="outlined"
              style={{ marginBottom: 12 }}
            />
            <TextInput
              label={t('settings.confirm_password_label', 'Confirm Password')}
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              secureTextEntry
              mode="outlined"
              style={{ marginBottom: 8 }}
            />
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              {t('settings.bind_email_password_hint', 'Password must be at least 6 characters with both letters and numbers')}
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setEmailDialogVisible(false)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              mode="contained"
              onPress={handleBindEmail}
              loading={emailLoading}
              disabled={emailLoading}
            >
              {t('settings.bind_email_confirm', 'Bind')}
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>

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
  deleteBtn: {
    width: '100%',
  },
});
