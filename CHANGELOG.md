# [1.47.0](https://github.com/HankHuang0516/realbot/compare/v1.46.0...v1.47.0) (2026-02-28)


### Features

* add AI chat concurrency queue with auto-retry ([ea58eb7](https://github.com/HankHuang0516/realbot/commit/ea58eb70e0f07b494cec7db495910edffe727d56))

# [1.46.0](https://github.com/HankHuang0516/realbot/compare/v1.45.1...v1.46.0) (2026-02-28)


### Features

* AI chat enhancements — feedback entry, image support, Android app ([ee94822](https://github.com/HankHuang0516/realbot/commit/ee94822739e20e48107db12851caf35fc360536c))

## [1.45.1](https://github.com/HankHuang0516/realbot/compare/v1.45.0...v1.45.1) (2026-02-28)


### Bug Fixes

* resetBotToBotCounter now resets all entity slots dynamically ([80b16ed](https://github.com/HankHuang0516/realbot/commit/80b16edb871afa1f6213f7c9f3d958cac1d7c9d8)), closes [#85](https://github.com/HankHuang0516/realbot/issues/85)

# [1.45.0](https://github.com/HankHuang0516/realbot/compare/v1.44.1...v1.45.0) (2026-02-28)


### Bug Fixes

* filter Android user messages from ChatIntegrity validation ([71bef4a](https://github.com/HankHuang0516/realbot/commit/71bef4a54a0376c4d91e32f5c29cb9e7ccf762c8)), closes [#82](https://github.com/HankHuang0516/realbot/issues/82) [#83](https://github.com/HankHuang0516/realbot/issues/83)


### Features

* add free bot limit hint and sold-out rental demand flow ([#81](https://github.com/HankHuang0516/realbot/issues/81)) ([2f57b26](https://github.com/HankHuang0516/realbot/commit/2f57b263c628f66ef8b66f34df981523c1a7e530))

## [1.44.1](https://github.com/HankHuang0516/realbot/compare/v1.44.0...v1.44.1) (2026-02-28)


### Bug Fixes

* use Dockerfile for claude-cli-proxy to ensure git is installed ([6e57edd](https://github.com/HankHuang0516/realbot/commit/6e57edd393cb0e7856179399030b3e3ba5abb175))

# [1.44.0](https://github.com/HankHuang0516/realbot/compare/v1.43.7...v1.44.0) (2026-02-28)


### Features

* log system errors to server_logs for AI visibility ([7410ac4](https://github.com/HankHuang0516/realbot/commit/7410ac46ee2ba9717f2d9f9ecba30443296091c2))

## [1.43.7](https://github.com/HankHuang0516/realbot/compare/v1.43.6...v1.43.7) (2026-02-28)


### Bug Fixes

* handle duplicate public_code gracefully during device save ([3c15ea6](https://github.com/HankHuang0516/realbot/commit/3c15ea6be4dea4360f44f82464e86e99cec159fe))

## [1.43.6](https://github.com/HankHuang0516/realbot/compare/v1.43.5...v1.43.6) (2026-02-28)


### Bug Fixes

* decouple Bash tool from repo clone status ([e2bc96a](https://github.com/HankHuang0516/realbot/commit/e2bc96ab7c217f61bcd6ff08821aed710a330c21))

## [1.43.5](https://github.com/HankHuang0516/realbot/compare/v1.43.4...v1.43.5) (2026-02-28)


### Bug Fixes

* add git via both nixPkgs and aptPkgs for Nixpacks compatibility ([b31dcf9](https://github.com/HankHuang0516/realbot/commit/b31dcf90ecc7599a7d8dc63d8891e1bcc8905bde))

## [1.43.4](https://github.com/HankHuang0516/realbot/compare/v1.43.3...v1.43.4) (2026-02-28)


### Bug Fixes

* add git to proxy container + remove invalid CLI flag ([3b98cd7](https://github.com/HankHuang0516/realbot/commit/3b98cd783415a5bf4dac82c321e6592c8581a4f2))

## [1.43.3](https://github.com/HankHuang0516/realbot/compare/v1.43.2...v1.43.3) (2026-02-28)


### Bug Fixes

* set CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS env var for headless CLI ([7a5681b](https://github.com/HankHuang0516/realbot/commit/7a5681b117c831664694fbae065115e9058d8c19))

## [1.43.2](https://github.com/HankHuang0516/realbot/compare/v1.43.1...v1.43.2) (2026-02-28)


### Bug Fixes

* add --dangerouslySkipPermissions to CLI chat spawn ([18a16ba](https://github.com/HankHuang0516/realbot/commit/18a16ba9b3073f88092b66e64171bd81b89fcfbf))

## [1.43.1](https://github.com/HankHuang0516/realbot/compare/v1.43.0...v1.43.1) (2026-02-28)


### Bug Fixes

* instruct AI to execute tools directly in non-interactive mode ([cceb659](https://github.com/HankHuang0516/realbot/commit/cceb659a2d3ef83bf3ddf2b263dd44b176926644))

# [1.43.0](https://github.com/HankHuang0516/realbot/compare/v1.42.2...v1.43.0) (2026-02-28)


### Features

* **proxy:** enable AI to query server logs via Bash + curl ([cf49236](https://github.com/HankHuang0516/realbot/commit/cf49236a86be3e61844a2af77d4b781e08daa6bd))

## [1.42.2](https://github.com/HankHuang0516/realbot/compare/v1.42.1...v1.42.2) (2026-02-28)


### Bug Fixes

* deduplicate broadcast header entities + user message dedup ([1722755](https://github.com/HankHuang0516/realbot/commit/1722755c54841a9d630e076cacb1b6f3083390c5))

## [1.42.1](https://github.com/HankHuang0516/realbot/compare/v1.42.0...v1.42.1) (2026-02-28)


### Bug Fixes

* entity reorder now syncs all associated data atomically ([0ef28ca](https://github.com/HankHuang0516/realbot/commit/0ef28cacb23a65e0ec6693d5050b16fdc012a3ab))

# [1.42.0](https://github.com/HankHuang0516/realbot/compare/v1.41.4...v1.42.0) (2026-02-28)


### Features

* universal AI chat widget + admin assistant with repo access ([0fee0b0](https://github.com/HankHuang0516/realbot/commit/0fee0b09138caacb2e206efc50bcbfd1a800d0f6))

## [1.41.4](https://github.com/HankHuang0516/realbot/compare/v1.41.3...v1.41.4) (2026-02-28)


### Bug Fixes

* make usage limit unconditional for all client/speak calls ([2b107ab](https://github.com/HankHuang0516/realbot/commit/2b107abe6a3ed096088038692dc301983343a39f))

## [1.41.3](https://github.com/HankHuang0516/realbot/compare/v1.41.2...v1.41.3) (2026-02-28)


### Bug Fixes

* add missing chat-integrity.js (fixes deployment crash) ([a87e700](https://github.com/HankHuang0516/realbot/commit/a87e7007ded80fdfa425d4aae84a973696d8e581))

## [1.41.2](https://github.com/HankHuang0516/realbot/compare/v1.41.1...v1.41.2) (2026-02-28)


### Bug Fixes

* fail-safe usage limit with in-memory fallback ([dac91f8](https://github.com/HankHuang0516/realbot/commit/dac91f88e1d8a6d27b0afad4ad69316ba5653259))

## [1.41.1](https://github.com/HankHuang0516/realbot/compare/v1.41.0...v1.41.1) (2026-02-28)


### Bug Fixes

* telemetry path in sub-routers, duration=0 handling, usage limit scope ([f0203f1](https://github.com/HankHuang0516/realbot/commit/f0203f1b381cfc197d29047c636ae027ca5c26e9))

# [1.41.0](https://github.com/HankHuang0516/realbot/compare/v1.40.1...v1.41.0) (2026-02-28)


### Features

* add admin role awareness to AI support proxy ([1d025e2](https://github.com/HankHuang0516/realbot/commit/1d025e2366b998599e090690f0bd1dd43ddfc993))

## [1.40.1](https://github.com/HankHuang0516/realbot/compare/v1.40.0...v1.40.1) (2026-02-28)


### Bug Fixes

* auto-restore .claude.json from backup on proxy startup ([9f87b2f](https://github.com/HankHuang0516/realbot/commit/9f87b2fecaac64ed50bed59d95bb636d98177ea6))

# [1.40.0](https://github.com/HankHuang0516/realbot/compare/v1.39.4...v1.40.0) (2026-02-28)


### Features

* add Claude CLI warmup to reduce cold start latency ([dd4d0ae](https://github.com/HankHuang0516/realbot/commit/dd4d0aec88f5989121fe809ed9569f03261f7a3b))

## [1.39.4](https://github.com/HankHuang0516/realbot/compare/v1.39.3...v1.39.4) (2026-02-28)


### Bug Fixes

* use stdin for Claude CLI prompt + increase timeout to 55s ([f8aad9d](https://github.com/HankHuang0516/realbot/commit/f8aad9d6d02c7d2a895428a339173fca6537ecd4))

## [1.39.3](https://github.com/HankHuang0516/realbot/compare/v1.39.2...v1.39.3) (2026-02-28)


### Bug Fixes

* install Claude CLI as dependency in proxy container ([3f4c854](https://github.com/HankHuang0516/realbot/commit/3f4c85443e45c3cef2eaecc767e6814024a41f82))

## [1.39.2](https://github.com/HankHuang0516/realbot/compare/v1.39.1...v1.39.2) (2026-02-28)


### Bug Fixes

* add debug logging to AI support proxy communication ([a3dcd81](https://github.com/HankHuang0516/realbot/commit/a3dcd816ce642126f2fc132e36781a8c6de2c096))

## [1.39.1](https://github.com/HankHuang0516/realbot/compare/v1.39.0...v1.39.1) (2026-02-28)


### Bug Fixes

* sync web-sent messages to Android chat + merge broadcast bubbles ([0e8c0b0](https://github.com/HankHuang0516/realbot/commit/0e8c0b0523fc36598e4863949d0021ab844934cd))

# [1.39.0](https://github.com/HankHuang0516/realbot/compare/v1.38.1...v1.39.0) (2026-02-28)


### Features

* **admin:** add AI Support Chat widget on admin dashboard ([f3ed7a9](https://github.com/HankHuang0516/realbot/commit/f3ed7a9f5bf2916dfdbae594dc605e57e1211288))

## [1.38.1](https://github.com/HankHuang0516/realbot/compare/v1.38.0...v1.38.1) (2026-02-28)


### Bug Fixes

* **ai-support:** improve 401 and setup_password rules ([d782e4f](https://github.com/HankHuang0516/realbot/commit/d782e4fda2d86fc765beace60e4ff54479298f90))

# [1.38.0](https://github.com/HankHuang0516/realbot/compare/v1.37.1...v1.38.0) (2026-02-28)


### Features

* add AI-powered binding troubleshooter with rule engine + Claude CLI proxy ([8bf04b3](https://github.com/HankHuang0516/realbot/commit/8bf04b3b36c7ca0a83a3c3a942e53fbd161142e0))

## [1.37.1](https://github.com/HankHuang0516/realbot/compare/v1.37.0...v1.37.1) (2026-02-28)


### Bug Fixes

* smart 401 handling — guide bot to retry with setup_password ([c1f9e70](https://github.com/HankHuang0516/realbot/commit/c1f9e705dc2b28cf9e283b4c0ede325d8b813ade))

# [1.37.0](https://github.com/HankHuang0516/realbot/compare/v1.36.0...v1.37.0) (2026-02-28)


### Features

* **admin:** add Setup Password field to create bot dialog ([6f44ad4](https://github.com/HankHuang0516/realbot/commit/6f44ad40fae92754c141d3cf8f85b4eec8e7d851))

# [1.36.0](https://github.com/HankHuang0516/realbot/compare/v1.35.1...v1.36.0) (2026-02-28)


### Features

* add WebSocket transport for OpenClaw gateways with SETUP_PASSWORD ([8cb91b4](https://github.com/HankHuang0516/realbot/commit/8cb91b4e1d86a86b69abf648b370d8dec953eeb8))

## [1.35.1](https://github.com/HankHuang0516/realbot/compare/v1.35.0...v1.35.1) (2026-02-28)


### Bug Fixes

* rename loading UI, entity card removal, copy button UX ([ca73a9e](https://github.com/HankHuang0516/realbot/commit/ca73a9ee4a92411215a2ba33b280e125d6b0d13c))

# [1.35.0](https://github.com/HankHuang0516/realbot/compare/v1.34.1...v1.35.0) (2026-02-28)


### Features

* send email notification when feedback status changes ([641fbf4](https://github.com/HankHuang0516/realbot/commit/641fbf4aa69ae8c916162618e6e870a19e74b112))

## [1.34.1](https://github.com/HankHuang0516/realbot/compare/v1.34.0...v1.34.1) (2026-02-28)


### Bug Fixes

* change message_reactions.message_id from INTEGER to UUID ([ac96233](https://github.com/HankHuang0516/realbot/commit/ac96233209a9565b57db12dc76a7f322e766740f))

# [1.34.0](https://github.com/HankHuang0516/realbot/compare/v1.33.2...v1.34.0) (2026-02-28)


### Features

* expand XP system with 8 new channels + message like/dislike UI ([96a95ef](https://github.com/HankHuang0516/realbot/commit/96a95efd46c0b48d8ff2ff0ac4e809c70205b9ea))

## [1.33.2](https://github.com/HankHuang0516/realbot/compare/v1.33.1...v1.33.2) (2026-02-27)


### Bug Fixes

* **admin:** use cookie-based auth for DELETE official-bot endpoint ([0c1b8dd](https://github.com/HankHuang0516/realbot/commit/0c1b8dd5aacdb6b14dae3c99c36b01547efbf765))

## [1.33.1](https://github.com/HankHuang0516/realbot/compare/v1.33.0...v1.33.1) (2026-02-27)


### Bug Fixes

* **web:** show edit mode button by using inline-flex display ([b01600a](https://github.com/HankHuang0516/realbot/commit/b01600a61c2814e2bc17ab127fc3d29473d4aa1f))

# [1.33.0](https://github.com/HankHuang0516/realbot/compare/v1.32.1...v1.33.0) (2026-02-27)


### Features

* **web:** add edit mode to dashboard entity cards (parity with Android) ([d41156c](https://github.com/HankHuang0516/realbot/commit/d41156cc2297db9e500c42d8714575ce6a29a2c6))
* **admin:** add individual remove button to official bot list ([1f85683](https://github.com/HankHuang0516/realbot/commit/1f85683a09e4c1997d962ee42debc6533a891ed8))

## [1.32.1](https://github.com/HankHuang0516/realbot/compare/v1.32.0...v1.32.1) (2026-02-27)


### Bug Fixes

* mount /docs static route for webhook troubleshooting page ([28590d0](https://github.com/HankHuang0516/realbot/commit/28590d07002c89c103209fbb94e61595ebc24b8d))

# [1.32.0](https://github.com/HankHuang0516/realbot/compare/v1.31.3...v1.32.0) (2026-02-27)


### Features

* add webhook troubleshooting FAQ page, unify error messages ([cb52c16](https://github.com/HankHuang0516/realbot/commit/cb52c16b7a3e30c574a38316c16db4b6fd06f53b))

## [1.31.3](https://github.com/HankHuang0516/realbot/compare/v1.31.2...v1.31.3) (2026-02-27)


### Bug Fixes

* warn bots not to edit config files directly, use openclaw CLI ([e67037e](https://github.com/HankHuang0516/realbot/commit/e67037e1ce95893889dd9224ef3491139c412626))

## [1.31.2](https://github.com/HankHuang0516/realbot/compare/v1.31.1...v1.31.2) (2026-02-27)


### Bug Fixes

* add pairing_required solution hint to error messages ([5118d26](https://github.com/HankHuang0516/realbot/commit/5118d261d4007ae7f245ada2c9e977a3eb1b7324))

## [1.31.1](https://github.com/HankHuang0516/realbot/compare/v1.31.0...v1.31.1) (2026-02-27)


### Bug Fixes

* handshake now rejects pairing_required in response body ([e20a949](https://github.com/HankHuang0516/realbot/commit/e20a9497dfdf37289f217c21396366b0096c2f4e))

# [1.31.0](https://github.com/HankHuang0516/realbot/compare/v1.30.1...v1.31.0) (2026-02-27)


### Features

* add push health status tracking for bots (方案 A + B) ([bf42320](https://github.com/HankHuang0516/realbot/commit/bf42320ebaffd287db85e18ae6c565ffcd6d5d79))

## [1.30.1](https://github.com/HankHuang0516/realbot/compare/v1.30.0...v1.30.1) (2026-02-27)


### Bug Fixes

* replace inline 44KB skill doc with short hint in bind response ([9b075bb](https://github.com/HankHuang0516/realbot/commit/9b075bbff455360f074ffed3f8e68e1a7f0b86b3))

# [1.30.0](https://github.com/HankHuang0516/realbot/compare/v1.29.2...v1.30.0) (2026-02-27)


### Features

* add skills_documentation_url to bind response for large skill doc fetch ([51cd7bb](https://github.com/HankHuang0516/realbot/commit/51cd7bb06bb4abbe737967bb15b27e93fc4473da))

## [1.29.2](https://github.com/HankHuang0516/realbot/compare/v1.29.1...v1.29.2) (2026-02-27)


### Bug Fixes

* improve local/private IP webhook rejection with OpenClaw Overview guidance ([940feda](https://github.com/HankHuang0516/realbot/commit/940fedaa42e6bc96c5aa93fb5d4639c64cef12d4))

## [1.29.1](https://github.com/HankHuang0516/realbot/compare/v1.29.0...v1.29.1) (2026-02-27)


### Bug Fixes

* update sessions_send error messages to reference official docs instead of hardcoded config paths ([554ba72](https://github.com/HankHuang0516/realbot/commit/554ba722188d60d030fc6dfe9d17906bb924fb4c))

# [1.29.0](https://github.com/HankHuang0516/realbot/compare/v1.28.0...v1.29.0) (2026-02-27)


### Features

* record handshake failures to PostgreSQL for analysis ([8ad97be](https://github.com/HankHuang0516/realbot/commit/8ad97be7970669580e351c20e659c0a490cd552e))

# [1.28.0](https://github.com/HankHuang0516/realbot/compare/v1.27.2...v1.28.0) (2026-02-27)


### Features

* detect bot gateway disconnection (pairing required) and notify device ([2569d29](https://github.com/HankHuang0516/realbot/commit/2569d299522afa0b2020870109fbdb165e728e29))

## [1.27.2](https://github.com/HankHuang0516/realbot/compare/v1.27.1...v1.27.2) (2026-02-27)


### Bug Fixes

* let entity cards scroll independently via RecyclerView ([d2a5c36](https://github.com/HankHuang0516/realbot/commit/d2a5c362b923bc88da2d46189b90d76fbe6baa6d))

## [1.27.1](https://github.com/HankHuang0516/realbot/compare/v1.27.0...v1.27.1) (2026-02-26)


### Bug Fixes

* resolve 8 open issues via multi-agent parallel implementation ([d7b0ee0](https://github.com/HankHuang0516/realbot/commit/d7b0ee0f45477c76badcc64d46fa924110bd666a)), closes [#77](https://github.com/HankHuang0516/realbot/issues/77) [#76](https://github.com/HankHuang0516/realbot/issues/76) [#72](https://github.com/HankHuang0516/realbot/issues/72) [#73](https://github.com/HankHuang0516/realbot/issues/73) [#79](https://github.com/HankHuang0516/realbot/issues/79) [#80](https://github.com/HankHuang0516/realbot/issues/80) [#75](https://github.com/HankHuang0516/realbot/issues/75) [#74](https://github.com/HankHuang0516/realbot/issues/74)

# [1.27.0](https://github.com/HankHuang0516/realbot/compare/v1.26.0...v1.27.0) (2026-02-25)


### Features

* add cross-device bot-to-bot communication via public entity codes ([4993572](https://github.com/HankHuang0516/realbot/commit/4993572687c9089ea4074e60c18b8e6f2832fe4a)), closes [#70](https://github.com/HankHuang0516/realbot/issues/70)

# [1.26.0](https://github.com/HankHuang0516/realbot/compare/v1.25.2...v1.26.0) (2026-02-25)


### Features

* dynamically show 8 entity slots for premium users on web dashboard ([b334396](https://github.com/HankHuang0516/realbot/commit/b334396b89c571c77aeb6ac4a0f5811472298bb8))

## [1.25.2](https://github.com/HankHuang0516/realbot/compare/v1.25.1...v1.25.2) (2026-02-25)


### Bug Fixes

* update footer description to AI collaboration platform ([20bb415](https://github.com/HankHuang0516/realbot/commit/20bb415d23671a4b3b2c86273a78384843c4f1d0))

## [1.25.1](https://github.com/HankHuang0516/realbot/compare/v1.25.0...v1.25.1) (2026-02-25)


### Bug Fixes

* admin link not showing on info page ([ad28fe4](https://github.com/HankHuang0516/realbot/commit/ad28fe4a2a32b2ea2c77c5c3a032a5075f920a7e))

# [1.25.0](https://github.com/HankHuang0516/realbot/compare/v1.24.0...v1.25.0) (2026-02-25)


### Features

* add video sending support to chat with streaming playback ([f24f462](https://github.com/HankHuang0516/realbot/commit/f24f462038f20494ab59e4ef10013e890033dadf))

# [1.24.0](https://github.com/HankHuang0516/realbot/compare/v1.23.0...v1.24.0) (2026-02-25)


### Features

* add bbb880008@gmail.com as admin user ([1aa4ade](https://github.com/HankHuang0516/realbot/commit/1aa4adec63ca0fb7622a91681b974da11bcc55d1))

# [1.23.0](https://github.com/HankHuang0516/realbot/compare/v1.22.3...v1.23.0) (2026-02-25)


### Bug Fixes

* show authenticated nav on info page for logged-in users ([ec7eed9](https://github.com/HankHuang0516/realbot/commit/ec7eed91589cba04bd40756ef7808cde94691538))


### Features

* add photo upload to settings feedback dialog ([e409ff6](https://github.com/HankHuang0516/realbot/commit/e409ff67f2bee5400384fab157fc095fc2f75df7))

## [1.22.3](https://github.com/HankHuang0516/realbot/compare/v1.22.2...v1.22.3) (2026-02-25)


### Bug Fixes

* add fill color to card emoji icons (lobster + airplane) ([5527523](https://github.com/HankHuang0516/realbot/commit/55275237476ad378f1c265c7ec2a8cdf3e1cb0b2)), closes [#6C63FF](https://github.com/HankHuang0516/realbot/issues/6C63FF) [#0088CC](https://github.com/HankHuang0516/realbot/issues/0088CC)
* regenerate PNG with CJK font support and updated QR codes ([f3989d4](https://github.com/HankHuang0516/realbot/commit/f3989d442654bdb10c020bdd283a6b74a2a80a29))
* replace broken QR codes with valid ones for Web portal and Android app ([1c61238](https://github.com/HankHuang0516/realbot/commit/1c612385f35a13bff9b6ae152fb47f37762f8c8d))
* replace emoji icons with proper SVG brand icons + fix table overflow ([51d0916](https://github.com/HankHuang0516/realbot/commit/51d0916021da264e5a3bf5fbc9fbae56f735d002))
* use rsvg-convert for PNG with proper emoji + CJK rendering ([29d5f9a](https://github.com/HankHuang0516/realbot/commit/29d5f9ae424ee891da5abef6e13b72e1c2e5ba4c))
* widen QR cards, replace blurry emoji, fix corrupted QR data ([b16bbe5](https://github.com/HankHuang0516/realbot/commit/b16bbe5e630a1e22ab2a81de54bb7ac63f0c2750))

## [1.22.2](https://github.com/HankHuang0516/realbot/compare/v1.22.1...v1.22.2) (2026-02-25)


### Bug Fixes

* resolve "Invalid Date" in notification items ([ecc745d](https://github.com/HankHuang0516/realbot/commit/ecc745d4551d9f91c29fce8c1d1e36663516cc36))

## [1.22.1](https://github.com/HankHuang0516/realbot/compare/v1.22.0...v1.22.1) (2026-02-25)


### Bug Fixes

* repair all GitHub Actions CI failures ([cf0145e](https://github.com/HankHuang0516/realbot/commit/cf0145efddb0dc8a714d0a78198b5250888cd38e))

# [1.22.0](https://github.com/HankHuang0516/realbot/compare/v1.21.0...v1.22.0) (2026-02-25)


### Features

* add XP/Level system for entities ([6acfff3](https://github.com/HankHuang0516/realbot/commit/6acfff325515bd7e117b896a37742b5578a3fdf2))

# [1.21.0](https://github.com/HankHuang0516/realbot/compare/v1.20.1...v1.21.0) (2026-02-24)


### Features

* reframe comparison as competitive + add iPhone/Web note & QR codes ([4008efa](https://github.com/HankHuang0516/realbot/commit/4008efa9ddf7717f3b44cf53d401099636463bcf))

## [1.20.1](https://github.com/HankHuang0516/realbot/compare/v1.20.0...v1.20.1) (2026-02-24)


### Bug Fixes

* allow debug/test devices to use all 8 entity slots ([#66](https://github.com/HankHuang0516/realbot/issues/66)) ([3ec7ca4](https://github.com/HankHuang0516/realbot/commit/3ec7ca490899495daaab56a4dd6bfeb01cba6fe2))
* dark theme for notification/language cards and fix API field name mismatch ([9b89f46](https://github.com/HankHuang0516/realbot/commit/9b89f461059b8547f1914dd002ef5c42c62e8f56)), closes [#1A1A1A](https://github.com/HankHuang0516/realbot/issues/1A1A1A) [#333333](https://github.com/HankHuang0516/realbot/issues/333333)

# [1.20.0](https://github.com/HankHuang0516/realbot/compare/v1.19.0...v1.20.0) (2026-02-24)


### Features

* redesign comparison infographic with 3-column card layout ([41511fd](https://github.com/HankHuang0516/realbot/commit/41511fdc27d2a2420ae75374a434dd2a8bcd3439))

# [1.19.0](https://github.com/HankHuang0516/realbot/compare/v1.18.0...v1.19.0) (2026-02-24)


### Features

* add E-Claw vs Telegram comparison infographic (SVG) ([7c72fee](https://github.com/HankHuang0516/realbot/commit/7c72fee0c13f3f57460d0b444b2f589168b8a6c1))
* complete E-Claw vs Telegram comparison with all 12 categories ([e593a86](https://github.com/HankHuang0516/realbot/commit/e593a86fa26bad7161e2f332fd56a5f84642d566))

# [1.18.0](https://github.com/HankHuang0516/realbot/compare/v1.17.0...v1.18.0) (2026-02-24)


### Features

* collapsible notification preferences section in settings ([8faf562](https://github.com/HankHuang0516/realbot/commit/8faf5627c74de1d48791527ddc1a8d76d29a7833))

# [1.17.0](https://github.com/HankHuang0516/realbot/compare/v1.16.2...v1.17.0) (2026-02-24)


### Features

* unified Info Hub with embedded User Guide, FAQ, Release Notes & Compare ([020ee67](https://github.com/HankHuang0516/realbot/commit/020ee6761c42a2e0f16599fac267b57e13935260)), closes [info.html#section](https://github.com/info.html/issues/section)

## [1.16.2](https://github.com/HankHuang0516/realbot/compare/v1.16.1...v1.16.2) (2026-02-24)


### Bug Fixes

* auth redirect loop caused by /api/notifications/count returning 401 ([cb4d6a7](https://github.com/HankHuang0516/realbot/commit/cb4d6a7791ae25e19b685247766ee68acfc6701c))

## [1.16.1](https://github.com/HankHuang0516/realbot/compare/v1.16.0...v1.16.1) (2026-02-24)


### Bug Fixes

* canonical domain redirect to prevent cookie/auth loop ([e7b2d5b](https://github.com/HankHuang0516/realbot/commit/e7b2d5bfdaf036b3a4fe69dc6ac1a4402e299e23))

# [1.16.0](https://github.com/HankHuang0516/realbot/compare/v1.15.0...v1.16.0) (2026-02-24)


### Features

* redirect root URL to /portal/ for custom domain ([a0affdf](https://github.com/HankHuang0516/realbot/commit/a0affdf6ce249314b5f2d4bec489e59142ad43f5))

# [1.15.0](https://github.com/HankHuang0516/realbot/compare/v1.14.0...v1.15.0) (2026-02-24)


### Features

* enable Firebase Cloud Messaging (FCM) for Android push notifications ([180b13f](https://github.com/HankHuang0516/realbot/commit/180b13ff3b92c22d33d25546d08348a8ce3ad0b0))

# [1.14.0](https://github.com/HankHuang0516/realbot/compare/v1.13.0...v1.14.0) (2026-02-24)


### Features

* add comprehensive notification system (Socket.IO, Web Push, FCM prep, preferences) ([8f629fc](https://github.com/HankHuang0516/realbot/commit/8f629fcde80f20e6adb85371b1b4dab6a0e0e7bf))

# [1.13.0](https://github.com/HankHuang0516/realbot/compare/v1.12.0...v1.13.0) (2026-02-24)


### Features

* add public navigation bar with FAQ, Release Notes, and User Guide pages ([cfd30f0](https://github.com/HankHuang0516/realbot/commit/cfd30f004562ff7d85f49c8f0cf40c9456f4b302))

# [1.12.0](https://github.com/HankHuang0516/realbot/compare/v1.11.0...v1.12.0) (2026-02-24)


### Features

* fix newline display and add link preview for chat ([#58](https://github.com/HankHuang0516/realbot/issues/58), [#57](https://github.com/HankHuang0516/realbot/issues/57)) ([3ccba06](https://github.com/HankHuang0516/realbot/commit/3ccba0624f5615cda00f29e56d4f83c292cbb231))

# [1.11.0](https://github.com/HankHuang0516/realbot/compare/v1.10.0...v1.11.0) (2026-02-24)


### Bug Fixes

* correct Multi-Entity max to 8 and Setup description (independent platforms) ([13a8770](https://github.com/HankHuang0516/realbot/commit/13a8770fbf0d5fe773785292d904aac1a7664a7e))


### Features

* add E-Claw vs Telegram channel comparison page ([231b555](https://github.com/HankHuang0516/realbot/commit/231b555c16ea4397f1e297402a6201db9c05a418))
* add Mission Control & Chat Attachments comparison rows, fix Setup description ([009c4d1](https://github.com/HankHuang0516/realbot/commit/009c4d1290dc5972a1360b37771c76c0291bb5c9))

# [1.10.0](https://github.com/HankHuang0516/realbot/compare/v1.9.0...v1.10.0) (2026-02-23)


### Features

* show payment maintenance notice for TapPay features on Web Portal ([1af5365](https://github.com/HankHuang0516/realbot/commit/1af5365ea315d6829eef9899c2dc48f101fec8da))

# [1.9.0](https://github.com/HankHuang0516/realbot/compare/v1.8.0...v1.9.0) (2026-02-23)


### Features

* add multi-language support (8 languages) for Web Portal and Android ([b36248d](https://github.com/HankHuang0516/realbot/commit/b36248dd3952dfe610e5e67a36e0fc33bf9fcef4))

# [1.8.0](https://github.com/HankHuang0516/realbot/compare/v1.7.0...v1.8.0) (2026-02-23)


### Features

* implement issue [#55](https://github.com/HankHuang0516/realbot/issues/55) (task saved toast) and [#54](https://github.com/HankHuang0516/realbot/issues/54) (schedule history + chat annotation) ([b8a8b3c](https://github.com/HankHuang0516/realbot/commit/b8a8b3c1326f473ca7d2288d9ec95394292fee02))

# [1.7.0](https://github.com/HankHuang0516/realbot/compare/v1.6.2...v1.7.0) (2026-02-23)


### Features

* replace chat photo icon with + button, support multi-file upload (100MB) ([09a1072](https://github.com/HankHuang0516/realbot/commit/09a10726263c226fadc6e13eba409577bd955e76))

## [1.6.2](https://github.com/HankHuang0516/realbot/compare/v1.6.1...v1.6.2) (2026-02-23)


### Bug Fixes

* convert ChatActivity to full-screen dark style with bottom nav ([54f4abe](https://github.com/HankHuang0516/realbot/commit/54f4abe3394c5a711f086da7fb8a5f14074b86f2)), closes [#0D0D1A](https://github.com/HankHuang0516/realbot/issues/0D0D1A) [#1A1A2E](https://github.com/HankHuang0516/realbot/issues/1A1A2E)

## [1.6.1](https://github.com/HankHuang0516/realbot/compare/v1.6.0...v1.6.1) (2026-02-22)


### Bug Fixes

* bottom nav position consistency and edge padding ([e7b184a](https://github.com/HankHuang0516/realbot/commit/e7b184aa4e4da367e2b84a2101c5f16f89829dd6))

# [1.6.0](https://github.com/HankHuang0516/realbot/compare/v1.5.4...v1.6.0) (2026-02-22)


### Bug Fixes

* schedule card add icon and rename to 進入排程 ([09751b7](https://github.com/HankHuang0516/realbot/commit/09751b797eefb9ea9dc1956023eb2922f9ec7202))


### Features

* per-device entity limit (free: 4, premium: 8) ([ab07aef](https://github.com/HankHuang0516/realbot/commit/ab07aef4e888781a2b90433f55a2fe71f885cab8)), closes [#50](https://github.com/HankHuang0516/realbot/issues/50) [#49](https://github.com/HankHuang0516/realbot/issues/49) [#50](https://github.com/HankHuang0516/realbot/issues/50)
* schedule execution history, mission control UI improvements ([e84c622](https://github.com/HankHuang0516/realbot/commit/e84c6227cc696488f199bf2dcf6548bd2348eee2))

## [1.5.4](https://github.com/HankHuang0516/realbot/compare/v1.5.3...v1.5.4) (2026-02-22)


### Reverts

* rollback MAX_ENTITIES_PER_DEVICE to 4 ([1609941](https://github.com/HankHuang0516/realbot/commit/1609941ce2343f1361fa42e5344c676e8d0677e3)), closes [#50](https://github.com/HankHuang0516/realbot/issues/50)

## [1.5.3](https://github.com/HankHuang0516/realbot/compare/v1.5.2...v1.5.3) (2026-02-22)


### Bug Fixes

* increase MAX_ENTITIES_PER_DEVICE to 8 for debug entity support ([21863c5](https://github.com/HankHuang0516/realbot/commit/21863c51d1ccba89fb8e38840d0d7158693351ff))

## [1.5.2](https://github.com/HankHuang0516/realbot/compare/v1.5.1...v1.5.2) (2026-02-22)


### Bug Fixes

* use device timezone for cron schedule execution ([f8d45b1](https://github.com/HankHuang0516/realbot/commit/f8d45b1db8cf7cfc39c2fe04af9874eb5ed83e77))

## [1.5.1](https://github.com/HankHuang0516/realbot/compare/v1.5.0...v1.5.1) (2026-02-22)


### Bug Fixes

* improve entity chip UI - remove close icons, add avatars, dark theme colors ([8b97b80](https://github.com/HankHuang0516/realbot/commit/8b97b80d431ae455d8cecbb57c2697f4d48ecede))

# [1.5.0](https://github.com/HankHuang0516/realbot/compare/v1.4.1...v1.5.0) (2026-02-22)


### Features

* dynamic entity chips with debug 4/8 toggle ([0da6355](https://github.com/HankHuang0516/realbot/commit/0da6355ef4034756fb2a19a5c95fd5b3c766a2e8))

## [1.4.1](https://github.com/HankHuang0516/realbot/compare/v1.4.0...v1.4.1) (2026-02-22)


### Bug Fixes

* add [#48](https://github.com/HankHuang0516/realbot/issues/48) entity visibility diagnosis logging + auto-sync fix ([2952b80](https://github.com/HankHuang0516/realbot/commit/2952b804b89338a3dc2b2545e3f95fa843246752))
* add PR write permission and make Railway deploy non-blocking ([dd707cb](https://github.com/HankHuang0516/realbot/commit/dd707cb9caa7fcec78975051bd39733e3f3ea621))

# [1.4.0](https://github.com/HankHuang0516/realbot/compare/v1.3.2...v1.4.0) (2026-02-22)


### Bug Fixes

* add JUnit and Gson test dependencies for Kotlin unit tests ([47a367d](https://github.com/HankHuang0516/realbot/commit/47a367deb6cb6b2a58886ed286ab3ac94fccff05))
* auto-sync feedback status with GitHub issue state ([d908266](https://github.com/HankHuang0516/realbot/commit/d908266af85c4b1ccf18bd41dc7e0cbba3efaa3a))
* create Railway preview environment before deploy ([fa45a23](https://github.com/HankHuang0516/realbot/commit/fa45a23d74999b523f018327e9562543a985427c))
* resolve ESLint and Android Lint CI failures ([97e1c95](https://github.com/HankHuang0516/realbot/commit/97e1c95d1d825fa0dcaea1999ef9a8912c5a29cf))
* resolve ESLint and Android Lint CI failures ([00c914b](https://github.com/HankHuang0516/realbot/commit/00c914b204567c20ce3de6a5eaf1ce586729bc3d))
* resolve merge conflicts in package.json/package-lock.json ([b987c22](https://github.com/HankHuang0516/realbot/commit/b987c22f09fec51a92199087223b0ee4d386f180))
* restore CI workflows, fix eslint version conflict, add Unix gradlew ([32517a9](https://github.com/HankHuang0516/realbot/commit/32517a99027f718c68da2eb35d9afe30a35399b8))


### Features

* add soul category to Mission Control for entity personality management ([fdced69](https://github.com/HankHuang0516/realbot/commit/fdced69cbc69b3891759bbdf7957e6598a76e2df))

## [1.3.2](https://github.com/HankHuang0516/realbot/compare/v1.3.1...v1.3.2) (2026-02-22)


### Bug Fixes

* auto-sync feedback status with GitHub issue state ([723b859](https://github.com/HankHuang0516/realbot/commit/723b8598e27cf21194b0c6a23cf491c0b6c9ca3f))

## [1.3.1](https://github.com/HankHuang0516/realbot/compare/v1.3.0...v1.3.1) (2026-02-22)


### Bug Fixes

* remove schedule tab from web nav, add Chinese translations for Android schedule ([a214fda](https://github.com/HankHuang0516/realbot/commit/a214fda33ae28a47d075ad611b1b1a87b2f42f32))

# [1.3.0](https://github.com/HankHuang0516/realbot/compare/v1.2.0...v1.3.0) (2026-02-22)


### Features

* auto-delete Railway preview environment on PR close ([8db5a0b](https://github.com/HankHuang0516/realbot/commit/8db5a0b27c2bfcda54733741875313564dbd9cf9))

# [1.2.0](https://github.com/HankHuang0516/realbot/compare/v1.1.0...v1.2.0) (2026-02-22)


### Features

* enable Railway PR preview deploy in backend-ci ([e1145b6](https://github.com/HankHuang0516/realbot/commit/e1145b65ef3d45426048b81321778c591bf3519c))

# [1.1.0](https://github.com/HankHuang0516/realbot/compare/v1.0.24...v1.1.0) (2026-02-22)


### Features

* add Jest+Supertest, Android instrumented test, and CI/CD workflows ([8a8459d](https://github.com/HankHuang0516/realbot/commit/8a8459d1c94d983fe68e5281798e0ed3fe3fd86c))
