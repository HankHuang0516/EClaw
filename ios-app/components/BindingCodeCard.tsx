import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Card, Text, Button, useTheme } from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import * as Clipboard from 'expo-clipboard';

interface BindingCodeCardProps {
  code: string;
  entityIndex: number;
  onDismiss: () => void;
}

export default function BindingCodeCard({
  code,
  entityIndex,
  onDismiss,
}: BindingCodeCardProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const [copied, setCopied] = React.useState(false);

  const handleCopy = async () => {
    await Clipboard.setStringAsync(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Format: "ABC123" → "ABC 123"
  const formattedCode = code.length === 6
    ? `${code.slice(0, 3)} ${code.slice(3)}`
    : code;

  return (
    <Card style={[styles.card, { backgroundColor: theme.colors.primaryContainer }]}>
      <Card.Content>
        <Text variant="titleSmall" style={{ color: theme.colors.onPrimaryContainer }}>
          {t('entity.binding_code_for', { index: entityIndex + 1 })}
        </Text>

        <Text
          variant="displaySmall"
          style={[styles.code, { color: theme.colors.primary, letterSpacing: 8 }]}
        >
          {formattedCode}
        </Text>

        <Text
          variant="bodySmall"
          style={{ color: theme.colors.onPrimaryContainer, marginTop: 4 }}
        >
          {t('home.binding_code_desc', { index: entityIndex + 1 })}
        </Text>

        <View style={styles.buttons}>
          <Button
            mode="contained"
            onPress={handleCopy}
            icon={copied ? 'check' : 'content-copy'}
            compact
          >
            {copied ? t('home.code_copied') : t('common.copy')}
          </Button>
          <Button mode="outlined" onPress={onDismiss} compact>
            {t('common.close')}
          </Button>
        </View>
      </Card.Content>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 16,
    marginVertical: 8,
    borderRadius: 16,
  },
  code: {
    textAlign: 'center',
    marginVertical: 16,
    fontWeight: 'bold',
  },
  buttons: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
});
