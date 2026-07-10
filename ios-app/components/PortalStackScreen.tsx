import React from 'react';
import { StyleSheet } from 'react-native';
import { Stack } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import WebViewScreen from './WebViewScreen';

type PortalStackScreenProps = {
  title: string;
  url: string;
};

export default function PortalStackScreen({ title, url }: PortalStackScreenProps) {
  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <Stack.Screen
        options={{
          title,
          headerStyle: { backgroundColor: '#0D0D1A' },
          headerTintColor: '#FFFFFF',
          headerShadowVisible: false,
        }}
      />
      <WebViewScreen url={url} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0D0D1A',
  },
});
