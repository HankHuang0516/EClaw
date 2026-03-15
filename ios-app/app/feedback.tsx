import React, { useState } from 'react';
import { View, StyleSheet, ScrollView, Image, TouchableOpacity, KeyboardAvoidingView, Platform } from 'react-native';
import {
  Text,
  TextInput,
  Button,
  Chip,
  useTheme,
  Snackbar,
  ActivityIndicator,
} from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { feedbackApi } from '../services/api';
import { MaterialCommunityIcons } from '@expo/vector-icons';

type FeedbackType = 'bug' | 'feature' | 'question';

export default function FeedbackScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const navigation = useNavigation();
  const router = useRouter();

  const [type, setType] = useState<FeedbackType>('bug');
  const [content, setContent] = useState('');
  const [screenshots, setScreenshots] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [snack, setSnack] = useState('');

  React.useLayoutEffect(() => {
    navigation.setOptions({ title: t('feedback.title'), headerShown: true });
  }, [navigation, t]);

  const handleAddScreenshot = async () => {
    if (screenshots.length >= 5) return;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.7,
    });
    if (!result.canceled && result.assets[0]) {
      setScreenshots((prev) => [...prev, result.assets[0].uri]);
    }
  };

  const handleSubmit = async () => {
    if (!content.trim()) return;
    setIsSubmitting(true);
    try {
      const res = await feedbackApi.submit(type, content.trim());
      const feedbackId = res.data.feedbackId ?? res.data.id;

      // Upload screenshots if any
      if (feedbackId && screenshots.length > 0) {
        for (const uri of screenshots) {
          const formData = new FormData();
          formData.append('photo', { uri, type: 'image/jpeg', name: 'screenshot.jpg' } as unknown as Blob);
          await feedbackApi.uploadPhotos(feedbackId, formData);
        }
      }

      setSnack(t('feedback.submit_success'));
      setTimeout(() => router.back(), 1500);
    } catch {
      setSnack(t('errors.server'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]} edges={['bottom']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
      <ScrollView contentContainerStyle={styles.content}>
        {/* Type selector */}
        <Text variant="labelLarge" style={styles.label}>{t('feedback.type_bug')}</Text>
        <View style={styles.chipRow}>
          {(['bug', 'feature', 'question'] as FeedbackType[]).map((tp) => (
            <Chip
              key={tp}
              selected={type === tp}
              onPress={() => setType(tp)}
              mode={type === tp ? 'flat' : 'outlined'}
            >
              {t(`feedback.type_${tp}`)}
            </Chip>
          ))}
        </View>

        {/* Description */}
        <Text variant="labelLarge" style={styles.label}>{t('feedback.describe')}</Text>
        <TextInput
          mode="outlined"
          placeholder={t('feedback.describe')}
          value={content}
          onChangeText={setContent}
          multiline
          numberOfLines={6}
          style={styles.textInput}
        />

        {/* Screenshots */}
        <Text variant="labelLarge" style={styles.label}>{t('feedback.attach_screenshot')}</Text>
        <View style={styles.screenshotRow}>
          {screenshots.map((uri, idx) => (
            <TouchableOpacity
              key={idx}
              onPress={() => setScreenshots((prev) => prev.filter((_, i) => i !== idx))}
            >
              <Image source={{ uri }} style={styles.screenshot} />
              <View style={styles.removeOverlay}>
                <MaterialCommunityIcons name="close" size={16} color="white" />
              </View>
            </TouchableOpacity>
          ))}
          {screenshots.length < 5 && (
            <TouchableOpacity style={[styles.addScreenshot, { borderColor: theme.colors.outline }]} onPress={handleAddScreenshot}>
              <MaterialCommunityIcons name="image-plus" size={28} color={theme.colors.onSurfaceVariant} />
            </TouchableOpacity>
          )}
        </View>

        {/* Submit */}
        <Button
          mode="contained"
          onPress={handleSubmit}
          loading={isSubmitting}
          disabled={!content.trim() || isSubmitting}
          style={styles.submitBtn}
        >
          {t('feedback.submit')}
        </Button>
      </ScrollView>
      </KeyboardAvoidingView>

      <Snackbar visible={!!snack} onDismiss={() => setSnack('')} duration={2000}>
        {snack}
      </Snackbar>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 20, gap: 8, paddingBottom: 40 },
  label: { marginTop: 12, marginBottom: 6 },
  chipRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  textInput: { marginBottom: 8 },
  screenshotRow: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  screenshot: { width: 80, height: 80, borderRadius: 8 },
  removeOverlay: {
    position: 'absolute',
    top: 2,
    right: 2,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 10,
    padding: 2,
  },
  addScreenshot: {
    width: 80,
    height: 80,
    borderRadius: 8,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    justifyContent: 'center',
    alignItems: 'center',
  },
  submitBtn: { marginTop: 24 },
});
