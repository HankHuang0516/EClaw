import React, { useState, useEffect } from 'react';
import { View, ScrollView, StyleSheet, Modal } from 'react-native';
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
  IconButton,
  Appbar,
} from 'react-native-paper';
import { WebView } from 'react-native-webview';
import { useTranslation } from 'react-i18next';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import i18next from 'i18next';
import { useAuthStore } from '../../store/authStore';
import { authApi, settingsManifestApi, miscApi } from '../../services/api';
import {
  planDynamicRows,
  type DynamicSettingsRow,
} from '../../services/settingsManifest';
import { shouldShowChip, appStoreDeepLink, appStoreHttpsLink } from '../../services/updateChip';
import { Alert, Linking } from 'react-native';
import { SUPPORTED_LANGUAGES } from '../../i18n';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import type { AuthUser } from '../../store/authStore';

export default function SettingsScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();
  const {
    deviceId,
    deviceSecret,
    user,
    authToken,
    clearUserSession,
    clearAll,
    language,
    setLanguage,
    setDeviceCredentials,
    setUserSession,
  } = useAuthStore();

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

  // ── Stage-3 native: Rotate Secret + Switch Device (card_c3b13f64) ──────────
  const [rotateDialogVisible, setRotateDialogVisible] = useState(false);
  const [rotateLoading, setRotateLoading] = useState(false);
  const [switchDialogVisible, setSwitchDialogVisible] = useState(false);
  const [switchDeviceId, setSwitchDeviceId] = useState('');
  const [switchDeviceSecret, setSwitchDeviceSecret] = useState('');
  const [switchLoading, setSwitchLoading] = useState(false);

  const appVersion = Constants.expoConfig?.version ?? '1.0.0';

  // ── Settings auto-sync (manifest Stage 2) ──────────────────────────────────
  // Mirrors Android SettingsActivity.loadSettingsManifest(): fetch
  // GET /api/settings-manifest at launch and surface any settings feature this
  // binary does NOT render natively — opening its web fallback in a WebView. A
  // native feature gated out by the running app version shows a "?" gated-help row.
  // Graceful degradation: any failure leaves the static screen exactly as-is.
  const [manifestRows, setManifestRows] = useState<DynamicSettingsRow[]>([]);
  const [webView, setWebView] = useState<DynamicSettingsRow | null>(null);
  const [helpRow, setHelpRow] = useState<DynamicSettingsRow | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Spec §4 / Stage-2: send the REAL installed version so the backend's
        // minAppVersion gate is correct. Constants.expoConfig.version is the
        // app.json version pinned at build time.
        const res = await settingsManifestApi.get(appVersion, 'ios');
        const data = res.data;
        if (cancelled) return;
        if (!data?.success || !data.manifest) {
          // non-success / missing manifest — keep static screen
          return;
        }
        const rows = planDynamicRows(data.manifest, appVersion);
        if (!cancelled) setManifestRows(rows);
      } catch {
        // offline / 5xx / parse — keep static settings screen, never crash/blank
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [appVersion]);

  // ── Update-available chip (card_1771f826) ──────────────────────────────────
  // iOS counterpart of the Android update chip (card_28a8290a): GET /api/version
  // and surface a chip ONLY when the backend says an update is available AND a
  // local version-compare confirms latest is strictly newer (shouldShowChip).
  // Tapping it deep-links to the App Store product page (itms-apps://, Apple-
  // compliant — the user taps "Update" there; no silent install). Any failure
  // leaves the chip hidden (graceful — never a false "update" prompt).
  const [updateLatest, setUpdateLatest] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await miscApi.getVersion(appVersion);
        const u = res?.data?.update;
        if (cancelled) return;
        if (shouldShowChip(u?.available, appVersion, u?.latestVersion)) {
          setUpdateLatest((u?.latestVersion ?? '').trim() || null);
        }
      } catch {
        // offline / 5xx / parse — keep chip hidden
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [appVersion]);

  const openAppStoreUpdate = async () => {
    try {
      const canDeep = await Linking.canOpenURL(appStoreDeepLink);
      await Linking.openURL(canDeep ? appStoreDeepLink : appStoreHttpsLink);
    } catch {
      Linking.openURL(appStoreHttpsLink).catch(() => {});
    }
  };

  const showUpdateHelp = () => {
    Alert.alert(
      t('settings.update_help_title', 'App update available'),
      t('settings.update_help_body', {
        current: appVersion,
        latest: updateLatest ?? '',
        defaultValue:
          'A newer version (v{{latest}}) is available; you are on v{{current}}. Tap Update to open the App Store, then tap Update there to install — Apple does not allow in-app installs.',
      }),
    );
  };

  const openWebFallback = (row: DynamicSettingsRow) => {
    setHelpRow(null);
    setWebView(row);
  };

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

  // ── Rotate Device Secret (Stage-3 native, card_c3b13f64) ───────────────────
  // Mirrors Android SettingsActivity.showRotateSecretDialog(): destructive
  // confirm → POST /api/device/rotate-secret. The new secret is returned ONCE in
  // `newDeviceSecret`; on success it is persisted via setDeviceCredentials with
  // the SAME deviceId (the credential store seam login.tsx uses). The secret is
  // never surfaced or logged in plaintext — only success/failure is shown.
  const handleRotateSecret = async () => {
    if (!deviceId || !deviceSecret) {
      setSnack(t('settings.rotate_secret_failed', 'Could not rotate Device Secret. Please try again.'));
      return;
    }
    setRotateLoading(true);
    try {
      const res = await authApi.rotateDeviceSecret(deviceId, deviceSecret);
      const newSecret = res.data?.newDeviceSecret;
      if (res.data?.success && newSecret) {
        // Persist the once-returned secret locally, keeping the same deviceId.
        await setDeviceCredentials(deviceId, newSecret);
        setRotateDialogVisible(false);
        setSnack(t('settings.rotate_secret_success', 'Device Secret rotated. The new secret has been saved on this device.'));
      } else {
        setSnack(
          res.data?.error ||
            res.data?.message ||
            t('settings.rotate_secret_failed', 'Could not rotate Device Secret. Please try again.')
        );
      }
    } catch (err: any) {
      // The interceptor already strips to a message; never echo the secret.
      setSnack(err?.message || t('settings.rotate_secret_failed', 'Could not rotate Device Secret. Please try again.'));
    } finally {
      setRotateLoading(false);
    }
  };

  // ── Switch Device (Stage-3 native, card_c3b13f64) ──────────────────────────
  // Mirrors Android SettingsActivity.showSwitchDeviceDialog() + login.tsx's
  // handleDeviceLogin: two inputs (Device ID + masked Device Secret) → the
  // EXISTING authApi.deviceLogin (POST /api/auth/device-login). On success the
  // returned creds are persisted the same way the login screen does
  // (setDeviceCredentials + setUserSession) and the app is reloaded so every
  // screen picks up the new device — the iOS equivalent of Android's
  // launch-intent restart.
  const handleSwitchDevice = async () => {
    const id = switchDeviceId.trim();
    const secret = switchDeviceSecret.trim();
    if (!id || !secret) {
      setSnack(t('auth.fill_required_fields', 'Please fill in all fields'));
      return;
    }
    setSwitchLoading(true);
    try {
      const res = await authApi.deviceLogin(id, secret);
      const data = res.data;
      if (!data?.success && data?.success !== undefined) {
        setSnack(data?.error || data?.message || t('settings.rotate_secret_failed', 'Failed'));
        return;
      }
      // Persist the new device credentials (the entered pair is canonical; prefer
      // any backend-echoed values when present), exactly like login.tsx.
      const respUser = data?.user;
      await setDeviceCredentials(respUser?.deviceId || id, respUser?.deviceSecret || secret);
      const token = data?.authToken || data?.token;
      if (token && respUser) {
        const authUser: AuthUser = {
          id: respUser.id,
          email: respUser.email ?? null,
          displayName: respUser.displayName ?? null,
          avatarUrl: respUser.avatarUrl ?? null,
          provider: 'device',
          subscriptionStatus: respUser.subscriptionStatus,
          googleLinked: respUser.googleLinked,
          facebookLinked: respUser.facebookLinked,
          appleLinked: respUser.appleLinked,
        };
        await setUserSession(token, authUser);
      }
      setSwitchDialogVisible(false);
      setSwitchDeviceId('');
      setSwitchDeviceSecret('');
      // Restart so the whole app reloads under the new device — mirrors the
      // Android post-login restart. In dev/Expo Go reloadAsync may be a no-op;
      // fall back to navigating to the tabs root.
      Alert.alert(
        t('settings.switch_device_success_title', 'Device Switched'),
        t('settings.switch_device_success_msg', {
          account: respUser?.email || respUser?.deviceId || id,
          defaultValue: 'Now signed in as: {{account}}\nThe app will restart to load this device.',
        }),
        [
          {
            text: t('settings.switch_device_restart', 'Restart'),
            onPress: async () => {
              try {
                await Updates.reloadAsync();
              } catch {
                // Not in an OTA-updatable build (e.g. dev client) — soft reload.
                router.replace('/(tabs)');
              }
            },
          },
        ]
      );
    } catch (err: any) {
      setSnack(err?.message || String(err));
    } finally {
      setSwitchLoading(false);
    }
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

        {/* Security & Device (Stage-3 native, card_c3b13f64) — Rotate Secret +
            Switch Device rendered natively instead of via the manifest WebView
            fallback. Both gated behind a device identity (deviceId/deviceSecret). */}
        <List.Section title={t('settings.security_device', 'Security & Device')}>
          <List.Item
            title={t('settings.rotate_device_secret', 'Rotate Device Secret')}
            description={t('settings.rotate_device_secret_hint', 'Generate a new Device Secret if the current one has leaked. Other sessions will need the new value to sign in.')}
            left={(props) => <List.Icon {...props} icon="key-change" />}
            disabled={!deviceId || !deviceSecret}
            onPress={() => setRotateDialogVisible(true)}
          />
          <List.Item
            title={t('settings.switch_device', 'Switch Device')}
            description={t('settings.switch_device_hint', 'Sign this app into a different Device ID. Useful if you have a second admin account with its own entities.')}
            left={(props) => <List.Icon {...props} icon="account-switch" />}
            right={(props) => <List.Icon {...props} icon="chevron-right" />}
            onPress={() => setSwitchDialogVisible(true)}
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
            onPress={() => Linking.openURL('https://eclawbot.com/portal/info.html').catch(() => {})}
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

        {/* Auto-synced settings (manifest Stage 2) — features this app version
            doesn't render natively; opens the web fallback in a WebView. Renders
            nothing when the manifest is empty / fetch failed (graceful degrade). */}
        {manifestRows.length > 0 && (
          <>
            <List.Section title={t('settings.more_section_title', 'More settings')}>
              {manifestRows.map((row) => (
                <List.Item
                  key={row.key}
                  title={row.name}
                  description={
                    row.gated
                      ? t('settings.feature_gated_badge', 'Update app for native screen')
                      : undefined
                  }
                  left={(props) => (
                    <List.Icon
                      {...props}
                      icon={row.gated ? 'alert-circle-outline' : 'open-in-new'}
                    />
                  )}
                  right={(props) => (
                    <IconButton
                      {...props}
                      icon="help-circle-outline"
                      accessibilityLabel={t('settings.feature_help_title', 'About this setting')}
                      onPress={() => setHelpRow(row)}
                    />
                  )}
                  onPress={() => openWebFallback(row)}
                />
              ))}
            </List.Section>
            <Divider />
          </>
        )}

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
          {updateLatest && (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                marginTop: 8,
              }}
            >
              <Button
                mode="contained-tonal"
                compact
                icon="arrow-up-circle-outline"
                onPress={openAppStoreUpdate}
              >
                {t('settings.update_available', {
                  latest: updateLatest,
                  defaultValue: 'Update available · v{{latest}}',
                })}
              </Button>
              <IconButton
                icon="help-circle-outline"
                size={18}
                onPress={showUpdateHelp}
                accessibilityLabel={t('settings.update_help_title', 'App update available')}
              />
            </View>
          )}
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

      {/* Rotate Device Secret confirm (Stage-3 native, card_c3b13f64) —
          destructive; manifest schema marks validation.confirm:true. */}
      <Portal>
        <Dialog visible={rotateDialogVisible} onDismiss={() => !rotateLoading && setRotateDialogVisible(false)}>
          <Dialog.Title>
            {t('settings.rotate_secret_confirm_title', 'Rotate Device Secret?')}
          </Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              {t('settings.rotate_device_secret_hint', 'Generate a new Device Secret if the current one has leaked. Other sessions will need the new value to sign in.')}
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setRotateDialogVisible(false)} disabled={rotateLoading}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              mode="contained"
              onPress={handleRotateSecret}
              loading={rotateLoading}
              disabled={rotateLoading}
              textColor={theme.colors.onError}
              buttonColor={theme.colors.error}
            >
              {t('settings.rotate_secret_confirm_btn', 'Rotate')}
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>

      {/* Switch Device dialog (Stage-3 native, card_c3b13f64) — Device ID +
          masked Device Secret → authApi.deviceLogin, then persist + restart. */}
      <Portal>
        <Dialog visible={switchDialogVisible} onDismiss={() => !switchLoading && setSwitchDialogVisible(false)}>
          <Dialog.Title>{t('settings.switch_device', 'Switch Device')}</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginBottom: 12 }}>
              {t('settings.switch_device_hint', 'Sign this app into a different Device ID. Useful if you have a second admin account with its own entities.')}
            </Text>
            <TextInput
              label={t('settings.device_id', 'Device ID')}
              value={switchDeviceId}
              onChangeText={setSwitchDeviceId}
              autoCapitalize="none"
              autoCorrect={false}
              mode="outlined"
              style={{ marginBottom: 12 }}
              disabled={switchLoading}
            />
            <TextInput
              label={t('settings.device_secret', 'Device Secret')}
              value={switchDeviceSecret}
              onChangeText={setSwitchDeviceSecret}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              mode="outlined"
              disabled={switchLoading}
            />
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setSwitchDialogVisible(false)} disabled={switchLoading}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              mode="contained"
              onPress={handleSwitchDevice}
              loading={switchLoading}
              disabled={switchLoading}
            >
              {t('settings.switch_device_confirm', 'Switch')}
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

      {/* Manifest feature "?" help — what / needs / next step (spec §4) */}
      <Portal>
        <Dialog visible={!!helpRow} onDismiss={() => setHelpRow(null)}>
          <Dialog.Title>
            {t('settings.feature_help_title', 'About this setting')}
          </Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              {helpRow?.gated
                ? t(
                    'settings.feature_gated_help',
                    "This setting has a native screen in a newer app version. Update the app to get it here, or open it on the web now."
                  )
                : t(
                    'settings.feature_web_help',
                    "This setting opens in a web view because the native screen isn't in this app version yet. You can use it on the web now."
                  )}
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setHelpRow(null)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              mode="contained"
              onPress={() => helpRow && openWebFallback(helpRow)}
            >
              {t('settings.open_on_web', 'Open on web')}
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>

      {/* Web fallback WebView — opens the manifest feature's portal page */}
      <Modal
        visible={!!webView}
        animationType="slide"
        onRequestClose={() => setWebView(null)}
      >
        <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }} edges={['top', 'bottom']}>
          <Appbar.Header>
            <Appbar.BackAction onPress={() => setWebView(null)} />
            <Appbar.Content title={webView?.name ?? ''} />
          </Appbar.Header>
          {webView && (
            <WebView
              source={{ uri: webView.webFallback }}
              startInLoadingState
              renderLoading={() => (
                <View style={styles.webLoading}>
                  <ActivityIndicator />
                </View>
              )}
            />
          )}
        </SafeAreaView>
      </Modal>

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
  webLoading: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
