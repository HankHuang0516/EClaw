import React, { useState } from 'react';
import { View, StyleSheet, Platform, KeyboardAvoidingView, ScrollView, Alert, Image } from 'react-native';
import { Text, TextInput, Button, Divider, useTheme, ActivityIndicator } from 'react-native-paper';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useRouter, Link } from 'expo-router';
import * as AppleAuthentication from 'expo-apple-authentication';
import { useAuthStore, AuthUser, AuthProvider } from '../../store/authStore';
import { authApi } from '../../services/api';

export default function LoginScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();
  const { setUserSession, setDeviceCredentials, deviceId, deviceSecret } = useAuthStore();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [appleAvailable, setAppleAvailable] = useState(false);
  const [showDeviceLogin, setShowDeviceLogin] = useState(false);
  const [manualDeviceId, setManualDeviceId] = useState('');
  const [manualDeviceSecret, setManualDeviceSecret] = useState('');

  React.useEffect(() => {
    AppleAuthentication.isAvailableAsync().then(setAppleAvailable);
  }, []);

  const handleLoginResponse = async (data: any, provider: AuthProvider) => {
    const { user, authToken, user: { deviceId: dId, deviceSecret: dSecret } = {} } = data;
    // Backend returns authToken in cookie; for mobile we extract from response body when present
    const token = authToken || data.authToken || data.token;
    if (token && user) {
      const authUser: AuthUser = {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        provider,
        subscriptionStatus: user.subscriptionStatus,
        googleLinked: user.googleLinked,
        facebookLinked: user.facebookLinked,
        appleLinked: user.appleLinked,
      };
      await setUserSession(token, authUser);
    }
    // Also persist deviceId + deviceSecret returned by backend (for bot APIs)
    if (user?.deviceId) {
      const ds = user.deviceSecret || dSecret || deviceSecret || '';
      if (ds) await setDeviceCredentials(user.deviceId, ds);
    }
    router.replace('/(tabs)');
  };

  const handleEmailLogin = async () => {
    if (!email.trim() || !password) {
      Alert.alert(t('common.error'), t('auth.fill_required_fields'));
      return;
    }
    setLoading(true);
    try {
      const res = await authApi.login(email.trim().toLowerCase(), password);
      await handleLoginResponse(res.data, 'email');
    } catch (err: any) {
      Alert.alert(t('auth.login_failed'), err.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleAppleLogin = async () => {
    setLoading(true);
    try {
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });
      if (!credential.identityToken) {
        throw new Error('No identity token returned');
      }
      const res = await authApi.oauthApple({
        identityToken: credential.identityToken,
        authorizationCode: credential.authorizationCode ?? undefined,
        fullName: credential.fullName
          ? {
              givenName: credential.fullName.givenName,
              familyName: credential.fullName.familyName,
            }
          : undefined,
        email: credential.email ?? undefined,
        deviceId: deviceId ?? undefined,
        deviceSecret: deviceSecret ?? undefined,
      });
      await handleLoginResponse(res.data, 'apple');
    } catch (err: any) {
      if (err.code === 'ERR_REQUEST_CANCELED') {
        // User cancelled — no error shown
        return;
      }
      Alert.alert(t('auth.apple_failed'), err.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleDeviceLogin = async () => {
    if (!manualDeviceId.trim() || !manualDeviceSecret.trim()) {
      Alert.alert(t('common.error'), t('auth.fill_required_fields'));
      return;
    }
    setLoading(true);
    try {
      const res = await authApi.deviceLogin(manualDeviceId.trim(), manualDeviceSecret.trim());
      await setDeviceCredentials(manualDeviceId.trim(), manualDeviceSecret.trim());
      await handleLoginResponse(res.data, 'device');
    } catch (err: any) {
      Alert.alert(t('auth.login_failed'), err.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView contentContainerStyle={styles.scroll}>
          <View style={styles.header}>
            <Image
              source={require('../../assets/icon.png')}
              style={{ width: 80, height: 80, borderRadius: 20 }}
            />
            <Text variant="headlineLarge" style={styles.title}>
              EClawbot
            </Text>
            <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
              {t('auth.login_tagline', 'Sign in to continue')}
            </Text>
          </View>

          {/* Apple Sign-In (top priority per Apple HIG) */}
          {appleAvailable && (
            <AppleAuthentication.AppleAuthenticationButton
              buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
              buttonStyle={
                theme.dark
                  ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE
                  : AppleAuthentication.AppleAuthenticationButtonStyle.BLACK
              }
              cornerRadius={8}
              style={styles.appleButton}
              onPress={handleAppleLogin}
            />
          )}

          {/* Google / Facebook placeholders — keep for parity with Web; actual native SDK
              integration deferred to Phase 2b if needed */}
          {/* <Button mode="outlined" onPress={handleGoogleLogin}>
            {t('auth.sign_in_with_google')}
          </Button>
          <Button mode="outlined" onPress={handleFacebookLogin}>
            {t('auth.sign_in_with_facebook')}
          </Button> */}

          <View style={styles.divider}>
            <Divider style={{ flex: 1 }} />
            <Text style={styles.dividerText}>{t('auth.or_divider', 'or')}</Text>
            <Divider style={{ flex: 1 }} />
          </View>

          <TextInput
            label={t('auth.email_placeholder', 'Email')}
            value={email}
            onChangeText={setEmail}
            mode="outlined"
            autoCapitalize="none"
            keyboardType="email-address"
            autoComplete="email"
            style={styles.input}
            disabled={loading}
          />
          <TextInput
            label={t('auth.password_placeholder', 'Password')}
            value={password}
            onChangeText={setPassword}
            mode="outlined"
            secureTextEntry
            autoComplete="password"
            style={styles.input}
            disabled={loading}
          />

          <Button
            mode="contained"
            onPress={handleEmailLogin}
            loading={loading}
            disabled={loading}
            style={styles.loginButton}
          >
            {t('auth.login', 'Login')}
          </Button>

          <View style={styles.links}>
            <Link href="/(auth)/register" style={styles.link}>
              <Text style={{ color: theme.colors.primary }}>
                {t('auth.register', 'Register')}
              </Text>
            </Link>
            <Text style={{ color: theme.colors.onSurfaceVariant }}> · </Text>
            <Link href="/(auth)/forgot-password" style={styles.link}>
              <Text style={{ color: theme.colors.primary }}>
                {t('auth.forgot_password', 'Forgot Password?')}
              </Text>
            </Link>
          </View>

          <Divider style={{ marginVertical: 24 }} />

          <Button
            mode="text"
            onPress={() => setShowDeviceLogin(!showDeviceLogin)}
            style={styles.advancedToggle}
          >
            {showDeviceLogin
              ? t('auth.hide_device_login', 'Hide Device Login')
              : t('auth.device_login_advanced', 'Device Login (Advanced)')}
          </Button>

          {showDeviceLogin && (
            <View style={styles.deviceSection}>
              <TextInput
                label="Device ID"
                value={manualDeviceId}
                onChangeText={setManualDeviceId}
                mode="outlined"
                autoCapitalize="none"
                style={styles.input}
                disabled={loading}
              />
              <TextInput
                label="Device Secret"
                value={manualDeviceSecret}
                onChangeText={setManualDeviceSecret}
                mode="outlined"
                secureTextEntry
                autoCapitalize="none"
                style={styles.input}
                disabled={loading}
              />
              <Button
                mode="contained-tonal"
                onPress={handleDeviceLogin}
                loading={loading}
                disabled={loading}
              >
                {t('auth.login_with_device', 'Login with Device')}
              </Button>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { padding: 24, paddingTop: 32 },
  header: { alignItems: 'center', marginBottom: 32 },
  title: { marginTop: 8, marginBottom: 4, fontWeight: 'bold' },
  appleButton: { width: '100%', height: 48, marginBottom: 12 },
  divider: { flexDirection: 'row', alignItems: 'center', marginVertical: 16 },
  dividerText: { marginHorizontal: 12, opacity: 0.6 },
  input: { marginBottom: 12 },
  loginButton: { marginTop: 8, paddingVertical: 4 },
  links: { flexDirection: 'row', justifyContent: 'center', marginTop: 16 },
  link: { paddingHorizontal: 4 },
  advancedToggle: { alignSelf: 'center' },
  deviceSection: { marginTop: 12, gap: 8 },
});
