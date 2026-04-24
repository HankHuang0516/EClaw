import { Tabs } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useTheme } from 'react-native-paper';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Text } from 'react-native';

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

// Only the focused tab shows its label, so on narrow devices the 5 icons
// always fit even in ja / ko where labels are wider. Inactive tabs render
// nothing below the icon; the active label shrinks to a single line via
// adjustsFontSizeToFit so 3-char CJK labels never truncate.
function TabLabel({
  color,
  focused,
  children,
}: {
  color: string;
  focused: boolean;
  children: React.ReactNode;
}) {
  if (!focused) return null;
  return (
    <Text
      numberOfLines={1}
      adjustsFontSizeToFit
      minimumFontScale={0.7}
      style={{ color, fontSize: 10, textAlign: 'center' }}
    >
      {children}
    </Text>
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
        headerStyle: { backgroundColor: theme.colors.surface },
        headerTintColor: theme.colors.onSurface,
        headerShown: true,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: t('tabs.home'),
          headerTitle: t('home.title'),
          tabBarIcon: ({ focused }) => (
            <TabIcon name={focused ? 'home' : 'home-outline'} focused={focused} />
          ),
          tabBarLabel: ({ color, focused }) => (
            <TabLabel color={color} focused={focused}>{t('tabs.home')}</TabLabel>
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
          tabBarLabel: ({ color, focused }) => (
            <TabLabel color={color} focused={focused}>{t('tabs.chat')}</TabLabel>
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
          tabBarLabel: ({ color, focused }) => (
            <TabLabel color={color} focused={focused}>{t('tabs.mission')}</TabLabel>
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
          tabBarLabel: ({ color, focused }) => (
            <TabLabel color={color} focused={focused}>{t('tabs.cards')}</TabLabel>
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
          tabBarLabel: ({ color, focused }) => (
            <TabLabel color={color} focused={focused}>{t('tabs.settings')}</TabLabel>
          ),
        }}
      />
    </Tabs>
  );
}
