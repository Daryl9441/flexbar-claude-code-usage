# Changelog

## [0.5.0](https://github.com/Daryl9441/flexbar-claude-code-usage/compare/v0.4.0...v0.5.0) (2026-10-09)


### Features

* add a New Session key that opens a new Claude Code session ([b76fbfd](https://github.com/Daryl9441/flexbar-claude-code-usage/commit/b76fbfdbead85ff5ea911029756dece09a95b78c))
* add a Session Status key for the latest Claude Code session ([2319505](https://github.com/Daryl9441/flexbar-claude-code-usage/commit/23195054e470490ae2a3284b8e77701a0100bc37))
* Antigravity provider skeleton with usage, session and new session keys ([e9c51ba](https://github.com/Daryl9441/flexbar-claude-code-usage/commit/e9c51bae016d964aaf48d98dca7a7bd331d6f4e2))
* Antigravity Session and New Session keys ([e689895](https://github.com/Daryl9441/flexbar-claude-code-usage/commit/e68989588e97b7bba5f251aa524e7546e7df7bb8))
* Antigravity usage key reads the model quota from the running app or IDE ([e4e78dd](https://github.com/Daryl9441/flexbar-claude-code-usage/commit/e4e78dd5c0247852890593dc78e564f338a36f1d))
* Gemini session status and new session keys ([4849296](https://github.com/Daryl9441/flexbar-claude-code-usage/commit/484929629834dca57554e605ea80f8287db96da0))
* Gemini usage meter from Gemini Code Assist quota ([69dbd04](https://github.com/Daryl9441/flexbar-claude-code-usage/commit/69dbd045255db44d6ae08b4c2897a64abe63bf14))
* integrate the Antigravity usage, session and new session keys ([6ee166b](https://github.com/Daryl9441/flexbar-claude-code-usage/commit/6ee166b4cfbd937a236ebf66badee103e4398e55))
* integrate the Kimi and Gemini keys ([04f8c20](https://github.com/Daryl9441/flexbar-claude-code-usage/commit/04f8c2058f1d6371b4461f6a84ac0139cee684c3))
* Kimi Session Status and New Session keys ([dbe535a](https://github.com/Daryl9441/flexbar-claude-code-usage/commit/dbe535a354d28b56c6e5012329ed3917faf32565))
* Kimi usage meter from the Kimi Code quota API ([88d06e1](https://github.com/Daryl9441/flexbar-claude-code-usage/commit/88d06e10ebfd5fda55a94f628874faa0045298f5))
* list all running sessions on a Session Status key press ([c189344](https://github.com/Daryl9441/flexbar-claude-code-usage/commit/c1893444721643cf213bd2e872b4a79d4f65d347))
* pass a key's settings to its provider ([008badd](https://github.com/Daryl9441/flexbar-claude-code-usage/commit/008badd83d42af317d161722206e4bfa3799dbba))
* provider layer for Claude, Kimi and Gemini keys ([bec227b](https://github.com/Daryl9441/flexbar-claude-code-usage/commit/bec227ba85869b88ccd23e9fcb8aec7aa2bded84))
* shared Kimi and Gemini data-folder helpers ([8e59d0a](https://github.com/Daryl9441/flexbar-claude-code-usage/commit/8e59d0a50870b8928a5b9df4a2d748e023c7ae43))
* show what is left of the 5-hour and weekly limits on one key ([ab1b581](https://github.com/Daryl9441/flexbar-claude-code-usage/commit/ab1b581be41e0410b5b092b00d0f07ea759bb2d1))


### Bug Fixes

* apply the multi-provider review findings ([4e5424a](https://github.com/Daryl9441/flexbar-claude-code-usage/commit/4e5424aa4d90a0e18cf8d4c5fd31637a42f354f9))
* create sessions in Antigravity and Kimi Code apps ([742c1b7](https://github.com/Daryl9441/flexbar-claude-code-usage/commit/742c1b75c3e91cac8b92de5d9355855480aa7ff4))
* harden the Antigravity keys after review ([ca31583](https://github.com/Daryl9441/flexbar-claude-code-usage/commit/ca3158313bc8799e5406ff7c7be43582fba1ed3d))
* harden the key draw pipeline and add zh-CN localization ([2b57e20](https://github.com/Daryl9441/flexbar-claude-code-usage/commit/2b57e2086c94e60e56012486d213bdd8f59331a8))
* keep Claude's model chips and recover from a failing key face ([69adfc5](https://github.com/Daryl9441/flexbar-claude-code-usage/commit/69adfc52efac4d18c3f19f759d0a1e21534baf2d))
* keep extra usage selectable and tidy the Kimi stand-in edge cases ([98c1652](https://github.com/Daryl9441/flexbar-claude-code-usage/commit/98c1652ae1ecd9d44ff88bb91cd58226de3d2e1a))
* keep the integrated tree privacy-clean and document the new keys ([cbb293d](https://github.com/Daryl9441/flexbar-claude-code-usage/commit/cbb293de31c1d95943d679ed734d4353f2ebe77e))
* lay out key text without squashing or overlapping ([62195b6](https://github.com/Daryl9441/flexbar-claude-code-usage/commit/62195b69419b7eb6767e2262dde84d694c3a6b49))
* make the dual Usage Meter read as remaining and fit its countdowns ([ff7b860](https://github.com/Daryl9441/flexbar-claude-code-usage/commit/ff7b8601562808e3b0501aa3dbabcfd9312c6b4b))
* render CJK text instead of tofu boxes on key images ([527603b](https://github.com/Daryl9441/flexbar-claude-code-usage/commit/527603b7caf0adf3b48b8a765279b5ad12107a81))
* render emoji in key text and fully mask privacy-scan matches ([f7cde57](https://github.com/Daryl9441/flexbar-claude-code-usage/commit/f7cde57c0116cfa0ad6c29da1156e40a7b170374))
* route Claude requests through a proxy and report expired Claude Code logins ([e7fc156](https://github.com/Daryl9441/flexbar-claude-code-usage/commit/e7fc1567276e2c4cef1168275642b57f4aad2ce2))
* route Claude requests through a proxy and report expired Claude Code logins ([f5936c6](https://github.com/Daryl9441/flexbar-claude-code-usage/commit/f5936c62337516dd7d428572f0ec994df9fdd3f2))
* show the default Kimi limit when the plan lacks the chosen one ([3449f01](https://github.com/Daryl9441/flexbar-claude-code-usage/commit/3449f019c2770e31e51ede7d321d8183eccda2a9))

## [0.4.0](https://github.com/Sese-Schneider/flexbar-claude-code-usage/compare/v0.3.0...v0.4.0) (2026-07-07)


### Features

* refresh the Claude Code OAuth token automatically ([27d4005](https://github.com/Sese-Schneider/flexbar-claude-code-usage/commit/27d4005a4880f390e373fe5186acbbeed0da9a5f))


### Bug Fixes

* fall through to the next OAuth endpoint on HTTP rejection ([76851fe](https://github.com/Sese-Schneider/flexbar-claude-code-usage/commit/76851fe461da3cb219c6ec8ec8e2e6ce2088c979))

## [0.3.0](https://github.com/Sese-Schneider/flexbar-claude-code-usage/compare/v0.2.0...v0.3.0) (2026-07-06)


### Features

* honor Retry-After with a lockout countdown on the keys ([313c104](https://github.com/Sese-Schneider/flexbar-claude-code-usage/commit/313c10463bc17a5954c852c58b237559078c2ff6))


### Bug Fixes

* actionable message when the stored Claude Code token is expired ([edee7d7](https://github.com/Sese-Schneider/flexbar-claude-code-usage/commit/edee7d7ceb705beae57f8c16c3c6e62cd24adbeb))

## [0.2.0](https://github.com/Sese-Schneider/flexbar-claude-code-usage/compare/v0.1.0...v0.2.0) (2026-07-03)


### Features

* Clawd the crab mascot and refined key layout ([e41d9db](https://github.com/Sese-Schneider/flexbar-claude-code-usage/commit/e41d9dbbb89294a3ad8126f670d568ec90b7aa43))
* clawdmeter-style key design with gradient bar and Claude robot ([3fc8a2a](https://github.com/Sese-Schneider/flexbar-claude-code-usage/commit/3fc8a2a90d9ed9d0e04f8563250b26380a85727f))
* official Clawd artwork and improved legibility ([abedaf5](https://github.com/Sese-Schneider/flexbar-claude-code-usage/commit/abedaf555647299b21d9a15ce40637a6431a9b71))
