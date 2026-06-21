import React, { useEffect, useState, useCallback } from 'react';
import { View, StyleSheet, Alert, ScrollView, RefreshControl, Platform } from 'react-native';
import {
  Text,
  Card,
  Button,
  ActivityIndicator,
  useTheme,
  List,
  Divider,
  Chip,
} from 'react-native-paper';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';
import {
  initConnection,
  endConnection,
  fetchProducts,
  requestPurchase,
  finishTransaction,
  purchaseUpdatedListener,
  purchaseErrorListener,
  getReceiptIOS,
  ErrorCode,
  type Product,
  type Purchase,
  type PurchaseError,
} from 'react-native-iap';
import axios from 'axios';

// Product IDs — must match App Store Connect + backend TOPUP_TIERS
const IAP_PRODUCT_IDS = [
  'ec.topup.small',
  'ec.topup.starter',
  'ec.topup.standard',
  'ec.topup.advanced',
  'ec.topup.premium',
];

// Display metadata (in sync with backend wallet.js TOPUP_TIERS)
const TIER_META: Record<string, { ecoin: number; bonusPct: number; label: string }> = {
  'ec.topup.small': { ecoin: 3000, bonusPct: 0, label: 'Small' },
  'ec.topup.starter': { ecoin: 9450, bonusPct: 5, label: 'Starter' },
  'ec.topup.standard': { ecoin: 16200, bonusPct: 8, label: 'Standard' },
  'ec.topup.advanced': { ecoin: 33600, bonusPct: 12, label: 'Advanced' },
  'ec.topup.premium': { ecoin: 69000, bonusPct: 15, label: 'Premium' },
};

const API_BASE = 'https://eclawbot.com';

type WalletHistoryEntry = {
  id?: string;
  type: string;
  delta_mli: string | number;
  note?: string | null;
  created_at: string;
};

async function getWalletAuthParams() {
  const SecureStore = require('expo-secure-store');
  const deviceId = await SecureStore.getItemAsync('device_id');
  const deviceSecret = await SecureStore.getItemAsync('device_secret');
  if (!deviceId || !deviceSecret) return null;
  return { deviceId, deviceSecret };
}

function formatLedgerType(type: string) {
  return String(type || '').replace(/_/g, ' ');
}

function formatHistoryDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatEcoinDelta(deltaMli: string | number) {
  const delta = Number(deltaMli || 0);
  const ecoin = Math.round(Math.abs(delta) / 1000);
  return `${delta >= 0 ? '+' : '-'}${ecoin.toLocaleString()}`;
}

export default function WalletScreen() {
  const { t } = useTranslation();
  const theme = useTheme();

  const [balance, setBalance] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [products, setProducts] = useState<Product[]>([]);
  const [history, setHistory] = useState<WalletHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [purchasing, setPurchasing] = useState<string | null>(null);
  const [iapAvailable, setIapAvailable] = useState(false);
  const [iapError, setIapError] = useState<string | null>(null);

  const fetchBalance = useCallback(async () => {
    try {
      const params = await getWalletAuthParams();
      if (!params) return;
      const res = await axios.get(`${API_BASE}/api/wallet/balance`, { params });
      const ecoin = res.data?.wallet?.balance_ecoin ?? 0;
      setBalance(ecoin);
    } catch (err: any) {
      console.error('[Wallet] balance fetch failed:', err.message);
    }
  }, []);

  const fetchHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const params = await getWalletAuthParams();
      if (!params) return;
      const res = await axios.get(`${API_BASE}/api/wallet/history`, {
        params: { ...params, limit: 20 },
      });
      setHistory(Array.isArray(res.data?.entries) ? res.data.entries : []);
    } catch (err: any) {
      console.error('[Wallet] history fetch failed:', err.message);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const fetchWalletData = useCallback(async () => {
    await Promise.all([fetchBalance(), fetchHistory()]);
  }, [fetchBalance, fetchHistory]);

  useEffect(() => {
    let purchaseUpdateSub: { remove: () => void } | null = null;
    let purchaseErrorSub: { remove: () => void } | null = null;

    (async () => {
      await fetchWalletData();

      if (Platform.OS !== 'ios') {
        setIapAvailable(false);
        setIapError(t('wallet.iap_ios_only', 'Apple IAP top-up is only available on iOS.'));
        setLoading(false);
        return;
      }

      try {
        await initConnection();
        setIapAvailable(true);

        // Fetch products from App Store (v15: fetchProducts instead of getProducts)
        const fetchedProducts = await fetchProducts({ skus: IAP_PRODUCT_IDS, type: 'in-app' });
        const prods = (fetchedProducts ?? []).filter(
          (product): product is Product => product.type === 'in-app'
        );
        setProducts(prods);
        setIapError(
          prods.length === 0
            ? t('wallet.no_products', 'No products available. Try again later.')
            : null
        );

        // Listen for purchase completions
        purchaseUpdateSub = purchaseUpdatedListener(async (purchase: Purchase) => {
          if (purchase.platform !== 'ios') return;
          try {
            const receipt = await getReceiptIOS();
            if (!receipt) throw new Error('receipt_invalid');
            await verifyAndFinish(purchase, receipt);
          } catch (err: any) {
            console.error('[IAP] Verify failed:', err.message);
            Alert.alert(t('wallet.topup_failed', 'Top-up failed'), err.message);
          } finally {
            setPurchasing(null);
          }
        });

        // Listen for purchase errors
        purchaseErrorSub = purchaseErrorListener((err: PurchaseError) => {
          if (err.code === ErrorCode.UserCancelled) {
            setPurchasing(null);
            return;
          }
          console.error('[IAP] Purchase error:', err);
          Alert.alert(t('wallet.topup_failed', 'Top-up failed'), err.message || String(err));
          setPurchasing(null);
        });
      } catch (err: any) {
        console.error('[IAP] Init failed:', err.message);
        setIapAvailable(false);
        setIapError(
          t('wallet.iap_unavailable', 'Apple IAP is temporarily unavailable. Please try again later.')
        );
      } finally {
        setLoading(false);
      }
    })();

    return () => {
      purchaseUpdateSub?.remove();
      purchaseErrorSub?.remove();
      endConnection().catch(() => {});
    };
  }, [fetchWalletData, t]);

  const verifyAndFinish = async (purchase: Purchase, receipt: string) => {
    const productId = purchase.productId;
    const transactionId = purchase.transactionId || '';

    // Backend verification (must succeed before finishTransaction)
    const SecureStore = require('expo-secure-store');
    const deviceId = await SecureStore.getItemAsync('device_id');
    const deviceSecret = await SecureStore.getItemAsync('device_secret');
    const authToken = await SecureStore.getItemAsync('auth_token');

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

    const res = await axios.post(`${API_BASE}/api/wallet/topup/verify-apple`, {
      productId,
      transactionId,
      receipt,
      deviceId,
      deviceSecret,
    }, { headers });

    if (!res.data?.success) {
      throw new Error(res.data?.error || 'Verification failed');
    }

    // Only finish transaction after backend confirms credit
    await finishTransaction({ purchase, isConsumable: true });

    const newEcoin = res.data.order.ecoinTotal;
    const wasDeduped = res.data.order.deduped;
    if (!wasDeduped) {
      Alert.alert(
        t('wallet.topup_success', 'Top-up successful!'),
        t('wallet.topup_credited', 'Credited {{ecoin}} e-coins to your wallet.', {
          ecoin: newEcoin.toLocaleString(),
        })
      );
    }
    await fetchBalance();
  };

  const handlePurchase = async (productId: string) => {
    if (purchasing) return;
    setPurchasing(productId);
    try {
      await requestPurchase({
        type: 'in-app',
        request: { apple: { sku: productId } },
      });
      // purchaseUpdatedListener handles the rest
    } catch (err: any) {
      if (err.code === ErrorCode.UserCancelled) {
        setPurchasing(null);
        return;
      }
      Alert.alert(t('wallet.topup_failed', 'Top-up failed'), err.message || String(err));
      setPurchasing(null);
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchWalletData();
    setRefreshing(false);
  };

  if (loading) {
    return (
      <SafeAreaView style={[styles.container, styles.centered]} edges={['bottom']}>
        <Stack.Screen options={{ title: t('wallet.title', 'Wallet'), headerShown: true }} />
        <ActivityIndicator size="large" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <Stack.Screen options={{ title: t('wallet.title', 'Wallet'), headerShown: true }} />
      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        contentContainerStyle={styles.scroll}
      >
        {/* Balance Card */}
        <Card style={styles.balanceCard} mode="contained">
          <Card.Content style={styles.balanceContent}>
            <Text variant="labelMedium" style={styles.balanceLabel}>
              {t('wallet.balance', 'Balance')}
            </Text>
            <Text variant="displayMedium" style={styles.balanceValue}>
              {balance !== null ? balance.toLocaleString() : '—'}
            </Text>
            <Text variant="bodyMedium" style={styles.balanceUnit}>
              {t('wallet.ecoin_unit', 'e-coins')}
            </Text>
          </Card.Content>
        </Card>

        {/* Top-up Section */}
        <Text variant="titleMedium" style={styles.sectionTitle}>
          {t('wallet.topup_via_apple', 'Top Up (via Apple IAP)')}
        </Text>
        <Text variant="bodySmall" style={styles.sectionHint}>
          {t('wallet.topup_hint', 'All purchases are processed securely through Apple.')}
        </Text>

        {!iapAvailable || products.length === 0 ? (
          <Card style={styles.unavailableCard} mode="outlined">
            <Card.Content>
              <Text variant="bodyMedium" style={styles.unavailableText}>
                {iapError || t('wallet.no_products', 'No products available. Try again later.')}
              </Text>
            </Card.Content>
          </Card>
        ) : (
          products
            .sort((a, b) => Number(a.price ?? 0) - Number(b.price ?? 0))
            .map((product) => {
              const meta = TIER_META[product.id];
              const isPurchasing = purchasing === product.id;
              return (
                <Card
                  key={product.id}
                  style={styles.tierCard}
                  mode="outlined"
                  onPress={() => handlePurchase(product.id)}
                  disabled={!!purchasing}
                >
                  <Card.Content style={styles.tierContent}>
                    <View style={styles.tierLeft}>
                      <Text variant="titleMedium">
                        {meta?.label || product.title || product.id}
                      </Text>
                      <Text variant="bodySmall" style={{ opacity: 0.75 }}>
                        {meta
                          ? `${meta.ecoin.toLocaleString()} ${t('wallet.ecoin_unit', 'e-coins')}`
                          : product.description}
                      </Text>
                      {meta && meta.bonusPct > 0 && (
                        <Chip compact style={styles.bonusChip} textStyle={{ fontSize: 11 }}>
                          +{meta.bonusPct}% {t('wallet.bonus_label', 'bonus')}
                        </Chip>
                      )}
                    </View>
                    <View style={styles.tierRight}>
                      {isPurchasing ? (
                        <ActivityIndicator />
                      ) : (
                        <Text variant="titleLarge" style={{ color: theme.colors.primary }}>
                          {product.displayPrice || `$${product.price}`}
                        </Text>
                      )}
                    </View>
                  </Card.Content>
                </Card>
              );
            })
        )}

        {/* Transaction History */}
        <Divider style={{ marginVertical: 16 }} />
        <Text variant="titleMedium" style={styles.sectionTitle}>
          {t('wallet.transaction_history', 'Transaction History')}
        </Text>
        <Card mode="outlined" style={styles.historyCard}>
          {historyLoading ? (
            <Card.Content>
              <ActivityIndicator />
            </Card.Content>
          ) : history.length === 0 ? (
            <Card.Content>
              <Text style={styles.emptyHistory}>
                {t('wallet.empty_history', 'No transaction history yet.')}
              </Text>
            </Card.Content>
          ) : (
            history.map((entry) => {
              const delta = Number(entry.delta_mli || 0);
              return (
                <List.Item
                  key={entry.id || `${entry.created_at}-${entry.type}-${entry.delta_mli}`}
                  title={formatLedgerType(entry.type)}
                  description={[entry.note, formatHistoryDate(entry.created_at)].filter(Boolean).join(' · ')}
                  left={(props) => <List.Icon {...props} icon={delta >= 0 ? 'plus-circle' : 'minus-circle'} />}
                  right={() => (
                    <Text
                      variant="bodyMedium"
                      style={[
                        styles.ledgerAmount,
                        delta >= 0 ? styles.ledgerCredit : styles.ledgerDebit,
                      ]}
                    >
                      {formatEcoinDelta(entry.delta_mli)}
                    </Text>
                  )}
                />
              );
            })
          )}
        </Card>

        {/* Apple compliance footer */}
        <Text variant="bodySmall" style={styles.compliance}>
          {t(
            'wallet.iap_compliance',
            'Payments are processed by Apple. Terms and conditions apply.'
          )}
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: { justifyContent: 'center', alignItems: 'center' },
  scroll: { padding: 16, gap: 8 },
  balanceCard: { marginBottom: 24 },
  balanceContent: { alignItems: 'center', paddingVertical: 24 },
  balanceLabel: { opacity: 0.7, marginBottom: 4 },
  balanceValue: { fontWeight: 'bold' },
  balanceUnit: { opacity: 0.7 },
  sectionTitle: { marginTop: 8, marginBottom: 4, fontWeight: 'bold' },
  sectionHint: { marginBottom: 16, opacity: 0.7 },
  unavailableCard: { marginBottom: 8 },
  unavailableText: { opacity: 0.72, lineHeight: 20 },
  tierCard: { marginBottom: 8 },
  tierContent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  tierLeft: { flex: 1, gap: 4 },
  tierRight: { minWidth: 80, alignItems: 'flex-end' },
  bonusChip: { alignSelf: 'flex-start', marginTop: 4 },
  noProducts: { textAlign: 'center', opacity: 0.6, padding: 24 },
  historyCard: { marginTop: 8 },
  emptyHistory: { textAlign: 'center', opacity: 0.6, paddingVertical: 12 },
  ledgerAmount: { alignSelf: 'center', minWidth: 72, textAlign: 'right', fontWeight: '700' },
  ledgerCredit: { color: '#10b981' },
  ledgerDebit: { color: '#ef4444' },
  compliance: { textAlign: 'center', opacity: 0.5, marginTop: 24, padding: 16 },
});
