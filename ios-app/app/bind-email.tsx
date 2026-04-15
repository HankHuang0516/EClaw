import React, { useState } from 'react';
import { View, StyleSheet, Platform, KeyboardAvoidingView, ScrollView, Alert } from 'react-native';
import { Text, TextInput, Button, useTheme } from 'react-native-paper';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'expo-router';
import { authApi } from '../services/api';
import { useAuthStore } from '../store/authStore';

export default function BindEmailScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();
  const { user } = useAuthStore();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);

  const handleBind = async () => {
    if (!email.trim() || !password) {
      Alert.alert(t('common.error'), t('auth.fill_required_fields'));
      return;
    }
    if (password.length < 6) {
      Alert.alert(t('common.error'), t('auth.password_too_short'));
      return;
    }
    if (password !== confirm) {
      Alert.alert(t('common.error'), t('auth.password_mismatch'));
      return;
    }
    setLoading(true);
    try {
      await authApi.bindEmail(email.trim().toLowerCase(), password);
      Alert.alert(
        t('auth.bind_email_success', 'Email bound successfully'),
        t('auth.bind_email_verify_hint', 'Check your email to verify the address.'),
        [{
          text: 'OK',
          onPress: () => {
            if (router.canDismiss && router.canDismiss()) {
              router.dismiss();
            } else {
              router.replace('/(tabs)');
            }
          },
        }]
      );
    } catch (err: any) {
      if (err.message?.includes('409')) {
        Alert.alert(t('common.error'), t('auth.email_already_used'));
      } else {
        Alert.alert(t('common.error'), err.message || String(err));
      }
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
          <Text variant="headlineMedium" style={styles.title}>
            {t('auth.bind_email_title', 'Bind Email')}
          </Text>
          <Text variant="bodyMedium" style={styles.desc}>
            {t(
              'auth.bind_email_desc',
              'Bind an email to secure your account and sync across devices.'
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
          <TextInput
            label={t('auth.password_placeholder', 'Password')}
            value={password}
            onChangeText={setPassword}
            mode="outlined"
            secureTextEntry
            autoComplete="new-password"
            style={styles.input}
            disabled={loading}
          />
          <TextInput
            label={t('auth.confirm_password', 'Confirm Password')}
            value={confirm}
            onChangeText={setConfirm}
            mode="outlined"
            secureTextEntry
            style={styles.input}
            disabled={loading}
          />

          <Button
            mode="contained"
            onPress={handleBind}
            loading={loading}
            disabled={loading}
            style={styles.submitButton}
          >
            {t('auth.bind_email_cta', 'Bind Email')}
          </Button>

          <Button mode="text" onPress={() => router.back()} style={styles.cancelButton}>
            {t('common.cancel', 'Cancel')}
          </Button>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { padding: 24 },
  title: { marginBottom: 12, textAlign: 'center', fontWeight: 'bold' },
  desc: { marginBottom: 24, textAlign: 'center', opacity: 0.75 },
  input: { marginBottom: 12 },
  submitButton: { marginTop: 8, paddingVertical: 4 },
  cancelButton: { marginTop: 8 },
});
