import { Tabs } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useTheme } from 'react-native-paper';
import { MaterialCommunityIcons } from '@expo/vector-icons';

type IconName = keyof typeof MaterialCommunityIcons.glyphMap;

function TabIcon({ name, focused }: { name: IconName; focused: boolean }) {
  const theme = useTheme();
  return (
    <MaterialCommunityIcons
      name={name}
      size={24}
      color={focused ? theme.colors.primary : theme.colors.onSurfaceVariant}
    />
  );
}

export default function TabLayout() {
  const { t } = useTranslation();
  const theme = useTheme();

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: theme.colors.primary,
        tabBarInactiveTintColor: theme.colors.onSurfaceVariant,
        tabBarStyle: {
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.outline,
        },
        headerStyle: { backgroundColor: theme.colors.surface },
        headerTintColor: theme.colors.onSurface,
        headerShown: true,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: t('tabs.home'),
          tabBarIcon: ({ focused }) => (
            <TabIcon name={focused ? 'home' : 'home-outline'} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="chat"
        options={{
          title: t('tabs.chat'),
          tabBarIcon: ({ focused }) => (
            <TabIcon name={focused ? 'chat' : 'chat-outline'} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="mission"
        options={{
          title: t('tabs.mission'),
          tabBarIcon: ({ focused }) => (
            <TabIcon name={focused ? 'target' : 'target'} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="cards"
        options={{
          title: t('tabs.cards'),
          tabBarIcon: ({ focused }) => (
            <TabIcon name={focused ? 'card-account-details' : 'card-account-details-outline'} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: t('tabs.settings'),
          tabBarIcon: ({ focused }) => (
            <TabIcon name={focused ? 'cog' : 'cog-outline'} focused={focused} />
          ),
        }}
      />
    </Tabs>
  );
}
