# 第三方素材与许可

这个项目由两部分组成，许可完全不同，务必分开看。

## 一、本项目自己的代码

`src/`、`tools/`、`config/`、`docs/`、根目录文档 —— **MIT**，见 [LICENSE](../LICENSE)。
随便改、随便商用、随便分发，保留版权声明即可。

## 二、`vendor/whale-girl/` 下的 Live2D 模型与运行时

这部分**不是我的作品**，是从开源项目 **dsh-whale-girl-live2d** 取来的，
按原作者与模型作者的条款原样使用。

| 内容 | 来源 | 许可 |
| --- | --- | --- |
| `lib/`、`tools/`、文档等代码 | [Andersen216/dsh-whale-girl-live2d](https://github.com/Andersen216/dsh-whale-girl-live2d) | MIT |
| `assets/model/**`（moc3 / 贴图 / 动作 / 表情 / 物理） | 同上，源自 B 站 **@氵六青**（UID 11272072）的 VTube Studio 模型包 | **CC BY-NC-SA 4.0**（署名：上善无形 / ZipZipPipe / 氵六青） |
| `assets/vendor/live2dcubismcore.min.js` | Live2D Inc. 官方 SDK | Live2D Cubism SDK 许可（Redistributable Code） |
| `assets/vendor/pixi.min.js` | PIXI.js 6.5.10 | MIT |
| `assets/vendor/cubism4.min.js` | pixi-live2d-display 0.4.0 | MIT |
| `assets/pet.js` | 同上项目 | MIT（本仓库只用 `tools/patch-pet.mjs` 在**副本**里加了一行，暴露 `act()`） |

### 角色形象的三重版权链（转载/二次创作必须全部署名）

| 版权所有人 | 贡献 | 主页 |
| --- | --- | --- |
| **上善无形** | 鲸鱼娘角色形象原作「溟月」 | <https://space.bilibili.com/4456176> |
| **ZipZipPipe** | 加入 DeepSeek 元素的「女仆鲸鱼娘」二次设计 | <https://space.bilibili.com/4168597> |
| **氵六青** | 本仓库所用 Live2D 模型（绑定 / 动作 / 表情） | <https://space.bilibili.com/11272072> |

### 模型作者的使用须知（原文）

```
商用直播√
自印物料√

禁止任何形式的盗用以及出售，此模型为无偿分享

模型制作：B站@氵六青（11272072）
使用问题和定制桌宠请加QQ交流群：645169617
```

也就是说：**商用直播是明确允许的**，但形象本身是 CC BY-NC-SA 4.0（署名—非商业—相同方式共享），
两者存在张力。上游项目自己也标注了这一点。

**给你的实际建议：**

- 自己开着玩、不收费的直播 —— 没问题，记得在直播间简介里署名三位作者。
- 要正经拿它做商业化（带货、接广告、卖周边、付费服务）—— 请先联系作者取得授权，
  或者把 `vendor/whale-girl/assets/model/` 换成你自己拥有权利的模型（`c_0120.model3.json`
  是标准 Cubism 4 格式，换模型只需要替换这个目录并改一下文件名）。
- 无论哪种情况，都**不要**把模型文件单独拿出来分发或售卖。

如果你认为这里的素材侵犯了你的权利，提一个 issue 说明文件名与依据，我会立即替换或移除。

## 三、参考与致谢

- 抖音 webcast 协议的字段编号对照：[saermart/DouyinLiveWebFetcher](https://github.com/saermart/DouyinLiveWebFetcher)（AGPL-3.0）。
  本项目**没有**引入它的代码，只对照核实了 protobuf 字段编号（`src/douyin/proto.mjs` 是独立重写的最小集合）。
  如果你打算用它当采集器，请通过 `source.kind = "exec"` 以**独立进程**方式接入，这样两边许可互不影响。
