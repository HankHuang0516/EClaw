# Design: Copy Credentials UX — Settings Page

**Date**: 2026-03-07
**Status**: Approved

## Goal

Improve the Account card in `settings.html` so users can:
1. Copy Device ID individually (currently missing 📋 icon)
2. Copy Device Secret individually (already exists)
3. Copy both Device ID + Device Secret together in one click

Primary use case: sharing credentials with another person.

## Final Layout

```
┌─────────────────────────────────────────────┐
│ 👤 帳號                                      │
├─────────────────────────────────────────────┤
│ Email            bbb880008@gmail.com         │
├─────────────────────────────────────────────┤
│ Device ID        480def4c-···  👁 📋         │
├─────────────────────────────────────────────┤
│ Device Secret    3a4ddb10-···  👁 📋         │
├ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┤
│        [ 📋 Copy Credentials ]              │
├─────────────────────────────────────────────┤
│ 已連結帳號       Facebook                    │
└─────────────────────────────────────────────┘
```

## Changes

### settings.html — HTML

1. **Device ID row**: Add `copyDeviceId()` button (📋) after the 👁 button
2. **New "Copy Credentials" row**: After Device Secret row, before `connectedAccountsRow`
   - `border-top: 1px dashed var(--card-border)` separator
   - Full-width ghost outline button with `data-i18n="settings_copy_credentials"`
   - Calls `copyBothCredentials()`

### settings.html — JavaScript

1. `copyDeviceId()` — copies `_fullDeviceId`, calls `showCopyToast()`
2. `copyBothCredentials()` — copies `Device ID: {id}\nDevice Secret: {secret}`, calls `showCopyToast()`

### i18n.js

New key `settings_copy_credentials` added to all 8 locales:

| Locale | Value |
|--------|-------|
| en | Copy Credentials |
| zh-TW | 複製憑證 |
| zh-CN | 复制凭证 |
| ja | 認証情報をコピー |
| ko | 자격증명 복사 |
| th | คัดลอกข้อมูลรับรอง |
| vi | Sao chép thông tin xác thực |
| id | Salin Kredensial |
