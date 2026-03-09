import { listAccountIds, resolveAccount } from './config.js';

const DEFAULT_ACCOUNT_ID = 'default';

export const eclawOnboardingAdapter = {
  channel: 'eclaw',

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getStatus: async ({ cfg }: { cfg: any }) => {
    const ids = listAccountIds(cfg);
    const configured = ids.some((id: string) => {
      const acc = resolveAccount(cfg, id);
      return Boolean(acc.apiKey);
    });
    return {
      channel: 'eclaw',
      configured,
      statusLines: [`E-Claw: ${configured ? 'configured' : 'not configured'}`],
      selectionHint: configured ? 'configured' : 'E-Claw (AI Live Wallpaper Chat)',
      quickstartScore: configured ? 1 : 3,
    };
  },

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configure: async ({ cfg, prompter }: { cfg: any; prompter: any }) => {
    const accountId = DEFAULT_ACCOUNT_ID;
    const resolved = resolveAccount(cfg, accountId);

    await prompter.note(
      [
        '1. Log in to https://eclawbot.com',
        '2. Go to Portal → Settings → Channel API',
        '3. Create an API Key',
        '4. Enter the credentials below',
      ].join('\n'),
      'E-Claw Setup',
    );

    const apiKey = await prompter.text({
      message: 'Channel API Key',
      placeholder: 'eck_...',
      initialValue: resolved.apiKey || '',
      validate: (v: string) => (String(v ?? '').trim() ? undefined : 'Required'),
    });

    const botName = await prompter.text({
      message: 'Bot display name (optional)',
      placeholder: 'My Bot',
      initialValue: resolved.botName ?? '',
    });

    const webhookUrl = await prompter.text({
      message: 'Webhook URL (your OpenClaw public URL, e.g. https://openclaw.example.com)',
      placeholder: 'https://your-openclaw-domain.com',
      initialValue: resolved.webhookUrl ?? '',
    });

    const nextCfg = {
      ...cfg,
      channels: {
        ...(cfg.channels ?? {}),
        eclaw: {
          ...(cfg.channels?.eclaw ?? {}),
          accounts: {
            ...((cfg.channels?.eclaw as any)?.accounts ?? {}),  // eslint-disable-line @typescript-eslint/no-explicit-any
            [accountId]: {
              apiKey: String(apiKey).trim(),
              apiBase: resolved.apiBase || 'https://eclawbot.com',
              entityId: resolved.entityId,  // keep existing if re-configuring, else undefined = auto-assign
              botName: String(botName).trim() || undefined,
              webhookUrl: String(webhookUrl).trim() || undefined,
              enabled: true,
            },
          },
        },
      },
    };

    return { cfg: nextCfg, accountId };
  },
};
