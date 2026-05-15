import React from 'react';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import WebViewScreen from '../../components/WebViewScreen';

export default function ChatScreen() {
  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <WebViewScreen url="https://eclawbot.com/portal/chat.html" tabId="chat" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0D0D1A' },
});
