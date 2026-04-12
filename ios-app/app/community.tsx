import React from 'react';
import { SafeAreaView, StyleSheet } from 'react-native';
import { Stack } from 'expo-router';
import WebViewScreen from '../components/WebViewScreen';

export default function CommunityScreen() {
  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <Stack.Screen options={{ title: 'Community' }} />
      <WebViewScreen url="https://eclawbot.com/portal/community.html" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0D0D1A' },
});
