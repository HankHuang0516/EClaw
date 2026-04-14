import React, { useState } from 'react';
import { View, StyleSheet, Platform, KeyboardAvoidingView, Alert } from 'react-native';
import { Text, TextInput, Button, useTheme } from 'react-native-paper';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'expo-router';
import { authApi } from '../../services/api';

export default function ForgotPasswordScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSubmit = async () => {
    if (!email.trim()) {
      Alert.alert(t('common.error'), t('auth.fill_required_fields'));
      return;
    }
    setLoading(true);
    try {
      await authApi.forgotPassword(email.trim().toLowerCase());
      setSent(true);
    } catch (err: any) {
      Alert.alert(t('common.error'), err.message || String(err));
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
        <View style={styles.content}>
          <Text variant="headlineMedium" style={styles.title}>
            {t('auth.forgot_password', 'Forgot Password')}
          </Text>

          {!sent ? (
            <>
              <Text variant="bodyMedium" style={styles.desc}>
                {t(
                  'auth.forgot_password_desc',
                  'Enter your email address and we\'ll send you a password reset link.'
                )}
              </Text>

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

              <Button
                mode="contained"
                onPress={handleSubmit}
                loading={loading}
                disabled={loading}
                style={styles.submitButton}
              >
                {t('auth.send_reset_link', 'Send Reset Link')}
              </Button>
            </>
          ) : (
            <View style={styles.successBox}>
              <Text variant="titleMedium" style={{ color: theme.colors.primary }}>
                ✓ {t('auth.reset_link_sent', 'Reset link sent')}
              </Text>
              <Text variant="bodyMedium" style={styles.desc}>
                {t(
                  'auth.reset_link_hint',
                  'Check your email for instructions to reset your password.'
                )}
              </Text>
            </View>
          )}

          <Button
            mode="text"
            onPress={() => router.back()}
            style={styles.backButton}
          >
            {t('auth.back_to_login', 'Back to Login')}
          </Button>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 24, flex: 1 },
  title: { marginBottom: 16, textAlign: 'center', fontWeight: 'bold' },
  desc: { marginBottom: 16, textAlign: 'center', opacity: 0.75 },
  input: { marginBottom: 16 },
  submitButton: { paddingVertical: 4 },
  backButton: { marginTop: 24 },
  successBox: { alignItems: 'center', padding: 24, gap: 12 },
});
