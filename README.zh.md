# dsh-video-vision

看画面，而不是听人转述视频。每次调用给出一张**可寻址的分镜图**（storyboard
grid），为 `deepseek-v4.1-flash` 的视觉能力调优。可直接替换
`dsh-video-storyboard` / `dsh-video-understand` —— 三个工具名与参数形状跟它们一样，
另加两个它们没有的答案：一张整条片子的文本地图，什么都不画；一份给「有声无画面」
的文件的转录。

```
video_probe      元数据 + 阅读计划，不解码画面
video_outline    整条片子读成一行行文本 —— 0 张图、0 个视觉 token
video_storyboard 一张分镜图 + 逐格绑定时间码的文本索引
video_zoom       对一个短窗口放大看，1-9 格
video_read       整条视频读成带时间戳的文本 —— 讲课、幻灯片、录屏

输入可以是文件路径、直链，或 **B站 链接**（`bilibili.com/video/BV…`、裸 BV 号、
`av` 号、`b23.tv` 短链）：第一次会下载到缓存，之后和被下载好的文件一样读。
```

画面路径是给电影、体育、游戏，任何「画面本身就是内容」的片子用的。当内容就是屏幕
上的字时，`video_read` 直接赢：一堂两小时的课变成 7.7k 字的 `[mm:ss] 文本`，
外加十一道例题的目录，模型可以引用、检索、改写成笔记 —— 而在那个尺度上，一张
1024 token 的分镜图是读不出字的。两小时的片子 87 秒，95 秒带字幕的片段 5.6 秒，
36 秒的片段 1.3 秒。

> 每一项设计决定背后的实测数据见 [docs/DESIGN.md](docs/DESIGN.md)；
> 逐片段实测、误差说明与复现方式见 [docs/EVIDENCE.md](docs/EVIDENCE.md)。

<table>
<tr>
<td width="50%"><img src="docs/demo/storyboard-text-cards.png" alt="六张文字卡组成的一张分镜图"><br>
<em>D 片段：六张只有文字块不同的卡片，六格 / 359 token，每一条项目符号都清晰可读。</em></td>
<td width="50%"><img src="docs/demo/storyboard-audio.png" alt="底边带音频包络带的分镜图"><br>
<em>G 片段：九格 + 音频带 —— 青色包络、橙色说话区间、黄色切点刻度。一张图 542 token。</em></td>
</tr>
<tr>
<td colspan="2"><img src="docs/demo/zoom-transition.png" alt="跨 1 秒叠化的三格放大"><br>
<em><code>video_zoom</code> 看一个 1 秒叠化：前、过渡中、后，三格大图。</em></td>
</tr>
</table>

---

## 好在哪

**能看见「亮度相同」的切点。** 每个画面被压成 12x7 的**亮度块 + 色度块**，
一次 ffmpeg 解码同时算出。两个镜头亮度几乎一样、只是调色不同时，只看得见亮度的
检测器会认为「什么都没发生」，这里不会。跳变被分成五类：`cut`（真切）、
`partial`（幻灯片只有文字块变了）、`overlay`（字幕/贴图出现）、`light`（开灯）、
`noise`；只有前两类会变成格子。

**闪光和转场不算新镜头。** 单帧白闪会在 3 帧内恢复原画面，直接丢弃；叠化
（dissolve）被识别为**瞬态**——一段变化的平台期，之后必须安静下来——因此只产生
一个边界，而不是一串碎镜头；而缓慢摇镜不会产生任何边界。

**图按「每格」定尺寸，不按「整张」定。** 宿主按面积计费
（`tokens = gridH*(gridW+1)+2`，上限 1024）。1.25 Mpx 的图里放 10 格和放 4 格
**同价**，所以预算用来换「更多时刻、更小的格」，直到格子看不清为止：
6 格约 350 token，20 格约 1000 token，内容少的片子自然就便宜。

**格子是挣来的，不是平均分的。** 每个镜头保底一格；额外格子只给「时长够长」且
「存在一帧与已选帧的距离超过同图阈值 2.5 倍」的镜头。静态口播永远拿不到第二格，
30 秒摇镜会分到 4 格。

**没有切点的长段，按「变化」给格。** 讲课、录屏、写板书：十一分钟只有一个镜头，
而要看懂恰恰靠「每分钟多出了什么」。超过 90 秒的段，判据从「这两张图差多远」换成
「画面里有没有新的东西」——同样在 12×7 的块网格上算，一次变化一格，最多每 30 秒
一格、整段不超过 24 格。19 分钟的时间窗从 4 格变成 22 格，分镜图预算仍是
1024 token。

**解码是批量的。** 6 格共用**一个** ffmpeg 进程（多个输入、各自输出），并发 3 个
进程——一张 20 格的图只启动 2-4 次进程，而不是 60 次。

**最便宜的一眼，是不画任何东西。** `video_outline` 把整条片子切成等长窗口，用
一行行文本回答——切点数、说话占比、一条八格强度条、一个标签——再点出三个值得打开
的窗口，以及拿来打开它们的确切 `start`/`end`。它花 **0 个视觉 token**，短片
不到一秒：它的用处是决定**哪里**值得花一张图，而这恰恰是分镜图对一堂两小时的课
说不了的事。

**一格永远不会糊成一条。** 以前 `auto` 不看来料多大，都往一张 1.76 Mpx 的图里
塞 28 格，于是一条 4K 片子拿到的是 28 张 77 px 高的画。现在这张图保留同样的预算，
花在更少、更大的格子上——任何一格不低于原片高度的五分之一：720p 28 格、
1080p 21 格、1440p 11 格、4K 5 格——仍是约 1024 token；触到这条底线时，结果里会
写明。

**过了十分钟，只读关键帧。** 长片在关键帧至少相隔一秒时按关键帧分析：一堂两小时
的课快 **2.7 倍**，并在结果里说明「再缩短会漏掉什么」，以及用
`DSH_SCAN_KEYFRAMES=off` 退回逐帧。短窗口和短文件仍然逐帧解码，和以前一样。

**结果里不写废话。** 阅读说明放在工具描述里（属于可缓存的 prompt 前缀，只付一次），
结果本身只包含索引和那张图。`textOnly` + `cellRange` 可以零图像成本翻页，
重复调用命中缓存。

---

## 数据

9 个片段，逐帧精确的标准答案，同一台机器，直接以模块方式驱动
（`bench/final.mjs`）。完整协议、逐片段表格与结论的适用边界见
[docs/EVIDENCE.md](docs/EVIDENCE.md)。

| | 数值 |
| --- | --- |
| 耗时（冷启动） | **634 ms**（多次运行 581-648 ms） |
| 耗时（命中缓存） | **411 ms**（370-411 ms） |
| 给出的时刻数 | **67 格** |
| 视觉 token | 3 648 |
| 每个被展示时刻的 token | **54.5** |
| 切点 F1（micro，0.5 秒） | **0.872** |
| 切点召回 / 精确率 | 1.000 / 0.774 |
| 镜头覆盖率 | **0.963** |
| 结果里的说明文字 | 477 字符 |
| 两小时课程读成文本 | **87 秒**，53 屏，7.7k 字 |
| 36 秒文字卡片 | **1.3 秒**，6 屏 |
| 95 秒带字幕的片段 | **5.6 秒**，11 屏 |
| 40 秒片段，读成文本 | **0.9 秒**，8 个窗口，**0 个视觉 token** |
| 70 秒游戏片段，读成文本 | **2.6 秒**，8 个窗口里 24 个切点 |
| B站 链接只探测（不下载） | **226 毫秒** |

文本地图这一项是构造上就等于零的：`video_outline` 一张图都不返回，所以可以在
为任何一张图付钱之前，先把整条片子过一遍。

对一部 **13 分钟**的片子，一次调用给**一张**图：28 格、每格 331x186、1024 token、
6.2 秒，连同索引共约 1353 token 的上下文。完整表格在 EVIDENCE.md。

弱项写在上面那个文件里，不四舍五入：1 秒叠化会被判成一次渐变边界，而标准答案
认为该片段「没有切点」，所以这里记一次误报；语料里还有两个片段整帧换画面
（章节卡、音乐段落），会被判成切点。真实视频的抽检与实际可读性截图：
[docs/REAL-WORLD.md](docs/REAL-WORLD.md)。

---

## 安装

插件**零运行时依赖**。需要 `ffmpeg`；有 `ffprobe` 时用它，没有就从
`ffmpeg -i` 的输出里解析元数据。

```bash
cd /path/to/dsh-video-vision
node bin/install.mjs                 # 改 ~/.dsh/profiles/desktop，然后重启 DSH
node bin/install.mjs --dry-run       # 只打印要改什么，不动文件
node bin/install.mjs --remove        # 卸载
```

脚本手工做完了 `pnpm install` 本来会做的三件事：往 profile 的 `dependencies` 里写
`"dsh-video-vision": "link:<绝对路径>"`、把包名加进 `dsh.profile.bundles`、把包
**目录联接（junction）**到 profile 的 `node_modules`。可重复执行；`--copy` 改成
复制一份快照而不是链接。无论哪种方式，装完都要**重启应用**：包内的
`cordis.patch.yml` 在启动时把插件插入 harness 树，五个工具才会出现。

### ffmpeg 查找顺序

查找顺序（先命中先用）：`$DSH_FFMPEG_PATH` → `$DSH_VIDEO_FFMPEG` →
`$FFMPEG_PATH` → 包内 `vendor/bin` → node_modules 里的 `ffmpeg-static` /
`@ffmpeg-installer` → WinGet Links → `C:\ffmpeg\bin` → scoop shims →
npm roaming → `/usr/local/bin` → `~/.dsh/dsh-runtimes/*/` 里的
`imageio-ffmpeg` wheel → `PATH` 上的 `ffmpeg`。
`$DSH_FFPROBE_PATH` / `$FFPROBE_PATH` 对 ffprobe 做同样的事。

ffmpeg 4.x 以上都能用：抽帧器会先问一次二进制自己的版本，5.1 及以后用
`-fps_mode passthrough`，更老的用 `-vsync 0`，万一被拒就换另一种拼法重试一次。

一条命令端到端验一台机器（不需要现成视频，它会自己生成一个）：

```bash
node bin/selfcheck.mjs --smoke          # 21 项检查，自己生成素材
node bin/selfcheck.mjs --smoke --host   # 40 项：校验全部五个工具，对着已安装的
                                        # Harness 自己的 schema 引擎
node --test test/                       # 314 个单元测试，不联网，临时目录隔离
```

`--host` 跑的是 `ctx.tools.register` 真正执行的断言，然后逐个工具真调用一次，
再按运行时的规则校验返回值。要用 Electron 的 node 跑（`ELECTRON_RUN_AS_NODE=1`），
普通 node 读不进 `app.asar`。这不是形式主义：工具如果返回 `{ text: {…} }` 而不是
`{ text: "…" }`，宿主会直接拒绝并报 `"value.text" must be a string`，本地一切
正常，直到有用户按下调用。

---

## 用法

### 先画一张图，这一步不花钱

```
video_outline input:"dsh-video-vision-promo.mp4" windows:8 top:3
```

```
dsh-video-vision-promo.mp4 · 00:57 · 13 cuts · speech 97% · 8 windows of 00:07
note: text only — nothing was drawn, so this answer costs no image tokens; ask video_storyboard for a window once this says which one
   1  00:00-00:07  ▄███████  cuts 0  speech  93%  dark talk
   2  00:07-00:14  ████████  cuts 2  speech 100%  dark busy
   3  00:14-00:21  ████████  cuts 1  speech 100%  dark busy
   4  00:21-00:28  ████████  cuts 3  speech 100%  busy talk
   5  00:28-00:35  ████████  cuts 2  speech 100%  dark busy
   6  00:35-00:42  ████████  cuts 1  speech 100%  dark busy
   7  00:42-00:50  ████████  cuts 2  speech 100%  dark busy
   8  00:50-00:57  ██████▇▁  cuts 2  speech  86%  dark busy
watch first: 4 (00:21-00:28, 3 cuts, speech 100%) · 2 (00:07-00:14, 2 cuts, speech 100%) · 5 (00:28-00:35, 2 cuts, speech 100%)
next: video_storyboard start=21 end=28 for the pictures, video_read start=21 end=28 for the words
```

（这是对本包自带的 57 秒宣传片原样跑一次：1.9 秒，没有图，没有视觉 token。）

每一行是一个窗口：切点数、这个窗口里说话占多少、一条强度条（八格，高度由切点、
运动、说话量与响事件决定），以及最多两个标签——`dark`、`static`、`quiet`、
`busy`、`talk`。`watch first` 先按「屏幕上变化多少」排，再按「说了多少」排；
`next` 把这些数字直接带进真正去开窗口的那次调用。没有任何东西被解码两遍：
同一次分析也供所选窗口的分镜图使用。

| 参数 | 含义 |
| --- | --- |
| `input` | 文件路径、直链，或 B站 链接 |
| `windows` | 4–60 个等长切片（默认 24） |
| `top` | `watch first` 里点几个窗口（1–8，默认 3） |

### 一张分镜图

```
video_storyboard input:"C:\clips\pv.mp4"
```

```
pv.mp4 · 0:00:40.00 · 1280x720 · 30fps · 9 cuts · median shot 4.00s
sheet 1 · 2x5 grid · 942x1328 · 10 cells · window 00:00.00-00:40.00
cols: cell · pos · span · (cuts) · frame@
1 r1c1 00:00.00-00:04.00 @00:01.98
2 r1c2 00:04.00-00:07.68 @00:05.85
...
audio: speech 42% · -18.2 dBFS · loudest 0:41.20 · 3 silences · 12 onsets
transcript: subtitle-track · 18 segments
```

图片在同一个工具结果里返回。`r2c1` = 从上往下第 2 行、从左往右第 1 列；格子左上角
烧进去的数字就是格号。

| 参数 | 含义 |
| --- | --- |
| `input` | 文件路径，或 ffmpeg 能直接抓取的 `http(s)` 媒体地址 |
| `start` / `end` / `duration` | 只看一个窗口 |
| `detail` | `low`（≤6 格）· `auto`（≤20，默认）· `high`（≤28） |
| `cells` | 强制格数（1-24） |
| `pick` | `sharp`（默认）/ `middle` |
| `dedupe` | `shots`（默认）只合并同一镜头内的重复画面 · `global` 连跨切点的重复也合并 |
| `textOnly` | 只返回文本索引：不取图、不解码 |
| `cellRange` | 配合 `textOnly`，列出第 a 到第 b 格 |

`video_zoom` 支持同样的窗口参数，外加 `cells`（1-9）与 `at`；只有 1 格时返回
原分辨率单帧。

### 哪些格子需要放大

分镜拼得密，每格就小，一行字幕或一行代码会缩成灰带，而那一格整体看着仍然是好画面。
索引会直接说，不用你猜：

```
cols: cell · pos · span · (cuts) · frame@ · zoom
zoom: 3/22 cells carry detail finer than the sheet can show at 6.4x — cells 4, 9, 17 are marked, the rest read fine as they are
4  r2c1 00:12.00-00:28.00 @00:19.80 zoom
```

测量是把每格按格大小的两倍解一次再比对，所以读图成本不变、也不多花图像 token。
空帧、纯色卡片、黑边这类没有细节的格子不会被标记；如果每一格都太小，索引只说一次，
并建议用 `detail:"low"` 换更大的格子。`DSH_VIDEO_ZOOM_MARKERS=0` 可以关掉。

### 读一堂课

```
video_read input:"C:\clips\lecture.mp4"
```

```
# lecture.mp4 — read as text · 53 screens · 975 keyframes · 87 s

## outline
00:45 1.1
17:20 例题3
41:05 例题5
56:16 例题6
74:00 例题8

[00:45–01:44] 1.1 归纳证明 事实上，数学归纳法的使用是很灵活的…
[17:20–18:54] 例题 3 ．A、B 二人玩如下游戏：初始时有两堆硬币，各 2ⁿ 个…
```

长片只解**关键帧**（`-skip_frame nokey`），按画面变化聚类，每类只 OCR 一次幻灯片
区域，再把说的是同一件事的屏合并。几乎一样的幻灯片从两端往中间压：OCR 噪声让精确
比对失效，所以「是不是同一屏」用字符二元组相似度来判。

在大多数屏上都出现的行会被当成家具丢掉——录屏软件自己的标题栏就是这样消失的，
而本插件并不知道那是哪个软件。一条片子几乎没有可读文字时，它会说明看到了什么，
并点出可能的原因（手写、手机对着屏幕拍、根本没有幻灯片）——然后**给图而不是给一份
空文档**：解出六个变化过的帧，拼成一张图，并注明这些就是这条片子带的证据。对着一块
白板录屏的文件走这条路，而不是被拒绝。

**有声无画面**的文件也读。`video_read` 动手前先检查有没有视频流，mp3、m4a、wav
就变成一份转录：先试你传的 `transcriptFile`，再试容器自带的字幕轨，最后试
`DSH_ASR_CMD`。三条都没有时，它用一句话把三条出路说完再拒绝。同一个文件交给
`video_probe`，会报出编码并返回 `plan: null`；`video_storyboard` 和
`video_zoom` 会说「没有画面可抽；`video_read` 转录音频」。

传 `out` 可以把结果落成文件——`.srt` 或 `.vtt` 是字幕文件，其它扩展名是
`[mm:ss] 文本` 行，父目录会自动创建，最后一条注释会报出路径和条数：

```
video_read input:"C:\clips\lecture.mp4" out:"C:\notes\lecture.srt"
```

短片走抽样而不是关键帧：十五分钟以内每 1.2 秒解一帧，只解一遍，再用 0.4% 的画面
变化做闸门，通过的那些帧就是 OCR 真正读的帧——所以一个固定版式、只有字幕在变的
片子，是一行字一屏，而不是整条片子一屏。更长的片子仍走关键帧那条路，那里贵的是
解码，不是 OCR。

丢掉的是录屏软件，不是课：标签栏是贴着上边缘的短行，状态栏是贴着下边缘的短行，
聊天面板是一屏全是极短的行，老师手写的那些帧只会 OCR 成一堆两个字的碎片、没有
一句完整的话。这几个判据都是几何位置，跟是哪个软件录的无关。

实测一条 1:59:54、2560x1440 的真实课程：**87 秒**解完 975 个关键帧 →
**53 屏 → 7 663 字**，十一道例题全在目录里。同一条片子走 `video_storyboard` 要
163 秒，返回的是一张 1024 token 的分镜图，上面的幻灯片文字看不清。15 分钟窗口
**16 秒**读完；36 秒短片 **1.3 秒**。

| 参数 | 含义 |
| --- | --- |
| `input` | 文件路径，或 ffmpeg 能直接抓取的 `http(s)` 媒体地址 |
| `start` / `end` | 只读一个窗口 |
| `maxScreens` | 最多读几屏，3–400（默认 400） |
| `out` | 把结果写文件：`.srt`/`.vtt` 出字幕，其它扩展名出 `[mm:ss]` 文本 |
| `transcriptFile` | 你手上已有的 SRT/VTT/JSON——优先于引擎；有声无画面的文件没配引擎时，这是唯一入口 |

需要 OCR 引擎，找到哪个用哪个：Windows 自带的那个（内建，不用下载、不用模型）、
`PATH` 上任意位置的 `tesseract`（Linux、macOS 走这条），或者把 `DSH_OCR_CMD`
指向你自己的引擎（输入一个图片路径，输出若干行文字）。`DSH_OCR_BACKEND` 取
`windows` · `tesseract` · `off`；`DSH_OCR_LANG` 会给 tesseract 传 `-l`。
一个都没有时，工具直说，不装作有。

---

### 不用先下载就能读 B 站

CDN 给的是一个带签名的 mp4 直链，ffmpeg 可以直接边读边取。`video_probe` 一直
都这样；从 1.3.2 起，`video_storyboard`、`video_zoom`、`video_read` 也能直接
读链接，默认只对 `DSH_BILIBILI_STREAM_MAX` 秒（默认 300）以内的片子这么做。更长
的片子还是下载一次再缓存——两小时的课在线看两遍，流量比存下来还贵。用
`DSH_BILIBILI_STREAM=1` 强制在线、`=0` 强制下载。

实测一条 57 秒的片子：在线出分镜 5.7 秒（存下来后 1.9 秒），`video_read`
8.3 秒、2 161 字，磁盘上什么都没写。

**playurl 在内存里缓存十分钟**（`DSH_BILIBILI_PLAY_TTL_MS`，默认 600 000）。对同一个
B站 文件先 probe、再 storyboard、再 read，否则同一个签名直链要被解析三次；每次拿回来
的地址能用好几个小时，所以缓存按 `bvid|cid|maxHeight|auth` 做键，命中时结果里写
`cached: true`。

**下载缓存有预算**：`DSH_BILIBILI_CACHE_MB`（默认 4096）与
`DSH_BILIBILI_CACHE_MAX`（默认 24 个视频）。最久没用的先走，正在写的那个文件不
会被淘汰，同一个视频的 `.mp4`/`.json`/`.srt` 一起走。

**不是单个视频的链接，给的是原因，不是「不支持」**：`bangumi/play/ep` 或 `ss`
链接会说清那是第几集、第几季，以及这里读的是某一季里的 p 段；`bangumi/media/md`
是一部完整作品；直播间没有结尾可抽；空间或 `/list/` 链接是一个合集，所以答案
会点名那个合集、要你给其中一条视频；`opus`/`read`/`t.bilibili.com` 是图文
动态，里面没有视频。

### 语音转文字（自带引擎时）

如果把 `DSH_ASR_CMD` 指向一个你信得过的引擎，`video_storyboard` 和
`video_read` 会把**说的话**也引出来，不只是字：

```
set DSH_ASR_CMD=C:\python\python.exe F:\asr\engine.py --model small {wav} {out}
```

这一段的音频抽一次（16 kHz 单声道），跑你的命令，解析它写到 `{out}`（或直接打到
stdout）的 SRT。每句话挂在「中点落在哪一格」的格子上，所以一句只引一次。有字幕轨
时永远优先用字幕：那是人写的，而且不用解码。

**长音频先切块。** 把一小时、230 MB 的 wav 整个丢给识别器，换来的往往不是转录而是
OOM，所以超过 `DSH_ASR_CHUNK_SECONDS`（45）的窗口会被切开：先只做一遍解码，专门
听停顿；然后每个 45 秒的目标点往回退到最近的静音中点，且至少退到块内
`DSH_ASR_CHUNK_MIN`（12）秒处——一刀落在停顿里，而不是落在一个词中间。末尾剩下
的一点会并进前一块。切块以 `DSH_ASR_PARALLEL`（2）并行抽取与转写，时间戳再按块
平移回去，让一句话的时间就是文件里的时间；被切点分到两边、重复了一遍的那句会合并
成一句。停顿的门限是 `DSH_ASR_SILENCE_DB`（−32 dB）与 `DSH_ASR_SILENCE_MIN`
（0.35 秒）；`DSH_ASR_CHUNK_SECONDS=0` 可以关掉切块，交给想要整条文件的引擎。

某一块失败不会把整份转录拖走：其余的都保留，返回的原因会说清有几块、在哪——
`1 of 3 audio chunk(s) failed — chunk at 01:30: …`。

**故意不内置模型**：这个包是 600 KB 代码、零依赖，而准度在模型里（tiny 75 MB、
small 484 MB、medium 1.5 GB）。同一段两分钟的真实课堂录音、16 线程实测：

| 引擎 | 转录耗时 | 两小时外推 | 读出来的样子 |
|---|---|---|---|
| `tiny` | 2.5 s | 约 2.5 分钟 | 乱：把「选法」听成「選抜」，把「枚举」听成「按摩機束」 |
| `small` | 15.5 s | 约 15 分钟 | 可读，输出繁体，「递推」听成「地规」 |

本机自带的离线识别也试过并放弃：`System.Speech` 中文把同一分钟变成一行 60 字、
置信度 **1.7 %** 的乱码——那种「有 ASR」比没有更糟，所以这里是钩子而不是功能。

分工因此是：课件、录屏走 `video_read`（两小时 87–112 秒），纯语音走 ASR，
两者都要时先读字，再对关心的那一段传 `start`/`end` 跑 ASR。

**识别器的两类毛病由客户端负责**，因为每个引擎都有，而每个调用方都会各自做错：

- **音乐不是人声。** 让识别器转一段纯音乐，它不会交白卷——它会编一句话，再给它
  一个很长的时间段。一段 90 秒的 PV 上编出了 29 秒的假台词，而格子是按时间重叠
  引用的，于是同一句垃圾被贴到五张卡上。所以：只剩标点的句子、以及超过 8 秒且
  每秒不足 0.8 个字（真人说话是 2–6）的句子会被丢掉，并且**把丢了几条写进清单**
  （`2 suspect line(s) dropped`）——没人能审计的过滤器，和一个坏掉的识别器看不出
  区别。
- **术语是你的，不是互联网的。** `递推` 会听成 `地规`，`阶乘` 会听成 `階層`。
  把更正和命令一起写进 `~/.dsh/asr.json`：

  ```json
  {
    "cmd": "C:\\python\\python.exe F:\\asr\\engine.py --model small {wav} {out}",
    "terms": { "地规": "递推", "階層": "阶乘" }
  }
  ```

  环境变量仍然优先于文件（`DSH_ASR_CMD`）；留文件是因为桌面版宿主拿不到 `setx`
  设的变量。长的条目优先、只走一遍，清单里报 `1 term(s) fixed`。

  每个条目都在**两种字形**下各试一次（一堂课里实际会出现约 50 对简繁），因为
  whisper 把普通话转成繁体：写成 `地规` 的条目必须能匹配回来的 `地規`，而在
  这之前它悄悄什么都没做。按你脑子里想字的方式写字典就行，另一种写法同样有效。

**格子边界会挪到静音处。** 台词本来就知道句子在哪结束，所以离静音中点 1.5 秒以内
的边界会被移过去，而不是把一张卡切在某个字的第十个百分之一秒上；挪动之后任何格子
都不短于 0.3 秒。

**已经有转录就直接给。** `transcriptFile` 接受 SRT、WebVTT，或 JSON
（`[{start,end,text}]`，或 whisper 系工具输出的 `{"segments":[…]}`），**优先于**
内嵌字幕轨和 ASR：

```
video_storyboard({"input": "lecture.mp4", "transcriptFile": "lecture.srt"})
```

最划算的就是 B站：字幕本来就有，再花一次下载加一次识别去重新推导它是浪费。

## 做不到什么

- **不内置语音识别。** 只有文件自带字幕轨，或者你按上面的方式配了 `DSH_ASR_CMD`
  时，才会转录说话。两者都没有时，仍然给你音频摘要：说话占比、响度、静音、起音。
  长窗口会切块，但模型是你自己的：这个包从不下载模型。
- **OCR 要用三种引擎之一。** Windows 自带的那个（`Windows.Media.Ocr`）是内建的；
  Linux 和 macOS 用 `PATH` 上的 `tesseract`；`DSH_OCR_CMD` 指向任何「吃一张
  图、吐几行字」的引擎。三种都没有时工具直说——`DSH_OCR_BACKEND=off` 强制给出
  这个答案，而 `video_outline` 或 `video_storyboard` 照样能用，因为它们都不读字。
- **只认 B站，而且只拿它愿意给的清晰度。** B站 链接走公开接口解析，也就是说没有
  cookie（`DSH_BILIBILI_COOKIE`）就只有 720P；没有 `yt-dlp`，其它站点仍然要先
  下载成文件。付费内容和会员专享读不了。
- **切点是检测出来的，不是理解出来的。** 快速甩镜和硬切在 96x54 的网格里可能相似，
  分类器在「变化很局部」时倾向于判「不是切点」。
- **它不是播放器。** 一次调用 = 一张最多 28 个瞬间的静态图。

---

## 结构

```
src/index.js     插件入口：注册五个工具、解析二进制路径
src/tools.js     工具规格（描述进 prompt 缓存，所以写得很短）
src/pipeline.js  编排 + 分析缓存
src/scan.js      单遍解码（或只解关键帧），cut/overlay/light/flash/dissolve
src/layout.js    镜头构建、格子预算、清晰度底线、网格几何、token 计算
src/detail.js    一张图活着进格子还剩多少细节（纯算术）
src/frames.js    批量抽帧
src/sheet.js     分镜合成器（不用图像库，裸 RGB）
src/png.js       PNG 编码器（zlib）
src/manifest.js  文本索引
src/outline.js   只走文本的整片地图：窗口、切点、说话，不解像素
src/read.js      文本文档：屏幕聚类、家具剔除、导出、无画面路径
src/ocr.js       一个接口后面的三种 OCR 后端
src/asr.js       切块、静音感知的切分、识别器钩子
src/transcript.js 字幕文件（SRT/VTT/JSON）当 cue 用
src/timeline.js  音频包络、说话区间、字幕抽取
src/media.js     ffmpeg/ffprobe 查找、探测、进程辅助
src/bili.js      B站 链接 -> 可播地址 -> 缓存文件，每种链接一种拒绝理由

docs/EVIDENCE.md     实测行为，以及产出每个数字的脚本
docs/DESIGN.md       每条阈值为什么存在；被否掉的机制
docs/REAL-WORLD.md   三份没动过的截屏，用眼睛看过
docs/TOKENS.md       DeepSeek 怎么给一张图计价，网格尺寸花多少
bench/               语料、语料生成器，和产出每个数字的脚本
test/                314 个单元测试，不联网，临时目录隔离
```

---

## 致谢

本插件的起点是一个想法：一张画面上烧好格子编号的分镜图，配一份把格子与时间码
绑定的文本索引，而且不用任何图像库。这个想法来自
[SAOS-3624/dsh-video-storyboard](https://github.com/SAOS-3624/dsh-video-storyboard)，
那份文档也是「为什么这样做有效」最清楚的说明。谢谢。

这里是**独立实现**：没有复制它的代码，切点检测、格子预算、解码与合成方式都不同。
三个工具名、参数形状与清单语法是有意保持兼容的，这样在原插件已安装的地方可以直接
替换。归属声明见 [NOTICE](NOTICE)。

MIT 许可。ffmpeg 的许可取决于你指向的构建（GPL/LGPL）；本包不附带任何 ffmpeg 二进制。
