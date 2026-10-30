# r89: which model actually ran (from logs, not the UI)

Sources: each run's `claude/claude/<pid>.ndjson` start record (`args` = what the app asked for, `realArgs` = what the bench ran; no env block is recorded) and `claude/usage.ndjson` request lines (the model the provider reported). All through the Grok subscription bridge (routed=false), no Claude login, no Claude subscription. Workers were asked for DeepSeek V4.1 Flash but ran on Grok 4.7 because the dev copy has no DeepSeek key.

| run | scenario | Lead: asked -> ran (provider requests) | workers: asked -> ran (provider requests) | helpers |
|---|---|---|---|---|
| 20261030-103329-5849 **(shot 00)** | s16-1 scripted | grok-4.7 -> grok-4.7 (grok-4.7-build x17) | 1: deepseek-v4.1-flash -> grok-4.7 (grok-4.7-build x10) | 3x grok-4.7 |
| 2159 | s16-2 scripted | grok-4.7 -> grok-4.7 (x19) | 1: deepseek-v4.1-flash -> grok-4.7 (x16) | 3x grok-4.7 |
| 9039 | c02-1 blind | grok-4.7 -> grok-4.7 (x58) | 5: deepseek-v4.1-flash -> grok-4.7 (x100) | 7x grok-4.7 |
| 8aeb | s14-1 blind | grok-4.7 -> grok-4.7, 2 procs (x46) | 3: deepseek-v4.1-flash -> grok-4.7 (x145) | 5x grok-4.7 |
| 54ce | c02-2 blind | grok-4.7 -> grok-4.7 (x63) | 6: deepseek-v4.1-flash -> grok-4.7 (x152) | 8x grok-4.7 |
| 128a | s14-2 blind | grok-4.7 -> grok-4.7, 2 procs (x40) | 1: deepseek-v4.1-flash -> grok-4.7 (x54) | 3x grok-4.7 |
| a20e | s14-3 blind | grok-4.7 -> grok-4.7, 2 procs (x47) | 1: deepseek-v4.1-flash -> grok-4.7 (x73) | 3x grok-4.7 |
| ea1b | c02-3 blind | grok-4.7 -> grok-4.7 (x35) | 4: deepseek-v4.1-flash -> grok-4.7 (x94) | 6x grok-4.7 |

Shot 00 (evidence/r89/critiquito/00, taken 10:34:30 GMT, since deleted for privacy) falls in run 5849 (live 10:33:29-10:39:10 GMT): Lead pid 93251 (started 10:33:47) asked grok-4.7, ran grok-4.7; worker pid 94139 (started 10:34:21) asked deepseek-v4.1-flash, ran grok-4.7; the provider answered grok-4.7-build on all 27 requests.
