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
import { Stack, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import * as RNIap from 'react-native-iap';
import WebViewScreen from '../components/WebViewScreen';
import apiClient, { authApi } from '../services/api';

// Product IDs must match App Store Connect + backend TOPUP_TIERS in wallet.js
const IAP_PRODUCT_IDS = [
  'ec.topup.small',
  'ec.topup.starter',
  'ec.topup.standard',
  'ec.topup.advanced',
  'ec.topup.premium',
];

// Bonus labels per tier (kept in sync with backend TOPUP_TIERS)
const TIER_META: Record<string, { ecoin: number; bonusPct: number }> = {
  'ec.topup.small': { ecoin: 3000, bonusPct: 0 },
  'ec.topup.starter': { ecoin: 9450, bonusPct: 5 },
  'ec.topup.standard': { ecoin: 16200, bonusPct: 8 },
  'ec.topup.advanced': { ecoin: 33600, bonusPct: 12 },
  'ec.topup.premium': { ecoin: 69000, bonusPct: 15 },
};

export default function WalletScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();

  const [balance, setBalance] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [products, setProducts] = useState<RNIap.Product[]>([]);
  const [purchasing, setPurchasing] = useState<string | null>(null);
  const [iapAvailable, setIapAvailable] = useState(false);

  const fetchBalance = useCallback(async () => {
    try {
      const res = await apiClient.get('/api/wallet/balance');
      const ecoin = res.data?.wallet?.balance_ecoin ?? 0;
      setBalance(ecoin);
    } catch (err: any) {
      console.error('[Wallet] balance fetch failed:', err.message);
    }
  }, []);

  useEffect(() => {
    let purchaseUpdateSub: { remove: () => void } | null = null;
    let purchaseErrorSub: { remove: () => void } | null = null;

    (async () => {
      try {
        // iOS only — IAP not supported on Android via this component (uses Google Play native)
        if (Platform.OS !== 'ios') {
          setIapAvailable(false);
          setLoading(false);
          return;
        }
        await RNIap.initConnection();
        setIapAvailable(true);

        // Fetch products from App Store
        const prods = await RNIap.getProducts({ skus: IAP_PRODUCT_IDS });
        setProducts(prods);

        // Listen for purchase updates
        purchaseUpdateSub = RNIap.purchaseUpdatedListener(async (purchase) => {
          if (!purchase.transactionReceipt) return;
          try {
            await verifyAndFinish(purchase);
          } catch (err: any) {
            console.error('[IAP] Verify failed:', err.message);
            Alert.alert(t('wallet.topup_failed', 'Top-up failed'), err.message);
          } finally {
            setPurchasing(null);
          }
        });

        purchaseErrorSub = RNIap.purchaseErrorListener((err) => {
          if (err.code === 'E_USER_CANCELLED') {
            setPurchasing(null);
            return;
          }
          console.error('[IAP] Purchase error:', err);
          Alert.alert(t('wallet.topup_failed', 'Top-up failed'), err.message || String(err));
          setPurchasing(null);
        });

        await fetchBalance();
      } catch (err: any) {
        console.error('[IAP] Init failed:', err.message);
        setIapAvailable(false);
      } finally {
        setLoading(false);
      }
    })();

    return () => {
      purchaseUpdateSub?.remove();
      purchaseErrorSub?.remove();
      RNIap.endConnection().catch(() => {});
    };
  }, [fetchBalance, t]);

  const verifyAndFinish = async (purchase: RNIap.Purchase) => {
    const productId = purchase.productId;
    const transactionId =
      (purchase as any).originalTransactionIdentifierIOS ||
      (purchase as any).transactionId ||
      '';
    const receipt = purchase.transactionReceipt;

    // Call backend to verify with Apple + credit wallet
    const res = await apiClient.post('/api/wallet/topup/verify-apple', {
      productId,
      transactionId,
      receipt,
    });

    if (!res.data?.success) {
      throw new Error(res.data?.error || 'Verification failed');
    }

    // Only finish transaction after backend confirms
    await RNIap.finishTransaction({ purchase, isConsumable: true });

    const newEcoin = res.data.order.ecoinTotal;
    const wasDeduped = res.data.order.deduped;
    if (!wasDeduped) {
      Alert.alert(
        t('wallet.topup_success', 'Top-up successful'),
        t('wallet.topup_credited', 'Credited {{ecoin}} e-coins to your wallet.', { ecoin: newEcoin })
      );
    }
    await fetchBalance();
  };

  const handlePurchase = async (productId: string) => {
    if (purchasing) return;
    setPurchasing(productId);
    try {
      await RNIap.requestPurchase({ sku: productId });
    } catch (err: any) {
      if (err.code === 'E_USER_CANCELLED') {
        setPurchasing(null);
        return;
      }
      Alert.alert(t('wallet.topup_failed', 'Top-up failed'), err.message || String(err));
      setPurchasing(null);
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchBalance();
    setRefreshing(false);
  };

  // Fallback to WebView if IAP unavailable (Android, simulator, etc.)
  if (!iapAvailable && !loading) {
    return (
      <SafeAreaView style={styles.container} edges={['bottom']}>
        <Stack.Screen options={{ title: t('wallet.title', 'Wallet') }} />
        <WebViewScreen url="https://eclawbot.com/portal/wallet.html" />
      </SafeAreaView>
    );
  }

  if (loading) {
    return (
      <SafeAreaView style={[styles.container, styles.centered]} edges={['bottom']}>
        <Stack.Screen options={{ title: t('wallet.title', 'Wallet') }} />
        <ActivityIndicator size="large" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <Stack.Screen options={{ title: t('wallet.title', 'Wallet') }} />
      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        contentContainerStyle={styles.scroll}
      >
        {/* Balance */}
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

        {/* Top-up section */}
        <Text variant="titleMedium" style={styles.sectionTitle}>
          {t('wallet.topup_via_apple', 'Top Up (via Apple IAP)')}
        </Text>
        <Text variant="bodySmall" style={styles.sectionHint}>
          {t('wallet.topup_hint', 'All purchases are processed securely through Apple.')}
        </Text>

        {products.length === 0 ? (
          <Text style={styles.noProducts}>
            {t('wallet.no_products', 'No products available. Try again later.')}
          </Text>
        ) : (
          products
            .sort((a, b) => parseFloat(a.price) - parseFloat(b.price))
            .map((product) => {
              const meta = TIER_META[product.productId];
              const isPurchasing = purchasing === product.productId;
              return (
                <Card
                  key={product.productId}
                  style={styles.tierCard}
                  mode="outlined"
                  onPress={() => handlePurchase(product.productId)}
                  disabled={!!purchasing}
                >
                  <Card.Content style={styles.tierContent}>
                    <View style={styles.tierLeft}>
                      <Text variant="titleMedium">{product.title}</Text>
                      <Text variant="bodySmall" style={{ opacity: 0.75 }}>
                        {meta ? `${meta.ecoin.toLocaleString()} ${t('wallet.ecoin_unit', 'e-coins')}` : product.description}
                      </Text>
                      {meta && meta.bonusPct > 0 && (
                        <Chip compact style={styles.bonusChip}>
                          +{meta.bonusPct}% {t('wallet.bonus_label', 'bonus')}
                        </Chip>
                      )}
                    </View>
                    <View style={styles.tierRight}>
                      {isPurchasing ? (
                        <ActivityIndicator />
                      ) : (
                        <Text variant="titleLarge" style={{ color: theme.colors.primary }}>
                          {product.localizedPrice}
                        </Text>
                      )}
                    </View>
                  </Card.Content>
                </Card>
              );
            })
        )}

        {/* Transaction history link */}
        <Divider style={{ marginVertical: 16 }} />
        <List.Item
          title={t('wallet.transaction_history', 'Transaction History')}
          left={(props) => <List.Icon {...props} icon="history" />}
          right={(props) => <List.Icon {...props} icon="chevron-right" />}
          onPress={() => router.push({
            pathname: '/card-holder',
            params: { url: 'https://eclawbot.com/portal/wallet.html' },
          })}
        />

        {/* Apple IAP compliance footer */}
        <Text variant="bodySmall" style={styles.compliance}>
          {t('wallet.iap_compliance', 'Payments are processed by Apple. Terms and conditions apply.')}
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
  tierCard: { marginBottom: 8 },
  tierContent: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  tierLeft: { flex: 1, gap: 4 },
  tierRight: { minWidth: 80, alignItems: 'flex-end' },
  bonusChip: { alignSelf: 'flex-start', marginTop: 4 },
  noProducts: { textAlign: 'center', opacity: 0.6, padding: 24 },
  compliance: { textAlign: 'center', opacity: 0.5, marginTop: 24, padding: 16 },
});
