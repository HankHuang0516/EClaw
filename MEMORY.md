# EClaw Project Memory

Cross-session notes for Claude Code. Add new entries at the top of each section.

---

## Environment

### New Mac development environment setup (2026-03-23)
> File: `.claude/projects/.../memory/project_mac_env.md`

New ARM64 Mac set up for EClaw Android builds. Key paths:
- **Java 17**: `~/.jdk/amazon-corretto-17.jdk/Contents/Home` (Amazon Corretto, no Homebrew)
- **Node.js 20**: via NVM at `~/.nvm`
- **Android SDK**: `~/Android/sdk` (build-tools 35.0.0 + platforms android-35)
- **local.properties**: `sdk.dir=/Users/hank/Android/sdk`
- **keystore**: `release-key.jks` (password: android, alias: key0)

Always export before Android builds:
```bash
export JAVA_HOME="$HOME/.jdk/amazon-corretto-17.jdk/Contents/Home"
export PATH="$JAVA_HOME/bin:$PATH"
export ANDROID_HOME="$HOME/Android/sdk"
```

`gradlew` has macOS Xdock JVM options disabled (ARM64 ClassNotFoundException fix).

Key secrets in `~/Desktop/Project/`: `backend/.env`, `google-services.json`, `release-key.jks`, `play-service-account.json`.

---

## Git / Auth

### GitHub token setup for new Mac (2026-03-23)
> File: `.claude/projects/.../memory/feedback_git_token.md`

New Mac has no SSH keys and no `gh` CLI. Use PAT (classic, `repo` scope) stored in `backend/.env` as `GH_TOKEN`.

When `git push` fails with auth error:
```bash
GH_TOKEN=$(grep "^GH_TOKEN=" backend/.env | cut -d= -f2)
git remote set-url origin "https://HankHuang0516:${GH_TOKEN}@github.com/HankHuang0516/EClaw"
```

GitHub REST API (used instead of `gh` CLI):
```bash
# List open issues
curl -sL -H "Authorization: Bearer $GH_TOKEN" \
  "https://api.github.com/repositories/1150444936/issues?state=open&per_page=50"
```
