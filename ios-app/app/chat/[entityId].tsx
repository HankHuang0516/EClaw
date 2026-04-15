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

  const entityTitle = entity
    ? (entity.name || `${entity.character || 'Entity'} #${entity.entityId}`)
    : 'Chat';

  React.useLayoutEffect(() => {
    if (entity) {
      navigation.setOptions({ title: entityTitle, headerShown: true });
    }
  }, [entity, entityTitle, navigation]);

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <Stack.Screen options={{ title: entityTitle }} />
      <WebViewScreen
        url={`https://eclawbot.com/portal/chat.html${entityId ? `?filterEntity=${entityId}` : ''}`}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0D0D1A' },
});
