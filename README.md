# dsh-restart-button

在 DSH 里打一条命令就重启自己：

```
/restart
```

不用再关掉窗口、再从开始菜单（或托盘）打开。桌面端会自动结束、重新起来，**并且把界面窗口带回来**。

- 只在 DSH 桌面端可用。在普通 `dsh web` / headless 组合里命令会明确告诉你「没找到桌面端外壳」，而不是去找一个不存在的进程。
- 命令是敲出来的，所以没有确认弹窗——**敲这一下就是确认**。有任务在跑时结果里会写明会中断几个会话、几个后台任务。
- 纯宿主侧：没有客户端半边，没有界面座位，也就没有「按钮在别人屏幕上看不见」这一类问题。0.1.0 曾经是标题栏上的按钮，0.2.0 换成了命令。

## 它是怎么重启的

DSH 桌面端是 Electron：外壳主进程用 Electron 的 Node 模式把 Web 宿主（`dsh-desktop-host/lib/index.js`）作为子进程拉起来，两者之间只有那条 IPC 通道。宿主能对外壳说的话被白名单写死了（`ready` / `platform-session` / `fatal` / `shutdown-complete` / `update-tasks` / `quit-inspection`），Windows 打包版甚至没有重启菜单（应用菜单只有 devtools，托盘只有「打开」和「退出」）。所以命令不能「请求」外壳重启，它必须**自己就是那次重启**：

1. 结束外壳进程（宿主是它的子进程，它一死，宿主收到 `disconnect` 并优雅收尾）；
2. 等宿主进程和 Web 端口真正释放；
3. 重新拉起应用可执行文件（detached）；
4. **等替代进程真正露出窗口**，没有就把它拉出来（见下）。

这四步跑在一个**游离的 helper 进程**里，不在宿主进程里：安排重启的进程本身就要在这一步死掉，它没法同时负责第 3、4 步。helper 用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1` 启动，和外壳自己启动 pnpm / CLI 的方式完全一样，不需要额外工具链。helper 的每一句话都写进日志（`%TEMP%\dsh-restart-button\restart-<时间戳>.log`）：会写日志的进程必须比被观察的进程活得久。

为什么是硬杀而不是优雅退出：我们拿不到优雅退出的入口，而在 Windows 上「关窗口」根本不是退出——主窗口关闭会缩到托盘（`DesktopBackgroundNotice`），`before-quit` 还会弹一个没人能点的原生对话框问你要不要中断任务。反过来做更糟：先让宿主自己退出，外壳会把它当成崩溃，弹「应用意外停止」的恢复框——用户得到的是一个报错，不是一次重启。

### 为什么还要第 4 步（踩过的坑）

第一版重启是「成功」的：外壳起来了、端口在服务、托盘图标回来了——**就是没有窗口**。用户得去托盘双击一下把界面叫出来，也就是这功能本来要省掉的那一步。

查证过程：helper 日志显示替代进程 11 秒内就绑上了端口；应用自己的 `logs` 目录里**没有任何崩溃报告**，说明外壳走完了 `openInitialWindow()` → `enterWorkspace()` → `window.show()`；也就是说窗口被 show 了却没露面。而几分钟后同一条 `show()` 从托盘调用又管用。

所以第 4 步不猜、只查：helper 调 `src/raise-window.ps1`（user32 `EnumWindows` + `ShowWindowAsync` + `SetForegroundWindow`）问出替代进程的窗口到底存在不存在、可见不可见，然后

- 有窗口但没露脸 → `SW_RESTORE` / `SW_SHOW` 再置顶；
- 窗口存在但一直隐藏 → 同上；
- **根本没有窗口** → 再启动一次应用（就是你手动点托盘那一下做的事：已运行实例收到 `second-instance` 事件会把窗口弹出来），然后再探一次。

判定前会先等窗口出现（`windowWaitMs`，默认 12 秒），因为窗口出现的时刻不等于端口开始应答的时刻，而「判早了」会换来一次多余的二次启动，还会在日志里写下一个描述时钟而不是描述应用的结论。

另外那个唯一可疑的启动标志也去掉了：给 GUI 子进程设 `windowsHide: true` 会把 `SW_HIDE` 写进 STARTUPINFO，本来就是个自找的坑，现在是 `false`。`DSH_DESKTOP_DIAGNOSTIC_FILE` 也传了进去：重启若在启动阶段炸掉，堆栈会落到 `<日志名>.diagnostic.log`，而不是只留一个没人看得见的弹窗。

## 安装

从源码目录链接进 desktop profile（`<本仓库目录>` 指你 clone 出来的路径）：

```powershell
dsh plugin --profile desktop add link:<本仓库目录>
```

这条命令同时做了两件事：把包链接进 `profiles/desktop/node_modules`（junction，改工作区代码即改线上代码），并把 `dsh-restart-button` 写进 profile 的 `dsh.profile.bundles`。

**宿主半边只在 DSH 启动时加载**（改文件不会热重载，已实测），所以装完/改完要重启一次 DSH 才生效；之后 `/restart` 自己就负责这件事了。

移除：

```powershell
dsh plugin --profile desktop remove dsh-restart-button
```

或者手动（最稳）：把 `~/.dsh/profiles/desktop/package.json` 里 `dependencies` 的 `dsh-restart-button` 和 `dsh.profile.bundles` 里的同名项各删一行，再删掉 `node_modules/dsh-restart-button`，然后重启 DSH。

## 配置

配置写在 profile 的 bundle 层（`cordis.patch.yml` 的 `insert` 行里，或设置页的 Plugins 里）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 设 `false` 命令与接口都保留但一律拒绝，并说明原因 |
| `raiseWindow` | `true` | 重启后探窗口并把它拉出来；`false` 只重启不管窗口 |
| `restartDelayMs` | `900` | 命令返回后到杀外壳之间的缓冲，让命令结果先落进会话日志 |
| `shellExitWaitMs` | `15000` | 等外壳进程消失 |
| `hostExitWaitMs` | `15000` | 等宿主进程退出（它靠 `disconnect` 自己收尾） |
| `portWaitMs` | `30000` | 等 Web 端口释放 |
| `settleMs` | `400` | 端口释放后再等一会儿（TIME_WAIT） |
| `verifyMs` / `steadyMs` | `60000` / `8000` | 替代进程要连续应答多久才算起来了 |
| `windowWaitMs` | `12000` | 判定「有没有窗口」之前等多久 |
| `logDir` | 系统临时目录 | helper 脚本与日志目录 |

## 诊断接口

命令之外还留了一个只读诊断面和一条给脚本用的重启入口（同源/回环闸门 + POST 需要 `x-dsh-restart: 1` 头）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/dsh-restart/status` | 能力、原因、外壳/宿主 pid、是否有任务在跑、命令是否注册、上次重启记录 |
| POST | `/api/dsh-restart/now` | 和 `/restart` 同一条路径，给脚本用 |

它的用处是「命令没生效」时能问出原因：`command.registered` 会告诉你这个组合里到底有没有命令层——软 `inject` 等不到服务时不会报错，只会静默不注册，那是唯一能看见它的地方。

## 测试

```powershell
cd <本仓库目录>
node --test test/
```

32 个用例，包括：

- `restart-plan.test.mjs` — 桌面端识别（普通 `dsh web` 不会被误判）、配置兜底、任务在跑判定、请求闸门、helper 源码可解析且路径转义正确；
- `host-mount.test.mjs` — `/restart` 注册、参数被拒、非桌面宿主明确拒绝、闸门先于处理函数、缺命令层/缺 Web 层时仍能挂载；
- `raise-window.test.mjs` — **真窗口**：探针能诚实报告「没有窗口」和「进程不存在」，被它自己藏起来的窗口能被重新显示出来；
- `helper-e2e.test.mjs` — **真进程**跑生成的 helper：杀掉假外壳、等假宿主退出、等端口释放、拉起替代进程、探窗口并记录判定；替代进程起不来时写进日志；以及最要紧的那条性质——**游离子进程能活过生它的进程**（整条设计都压在这上面）。

测试需要的那扇 GUI 窗口是套件自己的 fixture（`tools/probe-window-fixture.mjs`）：编译进测试临时目录的 WinForms 窗口，摆在屏幕外，标题写明它是什么。第一版用的是记事本，错在两处——**残留的记事本是一扇摆在别人桌面上的空白应用**，而清理只杀了日志里的第一个 pid，可 helper 本来就有权启动两次替代进程（二次启动正是「窗口没露脸」的修复），于是每次走到回退分支的运行都会留下一个。现在清理会杀掉日志里出现的每一个 pid，且这些用例结束时都会断言：**临时目录里出来的进程一个都不剩**——泄漏是红测试，不是垃圾。

## 已知边界

- 只在桌面端有意义：普通 `dsh web` 下 `/restart` 会拒绝并说明。
- 重启会结束整个桌面应用：正在跑的 agent 任务会中断（结果里会写明数量）。会话本身是持久化的，重启后照旧。
- 窗口那一步是 Windows user32 的调用（PowerShell + `Add-Type`）；其他平台会跳过它（日志里会写明探针不可用），重启本身不受影响。
- 命令结果要落进会话日志，所以 `restartDelayMs` 默认 900ms：这 0.9 秒是留给日志刷盘的，不是留给用户犹豫的。

---

## English

Type `/restart` in DSH and it restarts itself — desktop shell terminated, application relaunched, **and its window brought back**, without closing and reopening anything by hand.

Host-side only: no client half, no UI seat. It registers one human command through `ctx.commands`, and a small read-only diagnostic surface (`GET /api/dsh-restart/status`, `POST /api/dsh-restart/now`) so a command that does not fire can be asked why.

The shell watches its host child and treats an unrequested exit as a crash, and it accepts only a fixed set of IPC message types from that child — so a restart cannot be *requested*. The command therefore performs it, in a detached helper that outlives the process that scheduled it: terminate the shell, wait for the host and the Web port to be released, relaunch the application, then **probe the replacement's window and raise it if it is missing or hidden** (a second launch covers "no window at all", which is what the running instance answers by showing its window). Everything the helper does is appended to `%TEMP%\dsh-restart-button\restart-<stamp>.log`, because the process that would report a failure is the one that just died.

`/restart` is typed deliberately, so there is no confirmation step; the result names what will be interrupted.

Install: `dsh plugin --profile desktop add link:<path to this checkout>` (links the package and adds it to `dsh.profile.bundles`; the host half loads on the next DSH start). Remove with the same command's `remove`.

Tests: `node --test test/` — 32 cases, including running the generated helper against real processes, driving the window probe against a window it hides itself, and proving a detached child outlives the process that spawned it.

The GUI window those tests need is the suite's own fixture (`tools/probe-window-fixture.mjs`): a WinForms window compiled into the test's temp directory, positioned off-screen, titled for what it is. Notepad was the first draft and was wrong — a leftover Notepad is a blank *application* on somebody's desktop, and the cleanup killed only the first pid in the log while the helper is allowed to launch the replacement twice, so every run where the fallback fired left one behind. Cleanup now kills every pid the log names, and every one of those tests finishes by asserting that nothing whose executable lives in its temp directory is still running — a leak is a red test, not litter.
