import React from 'react';
import { StyleSheet } from 'react-native';
import { useLocalSearchParams, useNavigation, Stack } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useEntityStore } from '../../store/entityStore';
import WebViewScreen from '../../components/WebViewScreen';

export default function ChatScreen() {
  const { entityId } = useLocalSearchParams<{ entityId: string }>();
  const navigation = useNavigation();
  const { entities } = useEntityStore();
  const entity = entities.find((e) => e.entityId === entityId) ?? null;

  React.useLayoutEffect(() => {
    if (entity) {
      navigation.setOptions({ title: entity.name, headerShown: true });
    }
  }, [entity, navigation]);

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <Stack.Screen options={{ title: entity?.name ?? 'Chat' }} />
      <WebViewScreen
        url={`https://eclawbot.com/portal/chat.html${entityId ? `?filterEntity=${entityId}` : ''}`}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0D0D1A' },
});
