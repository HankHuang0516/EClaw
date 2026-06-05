import React, { useEffect, useState, useCallback } from 'react';
import { View, StyleSheet, Alert, ScrollView, RefreshControl, Platform } from 'react-native';
import {
  Text,
  Card,
  Button,
  ActivityIndicator,
  useTheme,
  Divider,
  Chip,
} from 'react-native-paper';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';
import {
  ErrorCode,
  initConnection,
  endConnection,
  fetchProducts,
  requestPurchase,
  finishTransaction,
  purchaseUpdatedListener,
  purchaseErrorListener,
  type Purchase,
  type ProductIOS,
  type PurchaseIOS,
  type PurchaseError,
} from 'react-native-iap';
import { authApi } from '../services/api';
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

type ApplePurchasePayload = PurchaseIOS & {
  transactionReceipt?: string | null;
  jwsRepresentationIOS?: string | null;
  signedTransactionInfoIOS?: string | null;
};

function isIosProduct(product: unknown): product is ProductIOS {
  return !!product && typeof product === 'object' && (product as ProductIOS).platform === 'ios';
}

function appleReceiptPayload(purchase: PurchaseIOS) {
  const p = purchase as ApplePurchasePayload;
  return p.transactionReceipt
    || p.purchaseToken
    || p.jwsRepresentationIOS
    || p.signedTransactionInfoIOS
    || '';
}

function productPrice(product: ProductIOS) {
  return typeof product.price === 'number' ? product.price : Number.parseFloat(String(product.price || '0'));
}

export default function WalletScreen() {
  const { t } = useTranslation();
  const theme = useTheme();

  const [balance, setBalance] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [products, setProducts] = useState<ProductIOS[]>([]);
  const [purchasing, setPurchasing] = useState<string | null>(null);
  const [iapAvailable, setIapAvailable] = useState(false);
  const [iapInitError, setIapInitError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  const fetchBalance = useCallback(async () => {
    try {
      const res = await authApi.me();
      // Wallet balance comes from /api/wallet/balance but we need auth
      // For now get what's available from /api/auth/me or dedicated endpoint
    } catch {}
    try {
      const SecureStore = require('expo-secure-store');
      const deviceId = await SecureStore.getItemAsync('device_id');
      const deviceSecret = await SecureStore.getItemAsync('device_secret');
      if (deviceId && deviceSecret) {
        const res = await axios.get(`${API_BASE}/api/wallet/balance`, {
          params: { deviceId, deviceSecret },
        });
        const ecoin = res.data?.wallet?.balance_ecoin ?? 0;
        setBalance(ecoin);
      }
    } catch (err: any) {
      console.error('[Wallet] balance fetch failed:', err.message);
    }
  }, []);

  useEffect(() => {
    let purchaseUpdateSub: { remove: () => void } | null = null;
    let purchaseErrorSub: { remove: () => void } | null = null;

    (async () => {
      // IAP only on real iOS device (not simulator, not Android)
      if (Platform.OS !== 'ios') {
        await fetchBalance();
        setIapAvailable(false);
        setLoading(false);
        return;
      }

      try {
        await initConnection();
        setIapAvailable(true);
        setIapInitError(null);

        // Fetch products from App Store (v15: fetchProducts instead of getProducts)
        const prods = await fetchProducts({ skus: IAP_PRODUCT_IDS, type: 'in-app' });
        setProducts((prods || []).filter(isIosProduct));

        // Listen for purchase completions
        purchaseUpdateSub = purchaseUpdatedListener(async (purchase: Purchase) => {
          if (purchase.platform !== 'ios') return;
          const receipt = appleReceiptPayload(purchase as PurchaseIOS);
          if (!receipt) return;
          try {
            await verifyAndFinish(purchase as PurchaseIOS);
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

        await fetchBalance();
      } catch (err: any) {
        console.error('[IAP] Init failed:', err.message);
        await fetchBalance();
        setIapAvailable(false);
        setIapInitError(err.message || String(err));
      } finally {
        setLoading(false);
      }
    })();

    return () => {
      purchaseUpdateSub?.remove();
      purchaseErrorSub?.remove();
      endConnection().catch(() => {});
    };
  }, [fetchBalance, retryNonce, t]);

  const verifyAndFinish = async (purchase: PurchaseIOS) => {
    const productId = purchase.productId;
    const transactionId = purchase.transactionId || purchase.id || '';
    const receipt = appleReceiptPayload(purchase);

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
        request: { apple: { sku: productId } },
        type: 'in-app',
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
    await fetchBalance();
    setRefreshing(false);
  };

  const retryIap = () => {
    if (loading) return;
    setLoading(true);
    setIapInitError(null);
    setRetryNonce((n) => n + 1);
  };

  const balanceCard = (
    <Card style={styles.balanceCard} mode="contained">
      <Card.Content style={styles.balanceContent}>
        <Text variant="labelMedium" style={styles.balanceLabel}>
          {t('wallet.balance', 'Balance')}
        </Text>
        <Text variant="displayMedium" style={styles.balanceValue}>
          {balance !== null ? balance.toLocaleString() : '-'}
        </Text>
        <Text variant="bodyMedium" style={styles.balanceUnit}>
          {t('wallet.ecoin_unit', 'e-coins')}
        </Text>
      </Card.Content>
    </Card>
  );

  if (!iapAvailable && !loading) {
    return (
      <SafeAreaView style={styles.container} edges={['bottom']}>
        <Stack.Screen options={{ title: t('wallet.title', 'Wallet'), headerShown: true }} />
        <ScrollView
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          contentContainerStyle={styles.scroll}
        >
          {balanceCard}
          <Card mode="outlined" style={styles.unavailableCard}>
            <Card.Content>
              <Text variant="titleMedium" style={styles.sectionTitle}>
                {t('wallet.iap_unavailable_title', 'Purchases unavailable')}
              </Text>
              <Text variant="bodyMedium" style={styles.unavailableText}>
                {t(
                  'wallet.iap_unavailable_desc',
                  'E-coin top-up is only available through Apple In-App Purchase in the iOS app. Please try again later.'
                )}
              </Text>
              {iapInitError ? (
                <Text variant="bodySmall" style={styles.errorHint}>
                  {iapInitError}
                </Text>
              ) : null}
              <Button mode="contained-tonal" onPress={retryIap} style={styles.retryButton}>
                {t('common.retry', 'Retry')}
              </Button>
            </Card.Content>
          </Card>
        </ScrollView>
      </SafeAreaView>
    );
  }

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
        {balanceCard}

        {/* Top-up Section */}
        <Text variant="titleMedium" style={styles.sectionTitle}>
          {t('wallet.topup_via_apple', 'Top Up (via Apple IAP)')}
        </Text>
        <Text variant="bodySmall" style={styles.sectionHint}>
          {t('wallet.topup_hint', 'All purchases are processed securely through Apple.')}
        </Text>

        {products.length === 0 ? (
          <Text style={styles.noProducts}>
            {t('wallet.no_products', 'Purchases are temporarily unavailable. Please try again later.')}
          </Text>
        ) : (
          products
            .slice()
            .sort((a, b) => productPrice(a) - productPrice(b))
            .map((product) => {
              const productId = product.id;
              const meta = TIER_META[productId];
              const isPurchasing = purchasing === productId;
              return (
                <Card
                  key={productId}
                  style={styles.tierCard}
                  mode="outlined"
                  onPress={() => handlePurchase(productId)}
                  disabled={!!purchasing}
                >
                  <Card.Content style={styles.tierContent}>
                    <View style={styles.tierLeft}>
                      <Text variant="titleMedium">
                        {meta?.label || product.title || productId}
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
                          {product.displayPrice || `$${product.price || ''}`}
                        </Text>
                      )}
                    </View>
                  </Card.Content>
                </Card>
              );
            })
        )}

        {/* Apple compliance footer */}
        <Divider style={{ marginVertical: 16 }} />
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
  unavailableCard: { marginTop: 8 },
  unavailableText: { opacity: 0.78, lineHeight: 20 },
  errorHint: { opacity: 0.58, marginTop: 12 },
  retryButton: { marginTop: 16, alignSelf: 'flex-start' },
  compliance: { textAlign: 'center', opacity: 0.5, marginTop: 24, padding: 16 },
});
