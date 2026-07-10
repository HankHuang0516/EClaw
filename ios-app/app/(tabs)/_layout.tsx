import { Tabs } from 'expo-router';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Text } from 'react-native';

type IconName = keyof typeof MaterialCommunityIcons.glyphMap;

const TAB_BACKGROUND = '#0D0D1A';
const TAB_BORDER = '#242033';
const TAB_ACTIVE = '#FFFFFF';
const TAB_INACTIVE = '#AAAAAA';

function TabIcon({ name, color }: { name: IconName; color: string }) {
  return <MaterialCommunityIcons name={name} size={24} color={color} />;
}

function TabLabel({
  color,
  children,
}: {
  color: string;
  children: ReactNode;
}) {
  return (
    <Text
      numberOfLines={1}
      adjustsFontSizeToFit
      minimumFontScale={0.7}
      style={{ color, fontSize: 10, textAlign: 'center', marginTop: 0 }}
    >
      {children}
    </Text>
  );
}

export default function TabLayout() {
  const { t } = useTranslation();

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: TAB_ACTIVE,
        tabBarInactiveTintColor: TAB_INACTIVE,
        tabBarStyle: {
          backgroundColor: TAB_BACKGROUND,
          borderTopColor: TAB_BORDER,
          // Without explicit height + safe-area padding the bar was collapsing to a
          // ~1-2pt strip at the bottom (home-indicator area consumed all space), making
          // every tab button unhittable. Pin a usable tap target.
          height: 83,
          paddingTop: 6,
          paddingBottom: 34,
        },
        tabBarLabelStyle: {
          fontSize: 10,
          marginTop: 0,
        },
        tabBarLabelPosition: 'below-icon',
        headerShown: false,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: t('tabs.home'),
          headerTitle: t('home.title'),
          tabBarIcon: ({ focused, color }) => (
            <TabIcon name={focused ? 'home' : 'home-outline'} color={color} />
          ),
          tabBarLabel: ({ color }) => (
            <TabLabel color={color}>{t('tabs.home')}</TabLabel>
          ),
        }}
      />
      <Tabs.Screen
        name="chat"
        options={{
          title: t('tabs.chat'),
          tabBarIcon: ({ focused, color }) => (
            <TabIcon name={focused ? 'chat' : 'chat-outline'} color={color} />
          ),
          tabBarLabel: ({ color }) => (
            <TabLabel color={color}>{t('tabs.chat')}</TabLabel>
          ),
        }}
      />
      <Tabs.Screen
        name="mission"
        options={{
          title: t('tabs.mission'),
          tabBarIcon: ({ color }) => (
            <TabIcon name="target" color={color} />
          ),
          tabBarLabel: ({ color }) => (
            <TabLabel color={color}>{t('tabs.mission')}</TabLabel>
          ),
        }}
      />
      <Tabs.Screen
        name="cards"
        options={{
          title: t('tabs.cards'),
          tabBarIcon: ({ focused, color }) => (
            <TabIcon name={focused ? 'card-account-details' : 'card-account-details-outline'} color={color} />
          ),
          tabBarLabel: ({ color }) => (
            <TabLabel color={color}>{t('tabs.cards')}</TabLabel>
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: t('tabs.settings'),
          tabBarIcon: ({ focused, color }) => (
            <TabIcon name={focused ? 'cog' : 'cog-outline'} color={color} />
          ),
          tabBarLabel: ({ color }) => (
            <TabLabel color={color}>{t('tabs.settings')}</TabLabel>
          ),
        }}
      />
    </Tabs>
  );
}
