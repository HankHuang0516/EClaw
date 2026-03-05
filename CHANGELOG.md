## [1.90.2](https://github.com/HankHuang0516/realbot/compare/v1.90.1...v1.90.2) (2026-03-05)


### Bug Fixes

* **entities:** prevent Gson crash when bot sends non-numeric parts value ([5b9f097](https://github.com/HankHuang0516/realbot/commit/5b9f0979e60c9f3227ac0c9a536aac6ed2070de3))

## [1.90.1](https://github.com/HankHuang0516/realbot/compare/v1.90.0...v1.90.1) (2026-03-05)


### Bug Fixes

* **android:** resolve ChatIntegrity false-positives and LinkPreviewHelper NPE ([ee98c2c](https://github.com/HankHuang0516/realbot/commit/ee98c2c9543ee5025aae6e8f399c07e00ce7dc32)), closes [#141](https://github.com/HankHuang0516/realbot/issues/141) [#142](https://github.com/HankHuang0516/realbot/issues/142)

# [1.90.0](https://github.com/HankHuang0516/realbot/compare/v1.89.8...v1.90.0) (2026-03-05)


### Features

* **cleanup:** remove pixel screenshot (Option B) feature ([788563f](https://github.com/HankHuang0516/realbot/commit/788563f849cf84c9794d076bcc39e1636e84decf))

## [1.89.8](https://github.com/HankHuang0516/realbot/compare/v1.89.7...v1.89.8) (2026-03-05)


### Bug Fixes

* **screenshot:** register 5mb json limit before global middleware ([2c07a68](https://github.com/HankHuang0516/realbot/commit/2c07a686d68db5baff170c41045c7e991aa04fe5))

## [1.89.7](https://github.com/HankHuang0516/realbot/compare/v1.89.6...v1.89.7) (2026-03-05)


### Bug Fixes

* **screenshot:** increase body limit to 5mb for screenshot-result endpoint ([c68be3f](https://github.com/HankHuang0516/realbot/commit/c68be3f0419d0ac50ffef3f1a4f4dfdd679be9f6))

## [1.89.6](https://github.com/HankHuang0516/realbot/compare/v1.89.5...v1.89.6) (2026-03-05)


### Bug Fixes

* **screenshot:** add error propagation and logging in takeAndPostScreenshot ([f3b7e27](https://github.com/HankHuang0516/realbot/commit/f3b7e2755bb2f6490e5c6d6f98853207626da23d))

## [1.89.5](https://github.com/HankHuang0516/realbot/compare/v1.89.4...v1.89.5) (2026-03-05)


### Bug Fixes

* **ssl:** trust-all TrustManager in debug builds for emulator SSL fix ([2ad2948](https://github.com/HankHuang0516/realbot/commit/2ad294885947563190ded40744c918e518afccb0))

## [1.89.4](https://github.com/HankHuang0516/realbot/compare/v1.89.3...v1.89.4) (2026-03-05)


### Bug Fixes

* **ssl:** add network_security_config to trust user CAs in debug builds ([67f142a](https://github.com/HankHuang0516/realbot/commit/67f142a0f4dcedd676523a185dd3ba47e763d34d))

## [1.89.3](https://github.com/HankHuang0516/realbot/compare/v1.89.2...v1.89.3) (2026-03-05)


### Bug Fixes

* **claude-cli-proxy:** add missing import sys ([8a53b5d](https://github.com/HankHuang0516/realbot/commit/8a53b5d81e35c9ecfb2299405d85cfef22aa06b5))

## [1.89.2](https://github.com/HankHuang0516/realbot/compare/v1.89.1...v1.89.2) (2026-03-05)


### Bug Fixes

* **screenshot:** add canTakeScreenshot flag + shorten backend timeout ([a4ef2ed](https://github.com/HankHuang0516/realbot/commit/a4ef2edd823006d7f4aa58ef7d538ab4032c21c1))

## [1.89.1](https://github.com/HankHuang0516/realbot/compare/v1.89.0...v1.89.1) (2026-03-05)


### Bug Fixes

* **screenshot:** report onFailure error immediately to backend ([6226704](https://github.com/HankHuang0516/realbot/commit/6226704f1503f9fc0022335c254b4ae6b5982044))

# [1.89.0](https://github.com/HankHuang0516/realbot/compare/v1.88.3...v1.89.0) (2026-03-05)


### Features

* **remote-control:** add getWindows() fallback + pixel screenshot endpoint ([b17393c](https://github.com/HankHuang0516/realbot/commit/b17393cd92dcf36a665daa670d5d58b07e88cdc7))

## [1.88.3](https://github.com/HankHuang0516/realbot/compare/v1.88.2...v1.88.3) (2026-03-05)


### Bug Fixes

* **claude-cli-proxy:** redirect Python logging to stdout ([6eab316](https://github.com/HankHuang0516/realbot/commit/6eab31667069b0ff82b92d9fe8c5fe20269ee139))

## [1.88.2](https://github.com/HankHuang0516/realbot/compare/v1.88.1...v1.88.2) (2026-03-05)


### Performance Improvements

* **claude-cli-proxy:** reduce warmup interval from 5min to 30min ([a4d08c6](https://github.com/HankHuang0516/realbot/commit/a4d08c6403cee7fa6eec0ac100c51ca23ffe6bca))

## [1.88.1](https://github.com/HankHuang0516/realbot/compare/v1.88.0...v1.88.1) (2026-03-05)


### Bug Fixes

* **screen-control:** always include truncated field in screen-capture response ([d97579a](https://github.com/HankHuang0516/realbot/commit/d97579a2bea0e6313fc57a76abc51a935be020b3))

# [1.88.0](https://github.com/HankHuang0516/realbot/compare/v1.87.2...v1.88.0) (2026-03-05)


### Features

* **screen-control:** increase MAX_ELEMENTS 150→300, add truncated flag ([3d7b5d0](https://github.com/HankHuang0516/realbot/commit/3d7b5d095fc30e2354677bfc0a645077d0333ef3))

## [1.87.2](https://github.com/HankHuang0516/realbot/compare/v1.87.1...v1.87.2) (2026-03-05)


### Bug Fixes

* **screen-control:** ime_action fallback when no INPUT focus (ACTION_SET_TEXT case) ([70f0592](https://github.com/HankHuang0516/realbot/commit/70f0592966662ca0bd25e672214eb3501d74bd08))

## [1.87.1](https://github.com/HankHuang0516/realbot/compare/v1.87.0...v1.87.1) (2026-03-05)


### Bug Fixes

* **claude-cli-proxy:** wrap startCommand with sh -c for PORT variable expansion ([91d6310](https://github.com/HankHuang0516/realbot/commit/91d6310365d8d14aeb768c1f8477717430cc1d97))

# [1.87.0](https://github.com/HankHuang0516/realbot/compare/v1.86.1...v1.87.0) (2026-03-05)


### Features

* **screen-control:** smart ime_action fallback for apps without Enter key ([b4f0ddb](https://github.com/HankHuang0516/realbot/commit/b4f0ddba3f84cff59e094aad1ca7bc0df9714bb9))

## [1.86.1](https://github.com/HankHuang0516/realbot/compare/v1.86.0...v1.86.1) (2026-03-05)


### Bug Fixes

* **channel:** multi-account portal UI + auth.js regression fixes ([e34603c](https://github.com/HankHuang0516/realbot/commit/e34603caf2701c53e78c9feb8036f9564dbc82cf))

# [1.86.0](https://github.com/HankHuang0516/realbot/compare/v1.85.0...v1.86.0) (2026-03-05)


### Features

* **remote-control:** replace border with entity name indicator + fix accessibility detection ([74b0e89](https://github.com/HankHuang0516/realbot/commit/74b0e893acbf8e4b697a052645055780f11de134))

# [1.85.0](https://github.com/HankHuang0516/realbot/compare/v1.84.0...v1.85.0) (2026-03-05)


### Features

* **channel:** add self-test infrastructure + provision-device endpoint ([5e187bf](https://github.com/HankHuang0516/realbot/commit/5e187bf1118266a6f9d31f29d8f6871010a301ac))

# [1.84.0](https://github.com/HankHuang0516/realbot/compare/v1.83.2...v1.84.0) (2026-03-05)


### Features

* **channel:** support multiple OpenClaw plugins binding different entities ([c7ba874](https://github.com/HankHuang0516/realbot/commit/c7ba8746c60acfef6bfaed40307819d519234311))

## [1.83.2](https://github.com/HankHuang0516/realbot/compare/v1.83.1...v1.83.2) (2026-03-04)


### Bug Fixes

* **ui:** round border corners to match screen + halve border thickness ([43c3c2a](https://github.com/HankHuang0516/realbot/commit/43c3c2a396759ba8e9fdb288225c132c9845ea65))

## [1.83.1](https://github.com/HankHuang0516/realbot/compare/v1.83.0...v1.83.1) (2026-03-04)


### Bug Fixes

* **ui:** guard coerceIn against empty range in AiChatFabHelper ([eea9712](https://github.com/HankHuang0516/realbot/commit/eea9712e5edf17f133f020e573e951d5e40cb7f7))

# [1.83.0](https://github.com/HankHuang0516/realbot/compare/v1.82.0...v1.83.0) (2026-03-04)


### Features

* **remote-control:** add ime_action command to submit keyboard input ([acb04a8](https://github.com/HankHuang0516/realbot/commit/acb04a8f509786d0938c9a20d99a0f7aa8cbf768))

# [1.82.0](https://github.com/HankHuang0516/realbot/compare/v1.81.0...v1.82.0) (2026-03-04)


### Features

* **ui:** add Channel binding type indicators across Portal and Android ([57b54ac](https://github.com/HankHuang0516/realbot/commit/57b54acd371e1abae1955c13cf59d3272f4169cb))

# [1.81.0](https://github.com/HankHuang0516/realbot/compare/v1.80.0...v1.81.0) (2026-03-04)


### Features

* Android Channel API display + OpenClaw metadata + backend auth fix ([762ed62](https://github.com/HankHuang0516/realbot/commit/762ed62c29d42b4072ede530e01242a57f3d08dc))

# [1.80.0](https://github.com/HankHuang0516/realbot/compare/v1.79.0...v1.80.0) (2026-03-04)


### Features

* **settings:** add Delete Account entry in Settings (web + Android) ([cb94da1](https://github.com/HankHuang0516/realbot/commit/cb94da17610aa29c9f15bb3a57c5c4f2d2e40012))

# [1.79.0](https://github.com/HankHuang0516/realbot/compare/v1.78.0...v1.79.0) (2026-03-04)


### Features

* **auth:** add account deletion page and API for Google Play Data Safety ([c2071f5](https://github.com/HankHuang0516/realbot/commit/c2071f52b468878559e2c5aa4c2a6366154c5fce))

# [1.78.0](https://github.com/HankHuang0516/realbot/compare/v1.77.5...v1.78.0) (2026-03-04)


### Features

* **ai-chat:** persist pending requestId to survive Activity recreation ([#129](https://github.com/HankHuang0516/realbot/issues/129)) ([e9ac0e4](https://github.com/HankHuang0516/realbot/commit/e9ac0e44fa8804aef6566d7ce7a30a681fbc613f))

## [1.77.5](https://github.com/HankHuang0516/realbot/compare/v1.77.4...v1.77.5) (2026-03-04)


### Bug Fixes

* **chat:** resolve link preview crash and coroutine lifecycle issues ([39a201d](https://github.com/HankHuang0516/realbot/commit/39a201d0cdc33b42d67429a4fb3bcbd026b5fe7a)), closes [#131](https://github.com/HankHuang0516/realbot/issues/131) [#136](https://github.com/HankHuang0516/realbot/issues/136) [#128](https://github.com/HankHuang0516/realbot/issues/128) [#127](https://github.com/HankHuang0516/realbot/issues/127) [#130](https://github.com/HankHuang0516/realbot/issues/130)

## [1.77.4](https://github.com/HankHuang0516/realbot/compare/v1.77.3...v1.77.4) (2026-03-04)


### Bug Fixes

* **claude-cli-proxy:** replace hatchling local package install with requirements.txt ([542b918](https://github.com/HankHuang0516/realbot/commit/542b9184a30930a2df480dfd2d5f2a19d108b088))

## [1.77.3](https://github.com/HankHuang0516/realbot/compare/v1.77.2...v1.77.3) (2026-03-04)


### Bug Fixes

* add prominent accessibility disclosure dialog for Google Play compliance (v1.0.37) ([aa39248](https://github.com/HankHuang0516/realbot/commit/aa3924865a2017b03dc4f1faf6fc87b39f375fb7))

## [1.77.2](https://github.com/HankHuang0516/realbot/compare/v1.77.1...v1.77.2) (2026-03-04)


### Bug Fixes

* **portal:** apply i18n after nav/footer render in info.html ([586ece7](https://github.com/HankHuang0516/realbot/commit/586ece7b17511a8bfbece7a1be739d44191e49f1))
* **upload:** remove changesNotSentForReview param (rejected by Play API) ([a183a1f](https://github.com/HankHuang0516/realbot/commit/a183a1f647360de2047591d51eba9f912360c2df))

## [1.77.1](https://github.com/HankHuang0516/realbot/compare/v1.77.0...v1.77.1) (2026-03-04)


### Bug Fixes

* **portal:** fix screen-control Loading bug + update info.html with new features ([d240e7d](https://github.com/HankHuang0516/realbot/commit/d240e7de60f476b9d38a39fa395aef69a906ef64))

# [1.77.0](https://github.com/HankHuang0516/realbot/compare/v1.76.3...v1.77.0) (2026-03-04)


### Features

* **portal:** add Security & Privacy info card to Remote Control page ([1e9907f](https://github.com/HankHuang0516/realbot/commit/1e9907f16fa6bd4bf8990e993fb287c1b5544c4a))

## [1.76.3](https://github.com/HankHuang0516/realbot/compare/v1.76.2...v1.76.3) (2026-03-04)


### Bug Fixes

* **screen-control:** remove 20-capture session limit, keep 500ms interval only ([2efb3f2](https://github.com/HankHuang0516/realbot/commit/2efb3f2b17665f7cae0d0d2c5172974ab513539e))

## [1.76.2](https://github.com/HankHuang0516/realbot/compare/v1.76.1...v1.76.2) (2026-03-04)


### Bug Fixes

* **screen-control:** revert OkHttp to HttpURLConnection, remove typeWindowContentChanged ([6ee40ba](https://github.com/HankHuang0516/realbot/commit/6ee40ba3ced6a457d6154b3088c27d5c0504ae7d))

## [1.76.1](https://github.com/HankHuang0516/realbot/compare/v1.76.0...v1.76.1) (2026-03-04)


### Performance Improvements

* screen-capture latency optimizations ([c903d03](https://github.com/HankHuang0516/realbot/commit/c903d0321168158d4e9d9a799b0ae46ceadd6483))

# [1.76.0](https://github.com/HankHuang0516/realbot/compare/v1.75.0...v1.76.0) (2026-03-04)


### Features

* phone remote control via Accessibility Tree ([6a08cf3](https://github.com/HankHuang0516/realbot/commit/6a08cf3f241e480c845da794a0b4ecccb1e65b9f))

# [1.75.0](https://github.com/HankHuang0516/realbot/compare/v1.74.2...v1.75.0) (2026-03-04)


### Features

* auto-provision channel API key on registration + settings UI ([cfa0a37](https://github.com/HankHuang0516/realbot/commit/cfa0a37495c50fd2d76f43b782c9465f3917c26d))

## [1.74.2](https://github.com/HankHuang0516/realbot/compare/v1.74.1...v1.74.2) (2026-03-04)


### Bug Fixes

* crash on device.entities iteration + add crash logging to /api/logs ([9818442](https://github.com/HankHuang0516/realbot/commit/9818442db389db89f6ea606079c4e6cfcbf23b2b))

## [1.74.1](https://github.com/HankHuang0516/realbot/compare/v1.74.0...v1.74.1) (2026-03-03)


### Bug Fixes

* channel test checks entities wrapper object correctly ([40a08ee](https://github.com/HankHuang0516/realbot/commit/40a08ee6899f5413edb36236661da133425a0ed1))

# [1.74.0](https://github.com/HankHuang0516/realbot/compare/v1.73.0...v1.74.0) (2026-03-03)


### Features

* add OpenClaw channel plugin + backend Channel API ([4912fdd](https://github.com/HankHuang0516/realbot/commit/4912fdd7394facbbbcb8c5cbf31887660a0b4e7b))

# [1.73.0](https://github.com/HankHuang0516/realbot/compare/v1.72.0...v1.73.0) (2026-03-03)


### Bug Fixes

* address code review issues before merge ([0b246cf](https://github.com/HankHuang0516/realbot/commit/0b246cf99cefa3a68d77f1eb8bd4b4af56125eeb))


### Features

* **android:** add JIT vars approval dialog + sync locked flag ([44f446e](https://github.com/HankHuang0516/realbot/commit/44f446e06d557e12d09741201a85f375c85801e4))
* add JIT vars approval dialog to Portal shared socket handler ([dda4edc](https://github.com/HankHuang0516/realbot/commit/dda4edc5ffc4e73063c6cd62f62c90aba3b71fc4))
* encrypted env vars with JIT approval via Socket.IO ([#121](https://github.com/HankHuang0516/realbot/issues/121)) ([56416e2](https://github.com/HankHuang0516/realbot/commit/56416e21009cde73dd218fedac941fcd30fe6c5e))
* env-vars.html sends lock as separate flag + adds security info section ([ab410b9](https://github.com/HankHuang0516/realbot/commit/ab410b9eef890e79ac4896992d8b7f5884e2a0b3))

# [1.72.0](https://github.com/HankHuang0516/realbot/compare/v1.71.0...v1.72.0) (2026-03-03)


### Features

* **db:** add device_vars table + CRUD helpers for encrypted env vars ([43b631e](https://github.com/HankHuang0516/realbot/commit/43b631e04a2973e6813deba70fb94037a392fd96))
* chat cloud sync recovery + app version in telemetry ([#123](https://github.com/HankHuang0516/realbot/issues/123), [#124](https://github.com/HankHuang0516/realbot/issues/124)) ([6a71c35](https://github.com/HankHuang0516/realbot/commit/6a71c350f76f4554a9c95eb47350c58fd814f2d0))

# [1.71.0](https://github.com/HankHuang0516/realbot/compare/v1.70.0...v1.71.0) (2026-03-03)


### Features

* add crash reporting & debug logging for issue [#120](https://github.com/HankHuang0516/realbot/issues/120) ([99f6216](https://github.com/HankHuang0516/realbot/commit/99f621648b602c5cc402b24e10f5672159a45531))

# [1.70.0](https://github.com/HankHuang0516/realbot/compare/v1.69.0...v1.70.0) (2026-03-03)


### Features

* unify Mission Control delete UX — tap to edit, delete inside dialog ([#114](https://github.com/HankHuang0516/realbot/issues/114)) ([093af72](https://github.com/HankHuang0516/realbot/commit/093af72d5ee317d9a65380ca4f9e79c2afa3cc58))

# [1.69.0](https://github.com/HankHuang0516/realbot/compare/v1.68.1...v1.69.0) (2026-03-03)


### Features

* add broadcast recipient info toggle to Web Portal settings ([#105](https://github.com/HankHuang0516/realbot/issues/105)) ([fa0b07b](https://github.com/HankHuang0516/realbot/commit/fa0b07b894f31f2bedfbfbd8bcf344c74c89cb2b))
* add buildBroadcastRecipientBlock() helper ([#105](https://github.com/HankHuang0516/realbot/issues/105)) ([746ae03](https://github.com/HankHuang0516/realbot/commit/746ae038841a9556d9b6b4fd58ac170c64490912))
* add device preferences module with DB table ([#105](https://github.com/HankHuang0516/realbot/issues/105)) ([abfe650](https://github.com/HankHuang0516/realbot/commit/abfe6505064ec0e2d5136d318804e9de7b43701f))
* add device preferences UI in SettingsActivity + localized strings ([#105](https://github.com/HankHuang0516/realbot/issues/105)) ([60ac42b](https://github.com/HankHuang0516/realbot/commit/60ac42b7fa5c8ed63658a506b60f3048065701aa))
* add device-preferences API endpoints (GET/PUT) ([#105](https://github.com/HankHuang0516/realbot/issues/105)) ([2bd73b1](https://github.com/HankHuang0516/realbot/commit/2bd73b16575a88687926b7cb727286f4a25b1482))
* inject recipient info into bot broadcast push ([#105](https://github.com/HankHuang0516/realbot/issues/105)) ([0f41b34](https://github.com/HankHuang0516/realbot/commit/0f41b34c58a2230e2fba8ad7466ca38e43335526))
* inject recipient info into user broadcast push ([#105](https://github.com/HankHuang0516/realbot/issues/105)) ([eb7c5e1](https://github.com/HankHuang0516/realbot/commit/eb7c5e10ed394fd78204a20470bf3150fe7db9b5))

## [1.68.1](https://github.com/HankHuang0516/realbot/compare/v1.68.0...v1.68.1) (2026-03-02)


### Bug Fixes

* add dialog input CSS to env-vars.html for consistent styling ([b1e40c3](https://github.com/HankHuang0516/realbot/commit/b1e40c381de7b10e422ab47511a20c04dd13674f))

# [1.68.0](https://github.com/HankHuang0516/realbot/compare/v1.67.2...v1.68.0) (2026-03-02)


### Features

* wire Android chat reaction buttons (like/dislike) to backend API ([#109](https://github.com/HankHuang0516/realbot/issues/109)) ([43fadd5](https://github.com/HankHuang0516/realbot/commit/43fadd5cee82198329552e915c70488ce6d8f07a))

## [1.67.2](https://github.com/HankHuang0516/realbot/compare/v1.67.1...v1.67.2) (2026-03-02)


### Bug Fixes

* remove duplicate currentUser declaration causing SyntaxError in env-vars.html ([42eddbd](https://github.com/HankHuang0516/realbot/commit/42eddbde824a1efe040f02fd98b7d7b7091aab4c))

## [1.67.1](https://github.com/HankHuang0516/realbot/compare/v1.67.0...v1.67.1) (2026-03-02)


### Bug Fixes

* allow key name editing in Env Variables dialog ([b21f424](https://github.com/HankHuang0516/realbot/commit/b21f42414c2d7a26f20f6fff568e77a3e045f923))

# [1.67.0](https://github.com/HankHuang0516/realbot/compare/v1.66.1...v1.67.0) (2026-03-02)


### Features

* move Env Variables to dedicated tab (env-vars.html) ([0c909f8](https://github.com/HankHuang0516/realbot/commit/0c909f8499e90cd684c67f3e78d69a5acd46daa6))

## [1.66.1](https://github.com/HankHuang0516/realbot/compare/v1.66.0...v1.66.1) (2026-03-02)


### Bug Fixes

* short-circuit AI call when close_issue is pre-executed ([4245826](https://github.com/HankHuang0516/realbot/commit/424582643c240b4d015d976a9fb059fe77b1ab74))

# [1.66.0](https://github.com/HankHuang0516/realbot/compare/v1.65.4...v1.66.0) (2026-03-02)


### Features

* add local variables vault — device-only .env-like secret store ([bfebeba](https://github.com/HankHuang0516/realbot/commit/bfebeba869a958d7010361c1616a005ef6748996))

## [1.65.4](https://github.com/HankHuang0516/realbot/compare/v1.65.3...v1.65.4) (2026-03-02)


### Bug Fixes

* **lint:** add AbortController, TextDecoder, TextEncoder to ESLint globals ([271d0d5](https://github.com/HankHuang0516/realbot/commit/271d0d5cb7d98bf0f5afdbefbf0af975cca50a8b))

## [1.65.3](https://github.com/HankHuang0516/realbot/compare/v1.65.2...v1.65.3) (2026-03-02)


### Bug Fixes

* resolve 4 GitHub issues in parallel — [#100](https://github.com/HankHuang0516/realbot/issues/100), [#111](https://github.com/HankHuang0516/realbot/issues/111), [#112](https://github.com/HankHuang0516/realbot/issues/112), [#113](https://github.com/HankHuang0516/realbot/issues/113) ([09f3a6c](https://github.com/HankHuang0516/realbot/commit/09f3a6c2259d2a616e13aa9909560b75b4fbcdc5))

## [1.65.2](https://github.com/HankHuang0516/realbot/compare/v1.65.1...v1.65.2) (2026-03-02)


### Bug Fixes

* server-side pre-execute close_issue intent to bypass model safety training ([2d133cf](https://github.com/HankHuang0516/realbot/commit/2d133cf6fe2a2177c818d6d63bf2159390387c81)), closes [#123](https://github.com/HankHuang0516/realbot/issues/123)

## [1.65.1](https://github.com/HankHuang0516/realbot/compare/v1.65.0...v1.65.1) (2026-03-02)


### Bug Fixes

* update claude-proxy skill template with correct openclaw-claude-proxy steps ([fdb8b43](https://github.com/HankHuang0516/realbot/commit/fdb8b4394c17066c66cef0112f1729d0bb15a69f))

# [1.65.0](https://github.com/HankHuang0516/realbot/compare/v1.64.1...v1.65.0) (2026-03-02)


### Features

* add official skill templates and installation steps to skill dialog ([8bd3e50](https://github.com/HankHuang0516/realbot/commit/8bd3e508c3aab33a2e6452852947faee74e7fcc1))

## [1.64.1](https://github.com/HankHuang0516/realbot/compare/v1.64.0...v1.64.1) (2026-03-02)


### Bug Fixes

* strengthen system prompt to override model's GitHub permission hesitation ([c765813](https://github.com/HankHuang0516/realbot/commit/c7658138f0a0c84a11f8567e849a256e8cbdfaf6))

# [1.64.0](https://github.com/HankHuang0516/realbot/compare/v1.63.2...v1.64.0) (2026-03-02)


### Features

* show real-time AI progress during long requests ([3a3d523](https://github.com/HankHuang0516/realbot/commit/3a3d523dd53b269c4b264e25ab6ff52f4097ed08))

## [1.63.2](https://github.com/HankHuang0516/realbot/compare/v1.63.1...v1.63.2) (2026-03-02)


### Bug Fixes

* add URLSearchParams to ESLint globals ([91ee972](https://github.com/HankHuang0516/realbot/commit/91ee972c9ed60827dd2d0ad01705c3fa3cdae03d))

## [1.63.1](https://github.com/HankHuang0516/realbot/compare/v1.63.0...v1.63.1) (2026-03-02)


### Bug Fixes

* bump versionCode to 37 (36 already used on Play Console) ([e5fd9b8](https://github.com/HankHuang0516/realbot/commit/e5fd9b887f8c9dfe415ac42b8906f9acd0ab5ec1))

# [1.63.0](https://github.com/HankHuang0516/realbot/compare/v1.62.0...v1.63.0) (2026-03-02)


### Features

* use Anthropic tool use for GitHub actions instead of text parsing ([b567834](https://github.com/HankHuang0516/realbot/commit/b5678348b693b0cbfcaac7562ec790b6f00983c6))

# [1.62.0](https://github.com/HankHuang0516/realbot/compare/v1.61.3...v1.62.0) (2026-03-02)


### Features

* enable AI to close GitHub issues via action system ([#98](https://github.com/HankHuang0516/realbot/issues/98)) ([ea0131d](https://github.com/HankHuang0516/realbot/commit/ea0131d482796074b283702015ae7953317ef19e))

## [1.61.3](https://github.com/HankHuang0516/realbot/compare/v1.61.2...v1.61.3) (2026-03-02)


### Bug Fixes

* resolve 7 GitHub issues — parallel agent batch fix ([9262f6b](https://github.com/HankHuang0516/realbot/commit/9262f6b9081f3357343a618e59b48e3d21055a82)), closes [#97](https://github.com/HankHuang0516/realbot/issues/97)

## [1.61.2](https://github.com/HankHuang0516/realbot/compare/v1.61.1...v1.61.2) (2026-03-01)


### Bug Fixes

* persist DATABASE_URL to file for Claude CLI child processes ([7f1975e](https://github.com/HankHuang0516/realbot/commit/7f1975e479abeeccf68176f4332fab4e7da15a81))

## [1.61.1](https://github.com/HankHuang0516/realbot/compare/v1.61.0...v1.61.1) (2026-03-01)


### Bug Fixes

* use absolute path for db-query.js in system prompt ([63b9b14](https://github.com/HankHuang0516/realbot/commit/63b9b1459dab3fd7211bc0eee3bcf30781d29fed))

# [1.61.0](https://github.com/HankHuang0516/realbot/compare/v1.60.4...v1.61.0) (2026-03-01)


### Features

* connect claude-cli-proxy to Postgres for direct DB queries ([5022543](https://github.com/HankHuang0516/realbot/commit/5022543780b04717812740d8de4c6acac21db711))

## [1.60.4](https://github.com/HankHuang0516/realbot/compare/v1.60.3...v1.60.4) (2026-03-01)


### Bug Fixes

* increase max-turns to 15 and add intermediate feedback for AI chat ([87169be](https://github.com/HankHuang0516/realbot/commit/87169bea548dec916f946ea12f5398013d9686f7))

## [1.60.3](https://github.com/HankHuang0516/realbot/compare/v1.60.2...v1.60.3) (2026-03-01)


### Bug Fixes

* add Cache-Control no-cache for i18n.js to prevent stale translations ([4318f75](https://github.com/HankHuang0516/realbot/commit/4318f75487ae9316aafc633d3ebf71e417cb5a23))

## [1.60.2](https://github.com/HankHuang0516/realbot/compare/v1.60.1...v1.60.2) (2026-03-01)


### Bug Fixes

* add --verbose flag for stream-json output format ([0d2c859](https://github.com/HankHuang0516/realbot/commit/0d2c859155121e96118b86691ef3a720b007c724))

## [1.60.1](https://github.com/HankHuang0516/realbot/compare/v1.60.0...v1.60.1) (2026-03-01)


### Bug Fixes

* add fallback parsing when stream-json produces no NDJSON events ([8034150](https://github.com/HankHuang0516/realbot/commit/8034150517093c2fdffd340eca892c1d24af94bc))

# [1.60.0](https://github.com/HankHuang0516/realbot/compare/v1.59.5...v1.60.0) (2026-03-01)


### Features

* add /api/ai-support/proxy-sessions admin endpoint for session monitoring ([ca06dd8](https://github.com/HankHuang0516/realbot/commit/ca06dd86a005dcb8aa6c0830cf6ca14d9f7f9781))

## [1.59.5](https://github.com/HankHuang0516/realbot/compare/v1.59.4...v1.59.5) (2026-03-01)


### Bug Fixes

* sanitize raw CLI JSON in async path + stream-json monitoring for proxy ([b8ab09b](https://github.com/HankHuang0516/realbot/commit/b8ab09ba6c12f842e386734ba8fc55c40004e53b))

## [1.59.4](https://github.com/HankHuang0516/realbot/compare/v1.59.3...v1.59.4) (2026-03-01)


### Bug Fixes

* remove AD_ID permission and add changesNotSentForReview flag ([f2ae128](https://github.com/HankHuang0516/realbot/commit/f2ae1287cc52ae3bf8a45ce65754ca8f9e499c2b))

## [1.59.3](https://github.com/HankHuang0516/realbot/compare/v1.59.2...v1.59.3) (2026-03-01)


### Bug Fixes

* only dedup bot messages, not user messages in saveChatMessage ([bf6236d](https://github.com/HankHuang0516/realbot/commit/bf6236ddce3f17b56443a68fc444a7161d2d5d70))

## [1.59.2](https://github.com/HankHuang0516/realbot/compare/v1.59.1...v1.59.2) (2026-03-01)


### Bug Fixes

* use regular callback for FB.login (async not supported by Facebook SDK) ([f1443a8](https://github.com/HankHuang0516/realbot/commit/f1443a8ce68d865e3c65a19b864e0e62da8855fd))

## [1.59.1](https://github.com/HankHuang0516/realbot/compare/v1.59.0...v1.59.1) (2026-03-01)


### Bug Fixes

* add social login buttons and Google SDK to web portal login/register ([dd98a65](https://github.com/HankHuang0516/realbot/commit/dd98a65da0a786e00dcaff53fe9fa857352680b3))

# [1.59.0](https://github.com/HankHuang0516/realbot/compare/v1.58.0...v1.59.0) (2026-03-01)


### Features

* complete Google + Facebook OAuth social login integration ([aae345a](https://github.com/HankHuang0516/realbot/commit/aae345ae0c0f0d3509e9d28c14d721e4f4516380))

# [1.58.0](https://github.com/HankHuang0516/realbot/compare/v1.57.1...v1.58.0) (2026-03-01)


### Features

* async AI chat with direct Anthropic API + error handling ([3c1a3bc](https://github.com/HankHuang0516/realbot/commit/3c1a3bc5a171d78ddb4ed1bad2ce90a803bf242c))

## [1.57.1](https://github.com/HankHuang0516/realbot/compare/v1.57.0...v1.57.1) (2026-03-01)


### Bug Fixes

* add missing ai_chat_view_feedback string resource ([1429efc](https://github.com/HankHuang0516/realbot/commit/1429efc7aed573ae3eb6182f2be97af679b9a733))

# [1.57.0](https://github.com/HankHuang0516/realbot/compare/v1.56.0...v1.57.0) (2026-03-01)


### Features

* social login (Google/Facebook) + AI chat feedback dual-track ([62bc8ff](https://github.com/HankHuang0516/realbot/commit/62bc8ffc63e029dfe90d4d92bc9e177ee5444152))

# [1.56.0](https://github.com/HankHuang0516/realbot/compare/v1.55.0...v1.56.0) (2026-03-01)


### Features

* **android:** draggable AI FAB with edge snap and position memory ([bca3f81](https://github.com/HankHuang0516/realbot/commit/bca3f81ca5b46e83c8754949d83ba337f7b3e7e6))

# [1.55.0](https://github.com/HankHuang0516/realbot/compare/v1.54.2...v1.55.0) (2026-03-01)


### Features

* floating AI chat FAB on all main pages + account status card ([d8b1342](https://github.com/HankHuang0516/realbot/commit/d8b1342f25df3addb4e32784b6ed29918dcdae6d))

## [1.54.2](https://github.com/HankHuang0516/realbot/compare/v1.54.1...v1.54.2) (2026-03-01)


### Bug Fixes

* sanitize raw JSON from AI chat proxy response ([1bd6248](https://github.com/HankHuang0516/realbot/commit/1bd6248b6ce88b0ade3c96ae8d08d7ababdba401))

## [1.54.1](https://github.com/HankHuang0516/realbot/compare/v1.54.0...v1.54.1) (2026-03-01)


### Bug Fixes

* enable EYE_LID/EYE_ANGLE rendering and fix test scripts ([baec14d](https://github.com/HankHuang0516/realbot/commit/baec14d72d0f7abe794383ec7561e30805aac010))

# [1.54.0](https://github.com/HankHuang0516/realbot/compare/v1.53.2...v1.54.0) (2026-03-01)


### Features

* **android:** cross-device contacts system for chat ([1a12a7a](https://github.com/HankHuang0516/realbot/commit/1a12a7a6eb45e299ec8854de11055cc1fd63e73a))

## [1.53.2](https://github.com/HankHuang0516/realbot/compare/v1.53.1...v1.53.2) (2026-03-01)


### Bug Fixes

* chat filter shows broadcast/speak-to messages for recipient entities ([1772877](https://github.com/HankHuang0516/realbot/commit/17728779d12acf7ad95e22be39ebc39f09b9bb6c))

## [1.53.1](https://github.com/HankHuang0516/realbot/compare/v1.53.0...v1.53.1) (2026-03-01)


### Bug Fixes

* improve schedule history display, matching accuracy, and pagination ([f721628](https://github.com/HankHuang0516/realbot/commit/f721628777d066d2058103daf7047aacd27b082a))

# [1.53.0](https://github.com/HankHuang0516/realbot/compare/v1.52.1...v1.53.0) (2026-03-01)


### Features

* cross-device contacts system with unified target bar ([f58435f](https://github.com/HankHuang0516/realbot/commit/f58435f9d98b4700a306629649602e6b94478edb))

## [1.52.1](https://github.com/HankHuang0516/realbot/compare/v1.52.0...v1.52.1) (2026-03-01)


### Bug Fixes

* instruct bots to update mood/emoji only, not narrate messages ([8bfabd5](https://github.com/HankHuang0516/realbot/commit/8bfabd5c9ce343c335d03cf32c6648197957e9b4))

# [1.52.0](https://github.com/HankHuang0516/realbot/compare/v1.51.3...v1.52.0) (2026-03-01)


### Features

* add expects_reply field to bot-to-bot speak-to and broadcast APIs ([015c302](https://github.com/HankHuang0516/realbot/commit/015c302ec31dce9687f6b63fda289024a7008292))

## [1.51.3](https://github.com/HankHuang0516/realbot/compare/v1.51.2...v1.51.3) (2026-03-01)


### Bug Fixes

* AI chat stuck on "thinking" — t() not defined, use i18n.t() ([4ce6b26](https://github.com/HankHuang0516/realbot/commit/4ce6b2619cfa335e58bd699bb8601de1abc5d000))

## [1.51.2](https://github.com/HankHuang0516/realbot/compare/v1.51.1...v1.51.2) (2026-02-28)


### Bug Fixes

* prevent AI chat timeout — optimize prompt and fix spawn bugs ([539aadf](https://github.com/HankHuang0516/realbot/commit/539aadfb0d4b2c2ee2664c0cdcf992adba485d4f))

## [1.51.1](https://github.com/HankHuang0516/realbot/compare/v1.51.0...v1.51.1) (2026-02-28)


### Bug Fixes

* cross-device chat label shows local entity instead of remote target ([7d84753](https://github.com/HankHuang0516/realbot/commit/7d84753514736fc532c086eccb8be7c711214544))

# [1.51.0](https://github.com/HankHuang0516/realbot/compare/v1.50.0...v1.51.0) (2026-02-28)


### Features

* assign public_code to free bot bindings ([8ae1bb7](https://github.com/HankHuang0516/realbot/commit/8ae1bb77a66dd1dba1c11f080487a8a51305a357))

# [1.50.0](https://github.com/HankHuang0516/realbot/compare/v1.49.2...v1.50.0) (2026-02-28)


### Features

* AI chat runs in background — survives page refresh and navigation ([6d8a021](https://github.com/HankHuang0516/realbot/commit/6d8a0219ada442e1b45589cfd2356adf78fd08e1))

## [1.49.2](https://github.com/HankHuang0516/realbot/compare/v1.49.1...v1.49.2) (2026-02-28)


### Bug Fixes

* resolve cross-device display codes and prevent bubble count false positives ([e89eeca](https://github.com/HankHuang0516/realbot/commit/e89eecaf2a217a4b386ab90ceac8eba2667a847e)), closes [#86](https://github.com/HankHuang0516/realbot/issues/86) [#88](https://github.com/HankHuang0516/realbot/issues/88) [#89](https://github.com/HankHuang0516/realbot/issues/89)

## [1.49.1](https://github.com/HankHuang0516/realbot/compare/v1.49.0...v1.49.1) (2026-02-28)


### Bug Fixes

* show upload progress status when sending images in AI chat ([a3e1fae](https://github.com/HankHuang0516/realbot/commit/a3e1faee54e7083bc54e77be48256ceba688837b))

# [1.49.0](https://github.com/HankHuang0516/realbot/compare/v1.48.0...v1.49.0) (2026-02-28)


### Features

* AI chat can query user's server logs without asking for credentials ([8252fba](https://github.com/HankHuang0516/realbot/commit/8252fba8c3b22006d31aa490a1001abdd960221a))

# [1.48.0](https://github.com/HankHuang0516/realbot/compare/v1.47.1...v1.48.0) (2026-02-28)


### Features

* auto-create GitHub issues for user feedback via AI chat ([35c6edb](https://github.com/HankHuang0516/realbot/commit/35c6edb5c192d5efd99a563d107502f6bcead79f))

## [1.47.1](https://github.com/HankHuang0516/realbot/compare/v1.47.0...v1.47.1) (2026-02-28)


### Bug Fixes

* AI chat proactively creates GitHub issues for user feedback ([7270fa3](https://github.com/HankHuang0516/realbot/commit/7270fa3b4c665e710c74d57509549510f837c699))

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
