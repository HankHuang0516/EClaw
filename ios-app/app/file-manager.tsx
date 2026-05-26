import React, { useState, useEffect, useCallback } from 'react';
import { View, FlatList, StyleSheet, Image, TouchableOpacity, Dimensions, Alert } from 'react-native';
import {
  Text,
  Chip,
  useTheme,
  ActivityIndicator,
  IconButton,
  Snackbar,
} from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from 'expo-router';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system/legacy';
import { fileApi } from '../services/api';
import { MaterialCommunityIcons } from '@expo/vector-icons';

interface MediaFile {
  id: string;
  type: 'image' | 'audio';
  url: string;
  filename: string;
  size: number;
  createdAt: number;
}

type FileType = 'all' | 'image' | 'audio';
type TimeFilter = 'all' | 'today' | 'this_week' | 'this_month';

const GRID_COLUMNS = 3;
const SCREEN_WIDTH = Dimensions.get('window').width;
const ITEM_SIZE = (SCREEN_WIDTH - 32 - (GRID_COLUMNS - 1) * 4) / GRID_COLUMNS;

export default function FileManagerScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const navigation = useNavigation();

  const [files, setFiles] = useState<MediaFile[]>([]);
  const [typeFilter, setTypeFilter] = useState<FileType>('all');
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('all');
  const [isLoading, setIsLoading] = useState(false);
  const [snack, setSnack] = useState('');

  React.useLayoutEffect(() => {
    navigation.setOptions({ title: t('files.title'), headerShown: true });
  }, [navigation, t]);

  const getSinceTimestamp = (): string | undefined => {
    const now = Date.now();
    switch (timeFilter) {
      case 'today': return String(now - 86400000);
      case 'this_week': return String(now - 7 * 86400000);
      case 'this_month': return String(now - 30 * 86400000);
      default: return undefined;
    }
  };

  const loadFiles = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fileApi.list({
        type: typeFilter === 'all' ? undefined : typeFilter,
        since: getSinceTimestamp(),
      });
      setFiles(res.data.files ?? []);
    } catch {
      setSnack(t('errors.server'));
    } finally {
      setIsLoading(false);
    }
  }, [typeFilter, timeFilter]);

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  const handleShare = async (file: MediaFile) => {
    try {
      const localUri = FileSystem.cacheDirectory + file.filename;
      await FileSystem.downloadAsync(file.url, localUri);
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(localUri);
      } else {
        setSnack(t('errors.sharing_not_available'));
      }
    } catch {
      setSnack(t('errors.network'));
    }
  };

  const handleDelete = (file: MediaFile) => {
    Alert.alert(
      t('files.delete_title', 'Delete File'),
      t('files.delete_confirm', 'Are you sure you want to delete this file?'),
      [
        { text: t('common.cancel', 'Cancel'), style: 'cancel' },
        {
          text: t('common.delete', 'Delete'),
          style: 'destructive',
          onPress: async () => {
            try {
              await fileApi.delete(file.id);
              setFiles((prev) => prev.filter((f) => f.id !== file.id));
              setSnack(t('files.deleted', 'File deleted'));
            } catch {
              setSnack(t('errors.server'));
            }
          },
        },
      ],
    );
  };

  const handleLongPress = (file: MediaFile) => {
    Alert.alert(
      file.filename || (file.type === 'image' ? 'Photo' : 'Audio'),
      undefined,
      [
        { text: t('files.share', 'Share'), onPress: () => handleShare(file) },
        { text: t('files.delete', 'Delete'), style: 'destructive', onPress: () => handleDelete(file) },
        { text: t('common.cancel', 'Cancel'), style: 'cancel' },
      ],
    );
  };

  const renderItem = ({ item }: { item: MediaFile }) => (
    <TouchableOpacity style={styles.gridItem} onLongPress={() => handleLongPress(item)}>
      {item.type === 'image' ? (
        <Image source={{ uri: item.url }} style={styles.image} resizeMode="cover" />
      ) : (
        <View style={[styles.audioItem, { backgroundColor: theme.colors.primaryContainer }]}>
          <MaterialCommunityIcons name="play-circle" size={36} color={theme.colors.primary} />
          <Text variant="bodySmall" numberOfLines={2} style={{ textAlign: 'center', padding: 4 }}>
            {item.filename}
          </Text>
        </View>
      )}
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]} edges={['bottom']}>
      {/* Type filter */}
      <View style={styles.filterRow}>
        {(['all', 'image', 'audio'] as FileType[]).map((ft) => (
          <Chip
            key={ft}
            selected={typeFilter === ft}
            onPress={() => setTypeFilter(ft)}
            mode={typeFilter === ft ? 'flat' : 'outlined'}
            compact
          >
            {t(`files.${ft === 'all' ? 'all' : ft === 'image' ? 'photos' : 'audio'}`)}
          </Chip>
        ))}
      </View>

      {/* Time filter */}
      <View style={styles.filterRow}>
        {(['all', 'today', 'this_week', 'this_month'] as TimeFilter[]).map((tf) => (
          <Chip
            key={tf}
            selected={timeFilter === tf}
            onPress={() => setTimeFilter(tf)}
            mode={timeFilter === tf ? 'flat' : 'outlined'}
            compact
          >
            {t(`files.${tf}`)}
          </Chip>
        ))}
      </View>

      {isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator />
        </View>
      ) : files.length === 0 ? (
        <View style={styles.centered}>
          <MaterialCommunityIcons name="folder-open" size={56} color={theme.colors.onSurfaceVariant} />
          <Text variant="bodyLarge" style={{ color: theme.colors.onSurfaceVariant }}>
            {t('files.no_files')}
          </Text>
        </View>
      ) : (
        <FlatList
          data={files}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          numColumns={GRID_COLUMNS}
          contentContainerStyle={styles.grid}
        />
      )}

      <Snackbar visible={!!snack} onDismiss={() => setSnack('')} duration={2000}>
        {snack}
      </Snackbar>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  filterRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    flexWrap: 'wrap',
  },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12 },
  grid: { padding: 16, gap: 4 },
  gridItem: {
    width: ITEM_SIZE,
    height: ITEM_SIZE,
    margin: 2,
    borderRadius: 8,
    overflow: 'hidden',
  },
  image: { width: '100%', height: '100%' },
  audioItem: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 8,
    padding: 4,
  },
});
