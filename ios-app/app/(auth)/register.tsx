import React, { useState } from 'react';
import { View, StyleSheet, Platform, KeyboardAvoidingView, ScrollView, Alert } from 'react-native';
import { Text, TextInput, Button, useTheme } from 'react-native-paper';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'expo-router';
import { authApi } from '../../services/api';

export default function RegisterScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [loading, setLoading] = useState(false);

  const handleRegister = async () => {
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
      await authApi.register(email.trim().toLowerCase(), password, displayName.trim() || undefined);
      Alert.alert(
        t('auth.register_success', 'Registration successful'),
        t('auth.register_verify_hint', 'Check your email to verify your account, then log in.'),
        [{ text: 'OK', onPress: () => router.replace('/(auth)/login') }]
      );
    } catch (err: any) {
      Alert.alert(t('auth.register_failed'), err.message || String(err));
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
            {t('auth.register', 'Register')}
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
            label={t('auth.display_name_optional', 'Display Name (optional)')}
            value={displayName}
            onChangeText={setDisplayName}
            mode="outlined"
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
            onPress={handleRegister}
            loading={loading}
            disabled={loading}
            style={styles.submitButton}
          >
            {t('auth.register', 'Register')}
          </Button>

          <Button
            mode="text"
            onPress={() => router.back()}
            style={styles.cancelButton}
          >
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
  title: { marginBottom: 24, textAlign: 'center', fontWeight: 'bold' },
  input: { marginBottom: 12 },
  submitButton: { marginTop: 16, paddingVertical: 4 },
  cancelButton: { marginTop: 8 },
});
