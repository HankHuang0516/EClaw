import React from 'react';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import WebViewScreen, { type TabId } from './WebViewScreen';

type PortalTabScreenProps = {
  url: string;
  tabId: TabId;
};

export default function PortalTabScreen({ url, tabId }: PortalTabScreenProps) {
  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <WebViewScreen url={url} tabId={tabId} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0D0D1A',
  },
});
