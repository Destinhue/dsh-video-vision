# dsh-video-vision

让模型**看**视频，而不是听人转述视频。每次调用给出一张**可寻址的分镜图**（
storyboard grid），为 `deepseek-v4.1-flash` 的视觉能力调优。可直接替换
`dsh-video-storyboard` / `dsh-video-understand`：三个工具名一致、参数一致，引擎不同。

```
video_probe       读容器元数据 + 阅读计划，不解码画面
video_storyboard  一张分镜图 + 逐格对应的文本索引
video_zoom        对一个短窗口放大看，1-9 格
```

> 每一项设计决定背后的实测数据见 [docs/DESIGN.md](docs/DESIGN.md)；
> 与参考实现的对比数据见 [docs/EVIDENCE.md](docs/EVIDENCE.md)。

---

## 好在哪

**能看见「亮度相同」的切点。** 每个画面被压成 12x7 的**亮度块 + 色度块**，
一次 ffmpeg 解码同时算出。两个镜头亮度几乎一样、只是调色不同时，只看得见亮度的
检测器会认为「什么都没发生」，这里不会。跳变被分成五类：`cut`（真切）、
`partial`（幻灯片只有文字块变了）、`overlay`（字幕/贴图出现）、`light`（开灯）、
`noise`；只有前两类会变成格子。

**闪光和转场不算新镜头。** 单帧白闪会在 3 帧内恢复原画面，直接丢弃；渐变（disolive）
被识别为**瞬态**——一段变化的平台期，之后必须安静下来——因此只产生一个边界，
而不是一串碎镜头；而缓慢摇镜不会产生任何边界。

**图按「每格」定尺寸，不按「整张」定。** 宿主按面积计费
（`tokens = gridH*(gridW+1)+2`，上限 1024）。1.25 Mpx 的图里放 10 格和放 4 格
**同价**，所以预算用来换「更多时刻、更小的格」，直到格子看不清为止：
6 格约 350 token，20 格约 1000 token，内容少的片子自然就便宜。

**格子是挣来的，不是平均分的。** 每个镜头保底一格；额外格子只给「时长够长」且
「存在一帧与已选帧的距离超过同图阈值 2.5 倍」的镜头。静态口播永远拿不到第二格，
30 秒摇镜会分到 4 格。

**解码是批量的。** 6 格共用**一个** ffmpeg 进程（多个输入、各自输出），并发 3 个
进程——一张 20 格的图只启动 2-4 次进程，而不是 60 次。

**结果里不写废话。** 阅读说明放在工具描述里（属于可缓存的 prompt 前缀，只付一次），
上游设计在**每次结果**里重复约 700 token 的说明。`textOnly` + `cellRange` 可以零图像
成本翻页，重复调用命中缓存。

---

## 数据

9 个片段，逐帧精确的标准答案，同一台机器、同一周，两个实现都直接以模块方式驱动
（`bench/final.mjs` 与 `bench/ab/run-upstream.mjs`）。完整协议、逐片段表格、结论的
适用边界见 [docs/EVIDENCE.md](docs/EVIDENCE.md)。

| | dsh-video-storyboard 0.3.0 | 本插件 |
| --- | --- | --- |
| 耗时（冷启动） | 1450 ms | **634 ms**（2.3 倍） |
| 耗时（命中缓存） | 1168 ms | **411 ms**（2.8 倍） |
| 给出的时刻数 | 36 格 | **67 格** |
| 视觉 token | 3644 | 3648 |
| 每个被覆盖镜头的 token | 165.6 | **54.5**（省 3.0 倍） |
| 切点 F1（0.5 秒） | 0.720 | **0.872** |
| 镜头覆盖率 | 0.766 | **0.963** |
| 结果里的说明文字 | 8356 字符 | **4292 字符** |

同样的钱，多看到 1.9 倍的片子，文字少一半。

换成 **13 分钟** 的片子，差距会拉开，因为长片正是两种设计分道的地方：
18.1 秒 降到 **6.2 秒**，两张图 变 **一张**，每格 265×145 变 **331×186**，
同一个问题占的上下文从 1511 token 降到 **1353**（清单 1315 字符，对方 2787）。
完整表格在 EVIDENCE.md。

参考实现在哪一格赢（E：1 秒叠化，
我们判成一次渐变边界）、标准答案在哪两个片段上对双方都不公（G、H），都写在
EVIDENCE.md 里，没有四舍五入掉。真实视频的抽检与实际可读性截图：
[docs/REAL-WORLD.md](docs/REAL-WORLD.md)。

---

## 安装

插件**零运行时依赖**。需要 `ffmpeg`；有 `ffprobe` 时用它，没有就从 `ffmpeg -i`
的输出里解析元数据。

```bash
cd /path/to/dsh-video-vision
node bin/install.mjs            # 改 ~/.dsh/profiles/desktop，然后重启 DSH
node bin/install.mjs --dry-run  # 只打印要改什么，不动文件
node bin/install.mjs --remove   # 卸载
```

脚本手工做完了 `pnpm install` 本来会做的三件事：往 profile 的 `dependencies` 里写
`"dsh-video-vision": "link:<绝对路径>"`、把包名加进 `dsh.profile.bundles`、把包
**目录联接（junction）**到 profile 的 `node_modules`。可重复执行；`--copy` 改成
复制一份快照而不是链接。无论哪种方式，装完都要**重启应用**：包内的
`cordis.patch.yml` 在启动时把插件插入 harness 树，三个工具才会出现。

### ffmpeg 查找顺序

`$DSH_FFMPEG_PATH` → `$DSH_VIDEO_FFMPEG` → `$FFMPEG_PATH` → 包内 `vendor/bin` →
node_modules 里的 `ffmpeg-static` / `@ffmpeg-installer` → WinGet Links →
`C:\ffmpeg\bin` → scoop → npm roaming → `/usr/local/bin` →
`~/.dsh/dsh-runtimes/*/` 里的 `imageio-ffmpeg` → `PATH` 上的 `ffmpeg`。
ffprobe 同理（`$DSH_FFPROBE_PATH` / `$FFPROBE_PATH`）。

一条命令自检（不需要现成视频，它会自己生成一个）：

```bash
node bin/selfcheck.mjs --smoke          # 16 项检查（装了 ffprobe 则 17 项），自己生成素材
node bin/selfcheck.mjs --smoke --host   # 另外用已安装的 Harness 自己的 schema
                                        # 引擎校验三个工具（29 项）
node --test test/                       # 155 个单元测试，不联网，临时目录隔离
```

`--host` 跑的是 `ctx.tools.register` 真正执行的断言，然后逐个工具真调用一次，
再按运行时的规则校验返回值。要用 Electron 的 node 跑（`ELECTRON_RUN_AS_NODE=1`），
普通 node 读不进 `app.asar`。这不是形式主义：工具如果返回 `{ text: {…} }` 而不是
`{ text: "…" }`，宿主会直接拒绝并报 `"value.text" must be a string`，本地一切正常，
直到用户按下调用。

---

## 用法

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
| `textOnly` | 只返回文本索引：不取图、不解码 |
| `cellRange` | 配合 `textOnly`，列出第 a 到第 b 格 |

`video_zoom` 支持同样的窗口参数，外加 `cells`（1-9）与 `at`；只有 1 格时返回原分辨率单帧。

---

## 做不到什么

- **不做 OCR、不做语音识别。** 读字是模型看图的事；语音只有文件自带字幕轨时才会
  逐格引用。不下载模型、不需要 key、不联网。
- **不带下载器。** 网页地址（YouTube、B 站）不做解析：那需要 `yt-dlp`，本插件
  既不自带也不调用它。请先下载成文件再传路径。直链 `http(s)` 媒体地址可以，
  由 ffmpeg 自己抓。
- **切点是检测出来的，不是理解出来的。** 快速甩镜和硬切在 96x54 的网格里可能相似，
  分类器在「变化很局部」时倾向于判「不是切点」。
- **它不是播放器。** 一次调用 = 一张最多 28 个瞬间的静态图。

---

## 许可

MIT。ffmpeg 的许可见你指向的构建（GPL/LGPL）；本包不附带任何 ffmpeg 二进制。
