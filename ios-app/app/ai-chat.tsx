import React, { useState, useRef } from 'react';
import {
  View,
  FlatList,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Image,
  TouchableOpacity,
  Alert,
} from 'react-native';
import {
  Text,
  TextInput,
  IconButton,
  ActivityIndicator,
  useTheme,
  Snackbar,
  Button,
} from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { aiSupportApi } from '../services/api';
import { useAuthStore } from '../store/authStore';

interface AiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  images?: string[];
  timestamp: number;
}

export default function AiChatScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const navigation = useNavigation();
  const flatListRef = useRef<FlatList>(null);
  const { deviceId, deviceSecret } = useAuthStore();

  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [attachedImages, setAttachedImages] = useState<string[]>([]);
  const [isThinking, setIsThinking] = useState(false);
  const [snack, setSnack] = useState('');

  React.useLayoutEffect(() => {
    navigation.setOptions({
      title: t('ai_chat.title'),
      headerShown: true,
      headerRight: () => (
        <Button
          onPress={handleClearHistory}
          compact
          textColor={theme.colors.error}
        >
          {t('ai_chat.clear_history')}
        </Button>
      ),
    });
  }, [navigation, t]);

  const handleAttachImage = async () => {
    if (attachedImages.length >= 3) {
      setSnack(t('ai_chat.max_images'));
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.5,
      base64: true,
    });
    if (!result.canceled && result.assets[0].base64) {
      setAttachedImages((prev) => [...prev, `data:image/jpeg;base64,${result.assets[0].base64}`]);
    }
  };

  const handleClearHistory = () => {
    Alert.alert(t('ai_chat.clear_history'), t('ai_chat.clear_confirm'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.confirm'),
        style: 'destructive',
        onPress: () => setMessages([]),
      },
    ]);
  };

  const handleSend = async () => {
    const text = inputText.trim();
    if (!text || isThinking) return;

    const userMsg: AiMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: text,
      images: attachedImages.length > 0 ? [...attachedImages] : undefined,
      timestamp: Date.now(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInputText('');
    setAttachedImages([]);
    setIsThinking(true);

    // Build history for API
    const history = messages.map((m) => ({ role: m.role, content: m.content }));

    // Auto-inject device context on first message so AI customer service knows who the user is
    let messageForApi = text;
    if (history.length === 0 && deviceId) {
      const ctxParts = [`Device ID: ${deviceId}`];
      if (deviceSecret) ctxParts.push(`Device Secret: ${deviceSecret}`);
      messageForApi = `[Auto-injected device context]\n${ctxParts.join('\n')}\n\n${text}`;
    }

    try {
      const res = await aiSupportApi.chat(messageForApi, history, userMsg.images);
      const reply: AiMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: res.data.reply ?? res.data.message ?? '(no response)',
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, reply]);
    } catch {
      setSnack(t('errors.server'));
    } finally {
      setIsThinking(false);
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
    }
  };

  const renderItem = ({ item }: { item: AiMessage }) => {
    const isUser = item.role === 'user';
    return (
      <View style={[styles.bubbleRow, isUser ? styles.rowRight : styles.rowLeft]}>
        <View
          style={[
            styles.bubble,
            isUser
              ? { backgroundColor: theme.colors.primary }
              : { backgroundColor: theme.colors.surfaceVariant },
          ]}
        >
          {item.images?.map((img, idx) => (
            <Image key={idx} source={{ uri: img }} style={styles.attachedImage} />
          ))}
          <Text style={{ color: isUser ? 'white' : theme.colors.onSurface }}>
            {item.content}
          </Text>
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }} edges={['bottom']}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={100}
      >
        <FlatList
          ref={flatListRef}
          data={messages}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={styles.messageList}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text variant="headlineSmall">🤖</Text>
              <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                {t('ai_chat.placeholder')}
              </Text>
            </View>
          }
          ListFooterComponent={
            isThinking ? (
              <View style={styles.thinking}>
                <ActivityIndicator size="small" />
                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginLeft: 8 }}>
                  {t('ai_chat.thinking')}
                </Text>
              </View>
            ) : null
          }
        />

        {/* Attached images preview */}
        {attachedImages.length > 0 && (
          <View style={styles.imagePreviewRow}>
            {attachedImages.map((img, idx) => (
              <TouchableOpacity
                key={idx}
                onPress={() => setAttachedImages((prev) => prev.filter((_, i) => i !== idx))}
              >
                <Image source={{ uri: img }} style={styles.imageThumb} />
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Input bar */}
        <View style={[styles.inputBar, { backgroundColor: theme.colors.surface }]}>
          <IconButton
            icon="image"
            onPress={handleAttachImage}
            size={22}
            disabled={attachedImages.length >= 3}
          />
          <TextInput
            mode="outlined"
            placeholder={t('ai_chat.placeholder')}
            value={inputText}
            onChangeText={setInputText}
            style={styles.input}
            dense
            multiline
            maxLength={4000}
          />
          <IconButton
            icon="send"
            onPress={handleSend}
            disabled={!inputText.trim() || isThinking}
            iconColor={theme.colors.primary}
            size={24}
          />
        </View>
      </KeyboardAvoidingView>

      <Snackbar visible={!!snack} onDismiss={() => setSnack('')} duration={2000}>
        {snack}
      </Snackbar>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  messageList: { padding: 12, paddingBottom: 8, flexGrow: 1 },
  bubbleRow: { marginVertical: 4, maxWidth: '80%' },
  rowLeft: { alignSelf: 'flex-start' },
  rowRight: { alignSelf: 'flex-end' },
  bubble: { borderRadius: 18, paddingHorizontal: 14, paddingVertical: 10, gap: 6 },
  attachedImage: { width: 120, height: 90, borderRadius: 8 },
  thinking: { flexDirection: 'row', alignItems: 'center', padding: 12, alignSelf: 'flex-start' },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 8, padding: 32 },
  imagePreviewRow: { flexDirection: 'row', gap: 8, padding: 8, paddingHorizontal: 16 },
  imageThumb: { width: 56, height: 56, borderRadius: 8 },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 4,
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(0,0,0,0.1)',
  },
  input: { flex: 1, maxHeight: 120 },
});
